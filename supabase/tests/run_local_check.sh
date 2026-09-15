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

if [[ "${WITH_PUSH_TESTS:-1}" == "1" && -f push_tests.sql ]]; then
  echo "running push tests (#17 — 토큰/설정 RLS · outbox 트리거 · dequeue/mark 서버 전용)"
  $PSQL -d "$DB_NAME" -f push_tests.sql
fi

if [[ "${WITH_RECOMMENDATION_RUNS_TESTS:-1}" == "1" && -f recommendation_runs_tests.sql ]]; then
  echo "running recommendation runs tests (#22 — claim/busy/skip · lease 만료 재획득 · 서버 전용)"
  $PSQL -d "$DB_NAME" -f recommendation_runs_tests.sql
  DB_NAME="$DB_NAME" PSQL="$PSQL -X" bash recommendation_claim_concurrency_test.sh
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

if [[ "${WITH_RECOMMENDATION_DB_TEST:-1}" == "1" && -f recommendation_db_test.mjs ]]; then
  if command -v node >/dev/null 2>&1; then
    echo "running recommendation db test (#40 — DB → snapshot → engine → card, 외모 데이터 없이)"
    PGDATABASE="$DB_NAME" node --experimental-strip-types recommendation_db_test.mjs
  else
    echo "SKIP recommendation db test: node not found"
  fi
fi

echo "OK: schema check passed on $DB_NAME"
