#!/usr/bin/env bash
# 서버 순수 로직 selftest 전체 실행 (Node 22+, 외부 호출 없음). CI 와 로컬(Git Bash)에서 같은 명령.
# PowerShell 에서는 각 selftest 를 한 줄씩 실행한다 (docs/release-checklist.md).
set -euo pipefail
cd "$(dirname "$0")/.."

run() {
  echo "== $1/$2"
  set +e
  out="$(cd "$1" && node --experimental-strip-types "$2" 2>&1)"
  code=$?
  set -e
  printf '%s\n' "$out" | grep -v "MODULE_TYPELESS_PACKAGE_JSON\|Reparsing as ES module\|eliminate this warning\|trace-warnings" || true
  if [[ $code -ne 0 ]]; then
    echo "FAIL: $1/$2 (exit $code)" >&2
    exit 1
  fi
}

run supabase/functions/_shared/env selftest.ts
run supabase/functions/_shared/identity selftest.ts
run supabase/functions/_shared/identity verifyIdentitySelftest.ts
run supabase/functions/_shared/security selftest.ts
run supabase/functions/_shared/observability selftest.ts
run supabase/functions/_shared/notifications selftest.ts
run supabase/functions/_shared/matching selftest.ts
run supabase/functions/_shared/matching batchSelftest.ts
run supabase/functions/_shared/face selftest.ts
run supabase/functions/_shared/purge selftest.ts
run supabase/functions/_shared/consent selftest.ts
run supabase/functions/send-sms selftest.ts
echo "OK: all server selftests passed"
