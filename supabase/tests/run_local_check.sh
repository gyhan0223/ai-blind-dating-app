#!/usr/bin/env bash
# 로컬 Postgres 에 마이그레이션 전체를 적용해 스키마를 검증한다.
# 사용: DB_SUPERUSER=postgres ./run_local_check.sh
set -euo pipefail

cd "$(dirname "$0")"
DB_NAME="${DB_NAME:-blind_dating_check}"
PSQL="${PSQL:-psql -v ON_ERROR_STOP=1 -q}"

dropdb --if-exists "$DB_NAME"
createdb "$DB_NAME"

$PSQL -d "$DB_NAME" -f local_supabase_mock.sql
for f in ../migrations/*.sql; do
  echo "applying $f"
  $PSQL -d "$DB_NAME" -f "$f"
done

if [[ "${WITH_SEED:-1}" == "1" && -f ../seed/seed.sql ]]; then
  echo "applying seed"
  $PSQL -d "$DB_NAME" -f ../seed/seed.sql
fi

if [[ "${WITH_RLS_TESTS:-1}" == "1" && -f rls_tests.sql ]]; then
  echo "running RLS tests"
  $PSQL -d "$DB_NAME" -f rls_tests.sql
fi

if [[ "${WITH_IDENTITY_TESTS:-1}" == "1" && -f identity_tests.sql ]]; then
  echo "running identity tests"
  $PSQL -d "$DB_NAME" -f identity_tests.sql
fi

if [[ "${WITH_SMS_RATE_LIMIT_TESTS:-1}" == "1" && -f sms_rate_limit_tests.sql ]]; then
  echo "running sms rate limit tests"
  $PSQL -d "$DB_NAME" -f sms_rate_limit_tests.sql
fi

if [[ "${WITH_FACE_LIVENESS_TESTS:-1}" == "1" && -f face_liveness_tests.sql ]]; then
  echo "running face liveness tests"
  $PSQL -d "$DB_NAME" -f face_liveness_tests.sql
fi

if [[ "${WITH_ONBOARDING_GUARD_TESTS:-1}" == "1" && -f onboarding_guard_tests.sql ]]; then
  echo "running onboarding guard tests (#39 — 외모 데이터 없는 완료 / 인증 전 완료 차단 / 공개 자기소개 제약)"
  $PSQL -d "$DB_NAME" -f onboarding_guard_tests.sql
fi

if [[ "${WITH_FACE_CONCURRENCY_TESTS:-1}" == "1" && -f face_liveness_concurrency_test.sh ]]; then
  echo "running face liveness concurrency tests (approve RPC — two sessions)"
  DB_NAME="$DB_NAME" PSQL="$PSQL -X" bash face_liveness_concurrency_test.sh
fi

if [[ "${WITH_MEETUP_FLOW_TESTS:-1}" == "1" && -f meetup_flow_tests.sql ]]; then
  echo "running meetup flow tests (#41 — 멱등 전송 · 일방 의향 비공개 · 상호 1회 · 철회 · 만남 확인 집계 · 비공개 피드백 · 차단)"
  $PSQL -d "$DB_NAME" -f meetup_flow_tests.sql
fi

if [[ "${WITH_MEETUP_CONCURRENCY_TESTS:-1}" == "1" && -f meetup_concurrency_test.sh ]]; then
  echo "running meetup concurrency tests (#41 — 양측 동시 yes 1회 전이 · 같은 키 동시 재시도 1행)"
  DB_NAME="$DB_NAME" PSQL="$PSQL -X" bash meetup_concurrency_test.sh
fi

if [[ "${WITH_FUNNEL_TESTS:-1}" == "1" && -f funnel_tests.sql ]]; then
  echo "running funnel tests (#24 — 사용자/매치 쌍 퍼널 뷰 · legacy 분리 · 미응답 미집계)"
  $PSQL -d "$DB_NAME" -f funnel_tests.sql
fi

if [[ "${WITH_SERVER_ERRORS_TESTS:-1}" == "1" && -f server_errors_tests.sql ]]; then
  echo "running server errors tests (#20 — 서버 전용 기록 · fingerprint · prune)"
  $PSQL -d "$DB_NAME" -f server_errors_tests.sql
fi

if [[ "${WITH_MODERATION_TESTS:-1}" == "1" && -f moderation_tests.sql ]]; then
  echo "running moderation tests (#15/#16 — rate limit · 반복 스팸 · 위험 신호(오탐 없음) · 신고 긴급 · 관리자 조치 감사)"
  $PSQL -d "$DB_NAME" -f moderation_tests.sql
fi

if [[ "${WITH_ACCOUNT_DELETION_TESTS:-1}" == "1" && -f account_deletion_tests.sql ]]; then
  echo "running account deletion tests (#13/#11/#14 — 유예 · 익명화 · 상대 이력 보존 · 서버 전용)"
  $PSQL -d "$DB_NAME" -f account_deletion_tests.sql
fi

if [[ "${WITH_ACCOUNT_PURGE_JOBS_TESTS:-1}" == "1" && -f account_purge_jobs_tests.sql ]]; then
  echo "running account purge jobs tests (#13 — 단계 상태 · lease · 스냅샷 · 재시도 대상 · skip 감사 · hard delete 뒤 기록 유지 · 서버 전용)"
  $PSQL -d "$DB_NAME" -f account_purge_jobs_tests.sql
  echo "running account purge concurrency tests (#13 — 동시 claim 1개만 · busy)"
  DB_NAME="$DB_NAME" PSQL="$PSQL -X" bash account_purge_concurrency_test.sh
fi

if [[ "${WITH_FACE_SESSION_ASSETS_TESTS:-1}" == "1" && -f face_session_assets_tests.sql ]]; then
  echo "running face session assets tests (#11 — 세션별 경로 · superseded · 정리 큐 등록/claim 안전 조건/백오프 · cascade · 서버 전용)"
  $PSQL -d "$DB_NAME" -f face_session_assets_tests.sql
fi

if [[ "${WITH_FACE_CONSENTS_TESTS:-1}" == "1" && -f face_consents_tests.sql ]]; then
  echo "running face consents tests (#12 — 클라이언트 쓰기/위조 차단 · 서버 시각 · 멱등 · 본인 조회 · 익명화/hard delete 삭제)"
  $PSQL -d "$DB_NAME" -f face_consents_tests.sql
fi

if [[ "${WITH_ADMIN_LOGIN_GUARD_TESTS:-1}" == "1" && -f admin_login_guard_tests.sql ]]; then
  echo "running admin login guard tests (#27 — DB 공유 잠금 · 5회/15분 · 만료·초기화 · 클라이언트 접근 불가)"
  $PSQL -d "$DB_NAME" -f admin_login_guard_tests.sql
  echo "running admin login guard concurrency tests (#27 — 동시 실패 합산 · 잠금 일관)"
  DB_NAME="$DB_NAME" PSQL="$PSQL -X" bash admin_login_guard_concurrency_test.sh
fi

if [[ "${WITH_PUSH_TESTS:-1}" == "1" && -f push_tests.sql ]]; then
  echo "running push tests (#17 — 토큰/설정 RLS · outbox 트리거 · dequeue/mark 서버 전용)"
  $PSQL -d "$DB_NAME" -f push_tests.sql
fi

if [[ "${WITH_RECOMMENDATION_RUNS_TESTS:-1}" == "1" && -f recommendation_runs_tests.sql ]]; then
  echo "running recommendation runs tests (#22 — claim/busy/skip · lease 만료 재획득 · 서버 전용)"
  $PSQL -d "$DB_NAME" -f recommendation_runs_tests.sql
  DB_NAME="$DB_NAME" PSQL="$PSQL -X" bash recommendation_claim_concurrency_test.sh
fi

if [[ "${WITH_RECOMMENDATION_OBSERVABILITY_TESTS:-1}" == "1" && -f recommendation_observability_tests.sql ]]; then
  echo "running recommendation observability tests (#23 — 전략 이벤트 저장 행 기준 1회 · 적격 후보 수/상한/실패 단계 기록 · 운영 풀 통계 demo 제외·미측정·중앙값 · 클라이언트 호출 불가)"
  $PSQL -d "$DB_NAME" -f recommendation_observability_tests.sql
fi

if [[ "${WITH_SECURITY_TESTS:-1}" == "1" && -f security_tests.sql ]]; then
  echo "running security tests (#27 — RLS 전수 · SECURITY DEFINER allowlist · 뷰 비공개 · anon 0행 · 추천 변경 범위 · 신고 상한 · 서버 전용 RPC)"
  $PSQL -d "$DB_NAME" -f security_tests.sql
fi

if [[ "${WITH_PROFILE_EDIT_TESTS:-1}" == "1" && -f profile_edit_tests.sql ]]; then
  echo "running profile edit tests (#25 — 성별/출생연도 잠금 · preferences_save 원자성 · 변경 이벤트 컬럼명만)"
  $PSQL -d "$DB_NAME" -f profile_edit_tests.sql
fi

if [[ "${WITH_BETA_TESTS:-1}" == "1" && -f beta_tests.sql ]]; then
  echo "running beta tests (#26 — 게이트 · 초대코드 · 대기 목록 · 운영자 입장 · 정원 · 공개 전환)"
  $PSQL -d "$DB_NAME" -f beta_tests.sql
fi

if [[ "${WITH_CONVERSATION_TESTS:-1}" == "1" && -f conversation_tests.sql ]]; then
  echo "running conversation tests (#24 — 고정 시각 대화 지표(1시간/24시간 경계·연속 발신·중단/재개·종료 단계) · 3개 제한 · 나가기 · 재매칭 차단 · 종료 후 전송 차단 · 이유 비공개 · 퍼널 뷰)"
  $PSQL -d "$DB_NAME" -f conversation_tests.sql
  echo "running conversation concurrency tests (#24 — 빈자리 1개 동시 수락 · 양쪽 동시 나가기 · 나가기/전송 경쟁)"
  DB_NAME="$DB_NAME" PSQL="$PSQL -X" bash conversation_concurrency_test.sh
  echo "running conversation metrics raw check (#24 — 뷰 vs 원본 테이블 절차적 재계산 대조, 고정 기준 시각)"
  $PSQL -d "$DB_NAME" -v as_of="'2026-09-03 09:00:00+09'" -f conversation_metrics_raw_check.sql
  $PSQL -d "$DB_NAME" -v as_of="now()" -f conversation_metrics_raw_check.sql
fi

if [[ "${WITH_RECOMMENDATION_DB_TEST:-1}" == "1" && -f recommendation_db_test.mjs ]]; then
  if command -v node >/dev/null 2>&1; then
    echo "running recommendation db test (#40 — DB → snapshot → engine → card, 외모 데이터 없이)"
    PGDATABASE="$DB_NAME" node --experimental-strip-types recommendation_db_test.mjs
  else
    echo "SKIP recommendation db test: node not found"
  fi
fi

echo "OK: schema check passed on $DB_NAME"
