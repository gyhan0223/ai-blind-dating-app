import React from 'react';
import { requireAdmin } from '@/lib/adminAuth';
import { adminClient } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

type UserCohort = {
  cohort_week: string; signed_up: number; onboarded: number; got_recommendation: number; liked: number; matched: number;
  sent_message: number; two_way: number; sustained_7d: number; mutual_interest: number; reported_met: number; both_confirmed: number;
  gave_feedback: number; met_again_yes: number; next_intro_yes: number;
};
type PairCohort = {
  cohort_week: string; matched: number; first_message: number; two_way: number; sustained_7d: number; mutual_interest: number;
  outcome_reported: number; one_side_met: number; both_confirmed: number; legacy_completed: number; feedback_any: number;
  met_again_both_yes: number; met_again_any_yes: number; next_intro_any_yes: number;
};

const USER_COLS: { key: keyof UserCohort; label: string }[] = [
  { key: 'signed_up', label: '가입' }, { key: 'onboarded', label: '온보딩+인증' }, { key: 'got_recommendation', label: '추천 받음' },
  { key: 'liked', label: '호감' }, { key: 'matched', label: '매치' }, { key: 'sent_message', label: '메시지 보냄' },
  { key: 'two_way', label: '양방향' }, { key: 'sustained_7d', label: '지속(7일·2일↑)' }, { key: 'mutual_interest', label: '상호 만남 의향' },
  { key: 'reported_met', label: '본인 만났음' }, { key: 'both_confirmed', label: '양측 확인' }, { key: 'gave_feedback', label: '피드백' },
  { key: 'met_again_yes', label: '재만남 yes' }, { key: 'next_intro_yes', label: '다음 소개 yes' },
];
const PAIR_COLS: { key: keyof PairCohort; label: string }[] = [
  { key: 'matched', label: '매치' }, { key: 'first_message', label: '첫 메시지' }, { key: 'two_way', label: '양방향' },
  { key: 'sustained_7d', label: '지속' }, { key: 'mutual_interest', label: '상호 의향' }, { key: 'outcome_reported', label: '만남 응답' },
  { key: 'one_side_met', label: '한쪽↑ 만났음' }, { key: 'both_confirmed', label: '양측 확인' }, { key: 'legacy_completed', label: '예전 한쪽 완료' },
  { key: 'feedback_any', label: '피드백' }, { key: 'met_again_any_yes', label: '재만남 yes(한쪽↑)' }, { key: 'met_again_both_yes', label: '재만남 양측 yes' },
  { key: 'next_intro_any_yes', label: '다음 소개 yes' },
];

function pct(n: number, d: number): string {
  return d > 0 ? `${Math.round((n / d) * 100)}%` : '—';
}

/** 퍼널 (#24) — 사용자/매치 쌍 기준을 분리, 가입주·매치주 cohort. 정의: docs/funnel-metrics.md */
export default async function FunnelPage() {
  await requireAdmin();
  const db = adminClient();
  const [{ data: users }, { data: pairs }] = await Promise.all([
    db.from('funnel_user_cohorts').select('*').limit(26),
    db.from('funnel_pair_cohorts').select('*').limit(26),
  ]);
  const userRows = (users ?? []) as UserCohort[];
  const pairRows = (pairs ?? []) as PairCohort[];

  return (
    <div>
      <h1>퍼널</h1>
      <p className="muted">
        서버 사실(행 존재·상태 전환) 기준. 미응답은 실패로 세지 않고, 재만남 "의향" 과 실제 두 번째 만남은 다르다. 메시지 수는 진정성 점수가 아니다. 정의: docs/funnel-metrics.md
      </p>

      <h2>사용자 기준 (가입주 cohort, demo 제외) — 각 단계에 한 번이라도 도달한 사용자 수 / 가입 대비</h2>
      <div style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr><th>가입주</th>{USER_COLS.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
          <tbody>
            {userRows.map((r) => (
              <tr key={r.cohort_week}>
                <td>{r.cohort_week}</td>
                {USER_COLS.map((c) => (
                  <td key={c.key}>{r[c.key]}{c.key !== 'signed_up' && <span className="muted" style={{ fontSize: 11 }}> {pct(Number(r[c.key]), r.signed_up)}</span>}</td>
                ))}
              </tr>
            ))}
            {userRows.length === 0 && <tr><td colSpan={USER_COLS.length + 1} className="muted">데이터 없음</td></tr>}
          </tbody>
        </table>
      </div>

      <h2>매치 쌍 기준 (매치 생성주 cohort) — 매치 수 대비</h2>
      <div style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr><th>매치주</th>{PAIR_COLS.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
          <tbody>
            {pairRows.map((r) => (
              <tr key={r.cohort_week}>
                <td>{r.cohort_week}</td>
                {PAIR_COLS.map((c) => (
                  <td key={c.key}>{r[c.key]}{c.key !== 'matched' && <span className="muted" style={{ fontSize: 11 }}> {pct(Number(r[c.key]), r.matched)}</span>}</td>
                ))}
              </tr>
            ))}
            {pairRows.length === 0 && <tr><td colSpan={PAIR_COLS.length + 1} className="muted">데이터 없음</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
