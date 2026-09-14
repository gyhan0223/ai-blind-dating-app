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

if [[ "${WITH_RECOMMENDATION_DB_TEST:-1}" == "1" && -f recommendation_db_test.mjs ]]; then
  if command -v node >/dev/null 2>&1; then
    echo "running recommendation db test (#40 — DB → snapshot → engine → card, 외모 데이터 없이)"
    PGDATABASE="$DB_NAME" node --experimental-strip-types recommendation_db_test.mjs
  else
    echo "SKIP recommendation db test: node not found"
  fi
fi

echo "OK: schema check passed on $DB_NAME"
