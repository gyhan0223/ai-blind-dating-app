/**
 * FaceConsentDb 의 Supabase 구현 (Deno, service role). face_consents 는 0030 — 클라이언트는 본인 행 조회만 가능.
 */
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import type { FaceConsentDb } from './faceConsentDb.ts';

export class SupabaseFaceConsentDb implements FaceConsentDb {
  constructor(private readonly db: SupabaseClient) {}

  async hasCurrentConsent(userId: string, kind: string, version: string) {
    const { data, error } = await this.db
      .from('face_consents')
      .select('granted_at')
      .eq('user_id', userId)
      .eq('kind', kind)
      .eq('doc_version', version)
      .is('revoked_at', null)
      .limit(1)
      .maybeSingle();
    if (error) return { ok: false as const };
    return { ok: true as const, consented: !!data, grantedAt: data ? String((data as { granted_at: string }).granted_at) : null };
  }

  async recordConsent(userId: string, kind: string, version: string) {
    // 중복 요청은 unique(user_id, kind, doc_version) 으로 무시 → 기존 행을 돌려준다 (멱등)
    const { error } = await this.db
      .from('face_consents')
      .upsert({ user_id: userId, kind, doc_version: version }, { onConflict: 'user_id,kind,doc_version', ignoreDuplicates: true });
    if (error) return { ok: false as const };
    const existing = await this.hasCurrentConsent(userId, kind, version);
    if (!existing.ok || !existing.grantedAt) return { ok: false as const };
    return { ok: true as const, grantedAt: existing.grantedAt, created: true };
  }
}
