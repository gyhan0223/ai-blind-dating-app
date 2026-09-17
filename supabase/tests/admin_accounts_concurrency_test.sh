#!/usr/bin/env bash
# admin_accounts_concurrency_test.sh (#27) — 두 owner 가 서로를 동시에 강등해도 활성 owner 가 0명이 되지 않는다.
#   세션 1: o1 이 o2 강등 (트랜잭션 열고 잠금 유지)  · 세션 2: o2 가 o1 강등 → 세션 1 커밋 뒤 last_owner 로 거부돼야 한다.
# 사용: DB_NAME=blind_dating_check bash admin_accounts_concurrency_test.sh   (run_local_check.sh 가 호출)
set -euo pipefail

DB_NAME="${DB_NAME:-blind_dating_check}"
PSQL="${PSQL:-psql -v ON_ERROR_STOP=1 -q -X}"
O1='ad000000-0000-4000-8000-0000000000c1'
O2='ad000000-0000-4000-8000-0000000000c2'
OUT="${TMPDIR:-/tmp}/admin_accounts_concurrency_s1.out"

$PSQL -d "$DB_NAME" <<SQL
delete from auth.users where id in ('${O1}', '${O2}');
insert into auth.users (id, email, raw_app_meta_data) values ('${O1}', 'c-owner1@admin.test', '{"bonsim_admin":"true"}'), ('${O2}', 'c-owner2@admin.test', '{"bonsim_admin":"true"}');
insert into public.admin_members (user_id, display_name, role) values ('${O1}', 'o1', 'owner'), ('${O2}', 'o2', 'owner');
SQL

$PSQL -d "$DB_NAME" -At <<SQL > "$OUT" 2>&1 &
begin;
select 'S1=' || (public.admin_member_set_role('${O1}', '${O2}', 'viewer')->>'ok');
select pg_sleep(2);
commit;
SQL
S1=$!
sleep 0.5
S2="$($PSQL -d "$DB_NAME" -At -c "select public.admin_member_set_role('${O2}', '${O1}', 'viewer')")"
wait "$S1"
if ! grep -q 'S1=true' "$OUT"; then echo "FAIL admin concurrency: session 1: $(cat "$OUT")" >&2; exit 1; fi
if ! grep -q 'last_owner\|forbidden' <<<"$S2"; then echo "FAIL admin concurrency: second demotion must be refused, got $S2" >&2; exit 1; fi
OWNERS="$($PSQL -d "$DB_NAME" -At -c "select count(*) from public.admin_members where role = 'owner' and status = 'active' and user_id in ('${O1}', '${O2}')")"
if [[ "$OWNERS" != "1" ]]; then echo "FAIL admin concurrency: active owners = $OWNERS (expected 1)" >&2; exit 1; fi

$PSQL -d "$DB_NAME" -c "delete from auth.users where id in ('${O1}', '${O2}')"
rm -f "$OUT"
echo "ADMIN ACCOUNTS CONCURRENCY TESTS PASSED"
