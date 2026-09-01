/**
 * 본인 인증 Edge Function — 1인 1계정 보장의 서버 측 핵심.
 *
 * users.identity_verified / age_verified 와 user_identities 는 클라이언트가 직접
 * 수정할 수 없으므로 (DB 트리거 + RLS 무정책) 반드시 이 함수를 통해 갱신된다.
 *
 * POST { action: 'request', name, birthDate, carrier }
 *   → { requestId }
 * POST { action: 'confirm', requestId, code, name, birthDate, carrier }
 *   → { verified: true,  result: 'created' | 'already_verified' | 'relinked' }
 *   → { verified: false, result: 'existing_account', maskedPhone }   ← 복구 flow 로
 *   → { verified: false, result: 'blocked' | 'underage', reason }
 * POST { action: 'recover', requestId, code, name, birthDate, carrier }
 *   → 기존 계정에 현재 로그인 전화번호를 연결 (자동 overwrite 아님 — 사용자가 확인한 뒤 호출)
 *   → { recovered: true }  이후 클라이언트는 재로그인해야 한다.
 *
 * 1인 1계정 3중 방어:
 *   1) confirm 시 identity_key_hash 조회로 분기 (UX)
 *   2) insert 시 unique 위반 catch 후 재조회 (동시 가입 race)
 *   3) DB UNIQUE(identity_key_hash) — 최종 방어선
 *
 * 개인정보: raw identityKey / DI / 본인확인 응답 전문은 저장·로그하지 않는다.
 */
import { requireIdentitySecret } from '../_shared/env/env.ts';
import { corsHeaders, json, requireUser, serviceClient } from '../_shared/http.ts';
import {
  getIdentityProvider,
  type IdentityRequestInput,
} from '../_shared/identity/IdentityVerificationProvider.ts';
import {
  decideIdentityOutcome,
  hashIdentityKey,
  isAdult,
  maskPhone,
  type ExistingIdentity,
} from '../_shared/identity/identityCore.ts';

/**
 * cold start 시 secret 검증 (Issue #3 — fail-fast, 자동 fallback 금지):
 *   development                → 미설정이면 개발 fixture secret 사용 (seed 해시와 일치)
 *   staging / production       → IDENTITY_HASH_SECRET 미설정·개발 기본값·32자 미만이면
 *                                여기서 throw 되어 함수가 아예 요청을 받지 않는다.
 *   APP_ENV 누락/알 수 없는 값 → production 취급 (fail-closed)
 * secret 값 자체는 로그/오류 어디에도 출력하지 않는다.
 */
const IDENTITY_SECRET = requireIdentitySecret();

