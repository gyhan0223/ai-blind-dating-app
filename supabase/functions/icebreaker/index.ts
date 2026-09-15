/**
 * 대화 시작 질문 Edge Function (#41).
 * 공개 프로필(공개 질문 선택지·취미)만으로 규칙 기반 시작 질문 2~3개를 만들어 대화방에 캐시한다. LLM 호출 없음.
 *
 * POST { conversationId } → { icebreaker: { version: 2, generated_at, questions: [{ id, text, basis, promptId?, value? }] } }
 *
 * 캐시 정책
 *  * conversations.icebreaker 가 v2(version=2) 이면 그대로 반환한다 (사용자별 방향 질문이 아니라 대화방 공통 캐시 —
 *    'partner' 질문은 요청자 관점으로 매번 만들기 때문에 캐시에는 넣지 않고, 요청자마다 계산한다).
 *  * 과거 형식({ lead, question }) 캐시는 무효로 보고 덮어쓴다 — 0015 이전에 비공개 가치관 응답으로 만들어졌을 수 있는
 *    문구가 다시 노출되지 않게 한다.
 */
import { corsHeaders, json, requireUser, serviceClient } from '../_shared/http.ts';
import { enforceRateLimit } from '../_shared/rateLimit.ts';
import {
  buildStarterCache,
  generateStarterQuestions,
  parseStarterCache,
  type PublicFacts,
} from '../_shared/matching/starterQuestions.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  const body = await req.json().catch(() => null);
  const conversationId = body?.conversationId as string | undefined;
  if (!conversationId) return json({ error: 'invalid_body' }, 400);

  const db = serviceClient();
  // 남용 방지 (#27): 사용자당 30회/시간 (대화방마다 캐시되므로 정상 사용은 몇 번이면 충분)
  const rl = await enforceRateLimit(db, 'icebreaker', auth.userId, 30, 3600, 'icebreaker');
  if (rl) return rl;
  const { data: conv, error: convError } = await db
    .from('conversations')
    .select('id, icebreaker, matches(user_a, user_b, status)')
    .eq('id', conversationId)
    .maybeSingle();
  if (convError) return json({ error: 'lookup_failed' }, 500);
  if (!conv) return json({ error: 'not_found' }, 404);

  const match = conv.matches as unknown as { user_a: string; user_b: string; status: string };
  if (auth.userId !== match.user_a && auth.userId !== match.user_b) {
    return json({ error: 'forbidden' }, 403);
  }
  const partnerId = auth.userId === match.user_a ? match.user_b : match.user_a;

  // 공개 필드만 읽는다 (private_profiles·설문·인증 데이터 조회 없음)
  const { data: profiles, error: profileError } = await db
    .from('profiles')
    .select('user_id, hobbies, public_answers')
    .in('user_id', [auth.userId, partnerId]);
  if (profileError) return json({ error: 'lookup_failed' }, 500);
  const facts = new Map<string, PublicFacts>();
  for (const p of profiles ?? []) {
    facts.set(p.user_id as string, {
      hobbies: (p.hobbies as string[] | null) ?? [],
      publicAnswers: p.public_answers ?? null,
    });
  }
  const viewer = facts.get(auth.userId) ?? { hobbies: [], publicAnswers: null };
  const partner = facts.get(partnerId) ?? { hobbies: [], publicAnswers: null };

  const questions = generateStarterQuestions(viewer, partner);
  const cache = buildStarterCache(questions);

  // 과거 형식(lead/question) 캐시는 v2 로 덮어쓴다. 저장 실패는 응답을 막지 않는다 (다음 요청에서 재시도).
  if (!parseStarterCache(conv.icebreaker)) {
    await db.from('conversations').update({ icebreaker: cache }).eq('id', conversationId);
  }
  return json({ icebreaker: cache });
});
