/**
 * 오늘의 소개 생성 — 순수 코어 (#40). Edge Function(daily-recommendation)은 이 함수를 감싸는 얇은 어댑터다.
 *
 * 정책 (docs/matching-policy.md 에 사용자용 설명)
 *  * 하루 1명. Plus 추천 개수 차등은 PLUS 플래그(호출자)가 꺼져 있어 항상 1 (#29/#39).
 *  * 요청자·후보 모두: status='active' · onboarding_completed · identity_verified · face_verified · age_verified.
 *    onboarding_completed 만 믿지 않는다. 얼굴 벡터(feature_vector) 유무는 인증 판단에 쓰지 않는다.
 *  * 제외: 본인 · 과거 추천 상대 중 pending/accepted(영구) 와 최근 RECOMMENDATION_COOLDOWN_DAYS 안의 skipped/expired (#23) ·
 *          내가 좋아요한 상대 · 매치된 적 있는 상대(상태 무관) · 양방향 차단 쌍 · 신고 당사자 쌍(양방향, 전역 제외 아님).
 *    30일이 지난 skipped/expired 상대는 다시 후보가 된다 (좁은 cohort 에서 풀이 마르지 않게 — 좋아요·매치 이력은 영구 제외).
 *    운영 제재(suspended/banned)는 status 로 걸러진다. 신고만으로 다른 사용자에게까지 제외되지 않는다.
 *  * 안전·계정 조회(users/blocks/reports/likes/matches/recommendations) 실패 → lookup_failed. 추천을 계속하지 않는다.
 *    "후보 부족(exhausted)" 과는 다른 결과다.
 *  * 오늘 저장된 추천도 반환 전에 재검증한다: 상대가 지금 비활성/미인증/차단 쌍이면
 *      - pending  → expired 로 마감하고 응답에서 제외 (오늘 한도에서도 빠져 새 추천을 만든다)
 *      - accepted/skipped → 응답에서만 제외 (이미 상호작용한 추천은 보존하고 오늘 한도에 포함)
 *  * 후보 조회는 user_id 순으로 페이지를 돌며 제외 목록을 뺀 뒤 평가한다. MAX_CANDIDATES_SCANNED 까지
 *    끝까지 훑은 뒤에야 "후보 없음" 으로 판단한다 (앞의 N명만 보고 오판하지 않는다).
 *    상한에 걸리면 capReached=true 로 알린다 — 풀이 500명을 넘는 규모에서는 정렬·샤딩을 정해야 한다 (recommendation_runs.cap_reached 로 관측).
 *  * 멱등성(#22): 같은 사용자의 동시 실행은 호출자(Edge Function)가 recommendation_run_claim 으로 직렬화한다.
 *    그래도 insert 가 unique 충돌 등으로 실패하면 오늘 저장된 추천을 다시 읽어 돌려준다 (빈 응답으로 위장하지 않는다).
 *  * 순위: scored(총점 내림차순) → conditions_only, 동점은 (요청자, KST 날짜, 후보 id) 해시 tie-break.
 *    후보가 없어도 필수 조건을 완화하지 않는다. 신규끼리 배정 금지·외모 우대(#38)는 없다.
 *  * 카드에는 공개 필드 allowlist 만 담는다. 원시 점수·차원·비공개 응답·얼굴 데이터는 응답에 없다.
 */
import type { DataSource, NewRecommendationRow, PastRecommendation, Row, StoredRecommendation, UserAccountRow } from './dataSource.ts';
import { computeMatch, pickStrategy, rankCandidates } from './MatchingEngine.ts';
import { buildPublicAnswerCards, composeIntro, normalizeRelationshipGoal } from './publicPrompts.ts';
import { loadSnapshots } from './snapshot.ts';
import type { MatchResult, UserSnapshot } from './types.ts';

export const CANDIDATE_PAGE_SIZE = 100;
export const MAX_CANDIDATES_SCANNED = 500;
/** skipped/expired 추천 상대를 다시 후보로 보기까지의 기간 (#23) */
export const RECOMMENDATION_COOLDOWN_DAYS = 30;

export interface RunInput {
  userId: string;
  /** KST 날짜 (YYYY-MM-DD) */
  today: string;
  nowYear: number;
  dailyLimit: number;
}

export type RunOutcome =
  | { kind: 'not_ready' }
  | { kind: 'not_verified' }
  | { kind: 'profile_missing' }
  | { kind: 'lookup_failed'; stage: string }
  | {
      kind: 'ok';
      recommendations: StoredRecommendation[];
      dailyLimit: number;
      exhausted: boolean;
      /** 이번 요청에서 평가한 후보 수 (관측용) */
      scanned: number;
      /** MAX_CANDIDATES_SCANNED 에 걸려 풀을 끝까지 보지 못했는지 (관측용 — #23) */
      capReached: boolean;
    };

