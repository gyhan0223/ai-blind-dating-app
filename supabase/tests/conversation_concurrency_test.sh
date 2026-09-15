#!/usr/bin/env bash
# conversation_concurrency_test.sh — #24 동시성 검증 (두 psql 세션).
#   1) 빈자리 1개인 Z 에게 두 남성이 동시에 수락 → 매치는 정확히 1개, 다른 쪽은 no_slot_partner (거절 아님), Z 는 3개 초과 없음
#   2) 양쪽이 동시에 나가기 → 종료 1회 처리(이벤트 1건), closed_by 는 한 명
#   3) 나가기와 메시지 전송 경쟁 → 종료 커밋 뒤의 전송은 저장되지 않는다
#
# 사용: DB_NAME=blind_dating_check bash conversation_concurrency_test.sh   (run_local_check.sh 가 호출)
set -euo pipefail

DB_NAME="${DB_NAME:-blind_dating_check}"
PSQL="${PSQL:-psql -v ON_ERROR_STOP=1 -q -X}"
OUT_DIR="${TMPDIR:-/tmp}"
Z='cc240000-0000-4000-8000-000000000001'    # 여 — 빈자리 1개
M1='cc240000-0000-4000-8000-000000000011'   # 남
M2='cc240000-0000-4000-8000-000000000012'   # 남
F1='cc240000-0000-4000-8000-000000000021'   # 여 (Z 자리 채우기용 상대)
F2='cc240000-0000-4000-8000-000000000022'
L1='cc240000-0000-4000-8000-000000000031'   # 나가기 경쟁 쌍
L2='cc240000-0000-4000-8000-000000000032'

$PSQL -d "$DB_NAME" <<SQL
insert into auth.users (id, email) values
  ('${Z}', 'cc-z@test.dev'), ('${M1}', 'cc-m1@test.dev'), ('${M2}', 'cc-m2@test.dev'),
  ('${F1}', 'cc-f1@test.dev'), ('${F2}', 'cc-f2@test.dev'), ('${L1}', 'cc-l1@test.dev'), ('${L2}', 'cc-l2@test.dev')
on conflict do nothing;
insert into public.profiles (user_id, nickname, birth_year, gender, seeking_gender, region_code, height_cm, job_group, smoking, drinking) values
  ('${Z}', '동시Z', 1996, 'female', 'male', 'seoul', 162, 'office', 'none', 'none'),
  ('${M1}', '동시M1', 1994, 'male', 'female', 'seoul', 176, 'it', 'none', 'none'),
  ('${M2}', '동시M2', 1993, 'male', 'female', 'seoul', 178, 'it', 'none', 'none'),
  ('${F1}', '동시F1', 1995, 'male', 'female', 'seoul', 170, 'it', 'none', 'none'),
  ('${F2}', '동시F2', 1995, 'male', 'female', 'seoul', 170, 'it', 'none', 'none'),
  ('${L1}', '동시L1', 1995, 'male', 'female', 'seoul', 170, 'it', 'none', 'none'),
  ('${L2}', '동시L2', 1995, 'female', 'male', 'seoul', 160, 'it', 'none', 'none')
on conflict do nothing;
update public.users set onboarding_completed = true, identity_verified = true, face_verified = true, age_verified = true
where id in ('${Z}', '${M1}', '${M2}', '${F1}', '${F2}', '${L1}', '${L2}');
-- Z 자리 2개 사용 (F1, F2)
insert into public.matches (user_a, user_b) values (least('${Z}'::uuid, '${F1}'::uuid), greatest('${Z}'::uuid, '${F1}'::uuid)), (least('${Z}'::uuid, '${F2}'::uuid), greatest('${Z}'::uuid, '${F2}'::uuid)) on conflict do nothing;
insert into public.conversations (match_id) select id from public.matches where '${Z}'::uuid in (user_a, user_b) on conflict do nothing;
-- Z 가 M1, M2 를 먼저 좋아함 (상호 대기), M1/M2 에게 오늘 Z 추천
insert into public.recommendations (user_id, candidate_id, for_date, card) values
  ('${Z}', '${M1}', current_date - 1, '{}'), ('${Z}', '${M2}', current_date - 1, '{}'),
  ('${M1}', '${Z}', current_date, '{}'), ('${M2}', '${Z}', current_date, '{}');
insert into public.likes (from_user_id, to_user_id) values ('${Z}', '${M1}'), ('${Z}', '${M2}') on conflict do nothing;
-- 나가기 경쟁 쌍
insert into public.matches (user_a, user_b) values (least('${L1}'::uuid, '${L2}'::uuid), greatest('${L1}'::uuid, '${L2}'::uuid)) on conflict do nothing;
insert into public.conversations (match_id) select id from public.matches where user_a = least('${L1}'::uuid, '${L2}'::uuid) and user_b = greatest('${L1}'::uuid, '${L2}'::uuid) on conflict do nothing;
SQL

R1="$($PSQL -d "$DB_NAME" -At -c "select id from public.recommendations where user_id = '${M1}' and candidate_id = '${Z}'")"
R2="$($PSQL -d "$DB_NAME" -At -c "select id from public.recommendations where user_id = '${M2}' and candidate_id = '${Z}'")"

