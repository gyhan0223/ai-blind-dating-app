/**
 * 계정 익명화·완전 삭제 (#13/#11/#14) — service role 전용 (사용자 JWT 는 401).
 *
 * POST { user_id, hard?: boolean }        → 한 계정 처리 (status 가 deleted/banned 여야 한다)
 * POST { batch: true, grace_days?: 30 }   → 유예가 지난 탈퇴 계정을 최대 100명 익명화 (cron 일 1회)
 *
 * 순서 (사용자당)
 *  1. account_face_assets 로 얼굴 자산 목록 → storage faces/<uid>/ 아래 객체 삭제 → Didit 세션 삭제(best effort, provider=didit 만)
 *  2. account_purge RPC — 프로필·응답·설정·추천·좋아요·만남 응답·알림 삭제, 메시지 본문 자리표시, identity 익명화, 계정 스켈레톤 초기화 (한 트랜잭션)
 *  3. hard=true 면 auth.admin.deleteUser → auth.users cascade 로 users 행·메시지·매치·신고까지 삭제 (앱 밖 삭제 요청 등 명시 요청에만)
 * 얼굴 삭제가 실패하면 그 사용자는 건너뛰고(재시도 대상으로 남긴다) 다음 사용자로 간다.
 */
import { requireFaceProviderKind } from '../_shared/env/env.ts';
import { getFaceLivenessProvider } from '../_shared/face/FaceLivenessProvider.ts';
import { corsHeaders, json, requireServiceRole, serviceClient } from '../_shared/http.ts';

const FACES_BUCKET = 'faces';

type Db = ReturnType<typeof serviceClient>;
type FaceAsset = { provider: string; provider_session_id: string | null; reference_path: string | null; front_path: string | null; left_path: string | null; right_path: string | null };

function providerOrNull() {
  try {
    return getFaceLivenessProvider(requireFaceProviderKind(), (name) => Deno.env.get(name), (input, init) => fetch(input, init));
  } catch {
    return null; // provider 설정이 없는 환경(로컬 등) — Didit 삭제는 건너뛰고 나머지는 진행
  }
}

async function deleteFaceAssets(db: Db, userId: string): Promise<{ ok: boolean; storage: number; sessions: number; error?: string }> {
  const { data: assets, error } = await db.rpc('account_face_assets', { p_user_id: userId });
  if (error) return { ok: false, storage: 0, sessions: 0, error: `assets: ${error.message}` };
  const rows = (assets ?? []) as FaceAsset[];

  // storage: faces/<uid>/ 아래 전부 (liveness/reference.jpg 포함) + 과거 경로 컬럼
  let removed = 0;
  const paths = new Set<string>();
  for (const a of rows) for (const p of [a.reference_path, a.front_path, a.left_path, a.right_path]) if (p) paths.add(p);
  try {
    for (const dir of [userId, `${userId}/liveness`]) {
      const { data: objects, error: listErr } = await db.storage.from(FACES_BUCKET).list(dir, { limit: 1000 });
      if (listErr) throw new Error(listErr.message);
      for (const o of objects ?? []) if (o.name && o.id) paths.add(`${dir}/${o.name}`);
    }
    if (paths.size > 0) {
      const { data: gone, error: rmErr } = await db.storage.from(FACES_BUCKET).remove([...paths]);
      if (rmErr) throw new Error(rmErr.message);
      removed = gone?.length ?? 0;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'storage_failed';
    // 로컬 검증 환경에는 storage 가 없다 — 버킷 없음은 "지울 것 없음" 으로 본다
    if (!/bucket|not found|storage/i.test(msg)) return { ok: false, storage: removed, sessions: 0, error: `storage: ${msg}` };
  }

  // Didit 세션 삭제 (best effort)
  let sessions = 0;
  const provider = providerOrNull();
  if (provider) {
    for (const a of rows) {
      if (a.provider !== 'didit' || !a.provider_session_id) continue;
      const res = await provider.deleteSession(a.provider_session_id).catch(() => ({ ok: false }));
      if (res.ok) sessions += 1;
    }
  }
  return { ok: true, storage: removed, sessions };
}

async function purgeOne(db: Db, userId: string, hard: boolean) {
  const face = await deleteFaceAssets(db, userId);
  if (!face.ok) return { user_id: userId, ok: false, error: face.error };
  const { data: summary, error } = await db.rpc('account_purge', { p_user_id: userId });
  if (error) return { user_id: userId, ok: false, error: `purge: ${error.message}` };
  let hardDeleted = false;
  if (hard) {
    const { error: authErr } = await db.auth.admin.deleteUser(userId);
    if (authErr) return { user_id: userId, ok: false, error: `auth_delete: ${authErr.message}`, summary };
    hardDeleted = true;
  }
  return { user_id: userId, ok: true, face_storage_removed: face.storage, didit_sessions_deleted: face.sessions, hard_deleted: hardDeleted, summary };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const gate = requireServiceRole(req);
  if (gate instanceof Response) return gate;

  const body = (await req.json().catch(() => ({}))) as { user_id?: string; hard?: boolean; batch?: boolean; grace_days?: number };
  const db = serviceClient();

  if (body.batch) {
    const grace = Math.max(0, Math.min(365, Number(body.grace_days) || 30));
    const { data: cands, error } = await db.rpc('account_purge_candidates', { p_grace: `${grace} days`, p_limit: 100 });
    if (error) return json({ error: 'lookup_failed' }, 500);
    const results = [];
    for (const c of (cands ?? []) as { user_id: string }[]) {
      results.push(await purgeOne(db, c.user_id, false));
    }
    return json({ processed: results.length, succeeded: results.filter((r) => r.ok).length, results });
  }

  if (!body.user_id || typeof body.user_id !== 'string') return json({ error: 'invalid_body' }, 400);
  const result = await purgeOne(db, body.user_id, body.hard === true);
  return json(result, result.ok ? 200 : 409);
});
