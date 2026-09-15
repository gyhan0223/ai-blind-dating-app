/**
 * 만남 의향 · 실제 만남 확인 · 비공개 피드백 (#41)
 *
 * 모든 쓰기는 서버 RPC 로만 한다 (테이블 직접 insert/update 정책 없음). 상태 전환·집계·이벤트는 서버가 한 번만 기록한다.
 * 조회 오류는 예외로 던진다 — "상대 미응답" 처럼 보이게 하지 않는다.
 */
import { canReportOutcome, isBothConfirmed, isMutualNow, type MeetupState } from './chatCore';
import { supabase } from './supabase';

export type MeetupIntent = 'yes' | 'not_yet';
export type MeetupOutcome = 'met' | 'not_met';
export type NotMetReason = 'canceled' | 'no_show' | 'other';
export type TriState = 'yes' | 'no' | 'not_sure';
export type Concern = 'appearance_mismatch' | 'conversation' | 'goal_mismatch' | 'other';

export type MeetupStatus = {
  matchId: string;
  matchStatus: string;
  partnerId: string | null;
  meetupState: MeetupState;
  /** 처음 서로의 의향이 확인된 시각 (철회돼도 남는 과거 사실) */
  mutualInterestAt: string | null;
  myIntent: MeetupIntent | null;
  myDates: string[];
  myRegion: string | null;
  /** 지금 둘 다 yes 인지. 아닐 때 상대의 yes/not_yet/미응답은 알 수 없다 */
  mutualNow: boolean;
  /** 둘 다 yes 인 지금만 값이 채워진다 (RLS) */
  partnerDates: string[] | null;
  partnerRegion: string | null;
  /** 내 만남 결과 응답 (상대 응답은 API 로도 볼 수 없다) */
  myOutcome: MeetupOutcome | null;
  myNotMetReason: NotMetReason | null;
  /** 양측이 각자 "만났음" 이라고 응답했는지 */
  bothConfirmed: boolean;
  canReportOutcome: boolean;
  /** 0016 이전 앱에서 한쪽이 "완료" 버튼을 누른 과거 값 (양측 확인 아님) */
  legacyCompleted: boolean;
  myFeedback: MyFeedback | null;
};

export type MyFeedback = {
  overallSatisfaction: number | null;
  metAgainIntent: TriState | null;
  nextIntroIntent: TriState | null;
  concerns: Concern[];
};

export const DATE_OPTIONS = [
  { value: 'this_weekend', label: '이번 주말' },
  { value: 'next_weekend', label: '다음 주말' },
  { value: 'weekday_evening', label: '평일 저녁' },
  { value: 'flexible', label: '조율하고 싶어요' },
];

async function requireUserId(): Promise<string> {
  const { data } = await supabase.auth.getUser();
  const id = data.user?.id;
  if (!id) throw new Error('로그인이 필요합니다.');
  return id;
}

function rpcError(message: string | undefined, fallback: string): Error {
  const m = message ?? '';
  if (m.includes('partner_unavailable')) return new Error('지금은 이 상대와 만남 의향을 주고받을 수 없어요.');
  if (m.includes('match_not_active')) return new Error('종료된 대화예요.');
  if (m.includes('self_restricted')) return new Error('현재 계정 상태에서는 진행할 수 없어요.');
  if (m.includes('meetup_not_arranged')) return new Error('서로의 만남 의향이 확인된 뒤에 기록할 수 있어요.');
  if (m.includes('outcome_required')) return new Error('먼저 "만났어요" 를 기록해 주세요.');
  if (m.includes('forbidden')) return new Error('접근할 수 없는 매치예요.');
  return new Error(fallback);
}

