import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * 얼굴 인증 관리자 검토 — 서버 컴포넌트/서버 액션 전용.
 *
 * 승인/거절/복구는 DB 를 직접 갱신하지 않고 Supabase Edge Function `admin-face-review` 를 service role key 로 호출한다.
 * (그 함수가 Didit Decision 을 다시 조회해 liveness Approved · liveness_passed · reference_path 를 확인한 뒤
 *  RPC face_liveness_admin_review 로 승인 + 감사 기록을 한 트랜잭션에 반영한다.)
 * 이 파일의 어떤 값도 브라우저로 내려가지 않는다. 중복 매칭된 상대 사용자 정보·얼굴 이미지는 조회하지 않는다.
 */

export type FaceReviewRow = {
  id: string;
  user_id: string;
  status: string;
  provider_session_id: string | null;
  provider_status: string | null;
  provider_reason: string | null;
  liveness_passed: boolean;
  reference_path: string | null;
  attempt_count: number;
  created_at: string;
  provider_event_at: string | null;
};

export type FaceReviewAudit = {
  id: string;
  face_verification_id: string;
  user_id: string;
  action: string;
  previous_status: string;
  new_status: string;
  actor: string;
  note: string | null;
  created_at: string;
};

export type InconsistentRow = {
  face_verification_id: string;
  user_id: string;
  provider_session_id: string | null;
  reference_path: string | null;
  face_verified: boolean;
};

const ROW_COLUMNS =
  'id, user_id, status, provider_session_id, provider_status, provider_reason, liveness_passed, reference_path, attempt_count, created_at, provider_event_at';

export const REASON_LABEL: Record<string, string> = {
  face_search_match: '중복 얼굴 의심 (Face Search)',
  reference_image_unavailable: '참조 이미지 미확보',
  decision_incomplete: '라이브니스 결과 불완전',
  in_review: 'Provider 검토 중',
  admin_approved: '관리자 승인',
  admin_rejected: '관리자 거절',
};

/** 세션 id 는 앞 8자만 표시한다 (전체 id 는 화면에 내려보내지 않는다) */
export function shortId(id: string | null | undefined): string {
  if (!id) return '—';
  return id.length <= 8 ? id : `${id.slice(0, 8)}…`;
}

export async function loadFaceReviewQueue(db: SupabaseClient): Promise<{
  pending: FaceReviewRow[];
  inconsistent: InconsistentRow[];
  audits: FaceReviewAudit[];
  nickname: Map<string, string>;
}> {
  const [{ data: pending }, { data: inconsistent }, { data: audits }] = await Promise.all([
    db.from('face_verifications').select(ROW_COLUMNS).eq('status', 'in_review').order('created_at', { ascending: true }).limit(100),
    db.rpc('face_liveness_inconsistent_rows'),
    db.from('face_verification_reviews').select('*').order('created_at', { ascending: false }).limit(50),
  ]);

  const rows = (pending ?? []) as FaceReviewRow[];
  const incons = (inconsistent ?? []) as InconsistentRow[];
  const auditRows = (audits ?? []) as FaceReviewAudit[];

  const userIds = Array.from(new Set([...rows.map((r) => r.user_id), ...incons.map((r) => r.user_id), ...auditRows.map((a) => a.user_id)]));
  const { data: profiles } = await db
    .from('profiles')
    .select('user_id, nickname')
    .in('user_id', userIds.length > 0 ? userIds : ['00000000-0000-0000-0000-000000000000']);
  const nickname = new Map<string, string>((profiles ?? []).map((p) => [p.user_id as string, p.nickname as string]));

  return { pending: rows, inconsistent: incons, audits: auditRows, nickname };
}

export type AdminFaceAction = 'approve' | 'reject' | 'repair';

export type AdminFaceCallResult = { ok: true; status: string } | { ok: false; error: string; httpStatus: number };

/** Edge Function admin-face-review 호출 (service role key — 서버에서만) */
export async function callAdminFaceReview(input: {
  action: AdminFaceAction;
  rowId: string;
  actor: string;
  note: string | null;
}): Promise<AdminFaceCallResult> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return { ok: false, error: 'misconfigured', httpStatus: 0 };

  let res: Response;
  try {
    res = await fetch(`${url.replace(/\/+$/, '')}/functions/v1/admin-face-review`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        apikey: key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action: input.action, rowId: input.rowId, actor: input.actor, note: input.note }),
      cache: 'no-store',
    });
  } catch {
    return { ok: false, error: 'network', httpStatus: 0 };
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  if (res.ok && body.ok === true) return { ok: true, status: typeof body.status === 'string' ? body.status : 'unknown' };
  return { ok: false, error: typeof body.error === 'string' ? body.error : `http_${res.status}`, httpStatus: res.status };
}

export const ADMIN_ERROR_LABEL: Record<string, string> = {
  liveness_not_approved: 'Provider 라이브니스 결과가 Approved 가 아니어서 승인할 수 없습니다.',
  liveness_not_passed: '서버가 기록한 liveness_passed 가 true 가 아니어서 승인할 수 없습니다.',
  reference_image_unavailable: '참조 이미지를 확보하지 못해 승인할 수 없습니다. 잠시 후 다시 시도하거나 거절하세요.',
  invalid_state: '이미 처리된 행입니다. 목록을 새로고침하세요.',
  decision_unavailable: 'Didit 결과 조회에 실패했습니다 (일시 장애). 잠시 후 다시 시도하세요.',
  unauthorized: 'admin-face-review 호출 인증 실패 — SUPABASE_SERVICE_ROLE_KEY 를 확인하세요.',
  misconfigured: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 환경변수가 없습니다.',
  network: 'admin-face-review 함수에 연결할 수 없습니다 (배포 여부 확인).',
  not_found: '해당 검증 행을 찾을 수 없습니다.',
};
