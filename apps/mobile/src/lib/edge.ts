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

/**
 * verify-identity 세션 오류 (#6) — 서버가 세션을 소유하므로 만료·오용·처리 중·연속 실패를 코드로 돌려준다.
 * 해당 없으면 null. 문구에 서버 응답 원문·개인정보는 넣지 않는다.
 */
export function identitySessionErrorText(e: EdgeError): string | null {
  switch (e.code) {
    case 'session_expired':
      return '인증 시간이 지났어요. 다시 요청해 주세요.';
    case 'too_many_attempts':
      return '인증번호를 여러 번 틀려 이번 인증이 종료됐어요. 다시 요청해 주세요.';
    case 'invalid_session':
      return '인증 정보를 찾을 수 없어요. 처음부터 다시 진행해 주세요.';
    case 'session_in_progress':
      return '인증을 처리하고 있어요. 잠시 후 다시 시도해 주세요.';
    case 'identity_mismatch':
      return '이 계정에 이미 다른 본인확인 정보가 연결되어 있어요. 고객센터로 문의해 주세요.';
    case 'provider_unavailable':
      return '본인확인 기관에 연결할 수 없어요. 잠시 후 다시 시도해 주세요.';
    case 'phone_login_required':
      return '전화번호로 로그인한 계정에서만 복구할 수 있어요.';
    case 'not_recoverable':
      return '지금은 이 계정을 복구할 수 없어요. 고객센터로 문의해 주세요.';
    default:
      return null;
  }
}

/**
 * delete-account 오류 (#13) — 탈퇴/복구가 서버에 기록되지 않았을 때의 안내. 남용 제한(429)은 대기 시간을 함께 알린다.
 * 문구에 서버 응답 원문은 넣지 않는다.
 */
export function deleteAccountErrorText(e: EdgeError): string {
  const limited = rateLimitedText(e);
  if (limited) return limited;
  switch (e.code) {
    case 'not_allowed':
      return '이 계정은 앱에서 바로 탈퇴할 수 없어요. 고객센터로 문의해 주세요.';
    case 'not_deleted':
      return '탈퇴 상태가 아닌 계정이에요. 앱을 다시 열어 주세요.';
    default:
      return '서버와 연결하는 데 문제가 있어요. 잠시 후 다시 시도해 주세요.';
  }
}
