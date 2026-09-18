#!/usr/bin/env bash
# 실제 로컬 Supabase(Supabase CLI: Postgres · Auth(GoTrue) · PostgREST · Realtime · Edge Runtime) 위에서
#   1) migration 버전 중복 검사
#   2) 전체 migration 을 CLI 경로로 적용 (빈 DB → 최신 · 직전 버전 → 최신 · 최신에서 재적용 no-op) + 이력에 각 버전 1회 기록 확인
#   3) [app 스위트] Edge Function 을 띄우고(supabase functions serve, 개발 env) 앱 요청 통합 테스트 (supabase/tests/app_flow_integration.mjs)
#      — 로컬 테스트 계정(dev-login) 으로 추천 · 대화 · 메시지 실시간 전달(Realtime) · 차단 · 탈퇴/복구 · 나가기 · 넘기기
#   4) [admin 스위트] 관리자 웹(next build + next start)을 띄우고 관리자 Auth 통합 테스트 (apps/admin/scripts/admin-auth-integration.mjs)
# 를 실행한다. 빠른 selftest·psql SQL 테스트(run_local_check.sh)와는 별개의 느린 경로다. docs/local-supabase-integration.md
#
#   bash supabase/tests/run_supabase_integration.sh                 # 기본: 격리된 CLI 스택(project_id bonsim-it, 포트 553xx)을 띄우고 끝나면 내린다
#   SUPABASE_IT_MODE=attach SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... SUPABASE_DB_URL=... bash supabase/tests/run_supabase_integration.sh
#                                                                    # 이미 떠 있는 "로컬" 스택 사용 (원격이면 거부). 개발 DB 를 초기화하지 않으므로 이력 검사는 비파괴 부분만.
#                                                                    # app 스위트는 그 스택의 Realtime 이 켜져 있어야 한다 (config.toml [realtime] enabled = true)
#   SUPABASE_IT_SUITES=app,admin  실행할 스위트 (기본 둘 다 · 예: SUPABASE_IT_SUITES=app)
#   SUPABASE_IT_KEEP_STACK=1  끝나도 스택을 내리지 않는다 (디버그)
#
# 요구: Docker 데몬 · Supabase CLI 2.117.0 (npm: npx supabase@2.117.0 또는 PATH 의 supabase) · Node 22 · npm ci 된 apps/admin
#       (app 스위트의 @supabase/supabase-js 는 apps/mobile 이 npm ci 되어 있으면 그것을, 없으면 apps/admin 의 것을 쓴다)
# 환경이 없으면 "실패(exit 2)" 다 — 성공이나 조용한 skip 으로 처리하지 않는다 (CI 필수 job).
# 원칙: 원격 URL/DB 연결 문자열은 거부 · 실제 auth 스키마를 mock 으로 덮지 않는다 · 계정/비밀번호/TOTP secret/service key 를 출력하지 않는다.
#       Edge Function 개발 env(APP_ENV=development · ALLOW_DEV_LOGIN=1 · mock provider · 실행마다 난수 DEV_LOGIN_PASSWORD)는 격리 workdir 의 .env 에만 쓴다.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SUPABASE_CLI_VERSION="${SUPABASE_CLI_VERSION:-2.117.0}"
MODE="${SUPABASE_IT_MODE:-start}"
IT_DIR="${SUPABASE_IT_WORKDIR:-$ROOT/.supabase-it}"
ADMIN_PORT="${ADMIN_IT_PORT:-3101}"
API_PORT="${SUPABASE_IT_API_PORT:-55321}"
DB_PORT="${SUPABASE_IT_DB_PORT:-55322}"
SHADOW_PORT="${SUPABASE_IT_SHADOW_PORT:-55320}"
SUITES="${SUPABASE_IT_SUITES:-app,admin}"
export DO_NOT_TRACK=1 SUPABASE_TELEMETRY_DISABLED=1

