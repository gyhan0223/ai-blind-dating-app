/**
 * 얼굴 정보 처리 동의 정책 selftest (#12) — Node 로 실행.
 *   cd supabase/functions/_shared/consent && node --experimental-strip-types selftest.ts
 *
 *   - 서버 정책(faceConsentPolicy.ts)과 앱 사본(apps/mobile/src/constants/faceConsent.ts)의 kind/version/status/disclosures 일치
 *   - 문서 버전 형식 · 미확정 항목 목록 · production 준비 상태 규칙 (draft/미확정/FACE_CONSENT_VERSION)
 *   - 앱 화면 문구에 개발용 자리표시자([확인 필요]/TODO/[ ])가 없다
 */
import { FACE_CONSENT_POLICY, faceConsentReadiness, isValidConsentVersion, unresolvedDisclosures } from './faceConsentPolicy.ts';
import { FACE_CONSENT, FACE_CONSENT_ROWS } from '../../../../apps/mobile/src/constants/faceConsent.ts';

let passed = 0;
let failed = 0;
function eq(name: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) passed += 1;
  else {
    failed += 1;
    console.error(`FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
const ok = (name: string, cond: boolean) => eq(name, cond, true);

eq('kind in sync', FACE_CONSENT.kind, FACE_CONSENT_POLICY.kind);
eq('version in sync', FACE_CONSENT.version, FACE_CONSENT_POLICY.version);
eq('status in sync', FACE_CONSENT.status, FACE_CONSENT_POLICY.status);
eq('disclosures in sync', FACE_CONSENT.disclosures, FACE_CONSENT_POLICY.disclosures);
ok('version format valid', isValidConsentVersion(FACE_CONSENT_POLICY.version));
ok('every disclosure key shown or linked', FACE_CONSENT_ROWS.every((r) => r.key in FACE_CONSENT.disclosures));

const placeholder = /\[확인 필요\]|TODO|\[\s*\]|\[리전\]|example\.com/i;
for (const [k, v] of Object.entries(FACE_CONSENT_POLICY.disclosures)) {
  ok(`no placeholder in ${k}`, v === null || !placeholder.test(v));
}

const unresolved = unresolvedDisclosures(FACE_CONSENT_POLICY);
ok('unresolved list derived from nulls', unresolved.every((k) => FACE_CONSENT_POLICY.disclosures[k] === null));
if (FACE_CONSENT_POLICY.status === 'draft') {
  ok('draft policy is not production-ready', !faceConsentReadiness(FACE_CONSENT_POLICY, { appEnv: 'production', configuredVersion: FACE_CONSENT_POLICY.version }).ready);
} else {
  ok('final policy has no unresolved disclosures', unresolved.length === 0);
}
eq('development allows draft', faceConsentReadiness(FACE_CONSENT_POLICY, { appEnv: 'development', configuredVersion: undefined }), { ready: true });
eq('staging mismatch flagged', faceConsentReadiness(FACE_CONSENT_POLICY, { appEnv: 'staging', configuredVersion: 'nope' }), { ready: false, reasons: ['FACE_CONSENT_VERSION_mismatch'] });

console.log(`consent selftest: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
