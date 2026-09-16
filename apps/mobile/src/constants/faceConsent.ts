/**
 * 얼굴(생체) 정보 처리 별도 동의 — 앱 표시용 사본 (#12).
 *
 * 기준(단일 진실)은 서버 supabase/functions/_shared/consent/faceConsentPolicy.ts 다. 두 파일의 kind/version/status/disclosures 가
 * 같은지 `supabase/functions/_shared/consent/selftest.ts` 가 검사한다 (릴리스 체크리스트·CI). 버전이 다르면 서버가 409/403 으로 거부한다.
 *
 * 화면 규칙
 *   - 다른 약관과 구분된 별도 체크박스, 기본 미선택. 체크 없이 "동의하고 시작" 불가.
 *   - 확정되지 않은 값(null)은 화면에 자리표시자/TODO 로 노출하지 않고 "개인정보처리방침 전문" 링크로 안내한다.
 *   - 이 문구는 법률 검토 전 초안이다 (status: 'draft'). production 은 서버가 draft 인 동안 얼굴 수집 시작을 거부한다.
 */
export const FACE_CONSENT = {
  kind: 'face_biometric',
  version: '2026-09-16.draft.1',
  status: 'draft',
  disclosures: {
    purpose: '실제 사람인지 확인(라이브니스)하고 중복 가입이 의심될 때 검토하기 위해서만 처리합니다. 외모 평가·이상형 추천에는 쓰지 않습니다.',
    items: '얼굴 확인 결과(통과 여부·점수·사유 코드·확인 업체 세션 번호)와 서버만 접근할 수 있는 참조 이미지 1장. 확인 과정의 영상은 앱과 서비스 서버에 저장하지 않습니다.',
    processor: 'Didit (얼굴 라이브니스 확인 업체)',
    processor_country: null,
    retention: '계정이 활성인 동안 보관합니다. 탈퇴하면 30일 유예 뒤 서버의 참조 이미지·확인 결과를 삭제하고 확인 업체에 세션 삭제를 요청합니다.',
    processor_retention: null,
    refusal: '동의하지 않으면 얼굴 확인을 진행할 수 없어 가입을 완료할 수 없습니다. 이미 입력한 정보는 그대로 남습니다.',
    withdrawal: '내 정보 → 회원 탈퇴, 또는 계정 삭제 요청 페이지에서 철회·삭제를 요청할 수 있습니다. 삭제는 30일 유예 뒤 진행됩니다.',
    contact: null,
  },
} as const;

export type FaceConsentDisclosureKey = keyof typeof FACE_CONSENT.disclosures;

/** 화면에 보여 줄 항목 (확정된 값만). null 항목은 전문 링크로 대신한다 */
export const FACE_CONSENT_ROWS: { key: FaceConsentDisclosureKey; label: string }[] = [
  { key: 'purpose', label: '처리 목적' },
  { key: 'items', label: '처리 항목' },
  { key: 'processor', label: '처리업체' },
  { key: 'processor_country', label: '처리 국가' },
  { key: 'retention', label: '보관·삭제' },
  { key: 'processor_retention', label: '확인 업체 보관' },
  { key: 'refusal', label: '거부 시 제한' },
  { key: 'withdrawal', label: '철회·삭제 방법' },
];
