#!/usr/bin/env bash
# identity_concurrency_test.sh (#6) — 실제 DB 두 연결로 verifyIdentityCore 가 쓰는 조건부 쓰기의 경쟁 결과를 검증한다.
#   (1) 같은 identity 해시로 두 계정이 동시에 insert → 한쪽만 성공, 다른 쪽은 UNIQUE 위반 (코어는 conflict → 재조회 → existing_account)
#   (2) 삭제된 계정의 identity(user_id null)를 두 계정이 동시에 relink → 한쪽만 1행, 다른 쪽은 0행 (코어는 0행 → 재조회 → existing_account)
#   (3) 같은 세션의 동시 claim(pending→checking) → 한쪽만 1행
#   각 경우 끝에 "같은 identity 에 연결된 계정" 이 정확히 하나인지 확인한다.
# 사용: DB_NAME=blind_dating_check bash identity_concurrency_test.sh   (run_local_check.sh 가 호출)
set -euo pipefail

DB_NAME="${DB_NAME:-blind_dating_check}"
PSQL="${PSQL:-psql -v ON_ERROR_STOP=1 -q -X}"
UA='c0ffee11-0000-4000-8000-000000000001'
UB='c0ffee11-0000-4000-8000-000000000002'
H='concurrency-test-identity-hash'
OUT="${TMPDIR:-/tmp}/identity_concurrency_s1.out"

cleanup() {
  $PSQL -d "$DB_NAME" <<SQL
delete from public.user_identities where identity_key_hash = '${H}';
delete from auth.users where id in ('${UA}', '${UB}');
SQL
}
cleanup
$PSQL -d "$DB_NAME" -c "insert into auth.users (id, phone, phone_confirmed_at) values ('${UA}', '821000009201', now()), ('${UB}', '821000009202', now())"

# ── (1) 동시 insert ───────────────────────────────────────────────────────
$PSQL -d "$DB_NAME" -At <<SQL > "$OUT" 2>&1 &
begin;
insert into public.user_identities (user_id, identity_key_hash, identity_verified_at, adult_verified_at) values ('${UA}', '${H}', now(), now());
select pg_sleep(2);
commit;
select 'S1_DONE';
SQL
S1=$!
sleep 0.5
set +e
S2_OUT="$($PSQL -d "$DB_NAME" -At -c "insert into public.user_identities (user_id, identity_key_hash, identity_verified_at, adult_verified_at) values ('${UB}', '${H}', now(), now())" 2>&1)"
S2_CODE=$?
set -e
wait "$S1"
if ! grep -q 'S1_DONE' "$OUT"; then echo "FAIL identity concurrency (insert): session 1 failed: $(cat "$OUT")" >&2; exit 1; fi
if [[ $S2_CODE -eq 0 ]] || ! grep -q 'duplicate key' <<<"$S2_OUT"; then
  echo "FAIL identity concurrency (insert): second insert should hit UNIQUE after waiting: code=$S2_CODE $S2_OUT" >&2; exit 1
fi
LINKED="$($PSQL -d "$DB_NAME" -At -c "select count(*) || '/' || coalesce(min(user_id::text), 'none') from public.user_identities where identity_key_hash = '${H}'")"
if [[ "$LINKED" != "1/${UA}" ]]; then echo "FAIL identity concurrency (insert): final $LINKED" >&2; exit 1; fi

# ── (2) 동시 relink (user_id null 행) ─────────────────────────────────────
$PSQL -d "$DB_NAME" -c "update public.user_identities set user_id = null where identity_key_hash = '${H}'"
IDN="$($PSQL -d "$DB_NAME" -At -c "select id from public.user_identities where identity_key_hash = '${H}'")"
$PSQL -d "$DB_NAME" -At <<SQL > "$OUT" 2>&1 &
begin;
with r as (update public.user_identities set user_id = '${UA}', identity_verified_at = now() where id = '${IDN}' and user_id is null returning id) select 'S1_ROWS=' || count(*) from r;
select pg_sleep(2);
commit;
SQL
S1=$!
sleep 0.5
S2_ROWS="$($PSQL -d "$DB_NAME" -At -c "with r as (update public.user_identities set user_id = '${UB}', identity_verified_at = now() where id = '${IDN}' and user_id is null returning id) select count(*) from r")"
wait "$S1"
if ! grep -q 'S1_ROWS=1' "$OUT"; then echo "FAIL identity concurrency (relink): session 1: $(cat "$OUT")" >&2; exit 1; fi
if [[ "$S2_ROWS" != "0" ]]; then echo "FAIL identity concurrency (relink): loser should update 0 rows, got $S2_ROWS" >&2; exit 1; fi
LINKED="$($PSQL -d "$DB_NAME" -At -c "select count(*) || '/' || coalesce(min(user_id::text), 'none') from public.user_identities where identity_key_hash = '${H}'")"
if [[ "$LINKED" != "1/${UA}" ]]; then echo "FAIL identity concurrency (relink): final $LINKED" >&2; exit 1; fi

# ── (3) 같은 세션 동시 claim ──────────────────────────────────────────────
SID="$($PSQL -d "$DB_NAME" -At -c "insert into public.identity_verification_sessions (user_id, provider, provider_session_id, expires_at) values ('${UB}', 'test', 'prov-c', now() + interval '10 minutes') returning id")"
CLAIM="update public.identity_verification_sessions set status = 'checking', checking_since = now() where id = '${SID}' and user_id = '${UB}' and expires_at > now() and (status = 'pending' or (status = 'checking' and checking_since < now() - interval '120 seconds')) returning id"
$PSQL -d "$DB_NAME" -At <<SQL > "$OUT" 2>&1 &
begin;
with r as (${CLAIM}) select 'S1_ROWS=' || count(*) from r;
select pg_sleep(2);
commit;
SQL
S1=$!
sleep 0.5
S2_ROWS="$($PSQL -d "$DB_NAME" -At -c "with r as (${CLAIM}) select count(*) from r")"
wait "$S1"
if ! grep -q 'S1_ROWS=1' "$OUT"; then echo "FAIL identity concurrency (claim): session 1: $(cat "$OUT")" >&2; exit 1; fi
if [[ "$S2_ROWS" != "0" ]]; then echo "FAIL identity concurrency (claim): second claim should update 0 rows, got $S2_ROWS" >&2; exit 1; fi

cleanup
rm -f "$OUT"
echo "IDENTITY CONCURRENCY TESTS PASSED"