log() { echo "== $*"; }
fail() { echo "FAIL: $*" >&2; exit "${2:-1}"; }
has_suite() { case ",${SUITES}," in *,"$1",*) return 0 ;; *) return 1 ;; esac; }
has_suite app || has_suite admin || fail "SUPABASE_IT_SUITES 에 app 또는 admin 이 있어야 합니다 (${SUITES})" 2

is_local_host() {
  case "$1" in
    localhost|127.0.0.1|::1|\[::1\]|host.docker.internal) return 0 ;;
    *) return 1 ;;
  esac
}
url_host() { node -e 'try{console.log(new URL(process.argv[1]).hostname)}catch{console.log("")}' "$1"; }
assert_local_url() { # name url
  local h; h="$(url_host "$2")"
  [[ -n "$h" ]] || fail "$1 이 URL 이 아닙니다" 2
  case "$h" in *.supabase.co|*.supabase.com|*.pooler.supabase.com) fail "$1 이 원격 Supabase 호스트입니다 ($h) — 통합 테스트는 로컬에서만 실행한다" 2 ;; esac
  is_local_host "$h" || fail "$1 이 로컬 호스트가 아닙니다 ($h)" 2
}

# ---------------------------------------------------------------------------
# 0) 도구 · 버전 검사 (없으면 실패)
# ---------------------------------------------------------------------------
command -v node >/dev/null 2>&1 || fail "node 가 필요합니다 (22+)" 2
log "0) migration 버전 중복 검사"
node "$ROOT/supabase/scripts/check-migration-versions.mjs"

if [[ "$MODE" == "start" ]]; then
  command -v docker >/dev/null 2>&1 || fail "docker 가 필요합니다 (Supabase CLI 로컬 스택). Docker 없는 환경에서는 실행하지 못한 것으로 보고한다" 2
  docker info >/dev/null 2>&1 || fail "docker 데몬에 연결할 수 없습니다" 2
fi
SUPA=()
if [[ -n "${SUPABASE_CLI_BIN:-}" ]]; then SUPA=("$SUPABASE_CLI_BIN")
elif command -v supabase >/dev/null 2>&1; then SUPA=(supabase)
else SUPA=(npx --yes "supabase@${SUPABASE_CLI_VERSION}")
fi
CLI_VER="$("${SUPA[@]}" --version 2>/dev/null | tail -1 | tr -d '[:space:]')"
[[ "$CLI_VER" == "$SUPABASE_CLI_VERSION" ]] || fail "Supabase CLI 버전이 ${SUPABASE_CLI_VERSION} 이 아닙니다 (${CLI_VER:-없음}). npx supabase@${SUPABASE_CLI_VERSION} 또는 SUPABASE_CLI_BIN 지정" 2
log "Supabase CLI ${CLI_VER}"

