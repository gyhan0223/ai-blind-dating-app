/**
 * 얼굴 라이브니스 Provider 추상화 — 순수 모듈 (fetch 주입).
 *
 * 외부 Provider 타입은 이 파일과 diditClient/faceCore 안에서만 다루고,
 * Edge Function 과 앱에는 내부 도메인 상태(FaceVerificationStatus 등)만 노출한다.
 *
 *   didit → DiditFaceLivenessProvider (실서비스. API Key/Workflow/Webhook secret 필요 — 없으면 기동 실패)
 *   mock  → MockFaceLivenessProvider  (development/staging 전용. 실제 세션을 만들 수 없으며
 *            complete-face-verification 의 개발용 즉시 승인에만 쓰인다. production 은 env 단계에서 차단)
 */
import {
  createDiditSession,
  deleteDiditSession,
  downloadImage,
  type CreateSessionResult,
  type DiditClientDeps,
  type FetchLike,
  getDiditDecision,
  type ImageFetchResult,
} from './diditClient.ts';
import {
  type DecisionParseResult,
  type LivenessDecision,
  parseDiditDecision,
  REFERENCE_IMAGE_ALLOWED_TYPES,
  REFERENCE_IMAGE_MAX_BYTES,
} from './faceCore.ts';

export type FaceProviderKind = 'didit' | 'mock';

export type ProviderSessionResult =
  | { ok: true; sessionId: string; sessionToken: string; expiresAt: string | null }
  | { ok: false; reason: 'mock_provider' | 'provider_error'; httpStatus?: number };

export type ProviderDecisionResult =
  | { ok: true; decision: LivenessDecision }
  | { ok: false; reason: 'provider_error' | 'invalid_decision'; detail?: string; httpStatus?: number };

export interface FaceLivenessProvider {
  readonly kind: FaceProviderKind;
  /** 서버에서 세션 생성. vendorData 는 인증된 Supabase user id */
  createSession(input: { userId: string }): Promise<ProviderSessionResult>;
  /** 서버가 직접 최종 결정을 조회한다 — 승인의 유일한 근거 */
  getDecision(sessionId: string): Promise<ProviderDecisionResult>;
  /** 승인된 세션의 reference image 다운로드 (서명 URL 만료 전, 서버 전용) */
  fetchReferenceImage(url: string): Promise<ImageFetchResult>;
  /** 회원 탈퇴 시 Provider 측 세션/생체 데이터 삭제 */
  deleteSession(sessionId: string): Promise<{ ok: boolean }>;
}

// ---------------------------------------------------------------------------
// 환경변수 (서버 전용 secret — EXPO_PUBLIC_* / 번들 / 로그 / DB 금지)
// ---------------------------------------------------------------------------

export const DIDIT_REQUIRED_ENV_VARS = ['DIDIT_API_KEY', 'DIDIT_WORKFLOW_ID', 'DIDIT_WEBHOOK_SECRET'] as const;

export type DiditConfig = {
  apiKey: string;
  workflowId: string;
  webhookSecret: string;
  baseUrl: string | undefined;
};

export type DiditConfigResult = { ok: true; config: DiditConfig } | { ok: false; missing: string[] };

