/**
 * 행동 데이터 수집 — 핵심 퍼널 이벤트를 analytics_events 에 기록한다.
 * 실패해도 앱 UX 를 막지 않는다 (fire-and-forget).
 * 민감정보(얼굴 URL, 메시지 원문 등)는 payload 에 절대 넣지 않는다.
 */
import { supabase } from './supabase';

export type AnalyticsEvent =
  | 'signup_started'
  | 'onboarding_completed'
  | 'recommendation_viewed'
  | 'recommendation_accepted'
  | 'recommendation_skipped'
  | 'match_created'
  | 'chat_started'
  | 'message_sent'
  | 'conversation_resumed'
  | 'meetup_interest_yes'
  | 'meetup_interest_not_yet'
  | 'meetup_scheduled'
  | 'meetup_completed'
  | 'second_date_interest_yes'
  | 'second_date_interest_no';

export async function track(event: AnalyticsEvent, payload: Record<string, unknown> = {}) {
  try {
    const { data } = await supabase.auth.getUser();
    const userId = data.user?.id;
    if (!userId) return;
    await supabase.from('analytics_events').insert({
      user_id: userId,
      event_type: event,
      payload,
    });
  } catch {
    // 분석 이벤트 실패는 조용히 무시
  }
}
