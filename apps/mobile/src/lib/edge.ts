/**
 * Edge Function 호출 오류 해석 — supabase.functions.invoke 의 error.context(Response) 에서 상태 코드와 error 필드를 읽는다.
 * 폐쇄 베타 거부(403 beta_admission_required, #26) 와 남용 제한(429 rate_limited, #27) 을 화면이 구분해 안내하기 위한 용도.
 */
export type EdgeError = { status: number; code: string | null; retryAfterSeconds: number | null };

export async function readEdgeError(err: unknown): Promise<EdgeError> {
  const ctx = (err as { context?: Response } | null)?.context;
  if (!ctx || typeof ctx.status !== 'number') return { status: 0, code: null, retryAfterSeconds: null };
  let body: Record<string, unknown> | null = null;
  try {
    body = (await ctx.clone().json()) as Record<string, unknown>;
  } catch {
    body = null;
  }
  const retry = body && typeof body.retry_after_seconds === 'number' ? body.retry_after_seconds : null;
  return { status: ctx.status, code: body && typeof body.error === 'string' ? body.error : null, retryAfterSeconds: retry };
}

export function isBetaDenied(e: EdgeError): boolean {
  return e.status === 403 && e.code === 'beta_admission_required';
}

export function rateLimitedText(e: EdgeError): string | null {
  if (e.status !== 429) return null;
  const sec = e.retryAfterSeconds ?? 60;
  return sec >= 120 ? `요청이 너무 잦아요. 약 ${Math.ceil(sec / 60)}분 뒤에 다시 시도해 주세요.` : `요청이 너무 잦아요. ${sec}초 뒤에 다시 시도해 주세요.`;
}