/** 누락된 변수 "이름" 만 돌려준다 (값은 절대 포함하지 않는다). */
export function loadDiditConfig(env: (name: string) => string | undefined): DiditConfigResult {
  const read = (name: string) => (env(name) ?? '').trim();
  const missing = DIDIT_REQUIRED_ENV_VARS.filter((name) => read(name) === '');
  if (missing.length > 0) return { ok: false, missing: [...missing] };
  return {
    ok: true,
    config: {
      apiKey: read('DIDIT_API_KEY'),
      workflowId: read('DIDIT_WORKFLOW_ID'),
      webhookSecret: read('DIDIT_WEBHOOK_SECRET'),
      baseUrl: read('DIDIT_API_BASE_URL') || undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// Didit
// ---------------------------------------------------------------------------

export class DiditFaceLivenessProvider implements FaceLivenessProvider {
  readonly kind = 'didit' as const;
  private readonly config: DiditConfig;
  private readonly deps: DiditClientDeps;

  constructor(config: DiditConfig, fetchFn: FetchLike) {
    this.config = config;
    this.deps = { apiKey: config.apiKey, baseUrl: config.baseUrl, fetch: fetchFn };
  }

  async createSession(input: { userId: string }): Promise<ProviderSessionResult> {
    const res: CreateSessionResult = await createDiditSession(this.deps, {
      workflowId: this.config.workflowId,
      vendorData: input.userId,
    });
    if (!res.ok) return { ok: false, reason: 'provider_error', httpStatus: res.httpStatus };
    return { ok: true, sessionId: res.sessionId, sessionToken: res.sessionToken, expiresAt: res.expiresAt };
  }

  async getDecision(sessionId: string): Promise<ProviderDecisionResult> {
    const res = await getDiditDecision(this.deps, sessionId);
    if (!res.ok) return { ok: false, reason: 'provider_error', httpStatus: res.httpStatus };
    const parsed: DecisionParseResult = parseDiditDecision(res.json, sessionId);
    if (!parsed.ok) return { ok: false, reason: 'invalid_decision', detail: parsed.reason };
    return { ok: true, decision: parsed.decision };
  }

  fetchReferenceImage(url: string): Promise<ImageFetchResult> {
    return downloadImage(this.deps.fetch, url, {
      maxBytes: REFERENCE_IMAGE_MAX_BYTES,
      allowedTypes: REFERENCE_IMAGE_ALLOWED_TYPES,
    });
  }

  async deleteSession(sessionId: string): Promise<{ ok: boolean }> {
    const res = await deleteDiditSession(this.deps, sessionId);
    return { ok: res.ok };
  }
}

// ---------------------------------------------------------------------------
// Mock (development / staging 전용)
// ---------------------------------------------------------------------------

/**
 * Mock 은 실제 SDK 세션을 만들 수 없다 (SDK 는 진짜 session_token 만 받는다).
 * start-face-liveness 에서 mock 이면 세션 생성을 거부하고, 개발자는 앱의
 * "개발 모드: 얼굴 인증 통과" 버튼(complete-face-verification) 으로 흐름만 검증한다.
 */
export class MockFaceLivenessProvider implements FaceLivenessProvider {
  readonly kind = 'mock' as const;

  async createSession(): Promise<ProviderSessionResult> {
    return { ok: false, reason: 'mock_provider' };
  }

  async getDecision(sessionId: string): Promise<ProviderDecisionResult> {
    return {
      ok: true,
      decision: {
        providerStatus: 'Approved',
        status: 'approved',
        livenessPassed: true,
        livenessScore: 100,
        livenessMethod: 'MOCK',
        referenceImageUrl: null,
        duplicateSuspected: sessionId.includes('duplicate'),
      },
    };
  }

  async fetchReferenceImage(): Promise<ImageFetchResult> {
    return { ok: false, reason: 'http_error' };
  }

  async deleteSession(): Promise<{ ok: boolean }> {
    return { ok: true };
  }
}

// ---------------------------------------------------------------------------
// factory — kind 는 _shared/env 가 fail-closed 로 해석한 값 (production 에서 mock/미설정은 이미 거부됨)
// ---------------------------------------------------------------------------

export function getFaceLivenessProvider(
  kind: string,
  env: (name: string) => string | undefined,
  fetchFn: FetchLike,
): FaceLivenessProvider {
  switch (kind) {
    case 'didit': {
      const cfg = loadDiditConfig(env);
      if (!cfg.ok) {
        throw new Error(
          `[face] Didit 설정 누락: [${cfg.missing.join(', ')}] — supabase secrets set 으로 설정하세요 (docs/face-liveness-didit.md)`,
        );
      }
      return new DiditFaceLivenessProvider(cfg.config, fetchFn);
    }
    case 'mock':
      return new MockFaceLivenessProvider();
    default:
      throw new Error(`[face] 구현되지 않은 FACE_VERIFICATION_PROVIDER 입니다: ${kind}`);
  }
}
