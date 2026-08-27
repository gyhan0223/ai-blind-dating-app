import { track } from './analytics';
import { supabase } from './supabase';

export type MeetupIntent = 'yes' | 'not_yet';

export type MeetupStatus = {
  matchId: string;
  meetupState: 'none' | 'mutual_interest' | 'scheduled' | 'completed';
  myIntent: MeetupIntent | null;
  myDates: string[];
  myRegion: string | null;
  /** 둘 다 yes 일 때만 값이 채워진다 (RLS) */
  partnerDates: string[] | null;
  partnerRegion: string | null;
  mutualYes: boolean;
  feedbackSubmitted: boolean;
};

async function requireUserId(): Promise<string> {
  const { data } = await supabase.auth.getUser();
  const id = data.user?.id;
  if (!id) throw new Error('로그인이 필요합니다.');
  return id;
}

export async function fetchMeetupStatus(matchId: string): Promise<MeetupStatus> {
  const userId = await requireUserId();

  const [{ data: match }, { data: intentions }, { data: feedback }] = await Promise.all([
    supabase.from('matches').select('id, meetup_state').eq('id', matchId).single(),
    supabase.from('meetup_intentions').select('*').eq('match_id', matchId),
    supabase
      .from('meetup_feedback')
      .select('id')
      .eq('match_id', matchId)
      .eq('user_id', userId)
      .maybeSingle(),
  ]);
  if (!match) throw new Error('매치를 찾을 수 없습니다.');

  const mine = (intentions ?? []).find((i) => i.user_id === userId) ?? null;
  const partner = (intentions ?? []).find((i) => i.user_id !== userId) ?? null;
  const mutualYes = mine?.intent === 'yes' && partner?.intent === 'yes';

  return {
    matchId,
    meetupState: match.meetup_state,
    myIntent: (mine?.intent as MeetupIntent | undefined) ?? null,
    myDates: mine?.available_dates ?? [],
    myRegion: mine?.preferred_region ?? null,
    partnerDates: mutualYes ? (partner?.available_dates ?? []) : null,
    partnerRegion: mutualYes ? (partner?.preferred_region ?? null) : null,
    mutualYes,
    feedbackSubmitted: feedback != null,
  };
}

export async function submitMeetupIntent(
  matchId: string,
  intent: MeetupIntent,
  availableDates: string[],
  preferredRegion: string | null,
): Promise<void> {
  const userId = await requireUserId();
  const { error } = await supabase.from('meetup_intentions').upsert(
    {
      match_id: matchId,
      user_id: userId,
      intent,
      available_dates: availableDates,
      preferred_region: preferredRegion,
    },
    { onConflict: 'match_id,user_id' },
  );
  if (error) throw new Error('저장하지 못했습니다.');
  track(intent === 'yes' ? 'meetup_interest_yes' : 'meetup_interest_not_yet', { match_id: matchId });
}

/** 만남 완료 표시 → 피드백 요청 대상이 된다 */
export async function markMeetupCompleted(matchId: string): Promise<void> {
  const { error } = await supabase
    .from('matches')
    .update({ meetup_state: 'completed', meetup_completed_at: new Date().toISOString() })
    .eq('id', matchId);
  if (error) throw new Error('처리하지 못했습니다.');
  track('meetup_completed', { match_id: matchId });
}

export type MeetupFeedbackInput = {
  metAgainIntent: 'yes' | 'no';
  appearanceAttraction: number | null;
  conversationComfort: number | null;
  valuesFit: number | null;
};

export async function submitMeetupFeedback(matchId: string, input: MeetupFeedbackInput): Promise<void> {
  const userId = await requireUserId();
  const { error } = await supabase.from('meetup_feedback').upsert(
    {
      match_id: matchId,
      user_id: userId,
      met_again_intent: input.metAgainIntent,
      appearance_attraction: input.appearanceAttraction,
      conversation_comfort: input.conversationComfort,
      values_fit: input.valuesFit,
    },
    { onConflict: 'match_id,user_id' },
  );
  if (error) throw new Error('저장하지 못했습니다.');
  track(input.metAgainIntent === 'yes' ? 'second_date_interest_yes' : 'second_date_interest_no', {
    match_id: matchId,
  });
}
