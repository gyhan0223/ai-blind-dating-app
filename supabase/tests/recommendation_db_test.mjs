/**
 * #40 연결 검증 — 실제 Postgres 스키마(마이그레이션 0001→최신 + seed) 위에서
 *   DB → DataSource(psql) → loadSnapshots → MatchingEngine → 추천 저장 → 카드 반환
 * 까지 runDailyRecommendation 을 그대로 실행한다. (Edge 런타임·PostgREST 없이 psql 로 붙는다)
 *
 * 실행: run_local_check.sh 가 마이그레이션·seed 적용 후 호출한다.
 *   PGDATABASE=<db> PGHOST=... node --experimental-strip-types supabase/tests/recommendation_db_test.mjs
 * 실패 시 exit 1.
 *
 * 검증 항목
 *  1. 외모 취향 이벤트·feature_vector 가 있는 seed 사용자도, 그 데이터를 전부 지운 뒤와 같은 후보·같은 점수를 받는다
 *  2. 외모 데이터가 전혀 없는 신규 사용자(정상 인증)가 추천을 받고, 카드는 allowlist 필드만·저장 dimensions 에 appearance 없음
 *  3. 요청자 인증 미완료 → not_verified / 후보 인증 미완료·정지·탈퇴 → 후보 조회에서 제외
 *  4. 오늘 저장된 pending 추천 상대를 차단하면 expired 처리 후 반환하지 않고 다른 후보를 만든다
 *  5. 신고 당사자 쌍 제외 / 후보가 없으면 조건 완화 없이 exhausted
 *  6. reasons 는 공개 사실만, 비공개 응답을 바꿔도 reasons 불변
 *  8. (#23) 적격 후보 수(eligibleCount)·저장 id(createdIds) 관측, recommendation_created 이벤트는 저장 행 기준 1건 (재요청·재실행에도 불변),
 *     후보 없음은 eligibleCount=0 · 조회 실패는 이벤트·행 없음
 *  9. (#22/#17, 0032) 배치 sweep 전체: 후보 없음 대기 → 1시간 안 재탐색 없음 → 후보 추가 → 재시도 시점 뒤 배치가 소개 생성 → 알림 이벤트 1건,
 *     배치 재실행·앱 요청 중첩에도 중복 없음, 발송 시점 재확인(상대 제재 → 무효), 발송 실패·설정 off·토큰 없음은 소개 생성과 무관
 */
import { execFileSync } from 'node:child_process';
import { computeMatch } from '../functions/_shared/matching/MatchingEngine.ts';
import { runBatchSweep } from '../functions/_shared/matching/batchSweep.ts';
import { runDailyRecommendation, CARD_FIELDS } from '../functions/_shared/matching/recommend.ts';
import { runDailyRecommendationWithClaim } from '../functions/_shared/matching/runWithClaim.ts';
import { loadSnapshots } from '../functions/_shared/matching/snapshot.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const GENDER = new Set(['male', 'female']);

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) {
    passed += 1;
    console.log(`ok: ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL: ${name}`);
  }
}

