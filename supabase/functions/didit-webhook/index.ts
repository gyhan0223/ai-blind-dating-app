/**
 * didit-webhook — Didit 이 세션 상태 변화를 알려주는 공개 Edge Function (JWT 없음).
 *
 * 배포 (반드시 --no-verify-jwt — Didit 은 Supabase JWT 를 보내지 않는다):
 *   bash:        supabase functions deploy didit-webhook --no-verify-jwt --project-ref <PROJECT_REF>
 *   PowerShell:  supabase functions deploy didit-webhook --no-verify-jwt --project-ref <PROJECT_REF>
 *                (한 줄 명령. 여러 줄로 나눌 때는 Bash 의 `\` 대신 백틱(`) 을 사용한다)
 *
 * Didit 콘솔의 웹훅 destination 은 반드시 **V3** (webhook_version: v3) 로 등록한다 — event_id · plural-array decision.
 * 세션 이벤트(status.updated / data.updated)만 처리하고 user.* / business.* / transaction.* 등은 무시한다.
 *
 * 호출자 인증 = X-Signature-V2 HMAC-SHA256 검증 (DIDIT_WEBHOOK_SECRET) + X-Timestamp ±5분.
 * 서명이 맞아도 웹훅의 status 를 그대로 믿지 않는다 — 최종 상태는 서버가 Didit Decision API(v3) 를
 * 직접 재조회해 판정하며, 조회에 실패하면 승인하지 않고 503 을 돌려준다 (Didit 이 재시도).
 *
 * 멱등: 같은 event_id 재전송은 Decision 재조회 없이 200 duplicate (face_webhook_events). created_at 기준 순서 역전 보호.
 * 오래된 이벤트는 승인 상태를 되돌리지 못한다 (DB 트리거가 최종 방어). 승인은 RPC face_liveness_approve 한 트랜잭션.
 * 전체 payload · workflow_id · application/environment 원문은 저장하지 않는다. 로그에는 세션 id 축약값과 고정 코드만 남긴다.
 *
 * 필수 서버 환경변수: FACE_VERIFICATION_PROVIDER=didit · DIDIT_API_KEY · DIDIT_WORKFLOW_ID · DIDIT_WEBHOOK_SECRET
 */
import { requireFaceProviderKind } from '../_shared/env/env.ts';
import { json, serviceClient } from '../_shared/http.ts';
import { handleDiditWebhook } from '../_shared/face/diditWebhookCore.ts';
import { getFaceLivenessProvider } from '../_shared/face/FaceLivenessProvider.ts';
import { SupabaseFaceDb } from '../_shared/face/supabaseFaceDb.ts';

const provider = getFaceLivenessProvider(
  requireFaceProviderKind(),
  (name) => Deno.env.get(name),
  (input, init) => fetch(input, init),
);

const WEBHOOK_SECRET = Deno.env.get('DIDIT_WEBHOOK_SECRET') ?? null;
if (!WEBHOOK_SECRET) {
  console.error('[didit-webhook] DIDIT_WEBHOOK_SECRET 미설정 — 모든 요청을 거부합니다 (fail-closed)');
}

const log = {
  info: (m: string) => console.log(m),
  warn: (m: string) => console.warn(m),
  error: (m: string) => console.error(m),
};

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const rawBody = await req.text();
  try {
    const res = await handleDiditWebhook(
      {
        rawBody,
        headers: {
          signatureV2: req.headers.get('x-signature-v2'),
          timestamp: req.headers.get('x-timestamp'),
        },
      },
      { webhookSecret: WEBHOOK_SECRET, provider, db: new SupabaseFaceDb(serviceClient()), now: () => new Date(), log },
    );
    return json(res.body, res.status);
  } catch (err) {
    console.error(`[didit-webhook] ${err instanceof Error ? err.message : 'error'}`);
    return json({ error: 'server_error' }, 500);
  }
});
