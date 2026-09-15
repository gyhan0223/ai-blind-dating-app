import React from 'react';
import { requireAdmin } from '@/lib/adminAuth';
import { adminClient } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

type UserCohort = {
  cohort_week: string; cohort_age_days: number; signed_up: number; onboarded: number; got_recommendation: number; viewed_recommendation: number;
  accepted_recommendation: number; liked: number; matched: number; sent_message: number; two_way: number; mutual_interest: number;
  reported_met: number; both_confirmed: number; gave_feedback: number; met_again_yes: number; next_intro_yes: number; left_conversation: number;
};
type PairCohort = {
  cohort_week: string; cohort_age_days: number; matched: number; first_message: number; two_way: number; mutual_interest: number;
  outcome_reported: number; one_side_met: number; both_confirmed: number; legacy_completed: number; feedback_any: number;
  met_again_both_yes: number; met_again_any_yes: number; next_intro_any_yes: number; closed: number;
};
type ConversationCohort = {
  cohort_week: string; cohort_age_days: number; matched: number; observing: number; first_within_1h: number; first_after_1h: number; not_started: number;
  closed_early: number; first_sender_male: number; first_sender_female: number; replied: number; reply_waiting: number; reply_no_reply_closed: number;
  two_way: number; completed_wait_max_under_1h: number; completed_wait_max_1h_to_24h: number; completed_wait_max_24h_plus: number;
  male_waited_24h_plus: number; female_waited_24h_plus: number; open_wait_24h_plus: number; stalled_now: number; resumed_after_24h: number;
  closed: number; closed_left: number; closed_blocked: number; closed_account: number; closed_admin: number; closed_unknown: number;
  close_before_first_message: number; close_before_first_reply: number; close_after_two_way: number;
  exit_no_reply: number; exit_not_a_fit: number; exit_moved_elsewhere: number; exit_after_meetup: number; exit_other: number; exit_unanswered: number;
  met_confirmed: number;
};

type Col<T> = { key: keyof T; label: string; denom?: keyof T };

