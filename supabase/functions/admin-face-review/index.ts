/**
 * admin-face-review — 관리자 얼굴 인증 검토 Edge Function (서버 전용, 공개 API 아님).
 *
 * 배포 (JWT 검증 ON — service role key 도 유효한 JWT 이므로 게이트웨이를 통과한다):
 *   supabase functions deploy admin-face-review --project-ref <PROJECT_REF>
 *
 * 호출자 인증 = Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY> 와의 상수 시간 일치 검사 (requireServiceRole).
 * 관리자 웹(apps/admin, 비밀번호 쿠키 인증 + 서버 액션)만 이 함수를 호출한다. 사용자 JWT / anon key 는 401.
 *
 * POST { action: 'approve' | 'reject' | 'repair', rowId, actor, note? }
 *   approve: 서버가 Didit Decision 을 다시 조회해 liveness Approved · liveness_passed=true · reference_path 존재를
 *            모두 확인한 뒤에만 face_liveness_admin_review RPC (승인 + 감사 기록, 단일 트랜잭션)
 *   reject : status='rejected', users.face_verified=false 유지 + 감사 기록
 *   repair : approved 인데 users.face_verified=false / reference_path 없음 인 행 복구
 *
 * 응답과 로그에 중복 매칭된 상대 사용자 정보·이미지 URL·토큰은 포함되지 않는다.
 * 필수 서버 환경변수: FACE_VERIFICATION_PROVIDER=didit · DIDIT_API_KEY · DIDIT_WORKFLOW_ID · DIDIT_WEBHOOK_SECRET
 */
import { requireFaceProviderKind } from '../_shared/env/env.ts';
import { json, requireServiceRole, serviceClient } from '../_shared/http.ts';
import { handleAdminFaceReview } from '../_shared/face/adminReviewCore.ts';
import { getFaceLivenessProvider } from '../_shared/face/FaceLivenessProvider.ts';
import { SupabaseFaceDb } from '../_shared/face/supabaseFaceDb.ts';

const provider = getFaceLivenessProvider(
  requireFaceProviderKind(),
  (name) => Deno.env.get(name),
  (input, init) => fetch(input, init),
);

const log = {
  info: (m: string) => console.log(m),
  warn: (m: string) => console.warn(m),
  error: (m: string) => console.error(m),
};

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const auth = requireServiceRole(req);
  if (auth instanceof Response) return auth;

  const body = await req.json().catch(() => ({}));
  try {
    const res = await handleAdminFaceReview(
      { body },
      { provider, db: new SupabaseFaceDb(serviceClient()), now: () => new Date(), log },
    );
    return json(res.body, res.status);
  } catch (err) {
    console.error(`[admin-face-review] ${err instanceof Error ? err.message : 'error'}`);
    return json({ error: 'server_error' }, 500);
  }
});
