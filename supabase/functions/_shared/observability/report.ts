/**
 * Edge Function 오류 보고 (#20) — 마스킹 후 server_errors 에 기록한다. 실패해도 예외를 던지지 않는다.
 *
 * 사용: catch (e) { await reportServerError(db, 'send-push', e, { stage: 'dequeue' }); }
 * SENTRY_DSN 이 설정돼 있으면 같은 내용을 Sentry Store API 로도 보낸다 (선택, best effort — SDK 없이 HTTP 한 번).
 */
import { redact, safeErrorMessage, sanitizeContext } from './redact.ts';

type RpcClient = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ error: { message: string } | null }> };

function env(name: string): string | undefined {
  try {
    return (globalThis as { Deno?: { env: { get: (n: string) => string | undefined } } }).Deno?.env.get(name);
  } catch {
    return undefined;
  }
}

export async function reportServerError(
  db: RpcClient,
  fn: string,
  err: unknown,
  context: Record<string, unknown> = {},
): Promise<void> {
  const safe = safeErrorMessage(err);
  const ctx = sanitizeContext({ ...context, function: fn });
  const environment = env('APP_ENV') ?? null;
  const release = env('RELEASE') ?? null;
  console.error(`[${fn}] ${safe.name}: ${safe.message}`);
  try {
    await db.rpc('record_server_error', {
      p_function: fn,
      p_message: safe.message,
      p_name: safe.name,
      p_stack: safe.stack,
      p_context: ctx,
      p_environment: environment,
      p_release: release,
    });
  } catch {
    // 기록 실패는 무시 (오류 보고가 원래 요청을 깨지 않게)
  }
  const dsn = env('SENTRY_DSN');
  if (dsn) await sendToSentry(dsn, fn, safe, ctx, environment, release).catch(() => {});
}

/** Sentry Store API (SDK 없이). DSN 형식: https://<key>@<host>/<project> */
async function sendToSentry(
  dsn: string,
  fn: string,
  safe: { message: string; name: string; stack: string | null },
  ctx: Record<string, unknown>,
  environment: string | null,
  release: string | null,
): Promise<void> {
  const m = dsn.match(/^https:\/\/([^@]+)@([^/]+)\/(\d+)$/);
  if (!m) return;
  const [, key, host, project] = m;
  const body = {
    event_id: crypto.randomUUID().replace(/-/g, ''),
    timestamp: new Date().toISOString(),
    platform: 'javascript',
    level: 'error',
    logger: fn,
    environment: environment ?? undefined,
    release: release ?? undefined,
    tags: { function: fn },
    extra: ctx,
    exception: { values: [{ type: safe.name, value: redact(safe.message, 500) }] },
  };
  await fetch(`https://${host}/api/${project}/store/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${key}, sentry_client=bonsim-edge/1.0`,
    },
    body: JSON.stringify(body),
  });
}
