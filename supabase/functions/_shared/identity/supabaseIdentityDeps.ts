/**
 * verifyIdentityCore 의 DB/Auth 어댑터 — Supabase(service role) 구현 (Deno 전용).
 * 여기에는 판단 로직이 없다. 각 메서드는 코어가 요구하는 "조건부" 의미(0행이면 실패)를 그대로 SQL 조건으로 옮긴다.
 * 오류는 null/false/'error' 로 돌려주고 메시지에 개인정보를 싣지 않는다.
 */
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import type { DeviceEventType, IdentityAuth, IdentityDb, IdentityRow, SessionPatch, SessionRow, SessionStatus } from './verifyIdentityCore.ts';

type Row = Record<string, unknown>;

function toSession(r: Row): SessionRow {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    provider: String(r.provider),
    providerSessionId: (r.provider_session_id as string | null) ?? null,
    status: r.status as SessionStatus,
    outcome: (r.outcome as SessionRow['outcome']) ?? null,
    identityKeyHash: (r.identity_key_hash as string | null) ?? null,
    birthDate: (r.birth_date as string | null) ?? null,
    gender: (r.gender as SessionRow['gender']) ?? null,
    ownerUserId: (r.owner_user_id as string | null) ?? null,
    attempts: Number(r.attempts ?? 0),
    expiresAt: String(r.expires_at),
    checkingSince: (r.checking_since as string | null) ?? null,
  };
}

function toPatch(p: SessionPatch): Row {
  const out: Row = {};
  if (p.status !== undefined) out.status = p.status;
  if (p.outcome !== undefined) out.outcome = p.outcome;
  if (p.identityKeyHash !== undefined) out.identity_key_hash = p.identityKeyHash;
  if (p.birthDate !== undefined) out.birth_date = p.birthDate;
  if (p.gender !== undefined) out.gender = p.gender;
  if (p.ownerUserId !== undefined) out.owner_user_id = p.ownerUserId;
  if (p.attempts !== undefined) out.attempts = p.attempts;
  if (p.expiresAt !== undefined) out.expires_at = p.expiresAt;
  if (p.checkingSince !== undefined) out.checking_since = p.checkingSince;
  if (p.consumedAt !== undefined) out.consumed_at = p.consumedAt;
  return out;
}

function toIdentity(r: Row | null): IdentityRow | null {
  if (!r) return null;
  return { id: String(r.id), userId: (r.user_id as string | null) ?? null, banned: Boolean(r.banned) };
}

export function supabaseIdentityDb(db: SupabaseClient): IdentityDb {
  const sessions = () => db.from('identity_verification_sessions');
  return {
    async createSession(input) {
      const { data, error } = await sessions()
        .insert({ user_id: input.userId, provider: input.provider, provider_session_id: input.providerSessionId, expires_at: input.expiresAt })
        .select('id')
        .single();
      return error || !data ? null : { id: String(data.id) };
    },
    async getSession(id) {
      const { data, error } = await sessions().select('*').eq('id', id).maybeSingle();
      return error || !data ? null : toSession(data as Row);
    },
    async claimSession(id, userId, nowIso, staleBeforeIso) {
      const { data, error } = await sessions()
        .update({ status: 'checking', checking_since: nowIso })
        .eq('id', id)
        .eq('user_id', userId)
        .gt('expires_at', nowIso)
        .or(`status.eq.pending,and(status.eq.checking,checking_since.lt.${staleBeforeIso})`)
        .select('*');
      if (error || !data || data.length !== 1) return null;
      return toSession(data[0] as Row);
    },
    async updateSession(id, patch, expectStatus) {
      const { data, error } = await sessions().update(toPatch(patch)).eq('id', id).eq('status', expectStatus).select('id');
      return !error && !!data && data.length === 1;
    },
    async findIdentityByHash(hash) {
      const { data, error } = await db.from('user_identities').select('id, user_id, banned').eq('identity_key_hash', hash).maybeSingle();
      return error ? null : toIdentity((data as Row | null) ?? null);
    },
    async findIdentityByUser(userId) {
      const { data, error } = await db.from('user_identities').select('id, user_id, banned').eq('user_id', userId).maybeSingle();
      return error ? null : toIdentity((data as Row | null) ?? null);
    },
    async getUser(userId) {
      const { data, error } = await db.from('users').select('status, phone, identity_verified').eq('id', userId).maybeSingle();
      if (error || !data) return null;
      return { status: String(data.status), phone: (data.phone as string | null) ?? null, identityVerified: Boolean(data.identity_verified) };
    },
    async insertIdentity(row) {
      const { error } = await db.from('user_identities').insert({
        user_id: row.userId,
        identity_key_hash: row.identityKeyHash,
        identity_verified_at: row.verifiedAt,
        birth_date: row.birthDate,
        gender: row.gender,
        adult_verified_at: row.verifiedAt,
      });
      if (!error) return 'ok';
      return error.code === '23505' ? 'conflict' : 'error';
    },
    async relinkIdentity(id, userId, birthDate, gender, verifiedAt) {
      const { data, error } = await db
        .from('user_identities')
        .update({ user_id: userId, identity_verified_at: verifiedAt, adult_verified_at: verifiedAt, birth_date: birthDate, gender })
        .eq('id', id)
        .is('user_id', null)
        .select('id');
      if (error || !data) return 0;
      return data.length;
    },
    async markUserVerified(userId) {
      const { error } = await db.from('users').update({ identity_verified: true, age_verified: true }).eq('id', userId);
      return !error;
    },
    async upsertPrivateProfile(userId, birthDate, phoneE164) {
      const { error } = await db.from('private_profiles').upsert({ user_id: userId, birth_date: birthDate, phone: phoneE164 });
      return !error;
    },
    async setUserPhone(userId, phoneE164, atIso) {
      const { error } = await db.from('users').update({ phone: phoneE164, phone_verified_at: atIso }).eq('id', userId);
      return !error;
    },
    async reactivateIfDeleted(userId) {
      const { error } = await db.from('users').update({ status: 'active' }).eq('id', userId).eq('status', 'deleted');
      return !error;
    },
    async logEvent(userId, eventType: DeviceEventType, meta) {
      // meta 에는 사유 코드·단계·성공 여부만 (전화번호·identityKey·인증번호 없음)
      await db.from('device_events').insert({ user_id: userId, event_type: eventType, meta });
    },
  };
}

export function supabaseIdentityAuth(db: SupabaseClient): IdentityAuth {
  return {
    async getUser(userId) {
      const { data, error } = await db.auth.admin.getUserById(userId);
      if (error || !data?.user) return null;
      const u = data.user as { phone?: string | null; phone_confirmed_at?: string | null };
      return { phoneE164: u.phone ? (u.phone.startsWith('+') ? u.phone : `+${u.phone}`) : null, phoneConfirmed: !!u.phone && !!u.phone_confirmed_at };
    },
    async deleteUser(userId) {
      const { error } = await db.auth.admin.deleteUser(userId);
      return !error;
    },
    async updateUserPhone(userId, phoneE164) {
      const { error } = await db.auth.admin.updateUserById(userId, { phone: phoneE164.replace(/^\+/, ''), phone_confirm: true });
      return !error;
    },
  };
}