# ---------------------------------------------------------------------------
# 1) 스택 — start: 격리 workdir 로 CLI 스택 기동 / attach: 주어진 로컬 스택
# ---------------------------------------------------------------------------
NEXT_PID=""
FUNCS_PID=""
cleanup() {
  set +e
  if [[ -n "$NEXT_PID" ]]; then kill "$NEXT_PID" 2>/dev/null; wait "$NEXT_PID" 2>/dev/null; fi
  if [[ -n "$FUNCS_PID" ]]; then kill "$FUNCS_PID" 2>/dev/null; wait "$FUNCS_PID" 2>/dev/null; fi
  if [[ "$MODE" == "start" && "${SUPABASE_IT_KEEP_STACK:-0}" != "1" ]]; then
    log "정리: 격리 스택 종료 (supabase stop --no-backup)"
    "${SUPA[@]}" --workdir "$IT_DIR" stop --no-backup >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [[ "$MODE" == "start" ]]; then
  log "1) 격리 workdir 준비: $IT_DIR (project_id bonsim-it · api ${API_PORT} · db ${DB_PORT})"
  rm -rf "$IT_DIR/supabase"
  mkdir -p "$IT_DIR/supabase"
  cp -R "$ROOT/supabase/migrations" "$IT_DIR/supabase/migrations"
  # project_id 와 포트만 바꾼다 — 나머지(auth/mfa 설정 · seed 비활성)는 개발용 config.toml 과 같다
  sed -e 's/^project_id = .*/project_id = "bonsim-it"/' \
      -e "s/^port = 54321$/port = ${API_PORT}/" \
      -e "s/^port = 54322$/port = ${DB_PORT}/" \
      -e "s/^shadow_port = 54320$/shadow_port = ${SHADOW_PORT}/" \
      -e "s#^site_url = .*#site_url = \"http://127.0.0.1:${ADMIN_PORT}\"#" \
      -e "s#^additional_redirect_urls = .*#additional_redirect_urls = [\"http://127.0.0.1:${ADMIN_PORT}\"]#" \
      "$ROOT/supabase/config.toml" > "$IT_DIR/supabase/config.toml"
  grep -q 'project_id = "bonsim-it"' "$IT_DIR/supabase/config.toml" || fail "격리 config.toml 생성 실패"
  # app 스위트: Realtime(메시지 실시간 전달) · Edge Runtime(dev-login 등 함수) 을 이 격리 스택에서만 켠다 — 개발용 config.toml 은 그대로
  node -e '
    const fs = require("fs"); const p = process.argv[1]; let s = fs.readFileSync(p, "utf8");
    for (const sec of ["realtime", "edge_runtime"]) {
      const re = new RegExp("(\\[" + sec + "\\]\\n)enabled = false");
      if (!re.test(s)) { console.error("config.toml: [" + sec + "] enabled = false 항목을 찾지 못했습니다"); process.exit(1); }
      s = s.replace(re, "$1enabled = true");
    }
    fs.writeFileSync(p, s);
  ' "$IT_DIR/supabase/config.toml"
  # Edge Function 소스 복사 + 개발 env (격리 workdir 에만 — 저장소의 supabase/functions/.env 는 건드리지 않는다)
  rm -rf "$IT_DIR/supabase/functions"
  cp -R "$ROOT/supabase/functions" "$IT_DIR/supabase/functions"
  rm -f "$IT_DIR/supabase/functions/.env"
  FUNCS_ENV_FILE="$IT_DIR/supabase/functions/.env"
  DEV_LOGIN_PASSWORD_IT="$(node -e 'console.log(require("crypto").randomBytes(24).toString("base64url"))')"
  {
    echo "APP_ENV=development"
    echo "ALLOW_DEV_LOGIN=1"
    echo "IDENTITY_PROVIDER=mock"
    echo "FACE_VERIFICATION_PROVIDER=mock"
    echo "DEV_LOGIN_PASSWORD=${DEV_LOGIN_PASSWORD_IT}"
  } > "$FUNCS_ENV_FILE"
  unset DEV_LOGIN_PASSWORD_IT

  log "1) supabase start (postgres · gotrue · postgrest · realtime · kong — edge runtime 은 functions serve 로 따로)"
  "${SUPA[@]}" --workdir "$IT_DIR" stop --no-backup >/dev/null 2>&1 || true
  "${SUPA[@]}" --workdir "$IT_DIR" start -x storage-api,imgproxy,mailpit,postgres-meta,studio,edge-runtime,logflare,vector,supavisor
  STATUS_ENV="$("${SUPA[@]}" --workdir "$IT_DIR" status -o env)"
  get_env() { printf '%s\n' "$STATUS_ENV" | sed -n "s/^$1=\"\{0,1\}\([^\"]*\)\"\{0,1\}$/\1/p" | head -1; }
  SUPABASE_URL="$(get_env API_URL)"
  SUPABASE_ANON_KEY="$(get_env ANON_KEY)"
  SUPABASE_SERVICE_ROLE_KEY="$(get_env SERVICE_ROLE_KEY)"
  SUPABASE_DB_URL="$(get_env DB_URL)"
  [[ -n "$SUPABASE_URL" && -n "$SUPABASE_ANON_KEY" && -n "$SUPABASE_SERVICE_ROLE_KEY" && -n "$SUPABASE_DB_URL" ]] || fail "supabase status 에서 API_URL/ANON_KEY/SERVICE_ROLE_KEY/DB_URL 을 읽지 못했습니다"
else
  [[ "$MODE" == "attach" ]] || fail "SUPABASE_IT_MODE 는 start 또는 attach" 2
  : "${SUPABASE_URL:?attach 모드는 SUPABASE_URL 필요}" "${SUPABASE_ANON_KEY:?}" "${SUPABASE_SERVICE_ROLE_KEY:?}" "${SUPABASE_DB_URL:?attach 모드는 SUPABASE_DB_URL 필요}"
  # attach 모드의 Edge env: 저장소의 supabase/functions/.env (개발자가 만든 것) 가 있으면 그대로, 없으면 임시 개발 env
  if [[ -f "$ROOT/supabase/functions/.env" ]]; then
    FUNCS_ENV_FILE="$ROOT/supabase/functions/.env"
  else
    FUNCS_ENV_FILE="$(mktemp)"
    printf 'APP_ENV=development\nALLOW_DEV_LOGIN=1\nIDENTITY_PROVIDER=mock\nFACE_VERIFICATION_PROVIDER=mock\n' > "$FUNCS_ENV_FILE"
  fi
fi
assert_local_url SUPABASE_URL "$SUPABASE_URL"
assert_local_url SUPABASE_DB_URL "$SUPABASE_DB_URL"
export SUPABASE_URL SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY SUPABASE_DB_URL
DB_URL_CLI="$SUPABASE_DB_URL"
case "$DB_URL_CLI" in *sslmode=*) ;; *\?*) DB_URL_CLI="${DB_URL_CLI}&sslmode=disable" ;; *) DB_URL_CLI="${DB_URL_CLI}?sslmode=disable" ;; esac

