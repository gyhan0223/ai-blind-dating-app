#!/usr/bin/env bash
# meetup_concurrency_test.sh — 양측이 만남 의향(yes)을 동시에 제출해도 상호 관심 전이·이벤트·알림이 한 번만 생기는지,
# 같은 사용자의 같은 메시지 키 동시 재시도가 한 행으로 수렴하는지 검증한다 (두 psql 세션).
#
# 사용: DB_NAME=blind_dating_check bash meetup_concurrency_test.sh   (run_local_check.sh 가 호출)
# 실제 사용자 데이터 없음 (uuid fixture 만).
set -euo pipefail

DB_NAME="${DB_NAME:-blind_dating_check}"
PSQL="${PSQL:-psql -v ON_ERROR_STOP=1 -q -X}"
UA='cccc1111-0000-4000-8000-000000000001'
UB='cccc2222-0000-4000-8000-000000000002'
OUT_DIR="${TMPDIR:-/tmp}"

$PSQL -d "$DB_NAME" <<SQL
insert into auth.users (id, email) values ('${UA}', 'mc-a@test.dev'), ('${UB}', 'mc-b@test.dev') on conflict do nothing;
insert into public.profiles (user_id, nickname, birth_year, gender, seeking_gender, region_code, height_cm, job_group, smoking, drinking)
values ('${UA}', '동시가', 1994, 'male', 'female', 'seoul', 176, 'it', 'none', 'none'),
       ('${UB}', '동시나', 1996, 'female', 'male', 'seoul', 162, 'office', 'none', 'none')
on conflict do nothing;
insert into public.matches (user_a, user_b) values (least('${UA}'::uuid,'${UB}'::uuid), greatest('${UA}'::uuid,'${UB}'::uuid)) on conflict do nothing;
insert into public.conversations (match_id)
select id from public.matches where user_a = least('${UA}'::uuid,'${UB}'::uuid) and user_b = greatest('${UA}'::uuid,'${UB}'::uuid)
on conflict do nothing;
SQL

MID="$($PSQL -d "$DB_NAME" -At -c "select id from public.matches where user_a = least('${UA}'::uuid,'${UB}'::uuid) and user_b = greatest('${UA}'::uuid,'${UB}'::uuid)")"
CID="$($PSQL -d "$DB_NAME" -At -c "select id from public.conversations where match_id = '${MID}'")"

# --- 1) 양측 동시 yes -------------------------------------------------------
# 세션 A: 트랜잭션을 열고 의향을 제출한 뒤 2초간 잡고 있다 (매치 행 잠금 유지)
$PSQL -d "$DB_NAME" -At <<SQL > "$OUT_DIR/meetup_concurrency_a.out" 2>&1 &
select set_config('request.jwt.claim.sub', '${UA}', false);
set role authenticated;
begin;
select public.meetup_set_intent('${MID}', 'yes', '{}', null)->>'meetup_state';
select pg_sleep(2);
commit;
SQL
SA=$!
sleep 0.5

# 세션 B: 같은 순간 yes — A 의 커밋을 기다렸다가 상호 전이를 정확히 한 번 만든다
B_OUT="$($PSQL -d "$DB_NAME" -At <<SQL
select set_config('request.jwt.claim.sub', '${UB}', false);
set role authenticated;
select public.meetup_set_intent('${MID}', 'yes', '{}', null)->>'meetup_state';
SQL
)"
wait "$SA"
A_OUT="$(cat "$OUT_DIR/meetup_concurrency_a.out")"

if ! grep -q 'none' <<<"$A_OUT"; then
  echo "FAIL concurrency: session A (first, alone) should see state none: $A_OUT" >&2; exit 1
fi
if ! grep -q 'mutual_interest' <<<"$B_OUT"; then
  echo "FAIL concurrency: session B should see mutual_interest: $B_OUT" >&2; exit 1
fi

RES="$($PSQL -d "$DB_NAME" -At -c "select m.meetup_state || '/' || (select count(*) from public.analytics_events where event_type = 'meetup_mutual_interest' and payload->>'match_id' = m.id::text) || '/' || (select count(*) from public.notification_events where kind = 'mutual_meetup_interest' and match_id = m.id) || '/' || (m.mutual_interest_at is not null)::text from public.matches m where m.id = '${MID}'")"
if [[ "$RES" != "mutual_interest/2/2/true" ]]; then
  echo "FAIL concurrency: expected mutual_interest/2 events(one per user)/2 outbox/true, got $RES" >&2; exit 1
fi

# --- 2) 같은 메시지 키 동시 재시도 ------------------------------------------
KEY='c0000000-0000-4000-8000-00000000c0c0'
$PSQL -d "$DB_NAME" -At <<SQL > "$OUT_DIR/meetup_concurrency_m1.out" 2>&1 &
select set_config('request.jwt.claim.sub', '${UA}', false);
set role authenticated;
begin;
select (public.send_message('${CID}', '${KEY}', '동시 전송')).id;
select pg_sleep(2);
commit;
SQL
SM=$!
sleep 0.5
M2_OUT="$($PSQL -d "$DB_NAME" -At <<SQL
select set_config('request.jwt.claim.sub', '${UA}', false);
set role authenticated;
select (public.send_message('${CID}', '${KEY}', '동시 전송')).id;
SQL
)"
wait "$SM"
M1_OUT="$(cat "$OUT_DIR/meetup_concurrency_m1.out")"
M1_ID="$(grep -E '^[0-9a-f-]{36}$' <<<"$M1_OUT" | head -1 || true)"
M2_ID="$(grep -E '^[0-9a-f-]{36}$' <<<"$M2_OUT" | head -1 || true)"
if [[ -z "$M1_ID" || "$M1_ID" != "$M2_ID" ]]; then
  echo "FAIL concurrency: concurrent retry must return the same message id: [$M1_OUT] vs [$M2_OUT]" >&2; exit 1
fi
CNT="$($PSQL -d "$DB_NAME" -At -c "select count(*) || '/' || (select total_messages from public.conversation_metrics where conversation_id = '${CID}') from public.messages where conversation_id = '${CID}' and client_message_id = '${KEY}'")"
if [[ "$CNT" != "1/1" ]]; then
  echo "FAIL concurrency: expected 1 row / 1 metric, got $CNT" >&2; exit 1
fi

rm -f "$OUT_DIR/meetup_concurrency_a.out" "$OUT_DIR/meetup_concurrency_m1.out"
echo "MEETUP CONCURRENCY TESTS PASSED"
