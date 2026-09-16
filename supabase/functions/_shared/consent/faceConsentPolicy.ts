/**
 * 얼굴(생체) 정보 처리 별도 동의 — 정책 정의 (#12). 순수 모듈 (Deno / Node 겸용).
 *
 * 서버가 "현재 동의 문서 버전" 의 단일 기준이다. 앱은 같은 내용을 apps/mobile/src/constants/faceConsent.ts 에 갖고
 * 화면에 보여 주며, 두 파일이 일치하는지는 supabase/functions/_shared/consent/selftest.ts 가 검사한다.
 *
 * 이것은 동의 "기능" 구현이다 — 법률 검토 완료를 뜻하지 않는다. 확인되지 않은 값은 지어내지 않고 null 로 둔다.
 *   * status: 'draft' 인 동안 production 에서는 얼굴 수집을 시작할 수 없다 (start-face-liveness 가 503 consent_policy_not_ready).
 *   * disclosures 의 null 항목(처리 국가 · 확인 업체 보관 기간 · 사업자 정보)이 확정되고 status 를 'final' 로 바꾸고
 *     version 을 올린 뒤, 서버 secret FACE_CONSENT_VERSION 을 같은 값으로 설정해야 production 에서 준비 완료로 본다.
 *   * version 이 바뀌면 이전 버전 동의만 있는 사용자는 새 세션을 시작할 때 다시 동의한다 (docs/face-consent.md).
 *     이미 승인된 사용자의 인증은 해제하지 않는다.
 */

export const FACE_CONSENT_KIND = 'face_biometric' as const;

export type FaceConsentDisclosures = {
  /** 처리 목적 */
  purpose: string;
  /** 처리 항목 */
  items: string;
  /** 처리업체(수탁자) */
  processor: string;
  /** 처리 국가/리전 — 계약·콘솔로 확인 전에는 null */
  processor_country: string | null;
  /** 서비스 서버 보관·삭제 (구현 기본값, docs/data-retention.md) */
  retention: string;
  /** 확인 업체 측 보관 기간 — 콘솔/계약 확인 전에는 null */
  processor_retention: string | null;
  /** 거부 시 제한 */
  refusal: string;
  /** 철회·삭제 경로 */
  withdrawal: string;
  /** 개인정보 보호책임자/문의처 — 확정 전에는 null */
  contact: string | null;
};

export type FaceConsentPolicy = {
  kind: typeof FACE_CONSENT_KIND;
  /** 문서 버전 — 내용이 바뀌면 올린다 (재동의 기준) */
  version: string;
  /** draft: 개발/스테이징 확인용 · final: 법률 검토를 마친 production 사용 가능 상태 */
  status: 'draft' | 'final';
  disclosures: FaceConsentDisclosures;
};

export const FACE_CONSENT_POLICY: FaceConsentPolicy = {
  kind: FACE_CONSENT_KIND,
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
};

/** 아직 확정되지 않은 고지 항목 이름 */
export function unresolvedDisclosures(policy: FaceConsentPolicy): (keyof FaceConsentDisclosures)[] {
  return (Object.keys(policy.disclosures) as (keyof FaceConsentDisclosures)[]).filter((k) => policy.disclosures[k] === null);
}

export type ConsentReadiness = { ready: true } | { ready: false; reasons: string[] };

/**
 * production 준비 상태 — 셋 다 만족해야 얼굴 수집을 시작할 수 있다.
 *   1) status === 'final'   2) 미확정 고지 항목 없음   3) FACE_CONSENT_VERSION secret === policy.version (운영자가 배포 버전을 명시적으로 승인)
 * development/staging 에서는 draft 를 허용하되, FACE_CONSENT_VERSION 이 설정돼 있으면 일치해야 한다 (설정 불일치 조기 발견).
 */
export function faceConsentReadiness(
  policy: FaceConsentPolicy,
  env: { appEnv: 'development' | 'staging' | 'production'; configuredVersion: string | null | undefined },
): ConsentReadiness {
  const reasons: string[] = [];
  const configured = (env.configuredVersion ?? '').trim();
  if (env.appEnv === 'production') {
    if (policy.status !== 'final') reasons.push('policy_status_not_final');
    const unresolved = unresolvedDisclosures(policy);
    if (unresolved.length > 0) reasons.push(`unresolved_disclosures:${unresolved.join(',')}`);
    if (!configured) reasons.push('FACE_CONSENT_VERSION_missing');
    else if (configured !== policy.version) reasons.push('FACE_CONSENT_VERSION_mismatch');
  } else if (configured && configured !== policy.version) {
    reasons.push('FACE_CONSENT_VERSION_mismatch');
  }
  return reasons.length === 0 ? { ready: true } : { ready: false, reasons };
}

/** 문서 버전 문자열 검증 (클라이언트 입력) */
export function isValidConsentVersion(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9A-Za-z.\-]{1,40}$/.test(v);
}
