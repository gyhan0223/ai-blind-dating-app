#!/usr/bin/env bash
# recommendation_claim_concurrency_test.sh — 같은 사용자·같은 날의 claim 이 두 세션에서 동시에 들어와도
# 정확히 하나만 claimed 를 받고 다른 하나는 busy 를 받는지 검증한다 (#22).
set -euo pipefail

DB_NAME="${DB_NAME:-blind_dating_check}"
PSQL="${PSQL:-psql -v ON_ERROR_STOP=1 -q -X}"
UA='e2200000-0000-4000-8000-000000000011'
OUT_DIR="${TMPDIR:-/tmp}"

$PSQL -d "$DB_NAME" <<SQL
insert into auth.users (id, email) values ('${UA}', 'runs-cc@test.dev') on conflict do nothing;
delete from public.recommendation_runs where user_id = '${UA}';
SQL

# 세션 1: 트랜잭션 안에서 claim 하고 2초 유지 (커밋 전)
$PSQL -d "$DB_NAME" -At <<SQL > "$OUT_DIR/rec_claim_s1.out" 2>&1 &
begin;
select public.recommendation_run_claim('${UA}', (now() at time zone 'Asia/Seoul')::date)->>'claim';
select pg_sleep(2);
commit;
SQL
S1=$!
sleep 0.5
# 세션 2: 같은 순간 claim — 세션 1 커밋을 기다렸다가 busy 를 받아야 한다
S2_OUT="$($PSQL -d "$DB_NAME" -At -c "select public.recommendation_run_claim('${UA}', (now() at time zone 'Asia/Seoul')::date)->>'claim'")"
wait "$S1"
S1_OUT="$(cat "$OUT_DIR/rec_claim_s1.out")"

if ! grep -q '^claimed$' <<<"$S1_OUT"; then
  echo "FAIL claim concurrency: session 1 should be claimed: $S1_OUT" >&2; exit 1
fi
if [[ "$S2_OUT" != "busy" ]]; then
  echo "FAIL claim concurrency: session 2 should be busy, got $S2_OUT" >&2; exit 1
fi
CNT="$($PSQL -d "$DB_NAME" -At -c "select count(*) from public.recommendation_runs where user_id = '${UA}'")"
if [[ "$CNT" != "1" ]]; then
  echo "FAIL claim concurrency: expected 1 run row, got $CNT" >&2; exit 1
fi
rm -f "$OUT_DIR/rec_claim_s1.out"
echo "RECOMMENDATION CLAIM CONCURRENCY TESTS PASSED"