# ---------------------------------------------------------------------------
# 2) migration 이력 검증 — Supabase CLI 경로 (psql 직접 실행이 아니다)
# ---------------------------------------------------------------------------
WORKDIR_FLAG=()
[[ "$MODE" == "start" ]] && WORKDIR_FLAG=(--workdir "$IT_DIR")
[[ "$MODE" == "attach" ]] && WORKDIR_FLAG=(--workdir "$ROOT")
cli() { "${SUPA[@]}" "${WORKDIR_FLAG[@]}" "$@"; }

LOCAL_VERSIONS="$(ls "$ROOT/supabase/migrations" | sed -n 's/^\([0-9][0-9]*\)_.*\.sql$/\1/p' | sort)"
LATEST="$(printf '%s\n' "$LOCAL_VERSIONS" | tail -1)"
PREV="$(printf '%s\n' "$LOCAL_VERSIONS" | tail -2 | head -1)"
N_LOCAL="$(printf '%s\n' "$LOCAL_VERSIONS" | wc -l | tr -d ' ')"

# migration list (JSON) — local/remote 가 모두 있고 각 버전이 원격 이력에 1회
assert_history_complete() { # label
  local out
  out="$(cli migration list --db-url "$DB_URL_CLI" --output-format json 2>/dev/null | tail -1)"
  node -e '
    const j = JSON.parse(process.argv[1]); const n = Number(process.argv[2]); const label = process.argv[3];
    const rows = j.migrations || [];
    const bad = rows.filter((r) => !r.local || !r.remote || r.local !== r.remote);
    const remote = rows.map((r) => r.remote).filter(Boolean);
    const dup = remote.filter((v, i) => remote.indexOf(v) !== i);
    if (rows.length !== n || bad.length || dup.length) { console.error(`FAIL ${label}: rows=${rows.length}/${n} mismatched=${JSON.stringify(bad)} dup=${JSON.stringify(dup)}`); process.exit(1); }
    console.log(`OK ${label}: ${n} versions, local == remote, each recorded once`);
  ' "$out" "$N_LOCAL" "$1"
}
assert_up_to_date() { # label
  local out
  out="$(cli db push --db-url "$DB_URL_CLI" --dry-run --output-format json 2>/dev/null | tail -1)"
  node -e 'const j=JSON.parse(process.argv[1]); if(!(j.upToDate===true && Array.isArray(j.migrations) && j.migrations.length===0)){console.error("FAIL "+process.argv[2]+": "+process.argv[1]);process.exit(1)} console.log("OK "+process.argv[2]+": remote up to date, nothing pending")' "$out" "$1"
}

