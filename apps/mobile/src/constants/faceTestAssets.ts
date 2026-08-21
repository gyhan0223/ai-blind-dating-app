/**
 * 외모 취향 테스트용 asset.
 *
 * MVP 에서는 실제 사람 얼굴을 쓰지 않는다 — 특징 축을 표현한 추상 일러스트 카드로
 * 플로우와 데이터 수집 구조만 검증한다.
 * 실서비스에서는 합법적으로 사용 가능한 synthetic face dataset 으로 교체하고,
 * vector 를 얼굴 임베딩으로 바꾼다. (id/vector 구조는 유지)
 */
export type FaceTestAsset = {
  id: string;
  /** 스타일 축 (0~1): soft(부드러움), warm(따뜻함), bold(뚜렷함), playful(발랄함) */
  vector: { soft: number; warm: number; bold: number; playful: number };
  /** 일러스트 표현용 */
  look: {
    base: string;
    accent: string;
    faceShape: 'round' | 'oval' | 'angular';
    hair: 'short' | 'medium' | 'long';
  };
  label: string;
};

export const FACE_TEST_ASSETS: FaceTestAsset[] = [
  { id: 'ft01', vector: { soft: 0.9, warm: 0.8, bold: 0.2, playful: 0.4 }, look: { base: '#E8D5C4', accent: '#8C6A4F', faceShape: 'round', hair: 'medium' }, label: '부드럽고 따뜻한 인상' },
  { id: 'ft02', vector: { soft: 0.2, warm: 0.3, bold: 0.9, playful: 0.3 }, look: { base: '#D8D3CC', accent: '#3F3A35', faceShape: 'angular', hair: 'short' }, label: '뚜렷하고 시원한 인상' },
  { id: 'ft03', vector: { soft: 0.7, warm: 0.5, bold: 0.4, playful: 0.8 }, look: { base: '#EAD9CE', accent: '#A56A54', faceShape: 'round', hair: 'short' }, label: '밝고 장난기 있는 인상' },
  { id: 'ft04', vector: { soft: 0.4, warm: 0.7, bold: 0.6, playful: 0.2 }, look: { base: '#E2D6C8', accent: '#6B5842', faceShape: 'oval', hair: 'medium' }, label: '차분하고 단정한 인상' },
  { id: 'ft05', vector: { soft: 0.8, warm: 0.4, bold: 0.3, playful: 0.6 }, look: { base: '#E6DCD4', accent: '#7A6B63', faceShape: 'oval', hair: 'long' }, label: '온화하고 여유로운 인상' },
  { id: 'ft06', vector: { soft: 0.3, warm: 0.6, bold: 0.8, playful: 0.5 }, look: { base: '#DED2C2', accent: '#54432F', faceShape: 'angular', hair: 'medium' }, label: '또렷하고 자신감 있는 인상' },
  { id: 'ft07', vector: { soft: 0.6, warm: 0.9, bold: 0.3, playful: 0.7 }, look: { base: '#EFDDCB', accent: '#B07B52', faceShape: 'round', hair: 'long' }, label: '다정하고 환한 인상' },
  { id: 'ft08', vector: { soft: 0.5, warm: 0.2, bold: 0.7, playful: 0.2 }, look: { base: '#D9D9D9', accent: '#4A4E57', faceShape: 'angular', hair: 'long' }, label: '서늘하고 지적인 인상' },
  { id: 'ft09', vector: { soft: 0.7, warm: 0.6, bold: 0.5, playful: 0.3 }, look: { base: '#E5D8CB', accent: '#7E6650', faceShape: 'oval', hair: 'short' }, label: '단단하고 편안한 인상' },
  { id: 'ft10', vector: { soft: 0.4, warm: 0.5, bold: 0.4, playful: 0.9 }, look: { base: '#EBDDD2', accent: '#98705B', faceShape: 'round', hair: 'medium' }, label: '생기 있고 활발한 인상' },
  { id: 'ft11', vector: { soft: 0.9, warm: 0.7, bold: 0.1, playful: 0.5 }, look: { base: '#EFE4D9', accent: '#9B8471', faceShape: 'round', hair: 'long' }, label: '순하고 포근한 인상' },
  { id: 'ft12', vector: { soft: 0.2, warm: 0.4, bold: 0.9, playful: 0.6 }, look: { base: '#DBD0C4', accent: '#463C31', faceShape: 'angular', hair: 'short' }, label: '강렬하고 개성 있는 인상' },
];

/** 10라운드 A/B 페어 (겹치지 않게 구성) */
export function buildTestPairs(): [FaceTestAsset, FaceTestAsset][] {
  const shuffled = [...FACE_TEST_ASSETS].sort(() => Math.random() - 0.5);
  const pairs: [FaceTestAsset, FaceTestAsset][] = [];
  for (let i = 0; i + 1 < shuffled.length; i += 2) {
    pairs.push([shuffled[i], shuffled[i + 1]]);
  }
  // 6쌍 + 재조합 4쌍 = 10라운드
  for (let i = 0; i < 4; i += 1) {
    const a = shuffled[i];
    const b = shuffled[shuffled.length - 1 - i];
    if (a.id !== b.id) pairs.push([a, b]);
  }
  return pairs.slice(0, 10);
}
