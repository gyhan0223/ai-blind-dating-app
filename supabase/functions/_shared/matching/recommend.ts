/**
 * 오늘의 소개 생성 — 순수 코어 (#40). Edge Function(daily-recommendation)은 이 함수를 감싸는 얇은 어댑터다.
 *
 * 정책 (docs/matching-policy.md 에 사용자용 설명)
 *  * 하루 1명. Plus 추천 개수 차등은 PLUS 플래그(호출자)가 꺼져 있어 항상 1 (#29/#39).
 *  * 요청자·후보 모두: status='active' · onboarding_completed · identity_verified · face_verified · age_verified.
 *    onboarding_completed 만 믿지 않는다. 얼굴 벡터(feature_vector) 유무는 인증 판단에 쓰지 않는다.
 *  * 제외: 본인 · 과거에 추천된 적 있는 상대(전체 기간 — 재추천 주기는 #23) · 내가 좋아요한 상대 ·
 *          매치된 적 있는 상대(상태 무관) · 양방향 차단 쌍 · 신고 당사자 쌍(양방향, 전역 제외 아님).
 *    운영 제재(suspended/banned)는 status 로 걸러진다. 신고만으로 다른 사용자에게까지 제외되지 않는다.
 *  * 안전·계정 조회(users/blocks/reports/likes/matches/recommendations) 실패 → lookup_failed. 추천을 계속하지 않는다.
 *    "후보 부족(exhausted)" 과는 다른 결과다.
 *  * 오늘 저장된 추천도 반환 전에 재검증한다: 상대가 지금 비활성/미인증/차단 쌍이면
 *      - pending  → expired 로 마감하고 응답에서 제외 (오늘 한도에서도 빠져 새 추천을 만든다)
 *      - accepted/skipped → 응답에서만 제외 (이미 상호작용한 추천은 보존하고 오늘 한도에 포함)
 *  * 후보 조회는 user_id 순으로 페이지를 돌며 제외 목록을 뺀 뒤 평가한다. MAX_CANDIDATES_SCANNED 까지
 *    끝까지 훑은 뒤에야 "후보 없음" 으로 판단한다 (앞의 N명만 보고 오판하지 않는다). 상한 초과 규모는 #23.
 *  * 순위: scored(총점 내림차순) → conditions_only, 동점은 (요청자, KST 날짜, 후보 id) 해시 tie-break.
 *    후보가 없어도 필수 조건을 완화하지 않는다. 신규끼리 배정 금지·외모 우대(#38)는 없다.
 *  * 카드에는 공개 필드 allowlist 만 담는다. 원시 점수·차원·비공개 응답·얼굴 데이터는 응답에 없다.
 */
import type { DataSource, NewRecommendationRow, Row, StoredRecommendation, UserAccountRow } from './dataSource.ts';
import { computeMatch, pickStrategy, rankCandidates } from './MatchingEngine.ts';
import { buildPublicAnswerCards, composeIntro, normalizeRelationshipGoal } from './publicPrompts.ts';
import { loadSnapshots } from './snapshot.ts';
import type { MatchResult, UserSnapshot } from './types.ts';

export const CANDIDATE_PAGE_SIZE = 100;
export const MAX_CANDIDATES_SCANNED = 500;

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
    };

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
    return { kind: 'ok', recommendations: kept, dailyLimit, exhausted: false, scanned: 0 };
  }

  // 4) 제외 목록
  const excluded = new Set<string>([userId, ...blocked, ...reported]);
  try {
    const [past, liked, matched] = await Promise.all([
      ds.pastRecommendationCandidateIds(userId),
      ds.likedUserIds(userId),
      ds.matchedUserIds(userId),
    ]);
    for (const id of [...past, ...liked, ...matched]) excluded.add(id);
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
  try {
    while (scanned < MAX_CANDIDATES_SCANNED) {
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
    return { kind: 'ok', recommendations: kept, dailyLimit, exhausted: true, scanned };
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
      // 동시 요청으로 같은 후보가 이미 저장된 경우 등 — 이번 응답에서는 건너뛴다 (멱등성 완성은 #22)
      continue;
    }
  }

  return { kind: 'ok', recommendations: [...kept, ...created], dailyLimit, exhausted: false, scanned };
}
