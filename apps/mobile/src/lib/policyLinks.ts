/**
 * 공개 정책 문서 링크 (#12) — 관리자 웹이 /policy/* 로 서빙한다. EXPO_PUBLIC_POLICY_BASE_URL 이 없으면 링크를 숨긴다
 * (없는 URL 로 보내지 않는다 — 출시 전 필수 설정, release-checklist).
 */
import { Linking } from 'react-native';

const BASE = (process.env.EXPO_PUBLIC_POLICY_BASE_URL ?? '').replace(/\/+$/, '');

export const POLICY_LINKS_ENABLED = BASE.length > 0;

export type PolicyKind = 'terms' | 'privacy' | 'community' | 'delete-account';

export function policyUrl(kind: PolicyKind): string | null {
  if (!POLICY_LINKS_ENABLED) return null;
  return kind === 'delete-account' ? `${BASE}/delete-account` : `${BASE}/policy/${kind}`;
}

export async function openPolicy(kind: PolicyKind): Promise<void> {
  const url = policyUrl(kind);
  if (!url) return;
  try {
    await Linking.openURL(url);
  } catch {
    // 브라우저를 열 수 없는 환경 — 조용히 무시
  }
}
