/**
 * face_consents 접근 계약 (#12) — 서버 전용. 사용자 id 는 항상 JWT 에서 온 값이며 동의 시각은 DB 서버 시각이다.
 */
export interface FaceConsentDb {
  /** (user, kind, version) 의 유효한(철회되지 않은) 동의가 있는가. 조회 오류는 ok:false (fail-closed) */
  hasCurrentConsent(userId: string, kind: string, version: string): Promise<{ ok: true; consented: boolean; grantedAt: string | null } | { ok: false }>;
  /** 동의 기록 — 이미 있으면 그대로 (멱등). 시각은 서버가 정한다 */
  recordConsent(userId: string, kind: string, version: string): Promise<{ ok: true; grantedAt: string; created: boolean } | { ok: false }>;
}
