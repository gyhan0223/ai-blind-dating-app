/**
 * face_verifications 접근 인터페이스 — Edge Function 핵심 로직이 의존하는 최소 DB 계약.
 * 실제 구현은 supabaseFaceDb.ts (Deno, service role). selftest 는 인메모리 구현을 주입한다.
 *
 * 모든 쓰기는 service role 로만 수행된다 (클라이언트 RLS/트리거가 차단).
 * users.face_verified 는 오직 approveVerification(→ DB RPC face_liveness_approve, 단일 트랜잭션) 으로만 true 가 된다.
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
  providerReason: string | null;
  livenessPassed: boolean;
  livenessScore: number | null;
  livenessMethod: string | null;
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

/** face_liveness_approve RPC 입력 — 행·사용자·세션·reference_path 를 DB 가 다시 검증한다 */
export type ApproveInput = {
  rowId: string;
  userId: string;
  providerSessionId: string;
  referencePath: string;
  /** 서버가 Provider Decision 에서 직접 확인한 라이브니스 통과 여부 (false 면 RPC 가 거부) */
  livenessPassed: boolean;
  livenessScore: number | null;
  livenessMethod: string | null;
  providerStatus: string | null;
  providerEventAt: Date;
  reason: FaceReasonCode;
};

export type ApproveResult =
  | { ok: true; faceVerified: true; changed: boolean }
  | { ok: false; reason: string };

/** face_liveness_admin_review RPC 입력 (관리자 검토 — 감사 기록 포함, 단일 트랜잭션) */
export type AdminReviewInput = {
  rowId: string;
  action: 'approve' | 'reject';
  actor: string;
  note: string | null;
  /** approve 전용 — 서버가 확보한 reference_path / Decision 값 */
  referencePath?: string | null;
  livenessScore?: number | null;
  livenessMethod?: string | null;
  providerStatus?: string | null;
};

export type AdminReviewResult =
  | { ok: true; status: 'approved' | 'rejected'; faceVerified: boolean }
  | { ok: false; reason: string };

export type WebhookEventRecord = {
  eventId: string;
  providerSessionId: string | null;
  webhookType: string | null;
  providerStatus: string | null;
  /** 처리 결과 고정 코드 (ok / ignored:* / duplicate) */
  outcome: string;
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
  /**
   * 승인 확정 — face_verifications.status='approved' + verified_at + users.face_verified=true 를
   * 하나의 DB 트랜잭션(RPC face_liveness_approve)으로 반영한다. 멱등: 이미 approved 인 행에도
   * users.face_verified 가 false 면 복구한다. 조건 불충족이면 ok:false.
   */
  approveVerification(input: ApproveInput): Promise<ApproveResult>;
  /** 관리자 검토 (승인/거절 + audit) — RPC face_liveness_admin_review */
  adminReview(input: AdminReviewInput): Promise<AdminReviewResult>;
  /** private bucket faces 에 reference image 저장 → 저장 경로 (같은 경로에 upsert — 재시도 안전) */
  storeReferenceImage(userId: string, bytes: Uint8Array, contentType: string): Promise<{ ok: true; path: string } | { ok: false }>;
  isUserFaceVerified(userId: string): Promise<boolean>;
  /** V3 웹훅 event_id 멱등 처리 — 이미 처리한 이벤트면 true */
  hasProcessedWebhookEvent(eventId: string): Promise<boolean>;
  /** 처리 완료한 이벤트 기록 (실패/503 로 끝난 이벤트는 기록하지 않아 재시도가 다시 처리된다) */
  markWebhookEventProcessed(record: WebhookEventRecord): Promise<void>;
}

export type FaceLogger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

export const silentLogger: FaceLogger = { info: () => {}, warn: () => {}, error: () => {} };