if [[ "$MODE" == "start" ]]; then
  log "2a) 빈 DB → 전체 적용 (supabase start 가 CLI 경로로 적용) · 이력 각 버전 1회"
  assert_history_complete "empty→${LATEST}"
  log "2b) 최신 상태에서 재적용 → 변경 없음 (db push --dry-run · migration up)"
  assert_up_to_date "re-apply at ${LATEST}"
  cli migration up --db-url "$DB_URL_CLI" --output-format json 2>/dev/null | tail -1 | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s.trim().split("\n").pop()); if((j.applied||[]).length){console.error("FAIL migration up applied something at latest: "+s);process.exit(1)} console.log("OK migration up: nothing applied")})'
  log "2c) 직전 버전(${PREV})까지 적용된 DB → 최신(${LATEST}) (db reset --version ${PREV} · migration up)"
  cli db reset --db-url "$DB_URL_CLI" --version "$PREV" --yes >/dev/null
  cli migration up --db-url "$DB_URL_CLI" --output-format json 2>/dev/null | tail -1 | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s.trim().split("\n").pop()); const a=(j.applied||[]).map(p=>p.split("/").pop()); if(a.length!==1||!a[0].startsWith(process.argv[1]+"_")){console.error("FAIL expected only "+process.argv[1]+" applied, got "+JSON.stringify(a));process.exit(1)} console.log("OK upgrade "+process.argv[2]+"→"+process.argv[1]+": applied "+a[0])})' "$LATEST" "$PREV"
  assert_history_complete "${PREV}→${LATEST}"
  log "2d) 다시 빈 DB → 전체 적용 (db reset) — 통합 테스트는 이 상태에서 시작"
  cli db reset --db-url "$DB_URL_CLI" --yes >/dev/null
  assert_history_complete "reset→${LATEST}"
  assert_up_to_date "after reset"
else
  log "2) attach 모드: 비파괴 이력 검사만 (migration list · db push --dry-run). 빈 DB/직전 버전 경로는 start 모드에서"
  assert_history_complete "attach"
  assert_up_to_date "attach"
fi

