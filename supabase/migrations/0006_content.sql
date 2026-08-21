-- 0006_content.sql
-- 설문 문항 (앱 컨텐츠). 모바일 앱의 상수(constants/questions.ts)와 id가 일치해야 한다.
-- axis 는 MatchingEngine 이 차원 점수를 집계할 때 사용한다.

insert into public.questionnaire_questions (id, category, text_ko, axis, reverse, sort_order) values
  -- 성격 (personality)
  ('p01', 'personality', '처음 만난 사람과도 금방 편해지는 편이다',        'personality.extraversion', false, 10),
  ('p02', 'personality', '혼자만의 시간이 꼭 필요하다',                    'personality.extraversion', true,  20),
  ('p03', 'personality', '일정은 미리 계획하는 것이 편하다',               'personality.planning',     false, 30),
  ('p04', 'personality', '계획 없는 즉흥 여행도 좋다',                     'personality.planning',     true,  40),
  ('p05', 'personality', '감정 표현을 솔직하게 하는 편이다',               'personality.expression',   false, 50),
  ('p06', 'personality', '갈등이 생기면 바로 이야기해서 푸는 편이다',      'personality.direct',       false, 60),
  ('p07', 'personality', '장난스럽고 유머러스한 분위기가 좋다',            'personality.humor',        false, 70),
  ('p08', 'personality', '웬만한 일에는 스트레스를 잘 받지 않는 편이다',   'personality.calmness',     false, 80),
  ('p09', 'personality', '상대의 기분 변화를 빨리 알아차리는 편이다',      'personality.empathy',      false, 90),
  ('p10', 'personality', '새로운 경험이나 도전을 즐긴다',                  'personality.openness',     false, 100),
  -- 라이프스타일 (lifestyle)
  ('l01', 'lifestyle', '주말에는 주로 집에서 쉬는 편이다',                 'lifestyle.homebody',   false, 110),
  ('l02', 'lifestyle', '아침형 인간이다',                                  'lifestyle.morning',    false, 120),
  ('l03', 'lifestyle', '술자리 모임을 즐기는 편이다',                      'lifestyle.social',     false, 130),
  ('l04', 'lifestyle', '운동을 규칙적으로 하는 편이다',                    'lifestyle.exercise',   false, 140),
  ('l05', 'lifestyle', '소비보다 저축을 중요하게 생각한다',                'lifestyle.saving',     false, 150),
  ('l06', 'lifestyle', '정리정돈된 공간이 중요하다',                       'lifestyle.tidy',       false, 160),
  ('l07', 'lifestyle', '반려동물과 함께하는 삶이 좋다',                    'lifestyle.pets',       false, 170),
  ('l08', 'lifestyle', '기회가 되면 자주 여행을 떠나고 싶다',              'lifestyle.travel',     false, 180),
  -- 연애 스타일 (relationship)
  ('r01', 'relationship', '연인과는 연락을 자주 주고받는 게 좋다',         'relationship.contact',       false, 190),
  ('r02', 'relationship', '애정 표현은 자주 하는 편이 좋다',               'relationship.affection',     false, 200),
  ('r03', 'relationship', '연인과 최대한 많은 시간을 함께 보내고 싶다',    'relationship.together_time', false, 210),
  ('r04', 'relationship', '연애 중에도 각자의 생활이 중요하다',            'relationship.together_time', true,  220),
  ('r05', 'relationship', '다투면 그날 안에 풀어야 한다',                  'relationship.repair',        false, 230),
  ('r06', 'relationship', '연애 초반에도 미래에 대한 대화를 나누는 게 좋다', 'relationship.future_talk',  false, 240),
  ('r07', 'relationship', '연인의 이성 친구 관계를 존중할 수 있다',        'relationship.autonomy',      false, 250),
  ('r08', 'relationship', '천천히 알아가며 시작하는 연애가 좋다',          'relationship.slow_start',    false, 260);
