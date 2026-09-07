#!/usr/bin/env bash
# face_liveness_concurrency_test.sh — 승인 RPC(face_liveness_approve) 동시 호출 검증.
#   웹훅과 앱 sync 가 같은 세션을 동시에 승인해도 (1) 둘 다 성공하거나 멱등으로 끝나고
#   (2) 최종 상태는 approved + users.face_verified=true 하나로 수렴해야 한다.
#   또 승인 트랜잭션이 진행 중일 때 다른 세션의 거절(admin reject)이 끼어들어도 approved 를 되돌리지 못한다.
#
# 사용: DB_NAME=blind_dating_check bash face_liveness_concurrency_test.sh   (run_local_check.sh 가 호출)
# 실제 얼굴/실사용자 데이터 없음 (uuid fixture 만).
set -euo pipefail

DB_NAME="${DB_NAME:-blind_dating_check}"
PSQL="${PSQL:-psql -v ON_ERROR_STOP=1 -q -X}"
UA='77777777-7777-7777-7777-777777777777'
SID='didit-sess-concurrency'
REF="${UA}/liveness/reference.jpg"

$PSQL -d "$DB_NAME" <<SQL
insert into auth.users (id, email) values ('${UA}', 'face-concurrency@test.dev') on conflict do nothing;
update public.users set face_verified = false where id = '${UA}';
delete from public.face_verifications where user_id = '${UA}';
insert into public.face_verifications (user_id, status, provider, provider_session_id, expires_at)
values ('${UA}', 'pending', 'didit', '${SID}', now() + interval '30 minutes');
SQL

ROW_ID="$($PSQL -d "$DB_NAME" -At -c "select id from public.face_verifications where provider_session_id = '${SID}'")"

# 세션 1: 승인 트랜잭션을 열고 2초간 잠근 채로 유지한 뒤 커밋 (웹훅 역할)
$PSQL -d "$DB_NAME" -At <<SQL > /tmp/face_concurrency_s1.out 2>&1 &
begin;
select public.face_liveness_approve('${ROW_ID}', '${UA}', '${SID}', '${REF}', true, 95, 'active', 'Approved', now(), 'liveness_approved')->>'ok';
select pg_sleep(2);
commit;
SQL
S1=$!
sleep 0.5

# 세션 2: 같은 행을 동시에 승인 (앱 sync 역할) — 세션 1 의 행 잠금이 풀릴 때까지 기다렸다가 멱등으로 끝나야 한다
S2_OUT="$($PSQL -d "$DB_NAME" -At -c "select public.face_liveness_approve('${ROW_ID}', '${UA}', '${SID}', '${REF}', true, 95, 'active', 'Approved', now(), 'liveness_approved')")"
wait "$S1"
S1_OUT="$(cat /tmp/face_concurrency_s1.out)"

if ! grep -qE '^(t|true)$' <<<"$S1_OUT"; then
  echo "FAIL concurrency: session 1 approve did not succeed: $S1_OUT" >&2; exit 1
fi
if ! grep -q '"ok": *true' <<<"$S2_OUT"; then
  echo "FAIL concurrency: session 2 approve did not succeed: $S2_OUT" >&2; exit 1
fi
if ! grep -q '"changed": *false' <<<"$S2_OUT"; then
  echo "FAIL concurrency: session 2 should be idempotent no-op after session 1: $S2_OUT" >&2; exit 1
fi

FINAL="$($PSQL -d "$DB_NAME" -At -c "select fv.status || '/' || u.face_verified::text || '/' || (fv.verified_at is not null)::text || '/' || (select count(*) from public.face_verification_reviews where face_verification_id = fv.id) from public.face_verifications fv join public.users u on u.id = fv.user_id where fv.id = '${ROW_ID}'")"
if [[ "$FINAL" != "approved/true/true/0" ]]; then
  echo "FAIL concurrency: final state $FINAL (expected approved/true/true/0)" >&2; exit 1
fi

# 승인 진행 중 거절이 끼어드는 경우: 거절은 행 잠금을 기다린 뒤 approved 행이라 invalid_state 로 끝나야 한다
$PSQL -d "$DB_NAME" <<SQL
delete from public.face_verification_reviews where user_id = '${UA}';
delete from public.face_verifications where user_id = '${UA}';
update public.users set face_verified = false where id = '${UA}';
insert into public.face_verifications (user_id, status, provider, provider_session_id, liveness_passed, provider_reason)
values ('${UA}', 'in_review', 'didit', '${SID}', true, 'face_search_match');
SQL
ROW_ID="$($PSQL -d "$DB_NAME" -At -c "select id from public.face_verifications where provider_session_id = '${SID}'")"

$PSQL -d "$DB_NAME" -At <<SQL > /tmp/face_concurrency_s1.out 2>&1 &
begin;
select public.face_liveness_approve('${ROW_ID}', '${UA}', '${SID}', '${REF}', true)->>'ok';
select pg_sleep(2);
commit;
SQL
S1=$!
sleep 0.5
REJECT_OUT="$($PSQL -d "$DB_NAME" -At -c "select public.face_liveness_admin_review('${ROW_ID}', 'reject', 'ops', null)")"
wait "$S1"

if ! grep -q '"invalid_state"' <<<"$REJECT_OUT"; then
  echo "FAIL concurrency: reject during approval should be refused: $REJECT_OUT" >&2; exit 1
fi
FINAL="$($PSQL -d "$DB_NAME" -At -c "select fv.status || '/' || u.face_verified::text from public.face_verifications fv join public.users u on u.id = fv.user_id where fv.id = '${ROW_ID}'")"
if [[ "$FINAL" != "approved/true" ]]; then
  echo "FAIL concurrency: final state after approve+reject race $FINAL (expected approved/true)" >&2; exit 1
fi

# 정리
$PSQL -d "$DB_NAME" <<SQL
delete from public.face_verification_reviews where user_id = '${UA}';
delete from public.face_verifications where user_id = '${UA}';
SQL
rm -f /tmp/face_concurrency_s1.out
echo "FACE LIVENESS CONCURRENCY TESTS PASSED"