function q(sql) {
  const out = execFileSync('psql', ['-X', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' });
  return out.trim();
}
function qjson(sql) {
  const out = q(sql);
  return out ? JSON.parse(out) : [];
}
function lit(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}
function uuidArray(ids) {
  for (const id of ids) if (!UUID.test(id)) throw new Error(`bad uuid ${id}`);
  if (ids.length === 0) return `array[]::uuid[]`;
  return `array[${ids.map((i) => `'${i}'`).join(',')}]::uuid[]`;
}
function uuid(id) {
  if (!UUID.test(id)) throw new Error(`bad uuid ${id}`);
  return `'${id}'::uuid`;
}

/** DataSource 의 psql 구현 — supabaseDataSource.ts 와 같은 계약·같은 필터 */
const ds = {
  async profiles(ids) {
    return qjson(`select coalesce(json_agg(p), '[]') from public.profiles p where p.user_id = any(${uuidArray(ids)})`);
  },
  async privateProfiles(ids) {
    return qjson(`select coalesce(json_agg(p), '[]') from public.private_profiles p where p.user_id = any(${uuidArray(ids)})`);
  },
  async questionnaireResponses(ids) {
    return qjson(
      `select coalesce(json_agg(json_build_object('user_id', user_id, 'question_id', question_id, 'value', value)), '[]') from public.questionnaire_responses where user_id = any(${uuidArray(ids)})`,
    );
  },
  async questionnaireQuestions() {
    return qjson(`select coalesce(json_agg(json_build_object('id', id, 'category', category, 'axis', axis, 'reverse', reverse)), '[]') from public.questionnaire_questions`);
  },
  async preferenceSettings(ids) {
    // appearance_importance 는 읽지 않는다
    return qjson(
      `select coalesce(json_agg(json_build_object('user_id', user_id, 'age_min', age_min, 'age_max', age_max, 'age_direction', age_direction, 'height_min', height_min, 'height_max', height_max, 'regions', regions, 'smoking_pref', smoking_pref, 'personality_keywords', personality_keywords, 'personality_importance', personality_importance, 'values_importance', values_importance, 'lifestyle_importance', lifestyle_importance, 'relationship_importance', relationship_importance)), '[]') from public.preference_settings where user_id = any(${uuidArray(ids)})`,
    );
  },
  async dealbreakers(ids) {
    return qjson(`select coalesce(json_agg(json_build_object('user_id', user_id, 'kind', kind, 'value', value)), '[]') from public.dealbreakers where user_id = any(${uuidArray(ids)})`);
  },
  async userAccounts(ids) {
    if (ids.length === 0) return [];
    return qjson(
      `select coalesce(json_agg(json_build_object('id', id, 'status', status, 'onboarding_completed', onboarding_completed, 'identity_verified', identity_verified, 'face_verified', face_verified, 'age_verified', age_verified)), '[]') from public.users where id = any(${uuidArray(ids)})`,
    );
  },
  async activeMatchCounts(ids) {
    if (ids.length === 0) return {};
    const rows = qjson(`select coalesce(json_agg(json_build_object('user_id', user_id, 'active_matches', active_matches)), '[]') from public.conversation_slot_usage where user_id = any(${uuidArray(ids)})`);
    const out = {};
    for (const r of rows) out[r.user_id] = Number(r.active_matches) || 0;
    return out;
  },
  async blockPairs(userId) {
    return qjson(`select coalesce(json_agg(json_build_object('blocker_id', blocker_id, 'blocked_id', blocked_id)), '[]') from public.blocks where blocker_id = ${uuid(userId)} or blocked_id = ${uuid(userId)}`);
  },
  async reportPairs(userId) {
    return qjson(`select coalesce(json_agg(json_build_object('reporter_id', reporter_id, 'reported_id', reported_id)), '[]') from public.reports where reporter_id = ${uuid(userId)} or reported_id = ${uuid(userId)}`);
  },
  async likedUserIds(userId) {
    return qjson(`select coalesce(json_agg(to_user_id), '[]') from public.likes where from_user_id = ${uuid(userId)}`);
  },
  async matchedUserIds(userId) {
    return qjson(`select coalesce(json_agg(case when user_a = ${uuid(userId)} then user_b else user_a end), '[]') from public.matches where user_a = ${uuid(userId)} or user_b = ${uuid(userId)}`);
  },
  async pastRecommendations(userId) {
    return qjson(`select coalesce(json_agg(json_build_object('candidate_id', candidate_id, 'status', status, 'for_date', to_char(for_date, 'YYYY-MM-DD'))), '[]') from public.recommendations where user_id = ${uuid(userId)}`);
  },
  async recommendationsForDate(userId, forDate) {
    if (!DATE.test(forDate)) throw new Error('bad date');
    return qjson(
      `select coalesce(json_agg(json_build_object('id', id, 'status', status, 'strategy', strategy, 'card', card, 'candidate_id', candidate_id) order by created_at), '[]') from public.recommendations where user_id = ${uuid(userId)} and for_date = ${lit(forDate)}::date`,
    );
  },
  async candidateIdsPage(gender, seekingGender, offset, limit) {
    if (!GENDER.has(gender) || !GENDER.has(seekingGender)) throw new Error('bad gender');
    return qjson(
      `select coalesce(json_agg(t.user_id order by t.user_id), '[]') from (
         select p.user_id from public.profiles p join public.users u on u.id = p.user_id
         where p.gender = ${lit(gender)} and p.seeking_gender = ${lit(seekingGender)}
           and u.status = 'active' and u.onboarding_completed and u.identity_verified and u.face_verified and u.age_verified
         order by p.user_id offset ${Number(offset) | 0} limit ${Number(limit) | 0}) t`,
    );
  },
  async insertRecommendation(row) {
    const rows = qjson(
      `with ins as (insert into public.recommendations (user_id, candidate_id, for_date, strategy, score_total, score_a_to_b, score_b_to_a, dimensions, card)
         values (${uuid(row.user_id)}, ${uuid(row.candidate_id)}, ${lit(row.for_date)}::date, ${lit(row.strategy)},
                 ${row.score_total == null ? 'null' : Number(row.score_total)}, ${row.score_a_to_b == null ? 'null' : Number(row.score_a_to_b)}, ${row.score_b_to_a == null ? 'null' : Number(row.score_b_to_a)},
                 ${lit(JSON.stringify(row.dimensions))}::jsonb, ${lit(JSON.stringify(row.card))}::jsonb)
         returning id, status, strategy, card, candidate_id)
       select json_agg(json_build_object('id', id, 'status', status, 'strategy', strategy, 'card', card, 'candidate_id', candidate_id)) from ins`,
    );
    return rows[0];
  },
  async expireRecommendations(ids) {
    if (ids.length === 0) return;
    q(`update public.recommendations set status = 'expired' where id = any(${uuidArray(ids)}) and status = 'pending'`);
  },
};

const TODAY = q(`select (now() at time zone 'Asia/Seoul')::date`);
const NOW_YEAR = Number(TODAY.slice(0, 4));
const run = (userId) => runDailyRecommendation(ds, { userId, today: TODAY, nowYear: NOW_YEAR, dailyLimit: 1 });

// ---------------------------------------------------------------------------
// 1) seed 사용자(외모 이벤트 + feature_vector 있음): 외모 데이터를 지워도 같은 결과
// ---------------------------------------------------------------------------
const M2 = 'a1000000-0000-4000-8000-000000000002'; // 민준 — seed 에 추천 없음
{
  const appearanceRows = Number(q(`select count(*) from public.appearance_preference_events`));
  const vectorRows = Number(q(`select count(*) from public.face_verifications where feature_vector is not null`));
  check('seed 에 과거 외모 데이터가 존재한다 (테스트 전제)', appearanceRows > 0 && vectorRows > 0);

  const first = await run(M2);
  check('seed 사용자 추천 생성 (외모 데이터 존재 상태)', first.kind === 'ok' && first.recommendations.length === 1);
  const stored1 = qjson(`select json_agg(json_build_object('candidate_id', candidate_id, 'score_total', score_total, 'dimensions', dimensions, 'card', card)) from public.recommendations where user_id = ${uuid(M2)}`)[0];

  q(`delete from public.recommendations where user_id = ${uuid(M2)}`);
  q(`delete from public.appearance_preference_events`);
  q(`update public.face_verifications set feature_vector = null`);
  q(`update public.preference_settings set appearance_importance = 1`);
  const second = await run(M2);
  const stored2 = qjson(`select json_agg(json_build_object('candidate_id', candidate_id, 'score_total', score_total, 'dimensions', dimensions, 'card', card)) from public.recommendations where user_id = ${uuid(M2)}`)[0];
  check('외모 데이터·중요도를 모두 바꿔도 같은 후보', second.kind === 'ok' && stored1?.candidate_id === stored2?.candidate_id);
  check('… 같은 총점·차원', JSON.stringify(stored1?.score_total) === JSON.stringify(stored2?.score_total) && JSON.stringify(stored1?.dimensions) === JSON.stringify(stored2?.dimensions));
  check('… 같은 reasons', JSON.stringify(stored1?.card?.reasons) === JSON.stringify(stored2?.card?.reasons));
  check('저장된 dimensions 에 appearance 없음, basis 있음', stored2 && !('appearance' in stored2.dimensions) && ['scored', 'conditions_only'].includes(stored2.dimensions.basis));
}

// ---------------------------------------------------------------------------
// 2) 외모 데이터가 전혀 없는 신규 사용자 (정상 인증) — 실제 가입 경로와 같은 데이터 상태
// ---------------------------------------------------------------------------
const X = '40400000-0000-4000-8000-000000000001';
const Y1 = '40400000-0000-4000-8000-000000000002';
const Y2 = '40400000-0000-4000-8000-000000000003';
const Y3 = '40400000-0000-4000-8000-000000000004'; // 인증 미완료
const Y4 = '40400000-0000-4000-8000-000000000005'; // 정지
q(`
do $$
declare ids uuid[] := array['${X}','${Y1}','${Y2}','${Y3}','${Y4}']::uuid[]; i uuid;
begin
  foreach i in array ids loop
    insert into auth.users (id, email) values (i, i::text || '@t40.dev') on conflict do nothing;
  end loop;
  -- 서버 컨텍스트: 인증 플래그는 verify-identity / face_liveness_approve 가 세우는 값과 같은 형태
  update public.users set onboarding_completed = true, onboarding_step = 'done', identity_verified = true, face_verified = true, age_verified = true where id = any(ids);
  update public.users set face_verified = false where id = '${Y3}';
  update public.users set status = 'suspended' where id = '${Y4}';
  insert into public.profiles (user_id, nickname, birth_year, gender, seeking_gender, region_code, height_cm, job_group, smoking, drinking, hobbies, personality_keywords, relationship_goal, public_answers) values
    -- seed 데모 사용자(남→여/여→남)와 후보 풀이 겹치지 않도록 여→여 지향으로 만든다
    ('${X}',  '엑스', 1994, 'female', 'female', 'seoul', 166, 'it',      'none', 'sometimes', array['travel','cafe'], array['calm'],  'serious',      '{"day_off":["cafe","walk"],"important":"honest_talk"}'),
    ('${Y1}', '와이일', 1996, 'female', 'female', 'seoul', 162, 'office',  'none', 'sometimes', array['travel'],        array['calm'],  'serious',      '{"day_off":["walk"],"important":"respect"}'),
    ('${Y2}', '와이이', 1997, 'female', 'female', 'busan', 160, 'creative','none', 'none',      array['games'],         array['humor'], 'take_it_slow', '{"day_off":["rest_home"]}'),
    ('${Y3}', '와이삼', 1995, 'female', 'female', 'seoul', 165, 'medical', 'none', 'none',      array['travel','cafe'], array['calm'],  'serious',      '{"day_off":["cafe","walk"],"important":"honest_talk"}'),
    ('${Y4}', '와이사', 1995, 'female', 'female', 'seoul', 165, 'medical', 'none', 'none',      array['travel','cafe'], array['calm'],  'serious',      '{"day_off":["cafe","walk"],"important":"honest_talk"}');
  insert into public.private_profiles (user_id, marriage_intent, children_intent, contact_frequency, date_frequency, personal_time_need, spending_style) values
    ('${X}', 4, 3, 4, 3, 3, 3), ('${Y1}', 4, 3, 4, 3, 3, 3), ('${Y2}', 1, 1, 1, 1, 5, 5), ('${Y3}', 4, 3, 4, 3, 3, 3), ('${Y4}', 4, 3, 4, 3, 3, 3);
  insert into public.preference_settings (user_id) values ('${X}'), ('${Y1}'), ('${Y2}'), ('${Y3}'), ('${Y4}');
end $$;`);
check('신규 사용자에게 외모 데이터가 전혀 없다 (전제)', Number(q(`select count(*) from public.appearance_preference_events where user_id = any(${uuidArray([X, Y1, Y2])})`)) === 0 && Number(q(`select count(*) from public.face_verifications where user_id = any(${uuidArray([X, Y1, Y2])})`)) === 0);

{
  const out = await run(X);
  check('얼굴 벡터 없이 DB → 추천 생성 → 카드 반환', out.kind === 'ok' && out.recommendations.length === 1);
  if (out.kind === 'ok') {
    const rec = out.recommendations[0];
    check('공개 프로필이 더 겹치는 Y1 이 선택 (Y3 인증 미완료·Y4 정지는 후보 아님)', rec.candidate_id === Y1);
    const keys = Object.keys(rec.card);
    check('반환 카드는 allowlist 키만', keys.every((k) => CARD_FIELDS.includes(k)) && keys.length === CARD_FIELDS.length);
    check('카드 reasons 는 공개 사실만 (취미·지역·목적·쉬는 날 겹침)', rec.card.reasons.length > 0 && rec.card.reasons.every((r) => ['공통 관심사가 있어요', '같은 지역을 선택했어요', '연애 목적이 같아요', '쉬는 날 보내는 방식이 겹쳐요', '스스로 고른 키워드가 겹쳐요'].includes(r)));
    check('카드 intro 는 선택지로 조합된 문장', typeof rec.card.intro === 'string' && rec.card.intro.includes('진지한 연애를 원해요'));
    const row = qjson(`select json_agg(json_build_object('dimensions', dimensions, 'score_total', score_total, 'strategy', strategy)) from public.recommendations where user_id = ${uuid(X)}`)[0];
    check('DB 저장 행: dimensions 에 appearance 없음·strategy 는 허용값', row && !('appearance' in row.dimensions) && ['high_confidence', 'exploration', 'fallback'].includes(row.strategy));
    check('DB 저장 행: 외모 없이 scored 총점 존재', row && row.dimensions.basis === 'scored' && row.score_total != null);
    // #23 관측: 적격 후보는 Y1·Y2 (Y3 인증 미완료·Y4 정지 제외) → eligibleCount=2, createdIds 는 저장된 행
    check('#23 eligibleCount=2 (인증 미완료·정지 후보 제외) · capReached=false · createdIds=[저장 id]', out.eligibleCount === 2 && out.capReached === false && out.createdIds.length === 1 && out.createdIds[0] === rec.id);
    const ev = qjson(`select coalesce(json_agg(json_build_object('user_id', user_id, 'payload', payload)), '[]') from public.analytics_events where event_type = 'recommendation_created' and payload->>'recommendation_id' = ${lit(rec.id)}`);
    check('#23 recommendation_created 이벤트가 저장 행 기준 1건 · strategy/basis 는 저장값 · 카드 없음', ev.length === 1 && ev[0].user_id === X && ev[0].payload.strategy === rec.strategy && ev[0].payload.basis === 'scored' && !('card' in ev[0].payload) && !('score_total' in ev[0].payload));
  }
  // 재요청: 오늘 이미 있으면 그대로 반환, 새로 만들지 않는다
  const again = await run(X);
  check('재요청 시 같은 추천 반환·중복 생성 없음', again.kind === 'ok' && again.recommendations.length === 1 && Number(q(`select count(*) from public.recommendations where user_id = ${uuid(X)}`)) === 1);
  check('#23 재요청은 훑지 않는다 → eligibleCount=null(미측정) · createdIds=[] · 이벤트 여전히 1건', again.kind === 'ok' && again.eligibleCount === null && again.createdIds.length === 0 && Number(q(`select count(*) from public.analytics_events where event_type = 'recommendation_created' and payload->>'recommendation_id' in (select id::text from public.recommendations where user_id = ${uuid(X)})`)) === 1);
}

// 비공개 응답만 바꿔도 같은 쌍(X, Y1)의 reasons 불변 — 내부 순위는 달라질 수 있다
{
  const before = qjson(`select json_agg(json_build_object('reasons', card->'reasons', 'score_total', score_total)) from public.recommendations where user_id = ${uuid(X)}`)[0];
  q(`update public.private_profiles set marriage_intent = 1, children_intent = 1, contact_frequency = 1, date_frequency = 1, personal_time_need = 5, spending_style = 5 where user_id = ${uuid(X)}`);
  const snaps = await loadSnapshots(ds, [X, Y1]);
  const afterPair = computeMatch(snaps.get(X), snaps.get(Y1), NOW_YEAR);
  check('비공개 응답만 바꾸면 같은 쌍의 내부 점수는 달라진다', afterPair.score?.total != null && Math.abs(afterPair.score.total - Number(before.score_total)) > 1e-6);
  check('비공개 응답만 바꿔도 같은 쌍의 사용자용 reasons 는 동일', JSON.stringify(afterPair.reasons) === JSON.stringify(before.reasons));
  q(`update public.private_profiles set marriage_intent = 4, children_intent = 3, contact_frequency = 4, date_frequency = 3, personal_time_need = 3, spending_style = 3 where user_id = ${uuid(X)}`);
}

// ---------------------------------------------------------------------------
// 3) 요청자 인증 미완료 → 거부 / 4) 오늘 pending 추천 상대 차단 → expired + 다른 후보
// ---------------------------------------------------------------------------
{
  q(`update public.users set face_verified = false where id = ${uuid(X)}`);
  check('요청자 얼굴 인증 미완료 → not_verified', (await run(X)).kind === 'not_verified');
  q(`update public.users set face_verified = true where id = ${uuid(X)}`);

  // X 가 오늘 추천 상대(Y1)를 차단
  q(`insert into public.blocks (blocker_id, blocked_id) values (${uuid(X)}, ${uuid(Y1)})`);
  const out = await run(X);
  const statuses = qjson(`select json_agg(json_build_object('candidate_id', candidate_id, 'status', status) order by created_at) from public.recommendations where user_id = ${uuid(X)}`);
  check('차단 후 오늘 pending 추천은 expired 로 마감', statuses.some((r) => r.candidate_id === Y1 && r.status === 'expired'));
  check('차단 상대는 반환되지 않고 다른 후보(Y2)가 새로 생성', out.kind === 'ok' && out.recommendations.length === 1 && out.recommendations[0].candidate_id === Y2);
  check('기존 행(차단 상대) 삭제되지 않음 — 이력 보존', statuses.length === 2);
}

// ---------------------------------------------------------------------------
// 5) 후보 부족 → 조건 완화 없음 / 신고 당사자 쌍 제외
// ---------------------------------------------------------------------------
{
  // Y2 가 X 를 신고 → 다음 추천에서 쌍 제외. Y2 는 이미 오늘 pending 추천 상대: 재검증은 차단만 보므로 유지된다 (신고 ≠ 차단)
  q(`insert into public.reports (reporter_id, reported_id, reason) values (${uuid(Y2)}, ${uuid(X)}, 'spam')`);
  const still = await run(X);
  check('신고만으로는 이미 만들어진 오늘 추천이 사라지지 않는다 (차단과 구분)', still.kind === 'ok' && still.recommendations.length === 1);
  // 내일로 가정: 오늘 행을 skipped 로 만들고 새 요청 → Y1 차단·Y2 신고 쌍 → 남은 후보 없음
  q(`update public.recommendations set status = 'skipped' where user_id = ${uuid(X)} and status = 'pending'`);
  q(`delete from public.recommendations where user_id = ${uuid(X)} and status = 'skipped'`); // 과거 추천 제외 규칙과 무관하게 후보 부족만 검증
  const out = await run(X);
  check('차단·신고 쌍을 빼면 후보 없음 → exhausted (완화 없음, 인증 미완료 Y3·정지 Y4 도 뽑지 않음)', out.kind === 'ok' && out.exhausted && out.recommendations.length === 0);
  check('exhausted 시 새 행이 생기지 않는다', Number(q(`select count(*) from public.recommendations where user_id = ${uuid(X)}`)) === 1);
  check('#23 후보 없음은 eligibleCount=0 (측정됨) · capReached=false (전체 탐색) · 새 이벤트 없음', out.kind === 'ok' && out.eligibleCount === 0 && out.capReached === false && Number(q(`select count(*) from public.analytics_events where event_type = 'recommendation_created' and user_id = ${uuid(X)}`)) === 2);
}

// ---------------------------------------------------------------------------
// 5a) (#23) 조회 실패 → lookup_failed: 후보 0명·exhausted 로 위장하지 않고 행·이벤트도 남기지 않는다
// ---------------------------------------------------------------------------
{
  const before = Number(q(`select count(*) from public.analytics_events where event_type = 'recommendation_created' and user_id = ${uuid(X)}`));
  const broken = { ...ds, candidateIdsPage: async () => { throw new Error('simulated candidates failure'); } };
  q(`delete from public.recommendation_runs where user_id = ${uuid(X)}`);
  const fail = await runDailyRecommendation(broken, { userId: X, today: TODAY, nowYear: NOW_YEAR, dailyLimit: 1 });
  check('#23 후보 조회 실패 → lookup_failed(candidates), exhausted 아님', fail.kind === 'lookup_failed' && fail.stage === 'candidates');
  check('#23 조회 실패는 추천 행·이벤트를 만들지 않는다', Number(q(`select count(*) from public.recommendations where user_id = ${uuid(X)}`)) === 1 && Number(q(`select count(*) from public.analytics_events where event_type = 'recommendation_created' and user_id = ${uuid(X)}`)) === before);
}

// ---------------------------------------------------------------------------
// 5b) 재추천 주기 (#23): 31일 전 skipped 상대는 다시 후보, 최근 skipped 는 제외
// ---------------------------------------------------------------------------
{
  q(`delete from public.reports where reporter_id = ${uuid(Y2)} and reported_id = ${uuid(X)}`);
  q(`delete from public.recommendations where user_id = ${uuid(X)}`);
  q(`delete from public.recommendation_runs where user_id = ${uuid(X)}`);
  // Y2 를 10일 전에 스킵 → 오늘은 제외 (Y1 은 차단) → exhausted
  q(`insert into public.recommendations (user_id, candidate_id, for_date, status, card) values (${uuid(X)}, ${uuid(Y2)}, ${lit(TODAY)}::date - 10, 'skipped', '{}')`);
  const recent = await run(X);
  check('10일 전 스킵한 상대는 아직 제외 → exhausted', recent.kind === 'ok' && recent.exhausted);
  q(`update public.recommendations set for_date = ${lit(TODAY)}::date - 31 where user_id = ${uuid(X)} and candidate_id = ${uuid(Y2)}`);
  const again = await run(X);
  check('31일 전 스킵한 상대(Y2)는 다시 추천된다', again.kind === 'ok' && !again.exhausted && again.recommendations[0]?.candidate_id === Y2);
  check('과거 skipped 행은 보존되고 새 pending 행이 추가된다', Number(q(`select count(*) from public.recommendations where user_id = ${uuid(X)} and candidate_id = ${uuid(Y2)}`)) === 1 || Number(q(`select count(*) from public.recommendations where user_id = ${uuid(X)}`)) === 2);
}

// ---------------------------------------------------------------------------
// 6) 후보 조회 SQL 이 인증 미완료·정지 사용자를 반환하지 않는다 (DataSource 계약 검증)
// ---------------------------------------------------------------------------
{
  const page = await ds.candidateIdsPage('female', 'female', 0, 1000);
  check('candidateIdsPage 에 인증 미완료(Y3)·정지(Y4) 없음, Y1·Y2 있음', !page.includes(Y3) && !page.includes(Y4) && page.includes(Y1) && page.includes(Y2));
}

// ---------------------------------------------------------------------------
// 7) 동시 대화 3개 제한 (#24): 요청자가 가득 차면 slotsFull (exhausted 아님·새 행 없음), 가득 찬 후보는 제외
// ---------------------------------------------------------------------------
{
  q(`delete from public.recommendations where user_id = ${uuid(X)}`);
  q(`delete from public.recommendation_runs where user_id = ${uuid(X)}`);
  // X 에게 활성 매치 3개 (서버 직접 insert — 테스트용 상대는 실제 후보와 무관한 id)
  const partners = ['aa240000-0000-4000-8000-00000000a001', 'aa240000-0000-4000-8000-00000000a002', 'aa240000-0000-4000-8000-00000000a003'];
  for (const pid of partners) {
    q(`insert into auth.users (id, email) values (${uuid(pid)}, 'slot-${pid.slice(-4)}@test.dev') on conflict do nothing`);
    q(`insert into public.matches (user_a, user_b) values (least(${uuid(X)}, ${uuid(pid)}), greatest(${uuid(X)}, ${uuid(pid)})) on conflict do nothing`);
  }
  const full = await run(X);
  check('요청자 진행 중 매치 3개 → slotsFull (후보 부족 아님)', full.kind === 'ok' && full.slotsFull === true && !full.exhausted && full.recommendations.length === 0);
  check('slotsFull 이면 새 추천 행이 생기지 않는다', Number(q(`select count(*) from public.recommendations where user_id = ${uuid(X)}`)) === 0);
  // 하나 종료 → 자리 → 다시 생성 (Y2 는 31일 전 skipped 라 후보)
  q(`update public.matches set status = 'closed' where user_a = least(${uuid(X)}, ${uuid(partners[0])}) and user_b = greatest(${uuid(X)}, ${uuid(partners[0])})`);
  q(`delete from public.recommendation_runs where user_id = ${uuid(X)}`);
  const freed = await run(X);
  check('자리가 생기면 다시 추천된다', freed.kind === 'ok' && !freed.slotsFull && freed.recommendations.length === 1);
  // 후보(Y2)가 가득 차면 제외 → 후보 없음
  q(`delete from public.recommendations where user_id = ${uuid(X)}`);
  q(`delete from public.recommendation_runs where user_id = ${uuid(X)}`);
  for (const pid of partners) {
    q(`insert into public.matches (user_a, user_b) values (least(${uuid(Y2)}, ${uuid(pid)}), greatest(${uuid(Y2)}, ${uuid(pid)})) on conflict do nothing`);
  }
  const noCandidate = await run(X);
  check('진행 중 매치가 가득 찬 후보(Y2)는 제외 → exhausted (slotsFull 아님)', noCandidate.kind === 'ok' && noCandidate.exhausted && !noCandidate.slotsFull);
}

// ---------------------------------------------------------------------------
// 8) (#22/#17, 0032) 후보 부족 대기 → 후보 추가 → 앱 미접속 상태에서 배치가 소개 생성 → 알림 이벤트 1건 — 실제 DB 위에서 sweep 전체
//    claim/finish/커서/대상 RPC 를 psql 로 호출하고(Edge 함수와 같은 SQL), 시간은 finished_at 을 옮겨 제어한다.
//    풀 격리: 남→남 지향은 seed·앞 절 사용자에 없다. 대상 조회는 SQL 그대로 쓰되 이 절의 사용자만 남긴다 (seed 사용자를 배치로 훑지 않기 위해)
// ---------------------------------------------------------------------------
const A = '32320000-0000-4000-8000-000000000001'; // 대기 사용자
const B = '32320000-0000-4000-8000-000000000002'; // 나중에 가입하는 적격 후보
{
  const POOL = new Set([A, B]);
  const claims = {
    async claim(userId, forDate) {
      const j = JSON.parse(q(`select public.recommendation_run_claim(${uuid(userId)}, ${lit(forDate)}::date)`));
      return { claim: j.claim, result: j.result, capReached: j.cap_reached === true };
    },
    async finish(userId, forDate, result, scanned, capReached, details) {
      q(`select public.recommendation_run_finish(${uuid(userId)}, ${lit(forDate)}::date, ${lit(result)}, ${Number(scanned) | 0}, ${capReached ? 'true' : 'false'},
           ${details?.eligible == null ? 'null' : Number(details.eligible)}, ${details?.recommendationId ? uuid(details.recommendationId) : 'null'}, ${details?.errorStage ? lit(details.errorStage) : 'null'})`);
    },
  };
  const sweeps = [];
  const deps = {
    now: () => new Date(),
    seoulToday: (now) => now.toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' }),
    async cursorClaim(forDate) {
      const j = JSON.parse(q(`select public.recommendation_batch_cursor_claim(${lit(forDate)}::date, 180)`));
      return { claimed: j.claimed === true, after: typeof j.after === 'string' ? j.after : null };
    },
    async cursorSave(forDate, nextAfter, release) {
      q(`select public.recommendation_batch_cursor_save(${lit(forDate)}::date, ${nextAfter ? uuid(nextAfter) : 'null'}, ${release ? 'true' : 'false'}, 180)`);
    },
    async targets(forDate, after, limit) {
      const rows = qjson(`select coalesce(json_agg(t.user_id order by t.user_id), '[]') from public.recommendation_batch_targets(${lit(forDate)}::date, ${after ? uuid(after) : 'null'}, ${Number(limit) | 0}) t`);
      return rows.filter((id) => POOL.has(id));
    },
    processUser: (userId, forDate, nowYear) => runDailyRecommendationWithClaim(ds, claims, { userId, today: forDate, nowYear, dailyLimit: 1 }, { retries: 0 }),
    async reportError(e) { sweeps.push({ error: String(e) }); },
  };
  const sweep = async (opts = {}) => { const r = await runBatchSweep(deps, { pageSize: 100, ...opts }); sweeps.push(r); return r; };
  const count = (sql) => Number(q(sql));
  const recsA = () => count(`select count(*) from public.recommendations where user_id = ${uuid(A)}`);
  const eventsA = () => count(`select count(*) from public.notification_events where recipient_id = ${uuid(A)} and kind = 'daily_recommendation'`);
  const runA = () => qjson(`select coalesce(json_agg(json_build_object('status', status, 'result', result, 'attempts', attempts, 'eligible_count', eligible_count)), '[]') from public.recommendation_runs where user_id = ${uuid(A)} and for_date = ${lit(TODAY)}::date`)[0] ?? null;

  q(`
  do $$
  begin
    insert into auth.users (id, email) values (${uuid(A)}, 'batch-a@t22.dev') on conflict do nothing;
    update public.users set onboarding_completed = true, onboarding_step = 'done', identity_verified = true, face_verified = true, age_verified = true where id = ${uuid(A)};
    insert into public.profiles (user_id, nickname, birth_year, gender, seeking_gender, region_code, height_cm, job_group, smoking, drinking, hobbies, personality_keywords, relationship_goal, public_answers) values
      (${uuid(A)}, '대기에이', 1994, 'male', 'male', 'seoul', 176, 'it', 'none', 'sometimes', array['travel'], array['calm'], 'serious', '{"day_off":["cafe"]}');
    insert into public.private_profiles (user_id, marriage_intent, children_intent, contact_frequency, date_frequency, personal_time_need, spending_style) values (${uuid(A)}, 4, 3, 4, 3, 3, 3);
    insert into public.preference_settings (user_id) values (${uuid(A)});
    insert into public.push_tokens (user_id, token, platform) values (${uuid(A)}, 'ExponentPushToken[t22-aaaa]', 'android');
    delete from public.recommendation_batch_cursor;
  end $$;`);

  // (1) 후보가 없다 → 배치가 exhausted 로 기록, 추천·알림 없음. 그날 소개를 받은 것으로 치지 않는다
  const s1 = await sweep();
  check('#22 배치 sweep: 후보 없는 A → exhausted 1 · 생성 0 · 완료', s1.processed === 1 && s1.exhausted === 1 && s1.created === 0 && s1.sweep_completed && s1.stopped_reason === 'completed');
  check('#22 실행 기록 exhausted(eligible 0) · 추천 행 없음 · 알림 이벤트 없음 (후보 부족 확인만으로는 알림 없음)', runA()?.result === 'exhausted' && runA()?.eligible_count === 0 && recsA() === 0 && eventsA() === 0);
  // (2) 1시간 안 재실행: 다시 훑지 않는다 (대상에서 제외)
  const s2 = await sweep();
  check('#23 1시간 안의 재실행은 A 를 다시 훑지 않는다 (processed 0)', s2.processed === 0 && runA()?.attempts === 1);
  // (3) 적격 후보 B 가 가입·인증 — 그래도 1시간 안에는 재탐색하지 않는다. 알림도 없다 (신규 가입은 알림 사유가 아니다)
  q(`
  do $$
  begin
    insert into auth.users (id, email) values (${uuid(B)}, 'batch-b@t22.dev') on conflict do nothing;
    update public.users set onboarding_completed = true, onboarding_step = 'done', identity_verified = true, face_verified = true, age_verified = true where id = ${uuid(B)};
    insert into public.profiles (user_id, nickname, birth_year, gender, seeking_gender, region_code, height_cm, job_group, smoking, drinking, hobbies, personality_keywords, relationship_goal, public_answers) values
      (${uuid(B)}, '후보비', 1996, 'male', 'male', 'seoul', 178, 'office', 'none', 'sometimes', array['travel'], array['calm'], 'serious', '{"day_off":["cafe"]}');
    insert into public.private_profiles (user_id, marriage_intent, children_intent, contact_frequency, date_frequency, personal_time_need, spending_style) values (${uuid(B)}, 4, 3, 4, 3, 3, 3);
    insert into public.preference_settings (user_id) values (${uuid(B)});
  end $$;`);
  const s3 = await sweep();
  check('#23 후보 B 추가 직후(1시간 안): A 는 여전히 건너뛴다 · B 는 처리(A 가 pending 없음 → B→A 소개 가능)', s3.processed === 1 && recsA() === 0 && eventsA() === 0);
  // B 가 오늘 A 를 소개받았을 수 있다 (B→A). A 의 관점은 그대로 후보 부족 대기 — A 에게는 아직 소개가 없다
  // (4) 1시간 경과(시계 제어: finished_at 을 2시간 앞으로) → 앱을 열지 않아도 배치가 A 에게 B 를 소개하고 알림 이벤트가 1건 생긴다
  q(`update public.recommendation_runs set finished_at = finished_at - interval '2 hours' where user_id = ${uuid(A)} and for_date = ${lit(TODAY)}::date`);
  const s4 = await sweep();
  check('#22 재시도 시점 이후 배치: A 처리 → 소개 생성(created 1)', s4.processed === 1 && s4.created === 1 && s4.failed === 0);
  const recA = qjson(`select coalesce(json_agg(json_build_object('id', id, 'candidate_id', candidate_id, 'status', status)), '[]') from public.recommendations where user_id = ${uuid(A)}`)[0];
  check('#22 A 에게 B 가 pending 으로 저장 · 실행 기록 ok · attempts 2', recA?.candidate_id === B && recA?.status === 'pending' && runA()?.result === 'ok' && runA()?.attempts === 2);
  const evA = qjson(`select coalesce(json_agg(json_build_object('id', id, 'recommendation_id', recommendation_id, 'delivered_at', delivered_at, 'dedupe_key', dedupe_key)), '[]') from public.notification_events where recipient_id = ${uuid(A)} and kind = 'daily_recommendation'`);
  check('#17 소개 저장 → daily_recommendation 이벤트 정확히 1건 · 저장된 추천을 가리킴 · dedupe 는 사용자+KST 날짜', evA.length === 1 && evA[0].recommendation_id === recA?.id && evA[0].delivered_at === null && evA[0].dedupe_key === `recommendation:${A}:${TODAY}`);
  check('#23 recommendation_created 분석 이벤트도 저장 행 기준 1건', count(`select count(*) from public.analytics_events where event_type = 'recommendation_created' and payload->>'recommendation_id' = ${lit(recA?.id ?? '')}`) === 1);
  // (5) 배치 재실행·앱 요청·수동 after=null 실행이 겹쳐도 소개·이벤트가 늘지 않는다
  const s5 = await sweep();
  const app = await runDailyRecommendationWithClaim(ds, claims, { userId: A, today: TODAY, nowYear: NOW_YEAR, dailyLimit: 1 });
  const s6 = await sweep({ after: null });
  check('#22 배치 재실행(2회)·앱 요청이 겹쳐도 새 처리 없음 — 추천 1 · 알림 1 · 실행 행 1', s5.processed === 0 && s6.processed === 0 && app.kind === 'ok' && app.skipped === true && app.recommendations.length === 1 && app.recommendations[0].id === recA?.id && recsA() === 1 && eventsA() === 1 && count(`select count(*) from public.recommendation_runs where user_id = ${uuid(A)}`) === 1);
  check('#22 커서: sweep 완료 뒤 after=null · lease 해제 · 오늘 날짜', count(`select count(*) from public.recommendation_batch_cursor where for_date = ${lit(TODAY)}::date and after is null and lease_until is null`) === 1);
  // (6) 발송 시점 재확인 (#17): 유효 → true, 상대 제재 → false (발송기가 recommendation_invalid 로 닫는다), 발송 실패는 새 소개를 만들지 않는다
  const dq = (sql) => qjson(`select coalesce(json_agg(json_build_object('id', d.id, 'recommendation_valid', d.recommendation_valid, 'tokens', d.tokens, 'pref_enabled', d.pref_enabled)), '[]') from public.notification_events_dequeue(500) d where d.recipient_id = ${uuid(A)}`);
  const d1 = dq();
  check('#17 dequeue: A 의 소개 이벤트 1건 · 토큰 1개 · 설정 on · recommendation_valid=true', d1.length === 1 && d1[0].recommendation_valid === true && d1[0].tokens.length === 1 && d1[0].pref_enabled === true);
  q(`select public.notification_events_mark(array[]::bigint[], array[]::bigint[], null, array[${d1[0].id}]::bigint[], 'expo push http 500')`); // 발송 실패 → 재시도 대기
  check('#17 발송 실패는 새 소개를 만들지 않는다 (추천 1 · 이벤트 1)', recsA() === 1 && eventsA() === 1);
  q(`update public.notification_events set claimed_at = null where id = ${d1[0].id}`);
  q(`update public.users set status = 'suspended' where id = ${uuid(B)}`);
  const d2 = dq();
  check('#17 상대가 제재되면 발송 시점 재확인이 false (발송기가 recommendation_invalid 로 닫는다)', d2.length === 1 && d2[0].recommendation_valid === false);
  q(`update public.users set status = 'active' where id = ${uuid(B)}`);
  q(`update public.notification_events set claimed_at = null, attempts = 0 where id = ${d1[0].id}`);
  // 알림 설정 off·토큰 없음도 소개 생성과 무관 (발송기가 pref_off / no_token 으로 닫는다)
  q(`insert into public.notification_preferences (user_id, daily_recommendation) values (${uuid(A)}, false) on conflict (user_id) do update set daily_recommendation = false`);
  q(`delete from public.push_tokens where user_id = ${uuid(A)}`);
  const d3 = dq();
  check('#17 설정 off · 토큰 없음이어도 이벤트는 그대로 1건 (발송기 skip) · 소개는 그대로', d3.length === 1 && d3[0].pref_enabled === false && d3[0].tokens.length === 0 && recsA() === 1);
  // (7) 이미 오늘 소개를 받은 사용자·대화 3개 사용자는 배치 대상이 아니다 (기존 정책 유지) — 7절의 X 는 오늘 pending 이 있다
  const targetsNow = qjson(`select coalesce(json_agg(t.user_id), '[]') from public.recommendation_batch_targets(${lit(TODAY)}::date, null, 500) t`);
  check('#22 오늘 소개가 있는 A 는 대상이 아니다', !targetsNow.includes(A));
  check('#22 sweep 오류 보고 없음', !sweeps.some((s) => 'error' in s));
}

console.log(`\nrecommendation db test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
