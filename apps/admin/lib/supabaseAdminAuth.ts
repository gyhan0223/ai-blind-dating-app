/**
 * adminAuthCore 의 Supabase 구현 — GoTrue(비밀번호 · 관리형 TOTP MFA) + DB RPC(0033). 서버에서만 import 한다.
 *
 * 사용자 범위 호출(mfa.enroll/challenge/verify/unenroll, updateUser)은 요청마다 새 클라이언트를 만들고
 * setSession(access, refresh) 으로 그 사용자의 세션을 넣은 뒤 부른다 (persistSession=false — 아무것도 저장하지 않는다).
 * 관리 호출(createUser · mfa.deleteFactor · getUserById)은 service role 클라이언트.
 * 이 파일은 console 을 쓰지 않는다 — secret · QR · 코드 · 토큰이 로그에 남지 않게.
 *
 * 계약 (supabase-js v2 / GoTrue MFA — https://supabase.com/docs/guides/auth/auth-mfa):
 *   enroll({factorType:'totp'}) → { id, totp: { qr_code, secret, uri } } (status unverified)
 *   challenge({factorId}) → { id }  ·  verify({factorId, challengeId, code}) → aal2 세션 (unverified factor 는 verified 로)
 *   mfa.getAuthenticatorAssuranceLevel(jwt) → { currentLevel }  · unenroll 은 verified factor 에 aal2 필요
 *   admin.mfa.deleteFactor({ id, userId }) — 서버 전용 복구
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { AdminAuthProvider, AdminDirectory, AdminRole, AuthTokens, MemberInfo } from './adminAuthCore.ts';
import { type GuardEvent, type GuardHit, LOGIN_LOCK_SECONDS, LOGIN_MAX_FAILURES, type LoginGuardStore } from './adminSessionCore.ts';
import { adminClient } from './supabaseAdmin.ts';

function anonUrlKey(): { url: string; key: string } {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_ANON_KEY 환경변수가 필요합니다 (관리자 로그인 · docs/environments.md)');
  return { url, key };
}

async function userClient(tokens: AuthTokens): Promise<SupabaseClient | null> {
  const { url, key } = anonUrlKey();
  const c = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const { error } = await c.auth.setSession({ access_token: tokens.accessToken, refresh_token: tokens.refreshToken });
  return error ? null : c;
}

export function supabaseAdminAuthProvider(): AdminAuthProvider {
  return {
    async signInWithPassword(email, password) {
      let c: SupabaseClient;
      try {
        const { url, key } = anonUrlKey();
        c = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
      } catch {
        return { ok: false, reason: 'unavailable' };
      }
      try {
        const { data, error } = await c.auth.signInWithPassword({ email, password });
        if (error) {
          // 자격 증명 오류(400/invalid_credentials) 와 장애를 구분한다 — 장애는 실패로 세지 않는다
          const status = (error as { status?: number }).status ?? 0;
          return { ok: false, reason: status >= 500 || status === 0 ? 'unavailable' : 'bad_credentials' };
        }
        if (!data.session || !data.user) return { ok: false, reason: 'bad_credentials' };
        return { ok: true, userId: data.user.id, tokens: { accessToken: data.session.access_token, refreshToken: data.session.refresh_token } };
      } catch {
        return { ok: false, reason: 'unavailable' };
      }
    },
    async listFactors(tokens) {
      try {
        const c = await userClient(tokens);
        if (!c) return { ok: false };
        const { data, error } = await c.auth.mfa.listFactors();
        if (error || !data) return { ok: false };
        const totp = data.all.filter((f) => f.factor_type === 'totp');
        return { ok: true, verified: totp.filter((f) => f.status === 'verified').map((f) => f.id), unverified: totp.filter((f) => f.status !== 'verified').map((f) => f.id) };
      } catch {
        return { ok: false };
      }
    },
    async enrollTotp(tokens, friendlyName) {
      try {
        const c = await userClient(tokens);
        if (!c) return { ok: false };
        const { data, error } = await c.auth.mfa.enroll({ factorType: 'totp', friendlyName });
        if (error || !data) return { ok: false };
        return { ok: true, factorId: data.id, qrCodeSvg: data.totp.qr_code, secret: data.totp.secret, uri: data.totp.uri };
      } catch {
        return { ok: false };
      }
    },
    async unenroll(tokens, factorId) {
      try {
        const c = await userClient(tokens);
        if (!c) return false;
        const { error } = await c.auth.mfa.unenroll({ factorId });
        return !error;
      } catch {
        return false;
      }
    },
    async challengeAndVerify(tokens, factorId, code) {
      try {
        const c = await userClient(tokens);
        if (!c) return { ok: false, reason: 'unavailable' };
        const ch = await c.auth.mfa.challenge({ factorId });
        if (ch.error || !ch.data) return { ok: false, reason: ((ch.error as { status?: number } | null)?.status ?? 0) >= 500 ? 'unavailable' : 'bad_code' };
        const v = await c.auth.mfa.verify({ factorId, challengeId: ch.data.id, code });
        if (v.error || !v.data) {
          const status = (v.error as { status?: number } | null)?.status ?? 0;
          return { ok: false, reason: status >= 500 || status === 0 ? 'unavailable' : 'bad_code' };
        }
        return { ok: true, tokens: { accessToken: v.data.access_token, refreshToken: v.data.refresh_token } };
      } catch {
        return { ok: false, reason: 'unavailable' };
      }
    },
    async assuranceLevel(accessToken) {
      try {
        const { url, key } = anonUrlKey();
        const c = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
        // jwt 를 넘기면 GoTrue 에 사용자·factor 를 조회해 판단한다 (네트워크). 서버가 검증한 수준만 신뢰한다
        const { data, error } = await c.auth.mfa.getAuthenticatorAssuranceLevel(accessToken);
        if (error || !data) return null;
        return data.currentLevel === 'aal2' ? 'aal2' : 'aal1';
      } catch {
        return null;
      }
    },
    async updatePassword(tokens, newPassword) {
      try {
        const c = await userClient(tokens);
        if (!c) return { ok: false, reason: 'unavailable' };
        const { error } = await c.auth.updateUser({ password: newPassword });
        return error ? { ok: false, reason: 'rejected' } : { ok: true };
      } catch {
        return { ok: false, reason: 'unavailable' };
      }
    },
    async signOut(accessToken) {
      try {
        await adminClient().auth.admin.signOut(accessToken, 'local');
      } catch {
        // best effort — 우리 세션은 DB 행이 결정한다
      }
    },
    async emailOf(userId) {
      try {
        const { data, error } = await adminClient().auth.admin.getUserById(userId);
        return error || !data?.user?.email ? null : data.user.email;
      } catch {
        return null;
      }
    },
    async createAdminUser(email, password) {
      try {
        const { data, error } = await adminClient().auth.admin.createUser({
          email,
          password,
          email_confirm: true,
          app_metadata: { bonsim_admin: 'true' }, // 앱 사용자 행(public.users)을 만들지 않는 표식 — 권한 근거는 admin_members
        });
        if (error || !data?.user) return { ok: false, reason: error?.message?.includes('already') ? 'already_exists' : 'rejected' };
        return { ok: true, userId: data.user.id };
      } catch {
        return { ok: false, reason: 'unavailable' };
      }
    },
    async deleteAllFactors(userId) {
      try {
        const admin = adminClient().auth.admin;
        const { data, error } = await admin.mfa.listFactors({ userId });
        if (error || !data) return false;
        for (const f of data.factors) {
          const r = await admin.mfa.deleteFactor({ id: f.id, userId });
          if (r.error) return false;
        }
        return true;
      } catch {
        return false;
      }
    },
  };
}

const dbGuardStore: LoginGuardStore = {
  async hit(key: string, event: GuardEvent): Promise<GuardHit | null> {
    try {
      const { data, error } = await adminClient().rpc('admin_login_guard', { p_key: key, p_event: event, p_max_failures: LOGIN_MAX_FAILURES, p_lock_seconds: LOGIN_LOCK_SECONDS });
      if (error || typeof data !== 'object' || data === null) return null;
      const r = data as { locked?: unknown; locked_seconds?: unknown; failures?: unknown };
      if (typeof r.locked !== 'boolean') return null;
      return { locked: r.locked, lockedSeconds: Number(r.locked_seconds ?? 0), failures: Number(r.failures ?? 0) };
    } catch {
      return null;
    }
  },
};

function asRole(v: unknown): AdminRole | null {
  return v === 'owner' || v === 'viewer' ? v : null;
}

export function supabaseAdminDirectory(): AdminDirectory {
  return {
    async member(userId) {
      try {
        const { data, error } = await adminClient().from('admin_members').select('role, status, display_name').eq('user_id', userId).maybeSingle();
        if (error) return 'unavailable';
        if (!data) return null;
        const role = asRole(data.role);
        if (!role) return 'unavailable';
        return { role, status: data.status === 'active' ? 'active' : 'disabled', displayName: String(data.display_name) } satisfies MemberInfo;
      } catch {
        return 'unavailable';
      }
    },
    async sessionIssue(userId, ttlSeconds) {
      try {
        const { data, error } = await adminClient().rpc('admin_session_issue', { p_member: userId, p_ttl_seconds: ttlSeconds });
        const r = data as { ok?: boolean; session_id?: string; role?: string; display_name?: string } | null;
        if (error || !r?.ok || !r.session_id) return null;
        const role = asRole(r.role);
        if (!role) return null;
        return { sessionId: r.session_id, role, displayName: String(r.display_name ?? '') };
      } catch {
        return null;
      }
    },
    async sessionCheck(sessionId) {
      try {
        const { data, error } = await adminClient().rpc('admin_session_check', { p_session_id: sessionId });
        if (error) return null;
        const r = data as { ok?: boolean; user_id?: string; role?: string; display_name?: string } | null;
        if (!r?.ok || !r.user_id) return { ok: false };
        const role = asRole(r.role);
        if (!role) return { ok: false };
        return { ok: true, userId: r.user_id, role, displayName: String(r.display_name ?? '') };
      } catch {
        return null;
      }
    },
    async sessionRevoke(sessionId) {
      try {
        const { data, error } = await adminClient().rpc('admin_session_revoke', { p_session_id: sessionId });
        return !error && data === true;
      } catch {
        return false;
      }
    },
    async revokeAllSessions(actorUserId, targetUserId, reason) {
      try {
        const { data, error } = await adminClient().rpc('admin_member_revoke_sessions', { p_actor: actorUserId, p_target: targetUserId, p_reason: reason });
        return !error && (data as { ok?: boolean } | null)?.ok === true;
      } catch {
        return false;
      }
    },
    async legacyAllowed() {
      try {
        const { data, error } = await adminClient().rpc('admin_legacy_login_allowed');
        if (error || typeof data !== 'boolean') return null;
        return data;
      } catch {
        return null;
      }
    },
    guard: dbGuardStore,
    async audit(actor, action, targetType, targetId, detail) {
      const { recordAdminAuditRaw } = await import('./audit.ts');
      await recordAdminAuditRaw(actor, action, targetType, targetId, detail);
    },
  };
}
