/** 프로필/설문에서 쓰는 선택지 상수 */

export const REGIONS = [
  { value: 'seoul', label: '서울' },
  { value: 'gyeonggi', label: '경기' },
  { value: 'incheon', label: '인천' },
  { value: 'busan', label: '부산' },
  { value: 'daegu', label: '대구' },
  { value: 'daejeon', label: '대전' },
  { value: 'gwangju', label: '광주' },
  { value: 'ulsan', label: '울산' },
  { value: 'sejong', label: '세종' },
  { value: 'gangwon', label: '강원' },
  { value: 'chungcheong', label: '충청' },
  { value: 'jeolla', label: '전라' },
  { value: 'gyeongsang', label: '경상' },
  { value: 'jeju', label: '제주' },
] as const;

export type RegionCode = (typeof REGIONS)[number]['value'];

export function regionLabel(code: string | null | undefined): string {
  return REGIONS.find((r) => r.value === code)?.label ?? '미설정';
}

export const JOB_GROUPS = [
  { value: 'office', label: '사무·관리' },
  { value: 'it', label: 'IT·개발' },
  { value: 'professional', label: '전문직' },
  { value: 'medical', label: '의료·보건' },
  { value: 'education', label: '교육' },
  { value: 'public', label: '공공·행정' },
  { value: 'finance', label: '금융' },
  { value: 'creative', label: '디자인·미디어' },
  { value: 'service', label: '서비스·판매' },
  { value: 'manufacturing', label: '생산·기술' },
  { value: 'self_employed', label: '자영업·사업' },
  { value: 'student', label: '학생·수험' },
  { value: 'other', label: '기타' },
] as const;

export function jobLabel(code: string | null | undefined): string {
  return JOB_GROUPS.find((j) => j.value === code)?.label ?? '기타';
}

export const SMOKING_OPTIONS = [
  { value: 'none', label: '비흡연' },
  { value: 'sometimes', label: '가끔' },
  { value: 'regular', label: '흡연' },
] as const;

export const DRINKING_OPTIONS = [
  { value: 'none', label: '안 마셔요' },
  { value: 'sometimes', label: '가끔' },
  { value: 'often', label: '자주' },
] as const;

export const EDUCATION_OPTIONS = [
  { value: 'highschool', label: '고졸' },
  { value: 'college', label: '전문대' },
  { value: 'bachelor', label: '대졸' },
  { value: 'master_plus', label: '석사 이상' },
] as const;

export const RELIGION_OPTIONS = [
  { value: 'none', label: '무교' },
  { value: 'christian', label: '기독교' },
  { value: 'catholic', label: '천주교' },
  { value: 'buddhist', label: '불교' },
  { value: 'other', label: '기타' },
] as const;

export const EXERCISE_OPTIONS = [
  { value: 'rarely', label: '거의 안 해요' },
  { value: 'sometimes', label: '가끔' },
  { value: 'regular', label: '꾸준히' },
] as const;

export const HOBBY_OPTIONS = [
  { value: 'travel', label: '여행' },
  { value: 'movies', label: '영화·드라마' },
  { value: 'music', label: '음악' },
  { value: 'reading', label: '독서' },
  { value: 'cooking', label: '요리' },
  { value: 'cafe', label: '카페 탐방' },
  { value: 'sports', label: '운동' },
  { value: 'hiking', label: '등산·산책' },
  { value: 'games', label: '게임' },
  { value: 'art', label: '전시·공연' },
  { value: 'pets', label: '반려동물' },
  { value: 'photography', label: '사진' },
] as const;

export function hobbyLabel(code: string): string {
  return HOBBY_OPTIONS.find((h) => h.value === code)?.label ?? code;
}

export const PERSONALITY_KEYWORDS = [
  { value: 'calm', label: '차분한' },
  { value: 'energetic', label: '활발한' },
  { value: 'humorous', label: '유머러스한' },
  { value: 'thoughtful', label: '다정한' },
  { value: 'honest', label: '솔직한' },
  { value: 'careful', label: '신중한' },
  { value: 'positive', label: '긍정적인' },
  { value: 'curious', label: '호기심 많은' },
  { value: 'reliable', label: '듬직한' },
  { value: 'detailed', label: '섬세한' },
] as const;

export function keywordLabel(code: string): string {
  return PERSONALITY_KEYWORDS.find((k) => k.value === code)?.label ?? code;
}

/** 온보딩 단계 순서 — users.onboarding_step 값과 일치 */
export const ONBOARDING_STEPS = [
  'welcome',
  'identity',
  'face',
  'profile',
  'questionnaire',
  'values',
  'preferences',
  'appearance',
  'done',
] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export function nextOnboardingRoute(step: string): string {
  switch (step) {
    case 'welcome':
    case 'identity':
      return '/onboarding/identity';
    case 'face':
      return '/onboarding/face';
    case 'profile':
      return '/onboarding/profile';
    case 'questionnaire':
      return '/onboarding/questionnaire';
    case 'values':
      return '/onboarding/values';
    case 'preferences':
      return '/onboarding/preferences';
    case 'appearance':
      return '/onboarding/appearance';
    default:
      return '/onboarding/identity';
  }
}