# ---------------------------------------------------------------------------
# 3) [app] Edge Function 서빙 + 앱 요청 통합 테스트 — 실제 GoTrue · PostgREST · Realtime · Edge Runtime, 사용자 JWT 경로
# ---------------------------------------------------------------------------
if has_suite app; then
  # start 모드에서는 2c·2d 의 `db reset` 이 DB 를 drop/recreate 하므로, 먼저 떠 있던 Realtime 컨테이너의 WAL 복제 슬롯이
  # 옛 DB 를 가리킨 채 끊긴다 — 채널 구독(phoenix)은 SUBSCRIBED 되지만 INSERT/UPDATE 가 하나도 흘러오지 않는다.
  # Realtime 컨테이너를 재시작해 현재 DB 에 복제를 다시 건다 (attach 모드는 우리가 reset 하지 않으므로 불필요).
  if [[ "$MODE" == "start" ]]; then
    RT_CONTAINER="$(docker ps --format '{{.Names}}' 2>/dev/null | grep -i realtime | grep bonsim-it | head -1)"
    [[ -n "$RT_CONTAINER" ]] || fail "Realtime 컨테이너를 찾지 못했습니다 (bonsim-it) — 격리 스택에 realtime 이 떠 있는지 확인"
    log "3a) db reset 뒤 Realtime 복제 재설정 — 컨테이너 재시작 ($RT_CONTAINER)"
    docker restart "$RT_CONTAINER" >/dev/null || fail "Realtime 컨테이너 재시작 실패 ($RT_CONTAINER)"
    for _ in $(seq 1 30); do
      if [[ "$(docker inspect -f '{{.State.Running}}' "$RT_CONTAINER" 2>/dev/null)" == "true" ]]; then break; fi
      sleep 1
    done
    sleep 5  # 재시작 후 Postgres 재연결 · 복제 슬롯 재생성까지 여유
  fi

  log "3b) Realtime publication 확인 (messages · matches 가 supabase_realtime 에 있어야 실시간 전달이 된다)"
  PUB_TABLES=""
  if [[ "$MODE" == "start" ]]; then
    PUB_TABLES="$(docker exec -e PGPASSWORD=postgres supabase_db_bonsim-it psql -U postgres -d postgres -Atc "select coalesce(string_agg(tablename, ',' order by tablename), '') from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public'" 2>/dev/null || true)"
  elif command -v psql >/dev/null 2>&1; then
    PUB_TABLES="$(psql "$SUPABASE_DB_URL" -Atc "select coalesce(string_agg(tablename, ',' order by tablename), '') from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public'" 2>/dev/null || true)"
  else
    PUB_TABLES="(미확인 — psql 없음)"
  fi
  log "supabase_realtime publication: ${PUB_TABLES:-(없음)}"
  if [[ "$PUB_TABLES" != "(미확인"* ]]; then
    case ",$PUB_TABLES," in
      *,matches,*) ;; *) fail "supabase_realtime publication 에 matches 가 없습니다 (0016 은 publication 이 있을 때만 추가한다) — 로컬 스택의 publication 상태를 확인" ;;
    esac
    case ",$PUB_TABLES," in
      *,messages,*) ;; *) fail "supabase_realtime publication 에 messages 가 없습니다 (0004 은 publication 이 있을 때만 추가한다) — 로컬 스택의 publication 상태를 확인" ;;
    esac
  fi

  log "3c) supabase functions serve (개발 env · 백그라운드)"
  FUNCS_LOG="$IT_DIR/functions-serve.log"
  mkdir -p "$IT_DIR"
  (exec "${SUPA[@]}" "${WORKDIR_FLAG[@]}" functions serve --env-file "$FUNCS_ENV_FILE" >"$FUNCS_LOG" 2>&1) &
  FUNCS_PID=$!
  # 준비 확인: dev-login 에 빈 번호 → 400 invalid_phone (함수가 뜨고 env 가 적용된 상태). 403 이면 env(APP_ENV/ALLOW_DEV_LOGIN) 미적용
  FUNCS_CODE=""
  for _ in $(seq 1 120); do
    FUNCS_CODE="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$SUPABASE_URL/functions/v1/dev-login" \
      -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $SUPABASE_ANON_KEY" -H 'Content-Type: application/json' -d '{"phone":""}' 2>/dev/null || true)"
    case "$FUNCS_CODE" in 400|403) break ;; esac
    if ! kill -0 "$FUNCS_PID" 2>/dev/null; then break; fi
    sleep 2
  done
  case "$FUNCS_CODE" in
    400) log "Edge Runtime 준비됨 (dev-login 400 invalid_phone)" ;;
    403) fail "dev-login 이 403 — Edge env(APP_ENV=development · ALLOW_DEV_LOGIN=1) 가 적용되지 않았습니다 (${FUNCS_LOG})" ;;
    *) fail "Edge Runtime 이 ${SUPABASE_URL}/functions/v1 에서 응답하지 않습니다 (마지막 코드: ${FUNCS_CODE:-없음}, ${FUNCS_LOG})" ;;
  esac

  log "3d) 앱 요청 통합 테스트 (supabase/tests/app_flow_integration.mjs)"
  [[ -d "$ROOT/apps/admin/node_modules" || -d "$ROOT/apps/mobile/node_modules" ]] || fail "apps/admin 또는 apps/mobile 에 npm ci 가 필요합니다 (@supabase/supabase-js)" 2
  node "$ROOT/supabase/tests/app_flow_integration.mjs"

  # 함수 로그에 비밀번호·service key 가 없는지 (로그는 CI artifact 로 올리지 않는다 — 검사만)
  if grep -qE "SUPABASE_SERVICE_ROLE_KEY=|DEV_LOGIN_PASSWORD=|\"password\"" "$FUNCS_LOG" 2>/dev/null; then
    fail "functions serve 로그에 secret/비밀번호 흔적이 있습니다 (${FUNCS_LOG})"
  fi
  kill "$FUNCS_PID" 2>/dev/null || true
  wait "$FUNCS_PID" 2>/dev/null || true
  FUNCS_PID=""
  log "OK: app integration (dev-login accounts · recommendation · chat · realtime delivery · block · delete/reactivate · leave · skip)"
