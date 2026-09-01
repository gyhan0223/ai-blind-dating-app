#!/usr/bin/env bash
# production Edge Function 배포 — 명시적 allowlist 방식 (Issue #3).
#
#   bash supabase/scripts/deploy-production.sh <production-project-ref>
#
# 원칙:
#  1) dev-login 은 production 에 절대 배포하지 않는다 (아래 allowlist 에서 제외 — 1차 방어).
#     실수로 배포되어도 서버 가드(APP_ENV=production → 403)가 막는다 (2차 방어).
#  2) "supabase functions deploy" 를 인자 없이 실행하면 dev-login 을 포함한 전체 함수가
#     배포되므로 production 에서는 이 스크립트만 사용한다.
#  3) 배포 전 production secrets(APP_ENV, IDENTITY_HASH_SECRET)가 설정되어 있는지 확인한다.
set -euo pipefail

# production 에 배포하는 함수 allowlist — dev-login 은 절대 추가하지 않는다
PROD_FUNCTIONS=(
  verify-identity
  delete-account
  complete-face-verification
  daily-recommendation
  icebreaker
)

if [[ $# -ne 1 ]]; then
  echo "사용법: bash supabase/scripts/deploy-production.sh <production-project-ref>" >&2
  exit 1
fi
PROJECT_REF="$1"

echo "== production secrets 확인 (${PROJECT_REF}) =="
SECRETS="$(supabase secrets list --project-ref "$PROJECT_REF")"
for required in APP_ENV IDENTITY_HASH_SECRET; do
  if ! grep -q "$required" <<<"$SECRETS"; then
    echo "ERROR: production secret ${required} 가 설정되어 있지 않습니다." >&2
    echo "  supabase secrets set ${required}=... --project-ref ${PROJECT_REF}" >&2
    echo "  (APP_ENV=production, IDENTITY_HASH_SECRET 은 32자 이상 고유 값 — docs/environments.md)" >&2
    exit 1
  fi
done
if grep -q "ALLOW_DEV_LOGIN" <<<"$SECRETS"; then
  echo "WARNING: production 에 ALLOW_DEV_LOGIN secret 이 존재합니다. 제거를 권장합니다." >&2
  echo "  (APP_ENV=production 이면 무시되지만, 남겨둘 이유가 없습니다)" >&2
fi

echo "== production 함수 배포 (allowlist: ${PROD_FUNCTIONS[*]}) =="
for fn in "${PROD_FUNCTIONS[@]}"; do
  supabase functions deploy "$fn" --project-ref "$PROJECT_REF"
done

echo "== 완료. release 전 docs/release-checklist.md 를 확인하세요 =="
