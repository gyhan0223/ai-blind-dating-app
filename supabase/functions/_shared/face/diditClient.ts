/**
 * Didit Verification API 클라이언트 — 순수 모듈 (fetch 주입, Deno / Node 겸용).
 *
 * 엔드포인트 (Didit 공식 데모 didit-full-demo / 문서 기준):
 *   POST   {base}/v3/session/                   세션 생성 → { session_id, session_token, url, status, ... }
 *   GET    {base}/v2/session/{id}/decision/      세션 결정 조회 (liveness 결과·reference_image 포함)
 *   DELETE {base}/v2/session/{id}/delete/        세션·생체 데이터 삭제 (회원 탈퇴 후속 작업용)
 *   base = https://verification.didit.me  (DIDIT_API_BASE_URL 로 재정의 가능)
 *
 * 보안 원칙
 *   - API Key 는 서버에서만 사용한다. 응답/로그/오류 메시지에 key·session_token·이미지 URL 을 넣지 않는다.
 *   - 오류는 HTTP 상태 코드와 고정 reason 만 돌려준다 (Provider 본문은 전달하지 않는다).
 *   - 세션 생성 요청은 워크플로 id + vendor_data(인증된 Supabase user id) 만 보낸다.
 */

export const DIDIT_DEFAULT_BASE_URL = 'https://verification.didit.me';
export const DIDIT_SESSION_CREATE_PATH = '/v3/session/';
export const diditDecisionPath = (sessionId: string) => `/v2/session/${encodeURIComponent(sessionId)}/decision/`;
export const diditDeletePath = (sessionId: string) => `/v2/session/${encodeURIComponent(sessionId)}/delete/`;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type DiditClientDeps = {
  apiKey: string;
  baseUrl?: string;
  fetch: FetchLike;
  /** 개별 요청 타임아웃 (ms). Edge Function 실행 시간 안에서 끝나도록 짧게 유지 */
  timeoutMs?: number;
};

export type DiditFailureReason = 'http_error' | 'network_error' | 'invalid_response' | 'timeout';

export type CreateSessionResult =
  | {
      ok: true;
      sessionId: string;
      /** 모바일 SDK 에 한 번 전달되는 토큰. DB/로그에 저장하지 않는다 */
      sessionToken: string;
      expiresAt: string | null;
      providerStatus: string | null;
    }
  | { ok: false; reason: DiditFailureReason; httpStatus?: number };

export type DecisionFetchResult =
  | { ok: true; json: unknown }
  | { ok: false; reason: DiditFailureReason; httpStatus?: number };

function normalizeBase(baseUrl: string | undefined): string {
  const b = (baseUrl ?? '').trim() || DIDIT_DEFAULT_BASE_URL;
  return b.replace(/\/+$/, '');
}

async function requestJson(
  deps: DiditClientDeps,
  path: string,
  init: RequestInit,
): Promise<{ ok: true; status: number; json: unknown } | { ok: false; reason: DiditFailureReason; httpStatus?: number }> {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), deps.timeoutMs ?? 8000) : null;
  try {
    const res = await deps.fetch(`${normalizeBase(deps.baseUrl)}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-API-Key': deps.apiKey,
        ...(init.headers ?? {}),
      },
      signal: controller?.signal,
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    if (!res.ok) return { ok: false, reason: 'http_error', httpStatus: res.status };
    return { ok: true, status: res.status, json };
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    return { ok: false, reason: name === 'AbortError' ? 'timeout' : 'network_error' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 세션 생성. vendor_data 에는 반드시 서버가 검증한 사용자 id 만 넣는다. */
export async function createDiditSession(
  deps: DiditClientDeps,
  input: { workflowId: string; vendorData: string; callbackUrl?: string },
): Promise<CreateSessionResult> {
  const body: Record<string, unknown> = {
    workflow_id: input.workflowId,
    vendor_data: input.vendorData,
  };
  if (input.callbackUrl) body.callback = input.callbackUrl;

  const res = await requestJson(deps, DIDIT_SESSION_CREATE_PATH, { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) return res;

  const json = res.json as Record<string, unknown> | null;
  const sessionId = typeof json?.session_id === 'string' ? json.session_id : null;
  const sessionToken = typeof json?.session_token === 'string' ? json.session_token : null;
  if (!sessionId || !sessionToken) return { ok: false, reason: 'invalid_response', httpStatus: res.status };

  return {
    ok: true,
    sessionId,
    sessionToken,
    expiresAt: typeof json?.expires_at === 'string' ? json.expires_at : null,
    providerStatus: typeof json?.status === 'string' ? json.status : null,
  };
}

/** 세션 결정 조회 — 승인 여부의 유일한 근거. 파싱은 faceCore.parseDiditDecision 이 담당. */
export async function getDiditDecision(deps: DiditClientDeps, sessionId: string): Promise<DecisionFetchResult> {
  const res = await requestJson(deps, diditDecisionPath(sessionId), { method: 'GET' });
  if (!res.ok) return res;
  return { ok: true, json: res.json };
}

/** 세션 삭제 (회원 탈퇴 시 Didit 측 생체 데이터 삭제 경로). 실패해도 예외를 던지지 않는다. */
export async function deleteDiditSession(
  deps: DiditClientDeps,
  sessionId: string,
): Promise<{ ok: boolean; httpStatus?: number }> {
  const res = await requestJson(deps, diditDeletePath(sessionId), { method: 'DELETE' });
  return res.ok ? { ok: true, httpStatus: res.status } : { ok: false, httpStatus: res.httpStatus };
}

// ---------------------------------------------------------------------------
// reference image 다운로드 (서명 URL 만료 전 서버에서만 수행)
// ---------------------------------------------------------------------------

export type ImageFetchResult =
  | { ok: true; bytes: Uint8Array; contentType: string }
  | { ok: false; reason: 'insecure_url' | 'http_error' | 'bad_type' | 'too_large' | 'network_error' | 'timeout' };

export async function downloadImage(
  fetchFn: FetchLike,
  url: string,
  opts: { maxBytes: number; allowedTypes: readonly string[]; timeoutMs?: number },
): Promise<ImageFetchResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'insecure_url' };
  }
  if (parsed.protocol !== 'https:') return { ok: false, reason: 'insecure_url' };

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), opts.timeoutMs ?? 10000) : null;
  try {
    const res = await fetchFn(url, { method: 'GET', signal: controller?.signal });
    if (!res.ok) return { ok: false, reason: 'http_error' };

    const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!opts.allowedTypes.includes(contentType)) return { ok: false, reason: 'bad_type' };

    const declared = Number(res.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > opts.maxBytes) return { ok: false, reason: 'too_large' };

    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength === 0) return { ok: false, reason: 'http_error' };
    if (buf.byteLength > opts.maxBytes) return { ok: false, reason: 'too_large' };
    return { ok: true, bytes: buf, contentType };
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    return { ok: false, reason: name === 'AbortError' ? 'timeout' : 'network_error' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
