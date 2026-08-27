/**
 * 설문 문항 상수 — supabase/migrations/0006_content.sql 과 id/내용이 일치해야 한다.
 * (응답 저장 시 questionnaire_questions FK 검증을 통과해야 하므로)
 */
export type Question = {
  id: string;
  category: 'personality' | 'lifestyle' | 'relationship';
  text: string;
};

export const QUESTIONS: Question[] = [
  { id: 'p01', category: 'personality', text: '처음 만난 사람과도 금방 편해지는 편이다' },
  { id: 'p02', category: 'personality', text: '혼자만의 시간이 꼭 필요하다' },
  { id: 'p03', category: 'personality', text: '일정은 미리 계획하는 것이 편하다' },
  { id: 'p04', category: 'personality', text: '계획 없는 즉흥 여행도 좋다' },
  { id: 'p05', category: 'personality', text: '감정 표현을 솔직하게 하는 편이다' },
  { id: 'p06', category: 'personality', text: '갈등이 생기면 바로 이야기해서 푸는 편이다' },
  { id: 'p07', category: 'personality', text: '장난스럽고 유머러스한 분위기가 좋다' },
  { id: 'p08', category: 'personality', text: '웬만한 일에는 스트레스를 잘 받지 않는 편이다' },
  { id: 'p09', category: 'personality', text: '상대의 기분 변화를 빨리 알아차리는 편이다' },
  { id: 'p10', category: 'personality', text: '새로운 경험이나 도전을 즐긴다' },
  { id: 'l01', category: 'lifestyle', text: '주말에는 주로 집에서 쉬는 편이다' },
  { id: 'l02', category: 'lifestyle', text: '아침형 인간이다' },
  { id: 'l03', category: 'lifestyle', text: '술자리 모임을 즐기는 편이다' },
  { id: 'l04', category: 'lifestyle', text: '운동을 규칙적으로 하는 편이다' },
  { id: 'l05', category: 'lifestyle', text: '소비보다 저축을 중요하게 생각한다' },
  { id: 'l06', category: 'lifestyle', text: '정리정돈된 공간이 중요하다' },
  { id: 'l07', category: 'lifestyle', text: '반려동물과 함께하는 삶이 좋다' },
  { id: 'l08', category: 'lifestyle', text: '기회가 되면 자주 여행을 떠나고 싶다' },
  { id: 'r01', category: 'relationship', text: '연인과는 연락을 자주 주고받는 게 좋다' },
  { id: 'r02', category: 'relationship', text: '애정 표현은 자주 하는 편이 좋다' },
  { id: 'r03', category: 'relationship', text: '연인과 최대한 많은 시간을 함께 보내고 싶다' },
  { id: 'r04', category: 'relationship', text: '연애 중에도 각자의 생활이 중요하다' },
  { id: 'r05', category: 'relationship', text: '다투면 그날 안에 풀어야 한다' },
  { id: 'r06', category: 'relationship', text: '연애 초반에도 미래에 대한 대화를 나누는 게 좋다' },
  { id: 'r07', category: 'relationship', text: '연인의 이성 친구 관계를 존중할 수 있다' },
  { id: 'r08', category: 'relationship', text: '천천히 알아가며 시작하는 연애가 좋다' },
];

/** 가치관 축 (private_profiles 의 1~5 컬럼) */
export const VALUE_AXES: {
  key:
    | 'marriage_intent'
    | 'children_intent'
    | 'long_distance_ok'
    | 'contact_frequency'
    | 'date_frequency'
    | 'personal_time_need'
    | 'opposite_sex_friends_ok'
    | 'spending_style'
    | 'religion_importance';
  title: string;
  lowLabel: string;
  highLabel: string;
}[] = [
  { key: 'marriage_intent', title: '결혼에 대한 생각', lowLabel: '아직 없어요', highLabel: '적극적이에요' },
  { key: 'children_intent', title: '자녀 계획', lowLabel: '생각 없어요', highLabel: '꼭 갖고 싶어요' },
  { key: 'long_distance_ok', title: '장거리 연애', lowLabel: '어려워요', highLabel: '괜찮아요' },
  { key: 'contact_frequency', title: '연락 빈도', lowLabel: '필요할 때만', highLabel: '자주 자주' },
  { key: 'date_frequency', title: '데이트 빈도', lowLabel: '여유롭게', highLabel: '자주 만나요' },
  { key: 'personal_time_need', title: '개인 시간', lowLabel: '적어도 돼요', highLabel: '꼭 필요해요' },
  { key: 'opposite_sex_friends_ok', title: '연인의 이성 친구', lowLabel: '불편해요', highLabel: '존중해요' },
  { key: 'spending_style', title: '소비 성향', lowLabel: '저축 우선', highLabel: '경험에 투자' },
  { key: 'religion_importance', title: '종교의 중요도', lowLabel: '중요하지 않아요', highLabel: '많이 중요해요' },
];
