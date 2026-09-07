#!/usr/bin/env bash
# verify-sdk-no-token-log.sh — Didit React Native SDK 네이티브 브리지에 세션 토큰/워크플로 id/vendor_data/metadata 를
# 출력하는 로그가 남아 있지 않은지 확인한다 (patch-package 적용 여부 검증).
#   npm run sdk:verify-no-token-log
# 종료 코드 0 = 안전. 1 = 위험한 로그 잔존 (patches/ 가 적용되지 않았거나 SDK 버전이 바뀜).
set -euo pipefail
cd "$(dirname "$0")/.."

SDK_DIR="node_modules/@didit-protocol/sdk-react-native"
if [[ ! -d "$SDK_DIR" ]]; then
  echo "ERROR: $SDK_DIR 가 없습니다. npm install 먼저 실행하세요." >&2
  exit 1
fi

VERSION="$(node -p "require('./$SDK_DIR/package.json').version")"
PATCH="patches/@didit-protocol+sdk-react-native+${VERSION}.patch"
if [[ ! -f "$PATCH" ]]; then
  echo "ERROR: 설치된 SDK ${VERSION} 에 대한 patch 파일이 없습니다 (${PATCH}). SDK 버전을 올렸다면 patch 를 다시 만드세요." >&2
  exit 1
fi

# 네이티브 브리지 (Kotlin/Swift/ObjC) 와 JS 래퍼에서 토큰/식별자 값을 문자열에 끼워 넣는 로그를 찾는다
PATTERN='Log\.[deiwv]\(.*(\$\{?token|\$\{?workflowId|\$\{?vendorData|\$\{?metadata|\$\{?contactDetails|\$\{?expectedDetails|\$\{?transactionToken)'
if grep -rEn "$PATTERN" "$SDK_DIR/android" "$SDK_DIR/ios" 2>/dev/null; then
  echo "ERROR: 위 로그가 토큰/워크플로/vendor_data/metadata 값을 출력합니다. patch 가 적용되지 않았습니다." >&2
  exit 1
fi
if grep -rEn '(print|NSLog|os_log)\(.*(token|vendorData|workflowId|metadata)' "$SDK_DIR/ios" 2>/dev/null; then
  echo "ERROR: iOS 브리지에 토큰/식별자 로그가 있습니다." >&2
  exit 1
fi
if grep -rEn 'console\.(log|debug|info|warn)\(.*(token|vendorData|workflowId|metadata)' "$SDK_DIR/lib" "$SDK_DIR/src" 2>/dev/null | grep -v '^\S*:\s*\*' | grep -v '^\S*:[0-9]*:\s*\*'; then
  echo "ERROR: JS 래퍼에 토큰/식별자 로그가 있습니다." >&2
  exit 1
fi

echo "OK: Didit SDK ${VERSION} 네이티브 브리지/JS 래퍼에 토큰·워크플로·vendor_data·metadata 로그가 없습니다."
