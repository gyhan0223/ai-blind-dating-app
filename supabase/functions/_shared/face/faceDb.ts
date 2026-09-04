/**
 * face_verifications 접근 인터페이스 — Edge Function 핵심 로직이 의존하는 최소 DB 계약.
 * 실제 구현은 supabaseFaceDb.ts (Deno, service role). selftest 는 인메모리 구현을 주입한다.
 *
 * 모든 쓰기는 service role 로만 수행된다 (클라이언트 RLS/트리거가 차단). 이 계약을 통해서만
 * users.face_verified 가 true 가 된다.
 */
import type { FaceReasonCode, FaceVerificationStatus } from './faceCore.ts';

export type FaceRow = {
  id: string;
  userId: string;
  status: FaceVerificationStatus;
  provider: string;
  providerSessionId: string | null;
  providerStatus: string | null;
  providerEventAt: Date | null;
  livenessPassed: boolean;
  referencePath: string | null;
  expiresAt: Date | null;
  attemptCount: number;
  createdAt: Date;
};

export type BeginSessionResult =
  | { action: 'already_verified' }
  | { action: 'reuse'; id: string; providerSessionId: string; expiresAt: string }
  | { action: 'rate_limited'; reason: 'hourly' | 'daily'; retryAfterSeconds: number }
  | { action: 'create'; id: string; attemptCount: number };

export type FaceRowPatch = {
  status?: FaceVerificationStatus;
  providerStatus?: string | null;
  providerEventAt?: Date | null;
  livenessPassed?: boolean;
  livenessScore?: number | null;
  livenessMethod?: string | null;
  providerReason?: FaceReasonCode | null;
  referencePath?: string | null;
  expiresAt?: Date | null;
};

export interface FaceDb {
  /** face_liveness_begin_session RPC */
  beginSession(userId: string, provider: string, limits: { maxPerHour: number; maxPerDay: number }): Promise<BeginSessionResult>;
  /** 생성된 pending 행에 Provider 세션을 붙인다 */
  attachProviderSession(rowId: string, input: { providerSessionId: string; expiresAt: Date; providerStatus: string | null }): Promise<void>;
  getRowBySessionId(providerSessionId: string): Promise<FaceRow | null>;
  getRowById(id: string): Promise<FaceRow | null>;
  getLatestForUser(userId: string): Promise<FaceRow | null>;
  /** 상태 전이 트리거가 거부하면 ok:false (예외를 밖으로 던지지 않는다) */
  updateRow(rowId: string, patch: FaceRowPatch): Promise<{ ok: true } | { ok: false; error: string }>;
  setUserFaceVerified(userId: string): Promise<{ ok: boolean }>;
  /** private bucket faces 에 reference image 저장 → 저장 경로 */
  storeReferenceImage(userId: string, bytes: Uint8Array, contentType: string): Promise<{ ok: true; path: string } | { ok: false }>;
  isUserFaceVerified(userId: string): Promise<boolean>;
}

export type FaceLogger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

export const silentLogger: FaceLogger = { info: () => {}, warn: () => {}, error: () => {} };