const USER_COLS: Col<UserCohort>[] = [
  { key: 'signed_up', label: '가입' }, { key: 'onboarded', label: '온보딩+인증' },
  { key: 'got_recommendation', label: '추천 생성' }, { key: 'viewed_recommendation', label: '추천 확인' }, { key: 'accepted_recommendation', label: '추천 수락' },
  { key: 'liked', label: '호감' }, { key: 'matched', label: '매치' }, { key: 'sent_message', label: '메시지 보냄' },
  { key: 'two_way', label: '양방향' }, { key: 'mutual_interest', label: '상호 만남 의향' },
  { key: 'reported_met', label: '본인 만났음' }, { key: 'both_confirmed', label: '양측 확인' }, { key: 'gave_feedback', label: '피드백' },
  { key: 'met_again_yes', label: '재만남 yes' }, { key: 'next_intro_yes', label: '다음 소개 yes' }, { key: 'left_conversation', label: '나가기 경험' },
];
const PAIR_COLS: Col<PairCohort>[] = [
  { key: 'matched', label: '매치' }, { key: 'first_message', label: '첫 메시지' }, { key: 'two_way', label: '양방향' },
  { key: 'mutual_interest', label: '상호 의향' }, { key: 'outcome_reported', label: '만남 응답' },
  { key: 'one_side_met', label: '한쪽↑ 만났음' }, { key: 'both_confirmed', label: '양측 확인' }, { key: 'legacy_completed', label: '예전 한쪽 완료' },
  { key: 'feedback_any', label: '피드백' }, { key: 'met_again_any_yes', label: '재만남 yes(한쪽↑)' }, { key: 'met_again_both_yes', label: '재만남 양측 yes' },
  { key: 'next_intro_any_yes', label: '다음 소개 yes' }, { key: 'closed', label: '종료' },
];
/** 대화 행동 (#24) — 분모는 열마다 다르다 (denom). 24시간 이상은 구간으로만 센다 */
const CONV_GROUPS: { title: string; cols: Col<ConversationCohort>[] }[] = [
  {
    title: '첫 연락 (분모: 매치)',
    cols: [
      { key: 'matched', label: '매치' }, { key: 'observing', label: '관찰 중(1시간 미만)' },
      { key: 'first_within_1h', label: '1시간 내 첫 연락' }, { key: 'first_after_1h', label: '1시간 이후 시작' },
      { key: 'not_started', label: '아직 미시작' }, { key: 'closed_early', label: '첫 연락 전 조기 종료' },
      { key: 'first_sender_male', label: '첫 발신 남' }, { key: 'first_sender_female', label: '첫 발신 여' },
    ],
  },
  {
    title: '상대 첫 답장 · 양방향 (분모: 첫 메시지 있는 매치)',
    cols: [
      { key: 'replied', label: '첫 답장 있음' }, { key: 'reply_waiting', label: '첫 답장 대기 중' }, { key: 'reply_no_reply_closed', label: '첫 답장 없이 종료' },
      { key: 'two_way', label: '양방향' },
    ],
  },
  {
    title: '응답 대기 (분모: 양방향 매치 — 완료된 대기의 최댓값)',
    cols: [
      { key: 'completed_wait_max_under_1h', label: '최장 대기 1시간 미만', denom: 'two_way' },
      { key: 'completed_wait_max_1h_to_24h', label: '1시간~24시간', denom: 'two_way' },
      { key: 'completed_wait_max_24h_plus', label: '24시간 이상', denom: 'two_way' },
      { key: 'male_waited_24h_plus', label: '남→여 24시간 이상 기다림', denom: 'two_way' },
      { key: 'female_waited_24h_plus', label: '여→남 24시간 이상 기다림', denom: 'two_way' },
      { key: 'open_wait_24h_plus', label: '진행 중 대기 24시간 이상 (활성)' },
    ],
  },
  {
    title: '24시간 중단 · 재개 · 종료 (분모: 매치)',
    cols: [
      { key: 'stalled_now', label: '현재 24시간 이상 중단(활성)' }, { key: 'resumed_after_24h', label: '중단 후 재개 경험' },
      { key: 'closed', label: '종료' }, { key: 'closed_left', label: '나가기' }, { key: 'closed_blocked', label: '차단' },
      { key: 'closed_account', label: '탈퇴' }, { key: 'closed_admin', label: '운영 제재' }, { key: 'closed_unknown', label: '측정 전 종료(미상)' },
      { key: 'close_before_first_message', label: '첫 메시지 전 종료', denom: 'closed' }, { key: 'close_before_first_reply', label: '첫 답장 전 종료', denom: 'closed' },
      { key: 'close_after_two_way', label: '양방향 후 종료', denom: 'closed' }, { key: 'met_confirmed', label: '양측 만남 확인(참고)' },
    ],
  },
  {
    title: '나가기 이유 (분모: 나가기 — 선택 응답, 개인 식별 없음)',
    cols: [
      { key: 'exit_no_reply', label: '답장이 없어요', denom: 'closed_left' }, { key: 'exit_not_a_fit', label: '대화가 잘 맞지 않아요', denom: 'closed_left' },
      { key: 'exit_moved_elsewhere', label: '다른 연락수단으로', denom: 'closed_left' }, { key: 'exit_after_meetup', label: '만남 이후 종료', denom: 'closed_left' },
      { key: 'exit_other', label: '기타', denom: 'closed_left' }, { key: 'exit_unanswered', label: '응답하지 않음', denom: 'closed_left' },
    ],
  },
];

function pct(n: number, d: number): string {
  return d > 0 ? `${Math.round((n / d) * 100)}%` : '—';
}

function CohortTable<T extends { cohort_week: string; cohort_age_days: number }>({
  rows, cols, weekLabel, denomKey,
}: { rows: T[]; cols: Col<T>[]; weekLabel: string; denomKey: keyof T }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table>
        <thead><tr><th>{weekLabel}</th><th>관찰</th>{cols.map((c) => <th key={String(c.key)}>{c.label}</th>)}</tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.cohort_week}>
              <td>{r.cohort_week}</td>
              <td className="muted" style={{ fontSize: 12 }}>{r.cohort_age_days}일째</td>
              {cols.map((c) => {
                const denom = Number(r[c.denom ?? denomKey]);
                const value = Number(r[c.key]);
                const isDenom = c.key === denomKey;
                return (
                  <td key={String(c.key)}>
                    {value}
                    {!isDenom && <span className="muted" style={{ fontSize: 11 }}> {pct(value, denom)}</span>}
                  </td>
                );
              })}
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={cols.length + 2} className="muted">데이터 없음 (조회는 성공)</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

