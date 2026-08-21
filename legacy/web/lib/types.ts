// 공용 도메인 타입 정의

export type Gender = "M" | "F";

/** 라이프스타일 축 (0.0 ~ 1.0) */
export interface Lifestyle {
  morningType: number; // 0=저녁형, 1=아침형
  homeDate: number; // 0=밖에서 데이트, 1=집데이트
  travelFreq: number; // 여행 빈도
  exerciseFreq: number; // 운동 빈도
  contactFreq: number; // 연락 빈도
  drinkingParty: number; // 술자리 선호
  spending: number; // 0=절약, 1=소비
  weekendOut: number; // 0=집에서 휴식, 1=밖에서 활동
}

/** 성격 축 (0.0 ~ 1.0) — 행동 기반 질문으로 수집 */
export interface Personality {
  conflictDirect: number; // 0=시간을 갖는다, 1=바로 이야기한다
  expressive: number; // 0=행동으로 보여줌, 1=표현을 많이 함
  planned: number; // 0=즉흥형, 1=계획형
  togetherness: number; // 0=개인 시간 중요, 1=함께 시간 중요
  humor: number; // 0=차분한 대화, 1=장난/유머 많음
}

/** 연애 가치관 */
export interface Values {
  marriageIntent: number; // 0=생각 없음 ~ 1=꼭 하고 싶음
  marriageTiming: number; // 0=천천히 ~ 1=빨리
  kidsIntent: number; // 0=원하지 않음 ~ 1=꼭 원함
  longDistanceOk: number; // 0=불가 ~ 1=가능
  pastMatters: number; // 상대의 과거 연애가 중요한 정도 (0~1)
}

/** 연애 스타일 */
export interface RelationshipStyle {
  contactDesire: number; // 원하는 연락 빈도
  affection: number; // 애정 표현 정도
  dateFreq: number; // 데이트 빈도
  personalTime: number; // 개인 시간 필요 정도
  friendBoundary: number; // 이성 친구 허용 범위 (0=엄격, 1=자유)
}

/** 개인별 매칭 중요도 가중치 — 합계 100 */
export interface Weights {
  physical: number;
  personality: number;
  values: number;
  lifestyle: number;
  relationship: number;
  conversation: number;
}

/** Dealbreaker — 하나라도 어긋나면 매칭 자체를 하지 않는다 */
export interface Dealbreakers {
  noSmoking: boolean; // 흡연자 제외
  minAge: number;
  maxAge: number;
  regions: string[]; // 비어 있으면 전국
  religionRequired: string | null; // 특정 종교 필수 (null이면 무관)
  kidsMustAlign: boolean; // 자녀 계획이 크게 다르면 제외
}

/** 외모 특징 벡터 차원 정의 (AI 얼굴 분석 / 취향 벡터 공용) */
export const FACE_DIMS = [
  "faceRound", // 얼굴형: 0=갸름 ~ 1=둥근
  "eyeSize", // 눈 크기
  "eyeSmile", // 눈매: 0=또렷 ~ 1=웃는 눈
  "hairLength", // 머리 길이
  "hairTone", // 머리 톤: 0=어두움 ~ 1=밝음
  "softness", // 인상: 0=시크 ~ 1=부드러움
  "boldStyle", // 스타일: 0=단정 ~ 1=개성
  "warmth", // 분위기: 0=쿨톤 ~ 1=웜톤
] as const;

export type FaceVec = number[]; // 길이 = FACE_DIMS.length, 각 0~1

export interface UserRow {
  id: number;
  phone: string;
  name: string;
  gender: Gender;
  birth_year: number;
  region: string;
  height_cm: number;
  job: string;
  education: string;
  smoking: string; // '비흡연' | '가끔' | '흡연'
  drinking: string;
  religion: string;
  mbti: string;
  lifestyle: string; // JSON Lifestyle
  personality: string; // JSON Personality
  values_json: string; // JSON Values
  rel_style: string; // JSON RelationshipStyle
  weights: string; // JSON Weights
  dealbreakers: string; // JSON Dealbreakers
  face_vec: string; // JSON FaceVec — 본인 얼굴 분석 결과 (본인 포함 누구에게도 원본 비공개)
  face_pref_vec: string; // JSON FaceVec — 학습된 외모 취향
  phone_verified: number;
  face_verified: number;
  plan: string; // 'free' | 'plus'
  is_demo: number;
  onboarded: number;
  created_at: string;
}

export interface PublicProfile {
  id: number;
  age: number;
  region: string;
  heightCm: number;
  job: string;
  education: string;
  smoking: string;
  drinking: string;
  religion: string;
  mbti: string;
  phoneVerified: boolean;
  faceVerified: boolean;
}

export const DEFAULT_WEIGHTS: Weights = {
  physical: 25,
  personality: 25,
  values: 20,
  lifestyle: 15,
  relationship: 10,
  conversation: 5,
};

export const REGIONS = [
  "서울",
  "경기",
  "인천",
  "부산",
  "대구",
  "대전",
  "광주",
  "울산",
  "세종",
  "강원",
  "충북",
  "충남",
  "전북",
  "전남",
  "경북",
  "경남",
  "제주",
];

export const JOBS = [
  "직장인",
  "전문직",
  "공무원",
  "연구/개발",
  "디자인/창작",
  "의료",
  "교육",
  "금융",
  "자영업",
  "스타트업",
  "대학원생",
  "기타",
];

export const EDUCATIONS = ["고졸", "전문대졸", "대졸", "석사", "박사"];
export const SMOKING = ["비흡연", "가끔", "흡연"];
export const DRINKING = ["안 마심", "가끔", "자주"];
export const RELIGIONS = ["무교", "기독교", "천주교", "불교", "기타"];
export const MBTIS = [
  "ISTJ", "ISFJ", "INFJ", "INTJ",
  "ISTP", "ISFP", "INFP", "INTP",
  "ESTP", "ESFP", "ENFP", "ENTP",
  "ESTJ", "ESFJ", "ENFJ", "ENTJ",
];
