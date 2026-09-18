#!/usr/bin/env bash
# 실제 로컬 Supabase(Supabase CLI: Postgres · Auth(GoTrue) · PostgREST) 위에서
#   1) migration 버전 중복 검사
#   2) 전체 migration 을 CLI 경로로 적용 (빈 DB → 최신 · 직전 버전 → 최신 · 최신에서 재적용 no-op) + 이력에 각 버전 1회 기록 확인
#   3) 관리자 웹(next build + next start)을 띄우고 관리자 Auth 통합 테스트 (apps/admin/scripts/admin-auth-integration.mjs)
# 를 실행한다. 빠른 selftest·psql SQL 테스트(run_local_check.sh)와는 별개의 느린 경로다. docs/local-supabase-integration.md
#
#   bash supabase/tests/run_supabase_integration.sh                 # 기본: 격리된 CLI 스택(project_id bonsim-it, 포트 553xx)을 띄우고 끝나면 내린다
#   SUPABASE_IT_MODE=attach SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... SUPABASE_DB_URL=... bash supabase/tests/run_supabase_integration.sh
#                                                                    # 이미 떠 있는 "로컬" 스택 사용 (원격이면 거부). 개발 DB 를 초기화하지 않으므로 이력 검사는 비파괴 부분만
#   SUPABASE_IT_KEEP_STACK=1  끝나도 스택을 내리지 않는다 (디버그)
#
# 요구: Docker 데몬 · Supabase CLI 2.117.0 (npm: npx supabase@2.117.0 또는 PATH 의 supabase) · Node 22 · npm ci 된 apps/admin
# 환경이 없으면 "실패(exit 2)" 다 — 성공이나 조용한 skip 으로 처리하지 않는다 (CI 필수 job).
# 원칙: 원격 URL/DB 연결 문자열은 거부 · 실제 auth 스키마를 mock 으로 덮지 않는다 · 계정/비밀번호/TOTP secret/service key 를 출력하지 않는다.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SUPABASE_CLI_VERSION="${SUPABASE_CLI_VERSION:-2.117.0}"
MODE="${SUPABASE_IT_MODE:-start}"
IT_DIR="${SUPABASE_IT_WORKDIR:-$ROOT/.supabase-it}"
ADMIN_PORT="${ADMIN_IT_PORT:-3101}"
API_PORT="${SUPABASE_IT_API_PORT:-55321}"
DB_PORT="${SUPABASE_IT_DB_PORT:-55322}"
SHADOW_PORT="${SUPABASE_IT_SHADOW_PORT:-55320}"
export DO_NOT_TRACK=1 SUPABASE_TELEMETRY_DISABLED=1

log() { echo "== $*"; }
fail() { echo "FAIL: $*" >&2; exit "${2:-1}"; }

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
cleanup() {
  set +e
  if [[ -n "$NEXT_PID" ]]; then kill "$NEXT_PID" 2>/dev/null; wait "$NEXT_PID" 2>/dev/null; fi
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

  log "1) supabase start (postgres · gotrue · postgrest · kong 만)"
  "${SUPA[@]}" --workdir "$IT_DIR" stop --no-backup >/dev/null 2>&1 || true
  "${SUPA[@]}" --workdir "$IT_DIR" start -x realtime,storage-api,imgproxy,mailpit,postgres-meta,studio,edge-runtime,logflare,vector,supavisor
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
# 3) 관리자 웹 기동 (next build + next start, production 모드 → ADMIN_SESSION_SECRET 32자+ 필수)
# ---------------------------------------------------------------------------
log "3) 관리자 웹 build + start (port ${ADMIN_PORT})"
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
# 4) 관리자 Auth 통합 테스트 — 실제 GoTrue · 실제 어댑터 · HTTP 쿠키 경로
# ---------------------------------------------------------------------------
log "4) 관리자 Auth 통합 테스트"
(cd "$ADMIN_DIR" && node --experimental-strip-types scripts/admin-auth-integration.mjs 2>&1 | grep -v "ExperimentalWarning\|MODULE_TYPELESS_PACKAGE_JSON\|Reparsing as ES module\|eliminate this warning\|trace-warnings" ; exit "${PIPESTATUS[0]}")

# 서버 로그에 비밀번호·secret·토큰이 없는지 (실패 시에도 CI artifact 로 올리지 않는다 — 검사만)
if grep -qiE "otpauth://|SUPABASE_SERVICE_ROLE_KEY=|bonsim_admin=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+" "$ADMIN_DIR/.next/it-server.log"; then
  fail "관리자 웹 서버 로그에 secret/토큰 흔적이 있습니다 (apps/admin/.next/it-server.log)"
fi
log "OK: supabase integration (migration history via CLI · admin auth against real GoTrue · admin web HTTP/cookie path)"
