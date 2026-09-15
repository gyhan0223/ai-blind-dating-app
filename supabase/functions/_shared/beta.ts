/**
 * 폐쇄 베타 입장 강제 (#26) — 본인확인·얼굴 인증을 시작하기 전에 서버가 beta_access_allowed(uid) 를 확인한다.
 * 앱의 입장 화면은 UX 이고, 이 검사와 DB 정책(프로필 insert · 온보딩 완료)이 최종 방어선이다.
 *
 * fail-closed: RPC 오류면 허용하지 않는다 (503). 마이그레이션 0025 가 적용되지 않은 프로젝트에서는 verify-identity 가 503 이 된다 — 배포 순서 문서 참고.
 * 순수 판정은 security/core.ts (selftest).
 */
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { json } from './http.ts';
import { type BetaDecision, decideBetaAccess } from './security/core.ts';

/** 허용이면 null, 아니면 응답 (403 beta_admission_required / 503) */
export async function enforceBetaAccess(db: SupabaseClient, userId: string, fn: string): Promise<Response | null> {
  let decision: BetaDecision;
  try {
    decision = decideBetaAccess((await db.rpc('beta_access_allowed', { p_user: userId })) as { data: unknown; error: { message: string } | null });
  } catch {
    decision = 'unavailable';
  }
  if (decision === 'allowed') return null;
  if (decision === 'denied') return json({ error: 'beta_admission_required' }, 403);
  console.error(`[${fn}] beta access check unavailable — refusing request (fail-closed)`);
  return json({ error: 'beta_check_unavailable' }, 503);
}