/**
 * 퍼널 · 대화 행동 지표 (#24) — 사용자/매치 쌍 기준 분리, 가입주·매치주 cohort, 서버 사실 기준.
 * 정의: docs/funnel-metrics.md. 조회 오류는 "데이터 없음" 으로 숨기지 않는다.
 */
export default async function FunnelPage() {
  await requireAdmin();
  const db = adminClient();
  const [users, pairs, convs] = await Promise.all([
    db.from('funnel_user_cohorts').select('*').limit(26),
    db.from('funnel_pair_cohorts').select('*').limit(26),
    db.from('conversation_cohorts').select('*').limit(26),
  ]);
  const errors = [users.error, pairs.error, convs.error].filter((e): e is NonNullable<typeof e> => e != null);
  const userRows = (users.data ?? []) as UserCohort[];
  const pairRows = (pairs.data ?? []) as PairCohort[];
  const convRows = (convs.data ?? []) as ConversationCohort[];

  return (
    <div>
      <h1>퍼널 · 대화 행동</h1>
      <p className="muted">
        서버 사실(행 존재·상태 전환·메시지·종료 시각) 기준. 목표는 서로 모르던 두 사람이 소개와 대화를 통해 호감을 가질 기회를 만드는 것이며,
        실제 만남·관계 지속은 참고 정보다. 무응답·중단·나가기는 실패나 비호감으로 해석하지 않는다 (외부 연락수단으로 옮겨 앱 대화가 끝날 수 있다).
        "관찰" 열은 cohort 가 시작된 뒤 지난 일수다 — 관찰 기간이 다른 집단을 같은 성과로 비교하지 않는다. 정의: docs/funnel-metrics.md
      </p>

      {errors.length > 0 && (
        <div className="card" style={{ borderColor: 'var(--danger)', marginBottom: 16 }}>
          <div className="label" style={{ color: 'var(--danger)' }}>조회 오류 — 아래 표는 불완전하다 (데이터 없음이 아니다)</div>
          {errors.map((e, i) => <div key={i} className="muted" style={{ fontSize: 12 }}>{e.message}</div>)}
        </div>
      )}

      <h2>사용자 기준 (가입주 cohort, demo 제외) — 각 단계에 한 번이라도 도달한 사용자 수 / 가입 대비</h2>
      <p className="muted" style={{ fontSize: 12 }}>추천 생성(서버) · 추천 확인(앱이 카드를 실제로 표시, 0026 이후 기록) · 추천 수락을 구분한다. 확인 기록이 없는 과거 행은 "측정 시작 전" 이라 확인 수가 생성 수보다 작게 보일 수 있다.</p>
      <CohortTable rows={userRows} cols={USER_COLS} weekLabel="가입주" denomKey="signed_up" />

      <h2>매치 쌍 기준 (매치 생성주 cohort, demo 쌍 제외) — 매치 수 대비</h2>
      <CohortTable rows={pairRows} cols={PAIR_COLS} weekLabel="매치주" denomKey="matched" />

      <h2>대화 행동 (매치 생성주 cohort, demo 쌍 제외)</h2>
      <p className="muted" style={{ fontSize: 12 }}>
        1시간 이내 첫 연락은 정확히 1시간까지 포함한다. 매치 후 1시간이 안 된 미연락 대화는 "관찰 중" 이며 미시작으로 세지 않는다.
        응답 대기는 한쪽의 첫 미응답 메시지부터 상대의 다음 메시지까지다 (연속 발신은 시작 시각을 바꾸지 않는다). 24시간 이상은 모두 "24시간 이상" 으로 표시하고 원본 시각은 보존한다.
        "양쪽 모두 메시지가 없는 시간(중단)" 과 "상대 답장을 기다린 시간" 은 다른 지표다. 종료를 답장으로 세지 않으며 대기는 종료 시점에서 멈춘다.
        0026 이전에 종료된 매치는 종료 시각이 없어 "측정 전 종료(미상)" 로만 센다.
      </p>
      {CONV_GROUPS.map((g) => (
        <div key={g.title}>
          <h3 style={{ fontSize: 14, marginTop: 20 }}>{g.title}</h3>
          <CohortTable rows={convRows} cols={g.cols} weekLabel="매치주" denomKey="matched" />
        </div>
      ))}
    </div>
  );
}