fi

if ! has_suite admin; then
  log "OK: supabase integration (suites: ${SUITES})"
  exit 0
fi

# ---------------------------------------------------------------------------
# 4) [admin] 관리자 웹 기동 (next build + next start, production 모드 → ADMIN_SESSION_SECRET 32자+ 필수)
# ---------------------------------------------------------------------------
log "4) 관리자 웹 build + start (port ${ADMIN_PORT})"
ADMIN_DIR="$ROOT/apps/admin"
[[ -d "$ADMIN_DIR/node_modules" ]] || fail "apps/admin 에 npm ci 가 필요합니다" 2
ADMIN_SESSION_SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
export ADMIN_SESSION_SECRET
if [[ "${ADMIN_IT_SKIP_BUILD:-0}" != "1" ]]; then
  (cd "$ADMIN_DIR" && npx next build >/dev/null)
fi
(cd "$ADMIN_DIR" && NODE_ENV=production npx next start -p "$ADMIN_PORT" -H 127.0.0.1 >"$ADMIN_DIR/.next/it-server.log" 2>&1) &
NEXT_PID=$!
ADMIN_BASE_URL="http://127.0.0.1:${ADMIN_PORT}"
for _ in $(seq 1 60); do
  if curl -sS -o /dev/null -w '%{http_code}' "$ADMIN_BASE_URL/login" 2>/dev/null | grep -q '^200$'; then break; fi
  sleep 1
done
curl -sS -o /dev/null -w '%{http_code}' "$ADMIN_BASE_URL/login" | grep -q '^200$' || fail "관리자 웹이 ${ADMIN_BASE_URL} 에서 응답하지 않습니다 (apps/admin/.next/it-server.log)"
export ADMIN_BASE_URL

# ---------------------------------------------------------------------------
# 5) [admin] 관리자 Auth 통합 테스트 — 실제 GoTrue · 실제 어댑터 · HTTP 쿠키 경로
# ---------------------------------------------------------------------------
log "5) 관리자 Auth 통합 테스트"
(cd "$ADMIN_DIR" && node --experimental-strip-types scripts/admin-auth-integration.mjs 2>&1 | grep -v "ExperimentalWarning\|MODULE_TYPELESS_PACKAGE_JSON\|Reparsing as ES module\|eliminate this warning\|trace-warnings" ; exit "${PIPESTATUS[0]}")

# 서버 로그에 비밀번호·secret·토큰이 없는지 (실패 시에도 CI artifact 로 올리지 않는다 — 검사만)
if grep -qiE "otpauth://|SUPABASE_SERVICE_ROLE_KEY=|bonsim_admin=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+" "$ADMIN_DIR/.next/it-server.log"; then
  fail "관리자 웹 서버 로그에 secret/토큰 흔적이 있습니다 (apps/admin/.next/it-server.log)"
fi
log "OK: supabase integration (migration history via CLI · app requests against real stack [${SUITES}] · admin auth against real GoTrue · admin web HTTP/cookie path)"
