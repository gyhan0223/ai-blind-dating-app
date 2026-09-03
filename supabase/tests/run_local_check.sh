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

echo "OK: schema check passed on $DB_NAME"
