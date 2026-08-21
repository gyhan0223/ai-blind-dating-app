# 본심 — 사진 없는 AI 블라인드 소개팅 (MVP)

> **"서로의 얼굴은 AI만 먼저 봅니다."**
>
> 사용자끼리 사진을 직접 공개하지 않고, AI가 외모 취향·성격·가치관·행동 데이터를
> 기반으로 **하루 한 명**, 서로 잘 맞을 가능성이 높은 상대를 소개하는 소개팅 앱입니다.
>
> 이 MVP 의 목표는 하나의 가설 검증입니다 —
> **"사진을 직접 보지 않아도, AI 가 골라준 상대와 실제로 대화하고 만나러 나갈 것인가?"**

## 구성

| 영역 | 위치 | 스택 |
|---|---|---|
| 모바일 앱 | `apps/mobile` | React Native · Expo SDK 57 · TypeScript · Expo Router · TanStack Query |
| 백엔드 | `supabase/` | Supabase (Auth · PostgreSQL · Realtime · Storage · Edge Functions) |
| 매칭 엔진 | `supabase/functions/_shared/matching/` | 순수 TypeScript 모듈 (Deno/Node 겸용) |
| 관리자 웹 | `apps/admin` | Next.js 15 (service role 서버 컴포넌트) |
| 이전 프로토타입 | `legacy/web` | 참고용 (Next.js + SQLite 단일 웹 MVP) |

## 설치 & 실행

### 1. Supabase 설정

```bash
# Supabase CLI 로 새 프로젝트 연결 (또는 로컬: supabase start)
supabase link --project-ref <your-project-ref>

# 마이그레이션 적용 (0001 → 0008 순서대로)
supabase db push        # 또는: psql 로 supabase/migrations/*.sql 순서 실행

# 시드 (개발용 데모 사용자 12명 + 매치/대화 샘플)
psql "$DATABASE_URL" -f supabase/seed/seed.sql

# Edge Functions 배포
supabase functions deploy verify-identity
supabase functions deploy complete-face-verification
supabase functions deploy daily-recommendation
supabase functions deploy icebreaker
```

Supabase 대시보드에서 추가 확인:
- **Auth → Email**: 이메일 OTP 활성화 (기본값)
- **Storage**: `faces` 버킷은 마이그레이션이 생성 (private — public 전환 금지)

### 2. 모바일 앱

```bash
cd apps/mobile
cp .env.example .env     # Supabase URL/anon key 입력
npm install
npx expo start           # iOS 시뮬레이터: i / Android: a
```

`EXPO_PUBLIC_DEV_LOGIN=1` 이면 웰컴 화면에 시드 계정 바로 로그인 버튼이 표시됩니다.

- 테스트 남성: `demo-m1@bonsim.dev` (지훈)
- 테스트 여성: `demo-f1@bonsim.dev` (서연) — 지훈과 매치·대화가 시드되어 있음
- 비밀번호: `bonsim-dev-password`

### 3. 관리자 페이지

```bash
cd apps/admin
cp .env.example .env.local   # service role key + 관리자 비밀번호
npm install
npm run dev                  # http://localhost:3100
```

대시보드(핵심 퍼널 9단계 전환율) · 사용자 정지/해제 · 신고 처리.

## 검증 (로컬)

```bash
# DB 스키마 + 시드 + RLS 테스트 (Docker 없이 로컬 Postgres 로)
cd supabase/tests && bash run_local_check.sh

# MatchingEngine 단위 테스트 (19건)
cd supabase/functions/_shared/matching && node --experimental-strip-types selftest.ts

# 타입체크 / 빌드
cd apps/mobile && npx tsc --noEmit && npx expo export --platform web
cd apps/admin && npm run build
```

## MatchingEngine 구조

`supabase/functions/_shared/matching/MatchingEngine.ts` — 알고리즘 교체가 가능한 단일 모듈.

