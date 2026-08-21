/**
 * 디자인 토큰 — "프리미엄 중매" 톤.
 * 자극적인 색·그라데이션·핑크/보라 클리셰를 쓰지 않는다.
 * 사진이 없는 서비스이므로 타이포그래피와 여백이 첫 인상을 만든다.
 */
export const colors = {
  bg: '#FAF9F7', // 따뜻한 종이 느낌의 배경
  surface: '#FFFFFF',
  surfaceSubtle: '#F3F1ED',
  ink: '#1C1B1A',
  inkSoft: '#4A4642',
  sub: '#807A72',
  faint: '#B5AFA6',
  line: '#E8E4DE',
  accent: '#3E5C50', // 차분한 딥 그린 — 신뢰/안정
  accentSoft: '#EDF1EE',
  onAccent: '#FFFFFF',
  danger: '#B4483E',
  dangerSoft: '#F7ECEA',
  warmHighlight: '#F6F0E6',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 20,
  full: 999,
} as const;

export const type = {
  display: { fontSize: 28, lineHeight: 38, fontWeight: '700' },
  title: { fontSize: 22, lineHeight: 30, fontWeight: '700' },
  heading: { fontSize: 17, lineHeight: 24, fontWeight: '600' },
  body: { fontSize: 16, lineHeight: 24, fontWeight: '400' },
  caption: { fontSize: 13, lineHeight: 18, fontWeight: '400' },
  label: { fontSize: 14, lineHeight: 20, fontWeight: '600' },
} as const;
