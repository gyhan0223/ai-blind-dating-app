/**
 * 계정 삭제 / 복구 Edge Function.
 *
 * 계정 삭제 정책은 "일반 데이터 삭제"와 "중복가입 방지용 identity 처리"가 다르므로
 * 단계별 함수로 분리한다. 법률/운영 정책 확정 전이므로 hard delete 는 하지 않고
 * 각 함수를 확장 지점으로 남긴다.
 *
 * POST { action: 'delete' }     → 탈퇴 (status='deleted', 세션 전체 무효화)
 * POST { action: 'reactivate' } → 탈퇴 상태 복구 (재로그인 후 호출)
 */
import { corsHeaders, json, requireUser, serviceClient } from '../_shared/http.ts';

type Db = ReturnType<typeof serviceClient>;

/** 1) 콘텐츠 비활성화 — 매칭/추천에서 보이지 않게 한다 (소프트 삭제, deleted_at 은 DB 트리거가 기록).
 *  30일 유예 뒤 account-purge(batch) 가 개인정보를 익명화한다 (#13 — docs/data-retention.md). 그 전에는 같은 번호로 복구 가능.
 *  #41 로 추가된 사용자별 데이터(meetup_intentions·meetup_outcomes·meetup_feedback·notification_events)는
 *  모두 users(id) on delete cascade 라 계정 행을 hard delete 하면 함께 삭제된다 (#13 파이프라인 연결 — docs/meetup-flow.md 9절).
 *  status='deleted' 가 되면 can_chat_in/meetup_set_intent 가 양쪽 계정 active 를 요구하므로 기존 매치로도 더 이상 연락되지 않는다. */
async function deleteUserContent(db: Db, userId: string) {
  await db.from('users').update({ status: 'deleted' }).eq('id', userId);
  // 탈퇴한 기기로 알림이 가지 않게 토큰을 지운다 (#17). 미발송 outbox 는 발송기가 recipient_inactive 로 닫는다
  await db.from('push_tokens').delete().eq('user_id', userId);
  await db
    .from('recommendations')
    .update({ status: 'expired' })
    .eq('user_id', userId)
    .eq('status', 'pending');
}

/** 2) 인증 수단 정리 — 모든 세션/리프레시 토큰 무효화 (요청 JWT 기준 global signout).
 *  auth 계정과 전화번호 연결은 유지한다 → 같은 번호로 재로그인하면 복구 안내를 받을 수 있다.
 *  (정책 확정 시: 일정 기간 후 auth 계정 삭제 + 번호 해제를 이 함수에서 구현) */
async function deleteAuthenticationData(db: Db, callerJwt: string) {
  await db.auth.admin.signOut(callerJwt, 'global').catch(() => {});
}

/** 3) identity 보존 정책 — 현재: identity_key_hash 보존.
 *  같은 사람이 재가입하면 새 계정이 아니라 이 계정의 복구/재연결로 이어진다 (1인 1계정 유지).
 *  banned 플래그는 계정과 무관하게 identity 에 남는다.
 *  (정책 확정 시: N일 후 익명화 등을 이 함수에서 구현) */
async function handleIdentityRetention(db: Db, userId: string) {
  await db
    .from('user_identities')
    .update({ updated_at: new Date().toISOString() })
    .eq('user_id', userId);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  const body = await req.json().catch(() => ({}));
  const db = serviceClient();

  if (body.action === 'reactivate') {
    const { data: me } = await db.from('users').select('status, purged_at').eq('id', auth.userId).maybeSingle();
    if (me?.status !== 'deleted') return json({ error: 'not_deleted' }, 400);
    await db.from('users').update({ status: 'active' }).eq('id', auth.userId);
    // 익명화가 끝난 계정은 데이터가 없다 — 앱은 온보딩을 처음부터 안내한다 (인증 플래그도 초기화되어 있다)
    return json({ reactivated: true, fresh_start: me.purged_at != null });
  }

  if (body.action !== 'delete') return json({ error: 'unknown_action' }, 400);

  const { data: me } = await db.from('users').select('status').eq('id', auth.userId).maybeSingle();
  if (!me) return json({ error: 'not_found' }, 404);
  if (me.status === 'banned') return json({ error: 'not_allowed' }, 403);

  await deleteUserContent(db, auth.userId);
  await deleteAuthenticationData(db, auth.token);
  await handleIdentityRetention(db, auth.userId);

  await db.from('device_events').insert({ user_id: auth.userId, event_type: 'account_deletion' });
  return json({ deleted: true });
});
