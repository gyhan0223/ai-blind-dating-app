/**
 * FaceDb 의 Supabase 구현 (Deno Edge Function 전용 — service role).
 * RPC / 테이블 / storage 접근을 한 곳에 모아 핵심 로직(순수 모듈)이 supabase-js 에 의존하지 않게 한다.
 *
 * 로그에 경로/URL/토큰을 남기지 않는다. storage 는 private bucket "faces" 만 사용하며 public URL 을 만들지 않는다.
 */
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import type { BeginSessionResult, FaceDb, FaceRow, FaceRowPatch } from './faceDb.ts';
import type { FaceVerificationStatus } from './faceCore.ts';
import { referenceImagePath } from './faceCore.ts';

const FACES_BUCKET = 'faces';

const ROW_COLUMNS =
  'id, user_id, status, provider, provider_session_id, provider_status, provider_event_at, liveness_passed, reference_path, expires_at, attempt_count, created_at';

type RawRow = {
  id: string;
  user_id: string;
  status: FaceVerificationStatus;
  provider: string;
  provider_session_id: string | null;
  provider_status: string | null;
  provider_event_at: string | null;
  liveness_passed: boolean;
  reference_path: string | null;
  expires_at: string | null;
  attempt_count: number;
  created_at: string;
};

function toRow(r: RawRow): FaceRow {
  return {
    id: r.id,
    userId: r.user_id,
    status: r.status,
    provider: r.provider,
    providerSessionId: r.provider_session_id,
    providerStatus: r.provider_status,
    providerEventAt: r.provider_event_at ? new Date(r.provider_event_at) : null,
    livenessPassed: r.liveness_passed,
    referencePath: r.reference_path,
    expiresAt: r.expires_at ? new Date(r.expires_at) : null,
    attemptCount: r.attempt_count,
    createdAt: new Date(r.created_at),
  };
}

export class SupabaseFaceDb implements FaceDb {
  constructor(private readonly db: SupabaseClient) {}

  async beginSession(
    userId: string,
    provider: string,
    limits: { maxPerHour: number; maxPerDay: number },
  ): Promise<BeginSessionResult> {
    const { data, error } = await this.db.rpc('face_liveness_begin_session', {
      p_user_id: userId,
      p_provider: provider,
      p_max_per_hour: limits.maxPerHour,
      p_max_per_day: limits.maxPerDay,
    });
    if (error || !data || typeof data !== 'object') {
      // 마이그레이션 미적용/DB 오류 → 세션을 만들지 않는다 (fail-closed)
      throw new Error('face_liveness_begin_session rpc failed');
    }
    const r = data as Record<string, unknown>;
    switch (r.action) {
      case 'already_verified':
        return { action: 'already_verified' };
      case 'reuse':
        return {
          action: 'reuse',
          id: String(r.id),
          providerSessionId: String(r.provider_session_id),
          expiresAt: String(r.expires_at),
        };
      case 'rate_limited':
        return {
          action: 'rate_limited',
          reason: r.reason === 'daily' ? 'daily' : 'hourly',
          retryAfterSeconds: Number(r.retry_after_seconds ?? 60),
        };
      case 'create':
        return { action: 'create', id: String(r.id), attemptCount: Number(r.attempt_count ?? 1) };
      default:
        throw new Error('face_liveness_begin_session unexpected result');
    }
  }

  async attachProviderSession(
    rowId: string,
    input: { providerSessionId: string; expiresAt: Date; providerStatus: string | null },
  ): Promise<void> {
    const { error } = await this.db
      .from('face_verifications')
      .update({
        provider_session_id: input.providerSessionId,
        expires_at: input.expiresAt.toISOString(),
        provider_status: input.providerStatus,
      })
      .eq('id', rowId);
    if (error) throw new Error('face_verifications attach failed');
  }

  async getRowBySessionId(providerSessionId: string): Promise<FaceRow | null> {
    const { data } = await this.db
      .from('face_verifications')
      .select(ROW_COLUMNS)
      .eq('provider_session_id', providerSessionId)
      .maybeSingle();
    return data ? toRow(data as RawRow) : null;
  }

  async getRowById(id: string): Promise<FaceRow | null> {
    const { data } = await this.db.from('face_verifications').select(ROW_COLUMNS).eq('id', id).maybeSingle();
    return data ? toRow(data as RawRow) : null;
  }

  async getLatestForUser(userId: string): Promise<FaceRow | null> {
    const { data } = await this.db
      .from('face_verifications')
      .select(ROW_COLUMNS)
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    return data ? toRow(data as RawRow) : null;
  }

  async updateRow(rowId: string, patch: FaceRowPatch): Promise<{ ok: true } | { ok: false; error: string }> {
    const update: Record<string, unknown> = {};
    if (patch.status !== undefined) update.status = patch.status;
    if (patch.providerStatus !== undefined) update.provider_status = patch.providerStatus;
    if (patch.providerEventAt !== undefined) update.provider_event_at = patch.providerEventAt?.toISOString() ?? null;
    if (patch.livenessPassed !== undefined) update.liveness_passed = patch.livenessPassed;
    if (patch.livenessScore !== undefined) update.liveness_score = patch.livenessScore;
    if (patch.livenessMethod !== undefined) update.liveness_method = patch.livenessMethod;
    if (patch.providerReason !== undefined) update.provider_reason = patch.providerReason;
    if (patch.referencePath !== undefined) update.reference_path = patch.referencePath;
    if (patch.expiresAt !== undefined) update.expires_at = patch.expiresAt?.toISOString() ?? null;

    const { error } = await this.db.from('face_verifications').update(update).eq('id', rowId);
    // 트리거(전이 보호)가 거부하면 error.code = P0001 — 호출자가 ignored 로 처리한다
    if (error) return { ok: false, error: error.code ?? 'db_error' };
    return { ok: true };
  }

  async setUserFaceVerified(userId: string): Promise<{ ok: boolean }> {
    const { error } = await this.db.from('users').update({ face_verified: true }).eq('id', userId);
    return { ok: !error };
  }

  async isUserFaceVerified(userId: string): Promise<boolean> {
    const { data } = await this.db.from('users').select('face_verified').eq('id', userId).maybeSingle();
    return data?.face_verified === true;
  }

  async storeReferenceImage(
    userId: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<{ ok: true; path: string } | { ok: false }> {
    const path = referenceImagePath(userId, contentType);
    const { error } = await this.db.storage.from(FACES_BUCKET).upload(path, bytes, {
      contentType,
      upsert: true,
    });
    if (error) return { ok: false };
    return { ok: true, path };
  }
}