# --- 1) 빈자리 1개에 동시 수락 -----------------------------------------------
$PSQL -d "$DB_NAME" -At <<SQL > "$OUT_DIR/conv_cc_a.out" 2>&1 &
select set_config('request.jwt.claim.sub', '${M1}', false);
set role authenticated;
begin;
select public.recommendation_accept('${R1}')->>'result';
select pg_sleep(2);
commit;
SQL
SA=$!
sleep 0.5
B_OUT="$($PSQL -d "$DB_NAME" -At <<SQL
select set_config('request.jwt.claim.sub', '${M2}', false);
set role authenticated;
select public.recommendation_accept('${R2}')->>'result';
SQL
)"
wait "$SA"
A_OUT="$(cat "$OUT_DIR/conv_cc_a.out")"
if ! grep -q '^matched$' <<<"$A_OUT"; then
  echo "FAIL concurrency: first accept should match: $A_OUT" >&2; exit 1
fi
if ! grep -q '^no_slot_partner$' <<<"$B_OUT"; then
  echo "FAIL concurrency: second accept should see no_slot_partner: $B_OUT" >&2; exit 1
fi
RES="$($PSQL -d "$DB_NAME" -At -c "select public.conversation_active_count('${Z}') || '/' || (select count(*) from public.matches where '${Z}'::uuid in (user_a, user_b)) || '/' || (select status from public.recommendations where id = '${R2}') || '/' || (select count(*) from public.likes where from_user_id = '${M2}' and to_user_id = '${Z}')")"
if [[ "$RES" != "3/3/pending/0" ]]; then
  echo "FAIL concurrency: expected Z active 3 / matches 3 / M2 rec pending / no M2 like, got $RES" >&2; exit 1
fi

# --- 2) 양쪽 동시 나가기 -------------------------------------------------------
LM="$($PSQL -d "$DB_NAME" -At -c "select id from public.matches where user_a = least('${L1}'::uuid, '${L2}'::uuid) and user_b = greatest('${L1}'::uuid, '${L2}'::uuid)")"
LC="$($PSQL -d "$DB_NAME" -At -c "select id from public.conversations where match_id = '${LM}'")"
$PSQL -d "$DB_NAME" -At <<SQL > "$OUT_DIR/conv_cc_l1.out" 2>&1 &
select set_config('request.jwt.claim.sub', '${L1}', false);
set role authenticated;
begin;
select public.conversation_leave('${LM}', 'not_a_fit')->>'already_closed';
select pg_sleep(2);
commit;
SQL
SL=$!
sleep 0.5
L2_OUT="$($PSQL -d "$DB_NAME" -At <<SQL
select set_config('request.jwt.claim.sub', '${L2}', false);
set role authenticated;
select public.conversation_leave('${LM}', 'other')->>'already_closed';
SQL
)"
wait "$SL"
L1_OUT="$(cat "$OUT_DIR/conv_cc_l1.out")"
if ! grep -q '^false$' <<<"$L1_OUT" || ! grep -q '^true$' <<<"$L2_OUT"; then
  echo "FAIL concurrency: leave should close once (first=false, second=true): [$L1_OUT] [$L2_OUT]" >&2; exit 1
fi
RES="$($PSQL -d "$DB_NAME" -At -c "select m.status || '/' || (m.closed_by = '${L1}')::text || '/' || (select count(*) from public.analytics_events where event_type = 'conversation_left' and payload->>'match_id' = m.id::text) || '/' || (select count(*) from public.conversation_exits where match_id = m.id) from public.matches m where m.id = '${LM}'")"
if [[ "$RES" != "closed/true/1/2" ]]; then
  echo "FAIL concurrency: expected closed/closed_by L1/1 event/2 private exit rows, got $RES" >&2; exit 1
fi

# --- 3) 나가기 vs 전송 경쟁 (새 쌍) --------------------------------------------
$PSQL -d "$DB_NAME" <<SQL
insert into public.matches (user_a, user_b) values (least('${M2}'::uuid, '${F1}'::uuid), greatest('${M2}'::uuid, '${F1}'::uuid)) on conflict do nothing;
insert into public.conversations (match_id) select id from public.matches where user_a = least('${M2}'::uuid, '${F1}'::uuid) and user_b = greatest('${M2}'::uuid, '${F1}'::uuid) on conflict do nothing;
SQL
RM="$($PSQL -d "$DB_NAME" -At -c "select id from public.matches where user_a = least('${M2}'::uuid, '${F1}'::uuid) and user_b = greatest('${M2}'::uuid, '${F1}'::uuid)")"
RC="$($PSQL -d "$DB_NAME" -At -c "select id from public.conversations where match_id = '${RM}'")"
$PSQL -d "$DB_NAME" -At <<SQL > "$OUT_DIR/conv_cc_leave.out" 2>&1 &
select set_config('request.jwt.claim.sub', '${F1}', false);
set role authenticated;
begin;
select public.conversation_leave('${RM}', null)->>'status';
select pg_sleep(2);
commit;
SQL
SV=$!
sleep 0.5
set +e
SEND_OUT="$($PSQL -d "$DB_NAME" -At <<SQL 2>&1
select set_config('request.jwt.claim.sub', '${M2}', false);
set role authenticated;
select (public.send_message('${RC}', 'c0000000-0000-4000-8000-0000000024cc', '종료 직전 전송')).id;
SQL
)"
set -e
wait "$SV"
if ! grep -q 'conversation_closed' <<<"$SEND_OUT"; then
  echo "FAIL concurrency: send racing with leave must be rejected after close commits: $SEND_OUT" >&2; exit 1
fi
CNT="$($PSQL -d "$DB_NAME" -At -c "select count(*) from public.messages where conversation_id = '${RC}'")"
if [[ "$CNT" != "0" ]]; then
  echo "FAIL concurrency: message stored in closed conversation ($CNT)" >&2; exit 1
fi

rm -f "$OUT_DIR/conv_cc_a.out" "$OUT_DIR/conv_cc_l1.out" "$OUT_DIR/conv_cc_leave.out"
echo "CONVERSATION CONCURRENCY TESTS PASSED"
