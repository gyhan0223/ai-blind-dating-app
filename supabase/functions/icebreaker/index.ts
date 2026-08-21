/**
 * AI Icebreaker Edge Function.
 * 대화방 최초 진입 시 두 사람의 공통점 기반 대화 주제를 생성해 캐시한다.
 * 현재는 규칙 기반(generateIcebreaker) — 함수 교체로 LLM 전환 가능.
 *
 * POST { conversationId } → { icebreaker: { lead, question } }
 */
import { corsHeaders, json, requireUser, serviceClient } from '../_shared/http.ts';
import { generateIcebreaker } from '../_shared/matching/icebreaker.ts';
import { loadSnapshots } from '../_shared/matching/snapshot.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  const body = await req.json().catch(() => null);
  const conversationId = body?.conversationId as string | undefined;
  if (!conversationId) return json({ error: 'invalid_body' }, 400);

  const db = serviceClient();
  const { data: conv } = await db
    .from('conversations')
    .select('id, icebreaker, matches(user_a, user_b, status)')
    .eq('id', conversationId)
    .maybeSingle();
  if (!conv) return json({ error: 'not_found' }, 404);

  const match = conv.matches as unknown as { user_a: string; user_b: string; status: string };
  if (auth.userId !== match.user_a && auth.userId !== match.user_b) {
    return json({ error: 'forbidden' }, 403);
  }

  if (conv.icebreaker) return json({ icebreaker: conv.icebreaker });

  const snapshots = await loadSnapshots(db, [match.user_a, match.user_b]);
  const a = snapshots.get(match.user_a);
  const b = snapshots.get(match.user_b);
  if (!a || !b) return json({ icebreaker: null });

  const icebreaker = generateIcebreaker(a, b);
  await db.from('conversations').update({ icebreaker }).eq('id', conversationId);
  return json({ icebreaker });
});
