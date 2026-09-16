/**
 * 계정 익명화·완전 삭제 (#13/#11/#14) — service role 전용 (사용자 JWT 는 401).
 *
 * POST { user_id, hard?: boolean, requested_by?: string }  → 한 계정 처리 (status 가 deleted/banned 여야 한다)
 * POST { batch: true, grace_days?: 30, limit?: 100 }        → 유예가 지난 탈퇴 계정 + 실패한 작업 재시도 (cron 일 1회)
 * POST { face_cleanup: true, limit?: 50 }                    → 종료된 얼굴 세션의 자산 정리 큐 처리 (#11, cron)
 *
 * 작업 상태 (0028 account_purge_jobs — 단계별 done/failed/skipped · lease · 시도 횟수 · Provider 세션 스냅샷)
 *   storage → provider → db → (hard) auth. 실패한 단계는 다음 호출에서 이어서 처리하고, 완료한 단계는 건너뛴다.
 *   외부 삭제(Storage·Provider)가 실패하면 전체 완료로 보고하지 않는다 (status: failed, retryable: true, stages.<단계>.error 코드).
 *   Provider 설정이 없는 환경에서는 provider 단계가 provider_not_configured 로 남는다 (건너뛰지 않는다).
 *
 * 응답·로그·감사 기록에는 고정 코드·수치만 담는다 (경로·세션 id·오류 원문·개인정보 없음).
 * 핵심 로직: _shared/purge/accountPurgeCore.ts (selftest 로 실패·재시도·동시성·페이지 제한 시나리오 검증)
 */
import { requireFaceProviderKind } from '../_shared/env/env.ts';
import { getFaceLivenessProvider } from '../_shared/face/FaceLivenessProvider.ts';
import { corsHeaders, json, requireServiceRole, serviceClient } from '../_shared/http.ts';
import { runAccountPurge, runAccountPurgeBatch } from '../_shared/purge/accountPurgeCore.ts';
import { runFaceAssetCleanup } from '../_shared/purge/faceAssetCleanupCore.ts';
import { SupabaseFaceCleanupQueue } from '../_shared/purge/supabaseFaceCleanupQueue.ts';
import {
  purgeFailureReporter,
  purgeProviderFrom,
  SupabasePurgeAuth,
  SupabasePurgeJobs,
  SupabasePurgeStorage,
} from '../_shared/purge/supabasePurgeDeps.ts';

const log = {
  info: (m: string) => console.log(m),
  warn: (m: string) => console.warn(m),
  error: (m: string) => console.error(m),
};

/** Provider 설정이 없으면 null — provider 단계는 실패로 기록되어 재시도 대상으로 남는다 (건너뛰지 않는다) */
function providerOrNull() {
  try {
    return getFaceLivenessProvider(requireFaceProviderKind(), (name) => Deno.env.get(name), (input, init) => fetch(input, init));
  } catch (e) {
    log.error(`[account-purge] face provider not configured: ${e instanceof Error ? e.message.slice(0, 120) : 'error'}`);
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const gate = requireServiceRole(req);
  if (gate instanceof Response) return gate;

  const body = (await req.json().catch(() => ({}))) as {
    user_id?: string;
    hard?: boolean;
    requested_by?: string;
    batch?: boolean;
    grace_days?: number;
    limit?: number;
    face_cleanup?: boolean;
  };
  const db = serviceClient();
  const provider = purgeProviderFrom(providerOrNull());
  const deps = {
    storage: new SupabasePurgeStorage(db),
    provider,
    jobs: new SupabasePurgeJobs(db),
    auth: new SupabasePurgeAuth(db),
    log,
    reportFailure: purgeFailureReporter(db, 'account-purge'),
  };

  try {
    if (body.face_cleanup) {
      const limit = Math.max(1, Math.min(200, Number(body.limit) || 50));
      const res = await runFaceAssetCleanup({ limit }, { storage: deps.storage, provider, queue: new SupabaseFaceCleanupQueue(db), log });
      return json(res, res.ok ? 200 : 503);
    }

    if (body.batch) {
      const graceDays = Math.max(0, Math.min(365, Number(body.grace_days) || 30));
      const limit = Math.max(1, Math.min(500, Number(body.limit) || 100));
      const res = await runAccountPurgeBatch({ graceDays, limit }, deps);
      return json(res, res.ok ? 200 : 500);
    }

    if (!body.user_id || typeof body.user_id !== 'string') return json({ error: 'invalid_body' }, 400);
    const requestedBy = typeof body.requested_by === 'string' ? body.requested_by.slice(0, 64) : 'admin';
    const result = await runAccountPurge({ userId: body.user_id, mode: body.hard === true ? 'hard' : 'anonymize', requestedBy }, deps);
    const status =
      result.status === 'done' ? 200 : result.status === 'not_found' ? 404 : result.status === 'error' ? 500 : 409;
    return json(result, status);
  } catch (err) {
    console.error(`[account-purge] ${err instanceof Error ? err.message.slice(0, 200) : 'error'}`);
    return json({ error: 'server_error' }, 500);
  }
});
