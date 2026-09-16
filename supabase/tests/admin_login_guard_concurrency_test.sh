#!/usr/bin/env bash
# admin_login_guard_concurrency_test.sh — 여러 인스턴스가 같은 키로 동시에 실패를 기록해도 (#27)
#   (1) 실패 횟수가 정확히 합산되어 5번째에서 잠기고  (2) 잠금 응답이 그 뒤 요청에 일관되게 나온다.
# 사용: DB_NAME=blind_dating_check bash admin_login_guard_concurrency_test.sh   (run_local_check.sh 가 호출)
set -euo pipefail

DB_NAME="${DB_NAME:-blind_dating_check}"
PSQL="${PSQL:-psql -v ON_ERROR_STOP=1 -q -X}"
KEY='ip:concurrency-test-0123456789abcdef'

$PSQL -d "$DB_NAME" -c "delete from public.admin_login_locks where key = '${KEY}'"

# 12개 "인스턴스" 가 동시에 실패 기록
for i in $(seq 1 12); do
  $PSQL -d "$DB_NAME" -At -c "select public.admin_login_guard('${KEY}', 'failure', 5, 900)->>'locked'" > "/tmp/login_guard_w${i}.out" 2>&1 &
done
wait
LOCKED=$(cat /tmp/login_guard_w*.out | grep -c '^true$' || true)
NOT_LOCKED=$(cat /tmp/login_guard_w*.out | grep -c '^false$' || true)
if [[ "$NOT_LOCKED" != "4" || "$LOCKED" != "8" ]]; then
  echo "FAIL login guard concurrency: not_locked=$NOT_LOCKED locked=$LOCKED (expected 4 / 8)" >&2
  cat /tmp/login_guard_w*.out; exit 1
fi
STATE="$($PSQL -d "$DB_NAME" -At -c "select failures || '/' || (locked_until > now())::text from public.admin_login_locks where key = '${KEY}'")"
if [[ "$STATE" != "0/true" ]]; then echo "FAIL login guard concurrency: state $STATE (expected 0/true)" >&2; exit 1; fi

# 잠금 중 다른 인스턴스의 check 도 잠금
CHK="$($PSQL -d "$DB_NAME" -At -c "select public.admin_login_guard('${KEY}', 'check', 5, 900)->>'locked'")"
if [[ "$CHK" != "true" ]]; then echo "FAIL login guard concurrency: check during lock $CHK" >&2; exit 1; fi

$PSQL -d "$DB_NAME" -c "delete from public.admin_login_locks where key = '${KEY}'"
rm -f /tmp/login_guard_w*.out
echo "ADMIN LOGIN GUARD CONCURRENCY TESTS PASSED"