/** YYYY-MM-DD 문자열에 일 수를 더한다 (UTC 기준 날짜 산술 — 시간대 무관) */
export function addDays(ymd: string, days: number): string {
  const t = Date.parse(`${ymd}T00:00:00Z`);
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * 과거 추천 중 지금 제외할 상대 (#23):
 *  - pending / accepted : 영구 제외 (accepted 는 likes 로도 제외되지만 이중 방어)
 *  - skipped / expired  : for_date 가 (today - cooldown) 이후면 제외, 그 전이면 다시 후보
 */
export function excludedByRecommendationHistory(past: PastRecommendation[], today: string, cooldownDays = RECOMMENDATION_COOLDOWN_DAYS): Set<string> {
  const cutoff = addDays(today, -cooldownDays);
  const out = new Set<string>();
  for (const r of past) {
    if (r.status === 'pending' || r.status === 'accepted') out.add(r.candidate_id);
    else if (r.for_date >= cutoff) out.add(r.candidate_id);
  }
  return out;
}

/** 요청자·후보 공통 계정 조건 */
export function accountEligible(u: UserAccountRow | null | undefined): boolean {
  return (
    !!u &&
    u.status === 'active' &&
    u.onboarding_completed === true &&
    u.identity_verified === true &&
    u.face_verified === true &&
    u.age_verified === true
  );
}

/** 카드 스냅샷 — 공개 필드 allowlist. private_profiles·설문·인증 원본·외모·점수는 어떤 형태로도 싣지 않는다. */
export const CARD_FIELDS = [
  'nickname',
  'age',
  'region_code',
  'height_cm',
  'job_group',
  'smoking',
  'drinking',
  'hobbies',
  'personality_keywords',
  'intro',
  'relationship_goal',
  'public_answers',
  'identity_verified',
  'face_verified',
  'reasons',
] as const;

export function buildCard(
  candidate: UserSnapshot,
  badges: { identity: boolean; face: boolean },
  reasons: string[],
  nowYear: number,
): Row {
  const p = candidate.profile;
  return {
    nickname: p.nickname,
    age: nowYear - p.birthYear,
    region_code: p.regionCode,
    height_cm: p.heightCm,
    job_group: p.jobGroup,
    smoking: p.smoking,
    drinking: p.drinking,
    hobbies: p.hobbies,
    personality_keywords: p.personalityKeywords,
    intro: composeIntro(p.relationshipGoal, p.publicAnswers),
    relationship_goal: normalizeRelationshipGoal(p.relationshipGoal),
    public_answers: buildPublicAnswerCards(p.publicAnswers),
    identity_verified: badges.identity,
    face_verified: badges.face,
    reasons,
  };
}

function pairSet(pairs: { a: string; b: string }[], me: string): Set<string> {
  const out = new Set<string>();
  for (const p of pairs) {
    if (p.a === me) out.add(p.b);
    if (p.b === me) out.add(p.a);
  }
  return out;
}

export async function runDailyRecommendation(ds: DataSource, input: RunInput): Promise<RunOutcome> {
  const { userId, today, nowYear, dailyLimit } = input;

  // 1) 요청자 계정 상태
  let me: UserAccountRow | undefined;
  try {
    me = (await ds.userAccounts([userId]))[0];
  } catch {
    return { kind: 'lookup_failed', stage: 'requester' };
  }
  if (!me || me.status !== 'active' || !me.onboarding_completed) return { kind: 'not_ready' };
  if (!accountEligible(me)) return { kind: 'not_verified' };

  // 2) 안전 조회 — 하나라도 실패하면 진행하지 않는다
  let blocked: Set<string>;
  let reported: Set<string>;
  let todayRecs: StoredRecommendation[];
  try {
    const [blocks, reports, recs] = await Promise.all([
      ds.blockPairs(userId),
      ds.reportPairs(userId),
      ds.recommendationsForDate(userId, today),
    ]);
    blocked = pairSet(
      blocks.map((b) => ({ a: b.blocker_id, b: b.blocked_id })),
      userId,
    );
    reported = pairSet(
      reports.map((r) => ({ a: r.reporter_id, b: r.reported_id })),
      userId,
    );
    todayRecs = recs;
  } catch {
    return { kind: 'lookup_failed', stage: 'safety' };
  }

  // 3) 오늘 저장된 추천 재검증
  const kept: StoredRecommendation[] = [];
  const toExpire: string[] = [];
  let countedToday = 0;
  if (todayRecs.length > 0) {
    let accounts: Map<string, UserAccountRow>;
    try {
      accounts = new Map((await ds.userAccounts(todayRecs.map((r) => r.candidate_id))).map((u) => [u.id, u]));
    } catch {
      return { kind: 'lookup_failed', stage: 'stored_candidates' };
    }
    for (const rec of todayRecs) {
      if (rec.status === 'expired') continue; // 이미 마감된 행 — 반환도, 오늘 한도 계산도 하지 않는다
      const ok = accountEligible(accounts.get(rec.candidate_id)) && !blocked.has(rec.candidate_id);
      if (ok) {
        kept.push(rec);
        countedToday += 1;
      } else if (rec.status === 'pending') {
        toExpire.push(rec.id); // 아직 상호작용 없음 → 마감, 오늘 한도에서 제외
      } else {
        countedToday += 1; // 이미 수락/거절한 추천 — 보존하되 응답에서만 제외
      }
    }
    if (toExpire.length > 0) {
      try {
        await ds.expireRecommendations(toExpire);
      } catch {
        return { kind: 'lookup_failed', stage: 'expire_stored' };
      }
    }
  }

  if (countedToday >= dailyLimit) {
    return { kind: 'ok', recommendations: kept, dailyLimit, exhausted: false, scanned: 0, capReached: false };
  }

  // 4) 제외 목록
  const excluded = new Set<string>([userId, ...blocked, ...reported]);
  try {
    const [past, liked, matched] = await Promise.all([
      ds.pastRecommendations(userId),
      ds.likedUserIds(userId),
      ds.matchedUserIds(userId),
    ]);
    for (const id of [...excludedByRecommendationHistory(past, today), ...liked, ...matched]) excluded.add(id);
  } catch {
    return { kind: 'lookup_failed', stage: 'history' };
  }

  // 5) 내 스냅샷
  let meSnap: UserSnapshot | undefined;
  try {
    meSnap = (await loadSnapshots(ds, [userId])).get(userId);
  } catch {
    return { kind: 'lookup_failed', stage: 'requester_snapshot' };
  }
  if (!meSnap) return { kind: 'profile_missing' };

  // 6) 후보 순회 (페이지) → 제외 → 계정 재확인 → 스냅샷 → 양방향 계산
  const evaluated: { id: string; result: MatchResult; payload: { snap: UserSnapshot; account: UserAccountRow } }[] = [];
  let offset = 0;
  let scanned = 0;
  let capReached = false;
  try {
    while (true) {
      if (scanned >= MAX_CANDIDATES_SCANNED) {
        capReached = true;
        break;
      }
      const page = await ds.candidateIdsPage(meSnap.profile.seekingGender, meSnap.profile.gender, offset, CANDIDATE_PAGE_SIZE);
      if (page.length === 0) break;
      offset += page.length;
      const ids = page.filter((id) => !excluded.has(id));
      if (ids.length > 0) {
        const [snapshots, accounts] = await Promise.all([loadSnapshots(ds, ids), ds.userAccounts(ids)]);
        const accountMap = new Map(accounts.map((u) => [u.id, u]));
        for (const id of ids) {
          scanned += 1;
          const snap = snapshots.get(id);
          const account = accountMap.get(id);
          if (!snap || !accountEligible(account)) continue; // 조회 조건과 무관하게 한 번 더 확인
          const result = computeMatch(meSnap, snap, nowYear);
          if (result.eligible && result.score) evaluated.push({ id, result, payload: { snap, account: account! } });
        }
      }
      if (page.length < CANDIDATE_PAGE_SIZE) break; // 마지막 페이지
    }
  } catch {
    return { kind: 'lookup_failed', stage: 'candidates' };
  }

  const ranked = rankCandidates(evaluated, userId, today);
  if (ranked.length === 0) {
    return { kind: 'ok', recommendations: kept, dailyLimit, exhausted: true, scanned, capReached };
  }

  // 7) 부족한 개수만큼 생성
  const need = dailyLimit - countedToday;
  const created: StoredRecommendation[] = [];
  for (let i = 0; i < Math.min(need, ranked.length); i += 1) {
    const { id: candidateId, result, payload } = ranked[i];
    const score = result.score!;
    const strategy = pickStrategy(score, i);
    const card = buildCard(
      payload.snap,
      { identity: payload.account.identity_verified, face: payload.account.face_verified },
      result.reasons,
      nowYear,
    );
    const row: NewRecommendationRow = {
      user_id: userId,
      candidate_id: candidateId,
      for_date: today,
      strategy,
      score_total: score.total,
      score_a_to_b: score.aToB,
      score_b_to_a: score.bToA,
      // 새 dimensions 에는 appearance 가 없다. basis 로 conditions_only 를 구분한다.
      dimensions: { basis: score.basis, ...score.dimensions },
      card,
    };
    try {
      created.push(await ds.insertRecommendation(row));
    } catch {
      // 다른 실행이 먼저 저장한 경우(unique 충돌 등) — 빈 응답이 아니라 오늘 저장된 행을 다시 읽어 돌려준다 (#22)
      try {
        const stored = (await ds.recommendationsForDate(userId, today)).filter((r) => r.status !== 'expired');
        return { kind: 'ok', recommendations: stored, dailyLimit, exhausted: false, scanned, capReached };
      } catch {
        return { kind: 'lookup_failed', stage: 'reread_today' };
      }
    }
  }

  return { kind: 'ok', recommendations: [...kept, ...created], dailyLimit, exhausted: false, scanned, capReached };
}
