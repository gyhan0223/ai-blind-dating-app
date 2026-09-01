#!/usr/bin/env bash
# production Edge Function 배포 — 명시적 allowlist 방식 (Issue #3).
#
#   bash supabase/scripts/deploy-production.sh <production-project-ref>
#
# 원칙:
#  1) dev-login 은 production 에 절대 배포하지 않는다 (allowlist 에서 제외 — 1차 방어).
#     이미 배포되어 있으면 배포를 중단한다. 실수로 남아 있어도 서버 가드
#     (APP_ENV=production → 403)가 막는다 (2차 방어).
#  2) "supabase functions deploy" 를 인자 없이 실행하면 dev-login 을 포함한 전체 함수가
#     배포되므로 production 에서는 이 스크립트만 사용한다.
#  3) APP_ENV=production 은 이 스크립트가 직접 설정해 보장한다
#     (secrets list 는 값을 보여주지 않아 검증이 불가능하므로, 설정으로 확정한다).
#  4) 개발용 secret(ALLOW_DEV_LOGIN 등)이 존재하면 배포를 실패시킨다.
set -euo pipefail

# production 에 배포하는 함수 allowlist — dev-login 은 절대 추가하지 않는다
PROD_FUNCTIONS=(
  verify-identity
  delete-account
  complete-face-verification
  daily-recommendation
  icebreaker
)

# production 에 반드시 존재해야 하는 secret (값은 확인 불가 — 존재만 확인, 값 검증은 서버 가드가 수행)
REQUIRED_SECRETS=(
  IDENTITY_HASH_SECRET
  IDENTITY_PROVIDER
  FACE_VERIFICATION_PROVIDER
)

# production 에 존재하면 안 되는 개발용 secret — 발견 시 배포 실패
FORBIDDEN_SECRETS=(
  ALLOW_DEV_LOGIN
  DEV_LOGIN_PASSWORD
  DEV_LOGIN_ALLOW_ANY_PHONE
)

if [[ $# -ne 1 ]]; then
  echo "사용법: bash supabase/scripts/deploy-production.sh <production-project-ref>" >&2
  exit 1
fi
PROJECT_REF="$1"

echo "== 1/4 dev-login 배포 여부 확인 (${PROJECT_REF}) =="
DEPLOYED="$(supabase functions list --project-ref "$PROJECT_REF")"
if grep -qE "(^|[^a-zA-Z0-9-])dev-login([^a-zA-Z0-9-]|$)" <<<"$DEPLOYED"; then
  echo "ERROR: production 에 dev-login 함수가 배포되어 있습니다. 배포를 중단합니다." >&2
  echo "  먼저 삭제하세요: supabase functions delete dev-login --project-ref ${PROJECT_REF}" >&2
  exit 1
fi

echo "== 2/4 production secrets 확인 =="
SECRETS="$(supabase secrets list --project-ref "$PROJECT_REF")"
for required in "${REQUIRED_SECRETS[@]}"; do
  if ! grep -qE "(^|[^A-Z_])${required}([^A-Z_]|$)" <<<"$SECRETS"; then
    echo "ERROR: production secret ${required} 가 설정되어 있지 않습니다." >&2
    echo "  supabase secrets set ${required}=... --project-ref ${PROJECT_REF}" >&2
    echo "  (IDENTITY_HASH_SECRET: 32자+ 고유 값 / *_PROVIDER: mock 이 아닌 실제 provider" >&2
    echo "   — 값이 잘못되면 함수가 cold start 에서 기동을 거부합니다. docs/environments.md)" >&2
    exit 1
  fi
done
for forbidden in "${FORBIDDEN_SECRETS[@]}"; do
  if grep -qE "(^|[^A-Z_])${forbidden}([^A-Z_]|$)" <<<"$SECRETS"; then
    echo "ERROR: production 에 개발용 secret ${forbidden} 이 존재합니다. 배포를 중단합니다." >&2
    echo "  제거하세요: supabase secrets unset ${forbidden} --project-ref ${PROJECT_REF}" >&2
    echo "  (APP_ENV=production 이면 무시되는 값이지만, production 에 존재해서는 안 됩니다)" >&2
    exit 1
  fi
done

echo "== 3/4 APP_ENV=production 설정 (값 검증이 불가능하므로 직접 설정해 확정) =="
supabase secrets set APP_ENV=production --project-ref "$PROJECT_REF"

echo "== 4/4 production 함수 배포 (allowlist: ${PROD_FUNCTIONS[*]}) =="
for fn in "${PROD_FUNCTIONS[@]}"; do
  supabase functions deploy "$fn" --project-ref "$PROJECT_REF"
done

echo "== 완료. release 전 docs/release-checklist.md 를 확인하세요 =="
echo "   (주의: *_PROVIDER secret 의 값이 mock 이 아닌지는 CLI 로 확인할 수 없습니다."
echo "    잘못 설정된 경우 verify-identity / complete-face-verification 이 기동 실패로 드러납니다)"