async function logDeviceEvent(
  db: ReturnType<typeof serviceClient>,
  userId: string | null,
  eventType: string,
  meta: Record<string, unknown> = {},
) {
  // meta 에는 민감정보(전화번호 원본, identityKey, 인증번호 등)를 절대 넣지 않는다
  await db.from('device_events').insert({ user_id: userId, event_type: eventType, meta });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  const body = await req.json().catch(() => null);
  if (!body) return json({ error: 'invalid_body' }, 400);

  const db = serviceClient();

  // 로그인 전화번호는 클라이언트 입력이 아니라 auth 세션(OTP 로 소유 증명됨)에서 가져온다.
  const { data: authUser } = await db.auth.admin.getUserById(auth.userId);
  const authPhoneRaw = authUser?.user?.phone ?? null;
  const authPhoneE164 = authPhoneRaw
    ? authPhoneRaw.startsWith('+') ? authPhoneRaw : `+${authPhoneRaw}`
    : null;

  const provider = getIdentityProvider();
  const input: IdentityRequestInput = {
    name: String(body.name ?? ''),
    birthDate: String(body.birthDate ?? ''),
    phoneE164: authPhoneE164,
    carrier: String(body.carrier ?? ''),
  };

  if (body.action === 'request') {
    if (!input.name || !/^\d{4}-\d{2}-\d{2}$/.test(input.birthDate)) {
      return json({ error: 'invalid_input' }, 400);
    }
    const session = await provider.startVerification(input);
    return json({ requestId: session.verificationId, redirectUrl: session.redirectUrl });
  }

  if (body.action !== 'confirm' && body.action !== 'recover') {
    return json({ error: 'unknown_action' }, 400);
  }

  // confirm / recover 공통: Provider 결과 → identity_key_hash
  const result = await provider.getVerificationResult(
    String(body.requestId ?? ''),
    String(body.code ?? ''),
    input,
  );
  if (!result.verified) {
    await logDeviceEvent(db, auth.userId, 'verification_failure');
    return json({ verified: false, result: 'failed', reason: result.reason });
  }

  if (!isAdult(result.birthDate)) {
    return json({ verified: false, result: 'underage', reason: 'underage' });
  }

  // raw identityKey 는 즉시 해시로 변환하고 더 이상 사용하지 않는다
  const identityKeyHash = await hashIdentityKey(result.identityKey, IDENTITY_SECRET);

  const { data: identityRow } = await db
    .from('user_identities')
    .select('id, user_id, banned')
    .eq('identity_key_hash', identityKeyHash)
    .maybeSingle();

  let existing: ExistingIdentity = null;
  if (identityRow) {
    let userStatus: string | null = null;
    if (identityRow.user_id) {
      const { data: owner } = await db
        .from('users')
        .select('status')
        .eq('id', identityRow.user_id)
        .maybeSingle();
      userStatus = owner?.status ?? null;
    }
    existing = { userId: identityRow.user_id, banned: identityRow.banned, userStatus };
  }

  const outcome = decideIdentityOutcome(existing, auth.userId);

  // ── recover: 같은 사람의 기존 계정에 현재 전화번호를 연결 ────────────────
  if (body.action === 'recover') {
    if (outcome !== 'existing_account' || !identityRow?.user_id) {
      return json({ error: 'not_recoverable' }, 400);
    }
    if (!authPhoneE164) return json({ error: 'phone_login_required' }, 400);
    const oldUserId = identityRow.user_id;

    // 현재 세션의 (빈) 신규 계정을 지워 전화번호를 해제한 뒤, 기존 계정에 연결한다.
    // 신규 계정은 identity 연결 전 단계이므로 콘텐츠가 없다.
    const { error: delErr } = await db.auth.admin.deleteUser(auth.userId);
    if (delErr) return json({ error: 'recover_failed' }, 500);

    const { error: updErr } = await db.auth.admin.updateUserById(oldUserId, {
      phone: authPhoneE164.replace(/^\+/, ''),
      phone_confirm: true,
    });
    if (updErr) return json({ error: 'recover_failed' }, 500);

    // 삭제 상태였던 계정이면 재활성화 (별도 정책 함수 — delete-account 참고)
    await db
      .from('users')
      .update({ phone: authPhoneE164, phone_verified_at: new Date().toISOString() })
      .eq('id', oldUserId);
    await db.from('users').update({ status: 'active' }).eq('id', oldUserId).eq('status', 'deleted');

    await logDeviceEvent(db, oldUserId, 'account_recovery');
    return json({ recovered: true });
  }

  // ── confirm ───────────────────────────────────────────────────────────
  switch (outcome) {
    case 'blocked': {
      // banned identity — 전화번호를 바꿔도 재가입 불가
      await logDeviceEvent(db, auth.userId, 'banned_identity_attempt');
      return json({ verified: false, result: 'blocked', reason: 'blocked' });
    }

    case 'existing_account': {
      // 같은 사람의 계정이 이미 있다 (예: 전화번호가 바뀐 기존 사용자).
      // 새 계정을 만들지 않고 복구 flow 로 안내한다.
      const { data: owner } = await db
        .from('users')
        .select('phone')
        .eq('id', identityRow!.user_id!)
        .maybeSingle();
      await logDeviceEvent(db, auth.userId, 'duplicate_identity_attempt');
      return json({
        verified: false,
        result: 'existing_account',
        maskedPhone: maskPhone(owner?.phone),
      });
    }

    case 'relinked': {
      // 삭제된 계정의 identity 가 남아 있는 경우 → 새 계정에 재연결 (여전히 1 identity 1 계정)
      const { error } = await db
        .from('user_identities')
        .update({
          user_id: auth.userId,
          identity_verified_at: new Date().toISOString(),
          birth_date: result.birthDate,
        })
        .eq('id', identityRow!.id)
        .is('user_id', null);
      if (error) return json({ error: 'update_failed' }, 500);
      break;
    }

    case 'already_verified':
      break; // idempotent — 플래그 갱신만

    case 'created': {
      const now = new Date().toISOString();
      const { error } = await db.from('user_identities').insert({
        user_id: auth.userId,
        identity_key_hash: identityKeyHash,
        identity_verified_at: now,
        birth_date: result.birthDate,
        gender: result.gender ?? null,
        adult_verified_at: now,
      });
      if (error) {
        // 동시 가입 race: 다른 요청이 방금 같은 identity 로 등록했다 → UNIQUE 위반.
        // 재조회해서 기존 계정 안내로 전환한다. (DB constraint 가 최종 방어선)
        const { data: winner } = await db
          .from('user_identities')
          .select('user_id, banned')
          .eq('identity_key_hash', identityKeyHash)
          .maybeSingle();
        if (winner && winner.user_id !== auth.userId) {
          if (winner.banned) return json({ verified: false, result: 'blocked', reason: 'blocked' });
          const { data: owner } = await db
            .from('users')
            .select('phone')
            .eq('id', winner.user_id)
            .maybeSingle();
          await logDeviceEvent(db, auth.userId, 'duplicate_identity_attempt');
          return json({
            verified: false,
            result: 'existing_account',
            maskedPhone: maskPhone(owner?.phone),
          });
        }
        if (!winner) return json({ error: 'update_failed' }, 500);
      }
      break;
    }
  }

  // 서버 전용 플래그 갱신 (트리거가 클라이언트 변경을 막는 컬럼)
  const { error: userErr } = await db
    .from('users')
    .update({ identity_verified: true, age_verified: true })
    .eq('id', auth.userId);
  if (userErr) return json({ error: 'update_failed' }, 500);

  // private_profiles 에는 매칭에 필요한 생년월일만 (전화번호는 users.phone 이 원천)
  const { error: privErr } = await db.from('private_profiles').upsert({
    user_id: auth.userId,
    birth_date: result.birthDate,
    phone: authPhoneE164,
  });
  if (privErr) return json({ error: 'update_failed' }, 500);

  await logDeviceEvent(db, auth.userId, 'signup_success');
  return json({ verified: true, result: outcome, ageVerified: true });
});
