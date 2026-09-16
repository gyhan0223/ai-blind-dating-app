/**
 * 종료된 얼굴 세션의 자산 정리 (#11) — 순수 모듈. #13 의 Storage/Provider 삭제 실행기와 재시도 구조를 공유한다.
 *
 * 정리 대상은 DB 트리거가 face_asset_cleanup 큐에 넣는다 (0029): expired / rejected / superseded 로 끝난 세션의
 * 세션별 reference image 경로(<uid>/liveness/<row id>/...) 와 Provider 세션 id. 큐의 claim RPC 가 다음을 다시 확인한다.
 *   - 그 행이 지금도 종료 상태인가 (늦은 웹훅으로 approved 가 됐으면 정리하지 않는다)
 *   - 그 경로를 승인된 행이 참조하고 있지 않은가 (구 고정 경로 <uid>/liveness/reference.jpg 보호)
 *   - 계정 삭제 작업(#13)이 있는 사용자는 제외 (삭제 작업이 전부 지운다)
 * 여기서는 claim 이 돌려준 항목만 처리하고, 각 항목의 결과(done/failed + 고정 코드)를 큐에 되돌린다.
 */
import { deleteProviderSessions, deleteUserPaths, type PurgeLogger, type PurgeProvider, type PurgeStorage } from './accountPurgeCore.ts';

export type CleanupItem = {
  id: string;
  userId: string;
  storagePath: string | null;
  provider: string | null;
  providerSessionId: string | null;
  attemptCount: number;
};

export interface FaceCleanupQueue {
  claim(limit: number): Promise<{ ok: true; items: CleanupItem[] } | { ok: false }>;
  finish(id: string, outcome: 'done' | 'failed', code: string | null): Promise<{ ok: boolean }>;
}

export type FaceCleanupDeps = {
  storage: PurgeStorage;
  provider: PurgeProvider | null;
  queue: FaceCleanupQueue;
  log: PurgeLogger;
};

export type FaceCleanupResult = { ok: boolean; processed: number; succeeded: number; failed: number };

export async function cleanupOne(item: CleanupItem, deps: FaceCleanupDeps): Promise<{ ok: true } | { ok: false; code: string }> {
  if (item.storagePath) {
    const s = await deleteUserPaths(deps.storage, item.userId, [item.storagePath]);
    if (!s.ok) return { ok: false, code: s.code };
  }
  if (item.providerSessionId) {
    const p = await deleteProviderSessions(deps.provider, [
      { provider: item.provider ?? '', session_id: item.providerSessionId, deleted: false },
    ]);
    if (!p.ok) return { ok: false, code: p.code };
  }
  return { ok: true };
}

export async function runFaceAssetCleanup(input: { limit: number }, deps: FaceCleanupDeps): Promise<FaceCleanupResult> {
  const claimed = await deps.queue.claim(input.limit);
  if (!claimed.ok) {
    deps.log.error('[face-cleanup] queue unavailable');
    return { ok: false, processed: 0, succeeded: 0, failed: 0 };
  }
  let succeeded = 0;
  let failed = 0;
  for (const item of claimed.items) {
    const res = await cleanupOne(item, deps);
    if (res.ok) {
      succeeded += 1;
      await deps.queue.finish(item.id, 'done', null);
    } else {
      failed += 1;
      deps.log.warn(`[face-cleanup] item failed (${res.code}, attempt ${item.attemptCount + 1})`);
      await deps.queue.finish(item.id, 'failed', res.code);
    }
  }
  return { ok: true, processed: claimed.items.length, succeeded, failed };
}
