#!/usr/bin/env bash
# account_purge_concurrency_test.sh — 두 worker 가 같은 사용자의 삭제 작업을 동시에 획득하려 할 때 (#13)
#   (1) 정확히 하나만 lease 를 얻고 다른 하나는 busy 다   (2) 작업 행은 1개, attempt_count 는 1 이다.
#   또 lease 소유자가 커밋하지 않은 동안 두 번째 claim 이 advisory lock 을 기다렸다가 busy 로 끝난다.
# 사용: DB_NAME=blind_dating_check bash account_purge_concurrency_test.sh   (run_local_check.sh 가 호출)
set -euo pipefail

DB_NAME="${DB_NAME:-blind_dating_check}"
PSQL="${PSQL:-psql -v ON_ERROR_STOP=1 -q -X}"
UA='ac13c000-0000-4000-8000-000000000001'

$PSQL -d "$DB_NAME" <<SQL
insert into auth.users (id, email) values ('${UA}', 'purge-concurrency@test.dev') on conflict do nothing;
update public.users set status = 'deleted' where id = '${UA}';
delete from public.account_purge_jobs where user_id = '${UA}';
SQL

# 세션 1: claim 후 2초간 트랜잭션을 열어 둔다 (worker 1)
$PSQL -d "$DB_NAME" -At <<SQL > /tmp/purge_concurrency_s1.out 2>&1 &
begin;
select public.account_purge_job_claim('${UA}', 'anonymize', 'worker-1', 300)->>'ok';
select pg_sleep(2);
commit;
SQL
S1=$!
sleep 0.5
# 세션 2: 같은 사용자 claim (worker 2) — lock 을 기다린 뒤 busy 여야 한다
S2_OUT="$($PSQL -d "$DB_NAME" -At -c "select public.account_purge_job_claim('${UA}', 'anonymize', 'worker-2', 300)->>'reason'")"
wait "$S1"
S1_OUT="$(cat /tmp/purge_concurrency_s1.out)"

if ! grep -qE '^(t|true)$' <<<"$S1_OUT"; then echo "FAIL purge concurrency: worker 1 claim failed: $S1_OUT" >&2; exit 1; fi
if [[ "$S2_OUT" != "busy" ]]; then echo "FAIL purge concurrency: worker 2 should be busy, got: $S2_OUT" >&2; exit 1; fi

STATE="$($PSQL -d "$DB_NAME" -At -c "select count(*) || '/' || max(attempt_count) from public.account_purge_jobs where user_id = '${UA}'")"
if [[ "$STATE" != "1/1" ]]; then echo "FAIL purge concurrency: job rows/attempts $STATE (expected 1/1)" >&2; exit 1; fi

# 10개의 동시 claim (lease 없는 상태에서) → 정확히 1개만 ok
$PSQL -d "$DB_NAME" -c "update public.account_purge_jobs set status = 'failed', lease_owner = null, lease_until = null where user_id = '${UA}'"
for i in $(seq 1 10); do
  $PSQL -d "$DB_NAME" -At -c "select public.account_purge_job_claim('${UA}', 'anonymize', 'w${i}', 300)->>'ok'" > "/tmp/purge_concurrency_w${i}.out" 2>&1 &
done
wait
OKS=$(cat /tmp/purge_concurrency_w*.out | grep -cE '^(t|true)$' || true)
if [[ "$OKS" != "1" ]]; then echo "FAIL purge concurrency: $OKS claims succeeded (expected 1)" >&2; cat /tmp/purge_concurrency_w*.out; exit 1; fi
ATT="$($PSQL -d "$DB_NAME" -At -c "select attempt_count from public.account_purge_jobs where user_id = '${UA}'")"
if [[ "$ATT" != "2" ]]; then echo "FAIL purge concurrency: attempt_count $ATT (expected 2)" >&2; exit 1; fi

$PSQL -d "$DB_NAME" -c "delete from public.account_purge_jobs where user_id = '${UA}'"
rm -f /tmp/purge_concurrency_s1.out /tmp/purge_concurrency_w*.out
echo "ACCOUNT PURGE CONCURRENCY TESTS PASSED"
