/**
 * 행동 데이터 수집 — 클라이언트에서만 알 수 있는 퍼널 이벤트를 analytics_events 에 기록한다.
 * 실패해도 앱 UX 를 막지 않는다 (fire-and-forget).
 * 민감정보(얼굴 URL, 메시지 원문 등)는 payload 에 절대 넣지 않는다.
 *
 * #41: 대화·만남·피드백 이벤트는 클라이언트가 기록하지 않는다. 서버(트리거/RPC)가 실제 저장·상태 전환 시점에
 *      한 번만 기록한다 — first_message · two_way_conversation · message_sent · conversation_resumed ·
 *      meetup_intent_set · meetup_mutual_interest(_restored/_withdrawn) · meetup_outcome_reported ·
 *      meetup_confirmed_both · meetup_feedback_submitted/_changed. 정의: docs/meetup-flow.md
 *      (과거 클라이언트 이벤트 chat_started / meetup_interest_* / meetup_completed / second_date_interest_* 는
 *       0016 이전 데이터에만 남아 있으며 새로 기록하지 않는다)
 */
import { supabase } from './supabase';

export type AnalyticsEvent =
  | 'signup_started'
  | 'onboarding_completed'
  | 'recommendation_viewed'
  | 'recommendation_accepted'
  | 'recommendation_skipped';

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