```
UserSnapshot(프로필·가치관·설문·중요도·이상형·Dealbreaker·외모 벡터)
  ├─ checkDealbreakers()   조건 불일치 → 추천 자체에서 제외 (점수 아님)
  ├─ directionalScore()    A→B 예측 (차원: appearance/personality/values/lifestyle/relationship)
  │                        └ 개인화 중요도(1~5)로 가중 평균
  └─ computeMatch()        A→B, B→A 를 각각 계산 → 조화 평균
                           (한쪽만 좋아하는 조합은 우선순위 하락)
```

- **절대적 외모 점수 없음** — 외모 차원은 "내 취향 벡터 × 상대 스타일 벡터" 유사도만 사용
- 카드에는 원시 점수 대신 `buildReasons()` 가 만든 설명 문구만 노출
- `recommendationStrategy`: `high_confidence` / `exploration` / `fallback` (§30 탐색 정책 확장용)
- `ConversationSignals` 타입이 입력 계약에 포함되어 있어 대화 행동 신호를 이후 버전에서 반영 가능
- 추천 생성은 `daily-recommendation` Edge Function(service role)에서만 수행 —
  클라이언트는 타인의 원본 데이터에 접근하지 않고 서버가 만든 카드 스냅샷만 받음

## 개인정보 보호 구조

1. **얼굴 이미지**: private bucket `faces` (`<user_id>/<pose>.jpg`), storage RLS 로 본인 폴더만 접근.
   public URL 없음. 다른 사용자의 얼굴을 가져오는 코드 경로 자체가 없음.
2. **profiles(공개용) / private_profiles(가치관·민감 응답) 분리** — private 은 본인만 조회 가능.
3. **RLS 전면 적용**: 메시지·신고·피드백·행동 이벤트·좋아요(받은 쪽 비공개)·
   만남 의사(상호 yes 전 비공개)까지 시뮬레이션 테스트로 검증 (`supabase/tests/rls_tests.sql`).
4. **인증 플래그(본인/얼굴/나이)와 계정 상태는 서버 전용** — DB 트리거가 클라이언트 변경 차단.
5. 민감 설문은 선택 응답 + 공개 여부 별도 저장, 대화 분석은 `conversation_analysis_consent` 동의 필드로 준비만.
6. 로그에 얼굴 경로/민감정보를 남기지 않음.

## 현재 Mock 인 부분 (실서비스 전 교체)

| 기능 | 현재 | 교체 대상 |
|---|---|---|
| 본인 인증 | `MockIdentityProvider` (모든 6자리 코드 통과) | PASS / PortOne 본인인증 |
| 얼굴 라이브니스 | 촬영 UX 만 (좌/우 안내) + 서버 파일 존재 확인 | 온디바이스 라이브니스 SDK |
| 얼굴 특징 벡터 | 사용자별 결정적 해시 벡터 | 얼굴 임베딩 모델 |
| 외모 취향 테스트 | 추상 인상 일러스트 카드 | 합법적 synthetic face dataset |
| Icebreaker | 규칙 기반 | LLM |
| 결제 | 구조만 (subscriptions 테이블, Plus=추천 개수만) | 인앱 결제 / PG |
| SMS 로그인 | 이메일 OTP 만 | Supabase Phone Auth + SMS 사업자 |
| 시드 데모 사용자 | `is_demo=true` 12명 | 실배포 시 제거 |

## 제품 원칙 (구현에 반영됨)

- 무한 스와이프 없음 — 하루 1명 (Plus 는 2명, **개수만** 다름)
- 유료여도 매칭 품질·순서·노출 우위 없음
- 외모 점수/인기 순위/부스트/Super Like/SNS 피드 없음
- 한쪽만 좋아요한 사실, 거절 사실은 상대에게 비공개
- 채팅은 텍스트 전용 (사진 없는 경험 유지)

## 다음 개발 우선순위

1. 실제 본인인증(PASS/PortOne) 연동 + Phone Auth
2. 온디바이스 라이브니스 + 얼굴 임베딩 → 외모 취향 매칭 고도화
3. ConversationSignals 를 MatchingEngine 가중치에 반영 (만남 후 피드백 학습 포함)
4. 추천 탐색 정책(Exploit/Explore/Diversity) 본격 구현 + 추천 풀 공정성 모니터링
5. 푸시 알림 (매치/메시지) · 계정 삭제 셀프서비스 · 결제