export async function fetchMeetupStatus(matchId: string): Promise<MeetupStatus> {
  const userId = await requireUserId();

  const [matchRes, intentRes, outcomeRes, feedbackRes] = await Promise.all([
    supabase.from('matches').select('id, status, meetup_state, mutual_interest_at, user_a, user_b').eq('id', matchId).maybeSingle(),
    supabase.from('meetup_intentions').select('user_id, intent, available_dates, preferred_region').eq('match_id', matchId),
    supabase.from('meetup_outcomes').select('outcome, not_met_reason').eq('match_id', matchId).eq('user_id', userId).maybeSingle(),
    supabase
      .from('meetup_feedback')
      .select('overall_satisfaction, met_again_intent, next_intro_intent, concerns')
      .eq('match_id', matchId)
      .eq('user_id', userId)
      .maybeSingle(),
  ]);
  // 조회 오류는 각각 예외 — 오류를 "데이터 없음/상대 미응답" 으로 보이게 하지 않는다
  if (matchRes.error) throw new Error('매치 정보를 불러오지 못했습니다.');
  if (!matchRes.data) throw new Error('매치를 찾을 수 없습니다.');
  if (intentRes.error) throw new Error('만남 의향을 불러오지 못했습니다.');
  if (outcomeRes.error) throw new Error('만남 확인 상태를 불러오지 못했습니다.');
  if (feedbackRes.error) throw new Error('피드백 상태를 불러오지 못했습니다.');

  const match = matchRes.data;
  const state = match.meetup_state as MeetupState;
  const intentions = intentRes.data ?? [];
  const mine = intentions.find((i) => i.user_id === userId) ?? null;
  const partner = intentions.find((i) => i.user_id !== userId) ?? null;
  // 상대 행은 RLS 상 "지금 둘 다 yes" 일 때만 내려온다. 공통 상태와 교차 확인한다.
  const mutualNow = isMutualNow(state) && mine?.intent === 'yes' && partner?.intent === 'yes';

  const fb = feedbackRes.data;
  return {
    matchId,
    matchStatus: match.status,
    partnerId: match.user_a === userId ? match.user_b : match.user_a,
    meetupState: state,
    mutualInterestAt: match.mutual_interest_at ?? null,
    myIntent: (mine?.intent as MeetupIntent | undefined) ?? null,
    myDates: mine?.available_dates ?? [],
    myRegion: mine?.preferred_region ?? null,
    mutualNow,
    partnerDates: mutualNow ? (partner?.available_dates ?? []) : null,
    partnerRegion: mutualNow ? (partner?.preferred_region ?? null) : null,
    myOutcome: (outcomeRes.data?.outcome as MeetupOutcome | undefined) ?? null,
    myNotMetReason: (outcomeRes.data?.not_met_reason as NotMetReason | undefined) ?? null,
    bothConfirmed: isBothConfirmed(state),
    canReportOutcome: canReportOutcome(state, match.mutual_interest_at ?? null),
    legacyCompleted: state === 'completed',
    myFeedback: fb
      ? {
          overallSatisfaction: fb.overall_satisfaction ?? null,
          metAgainIntent: (fb.met_again_intent as TriState | null) ?? null,
          nextIntroIntent: (fb.next_intro_intent as TriState | null) ?? null,
          concerns: (fb.concerns as Concern[] | null) ?? [],
        }
      : null,
  };
}

/** 본인의 만남 의향 저장/변경 — 서버가 상호 전이·이벤트를 한 번만 기록한다. 같은 요청 재시도는 안전하다 */
export async function submitMeetupIntent(
  matchId: string,
  intent: MeetupIntent,
  availableDates: string[],
  preferredRegion: string | null,
): Promise<{ mutualYes: boolean; meetupState: string }> {
  const { data, error } = await supabase.rpc('meetup_set_intent', {
    p_match_id: matchId,
    p_intent: intent,
    p_available_dates: intent === 'yes' ? availableDates : [],
    p_preferred_region: intent === 'yes' ? preferredRegion : null,
  });
  if (error) throw rpcError(error.message, '저장하지 못했습니다.');
  const obj = (data ?? {}) as { mutual_yes?: boolean; meetup_state?: string };
  return { mutualYes: obj.mutual_yes === true, meetupState: obj.meetup_state ?? 'none' };
}

/** 본인의 만남 결과 응답 — 상대의 확인을 만들어내지 않는다. 양측 모두 met 일 때만 서버가 공통 상태를 바꾼다 */
export async function reportMeetupOutcome(
  matchId: string,
  outcome: MeetupOutcome,
  notMetReason: NotMetReason | null,
): Promise<{ bothConfirmed: boolean }> {
  const { data, error } = await supabase.rpc('meetup_report_outcome', {
    p_match_id: matchId,
    p_outcome: outcome,
    p_not_met_reason: outcome === 'not_met' ? notMetReason : null,
  });
  if (error) throw rpcError(error.message, '기록하지 못했습니다.');
  const obj = (data ?? {}) as { both_confirmed?: boolean };
  return { bothConfirmed: obj.both_confirmed === true };
}

export type MeetupFeedbackInput = {
  overallSatisfaction: number | null;
  metAgainIntent: TriState | null;
  nextIntroIntent: TriState | null;
  concerns: Concern[];
};

/** 비공개 피드백 제출/수정 — 본인이 "만났음" 이라고 응답한 매치만. 상대는 제출 여부·내용을 알 수 없다 */
export async function submitMeetupFeedback(matchId: string, input: MeetupFeedbackInput): Promise<void> {
  const { error } = await supabase.rpc('meetup_submit_feedback', {
    p_match_id: matchId,
    p_overall_satisfaction: input.overallSatisfaction,
    p_met_again_intent: input.metAgainIntent,
    p_next_intro_intent: input.nextIntroIntent,
    p_concerns: input.concerns,
  });
  if (error) throw rpcError(error.message, '저장하지 못했습니다.');
}
