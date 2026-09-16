/**
 * face_asset_cleanup 큐 (0029) — Supabase 구현 (Deno, service role).
 */
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import type { CleanupItem, FaceCleanupQueue } from './faceAssetCleanupCore.ts';

export class SupabaseFaceCleanupQueue implements FaceCleanupQueue {
  constructor(private readonly db: SupabaseClient) {}

  async claim(limit: number) {
    const { data, error } = await this.db.rpc('face_asset_cleanup_claim', { p_limit: limit });
    if (error || !Array.isArray(data)) return { ok: false as const };
    const items: CleanupItem[] = (data as Record<string, unknown>[]).map((r) => ({
      id: String(r.id),
      userId: String(r.user_id),
      storagePath: typeof r.storage_path === 'string' ? r.storage_path : null,
      provider: typeof r.provider === 'string' ? r.provider : null,
      providerSessionId: typeof r.provider_session_id === 'string' ? r.provider_session_id : null,
      attemptCount: Number(r.attempt_count ?? 0),
    }));
    return { ok: true as const, items };
  }

  async finish(id: string, outcome: 'done' | 'failed', code: string | null) {
    const { error } = await this.db.rpc('face_asset_cleanup_finish', { p_id: id, p_outcome: outcome, p_error_code: code });
    return { ok: !error };
  }
}
