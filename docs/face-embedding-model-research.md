# 얼굴 임베딩 모델 조사 · 최소 검증 계획 (Issue #8 준비 작업)

작성일 2026-09-08. 이 문서는 **조사와 계획** 이다. production 코드·DB·유료 서비스는 바꾸지 않았다.
같이 들어간 것은 개발자 PC 에서 돌리는 실험 도구 [`tools/face-embedding-experiment/`](../tools/face-embedding-experiment/README.md) 뿐이다.

> **한 줄 결론**
> "같은 사람인지 알아보는 벡터" 를 만드는 용도라면 후보는 **OpenCV Zoo 의 SFace(+YuNet)** 하나뿐이다.
> 코드와 **미리 학습된 가중치 파일까지 상업적 사용을 허용하는 라이선스(Apache-2.0 / MIT)가 문서로 확인된** 유일한 후보이기 때문이다.
> 하지만 **"외모 취향에 맞는 상대인가" 를 이 벡터의 거리로 알 수 있다는 근거는 어느 후보에도 없다.**
> 그래서 취향 매칭 용도로는 아직 어떤 모델도 선정하지 않는다. 4절의 작은 실험으로 먼저 확인한다.

---

## 0. 12살도 이해할 수 있는 설명

- **임베딩(embedding)** = 사진 속 얼굴을 숫자 128개짜리 목록으로 바꾼 것. 사람 얼굴을 "좌표" 로 바꾼다고 생각하면 된다.
- 이 숫자 목록은 **"같은 사람이면 가깝고, 다른 사람이면 멀게"** 나오도록 훈련됐다. 즉 이 모델들은 원래 **출입문 얼굴 인식** 같은 데 쓰는 것이다.
- 우리 앱이 하고 싶은 것은 **"내가 좋아하는 얼굴 느낌과 상대가 비슷한가"** 다. 이건 다른 질문이다.
  "너랑 똑같이 생긴 사람" 과 "네 취향인 사람" 은 다르니까.
- 그래서 이번에는 (1) 숫자 목록이 잘 나오는지, (2) 같은 사람끼리 정말 가까운지 먼저 확인하고,
  (3) "취향" 과 관계가 있는지는 **따로 작은 실험** 으로 확인한다. 관계가 없으면 다른 방법(예: 취향 전용 학습)을 찾아야 한다.

---

## 1. 현재 코드 확인 결과 (얼굴 인증 · 저장 · 매칭)

| 무엇 | 어디 | 지금 상태 |
|---|---|---|
| 얼굴 인증 | `supabase/functions/start-face-liveness`, `didit-webhook`, `_shared/face/*` | Didit 능동형 라이브니스. 승인 시 서버가 Didit Decision 의 `reference_image` 를 내려받아 private bucket `faces` 의 `<user_id>/liveness/reference.jpg` 에 저장 (`_shared/face/faceOutcome.ts`). 클라이언트는 이 경로를 읽을 수 없다 (`0013_face_liveness.sql`). **실제 Didit 계정·실기기 E2E 는 아직 안 했으므로 이 이미지의 해상도·크롭 형태는 모른다** (`docs/face-liveness-didit.md` 11·13절). |
| 특징 벡터 저장 | `face_verifications.feature_vector jsonb` (`0002_onboarding.sql`) | 항상 **null**. 개발용 `complete-face-verification` 도 `feature_vector: null` 로 넣는다. Issue #8 본문의 `mockFeatureVector(userId)` 는 **현재 코드에 이미 없다** (PR #35 에서 제거됨) — 완료 조건 3번은 사실상 끝났고 이슈 문구만 낡았다. |
| 벡터 → 매칭 | `_shared/matching/snapshot.ts` → `styleVectorFromFeature()` | approved 행의 `feature_vector` 앞 4개 숫자를 `soft/warm/bold/playful` 로 읽는다. 지금은 null 이라 `appearanceStyleVector` 가 null → `appearanceScore()` 가 **중립 0.5** 를 돌려준다 (`MatchingEngine.ts:231`). |
| 취향 벡터 | `appearance_preference_events` + `snapshot.ts` 의 `FACE_TEST_VECTORS` | 온보딩에서 고른 **일러스트 카드(ft01~ft12)** 의 4차원 손수 정한 벡터를 평균낸다 (`apps/mobile/src/constants/faceTestAssets.ts`). 실제 얼굴이 아니다. |
| 유사도 계산 | `MatchingEngine.ts:85 vectorAffinity()` | 두 벡터의 **공통 키** 코사인 유사도를 0~1 로 자른다. 키가 다르면 null(→0.5). |
| 벡터 DB 기능 | 마이그레이션 0001~0014 | `pgvector` 미사용. 임베딩 **모델 이름/버전/차원 컬럼 없음** (Issue #8 완료 조건 4 미충족). |
| 동의 | `docs/face-liveness-didit.md` 10절 | 라이브니스 목적과 외모 매칭 목적을 분리하고 **매칭 목적은 별도 동의** 가 필요하다고 이미 정해 둠 (문구·법무 검토는 미완). |

여기서 나오는 중요한 사실 하나: 임베딩을 넣는 순간 **취향 벡터(일러스트 4차원)와 상대 벡터(얼굴 128차원)는 서로 다른 공간** 이 된다.
`vectorAffinity` 는 공통 키가 없으면 null 을 돌려주니 계산 자체가 안 된다. 즉 Issue #8 은 **"외모 취향 테스트 자산을 실제(합법 synthetic) 얼굴 사진으로 바꾸고, 그 사진도 같은 모델로 임베딩하는 일"** 과 반드시 같이 가야 한다. 이 자산 조달은 이번 범위 밖이며 별도 조사가 필요하다.

---

## 2. 후보 모델 조사 (공식 자료 기준)

"무료라고 추정하지 않는다" 원칙으로, **코드 라이선스와 가중치(모델 파일) 라이선스를 따로** 봤다. 둘이 다른 경우가 많다.

| 후보 | 종류 | 코드 라이선스 | **가중치(모델 파일) 상업 사용** | 학습 데이터 | 벡터를 우리가 받을 수 있나 | 비용 | 실행 환경 |
|---|---|---|---|---|---|---|---|
| **SFace + YuNet** (OpenCV Zoo) | 오픈소스, 동일인 식별 | Apache-2.0 (SFace 폴더) / MIT (YuNet 폴더) | **허용** — 폴더의 모든 파일이 해당 라이선스라고 README 에 명시 [1][2] | OpenCV Zoo README 에 **명시 없음**. 원 논문 저장소는 CASIA-WebFace·VGGFace2·MS-Celeb-1M 로 실험 [3] → 배포 모델의 학습 데이터는 미확인 | 예 (128차원, 로컬 실행) | 0원 (모델 38.7MB) | Python/C++ OpenCV, CPU 로 충분 (이 환경 4코어: 1장 약 20ms). Windows 가능 |
| **InsightFace buffalo_l** (ArcFace 계열) | 오픈소스, 동일인 식별 | MIT | **불가** — "pretrained models … non-commercial research purposes only", 상업 사용은 recognition-oss-pack@insightface.ai 로 별도 계약 [4][5] | WebFace600K [5] | 예 (512차원) | 코드 0원, 상업 라이선스 비용 **미공개(문의 필요)** | Python + onnxruntime, Windows 가능 |
| **facenet-pytorch** (InceptionResnetV1) | 오픈소스, 동일인 식별 | MIT | **불명확** — README 가 가중치 라이선스를 말하지 않음 [6]. 가중치는 VGGFace2 / CASIA-WebFace 로 학습. VGGFace2 는 자료마다 CC BY / CC BY-NC-SA 로 엇갈리고 [7], CASIA-WebFace 는 **비상업 연구 전용 서약서** [8] | VGGFace2, CASIA-WebFace | 예 (512차원) | 0원 | Python + PyTorch (약 100MB), Windows 가능 |
| **AdaFace** | 오픈소스, 동일인 식별 | MIT | **불명확** — 가중치 라이선스 언급 없음 [9]. 학습 데이터가 MS1MV2(Microsoft 가 2019년 철회한 MS-Celeb-1M 파생 [10]) 또는 WebFace4M/12M(비상업 연구용 배포 데이터셋으로 알려짐, 이번 조사에서 공식 페이지 접속 실패로 **미확인**) | MS1MV2·WebFace4M·12M 등 | 예 (512차원) | 0원 | Python + PyTorch |
| **Amazon Rekognition** | 상용 API, 동일인 식별 | — | 서비스 약관 | 비공개 | **아니오** — 벡터는 AWS 내부 컬렉션에만 저장되고 유사도만 돌려준다 [11] | Group 1(CompareFaces·IndexFaces 등) 이미지당 $0.001 (월 100만 장까지), 얼굴 메타데이터 보관 월 $0.00001/개, 첫 12개월 월 5,000장 무료 [12] | AWS 계정·과금 등록 필요 |
| **Azure AI Face** | 상용 API, 동일인 식별 | — | 서비스 약관 | 비공개 | 아니오 (식별/검증 결과만) | **Limited Access** — 등록·심사(영업일 10일) 후 승인된 용도만, F0 무료 티어 불가 [13] | Azure 계정, 심사 통과 필요 |
| **Didit** (이미 쓰는 라이브니스 업체) | 상용 API | — | 서비스 약관 | 비공개 | 공식 문서에서 **임베딩 반환 확인 안 됨** (Face Match 1:1 은 결과/점수 API, 블로그에 512차원 임베딩을 내부 사용한다고만 씀) [14] | Face Match 1:1 건당 $0.05 로 안내(검색 결과, 공식 페이지 접속 실패로 **재확인 필요**) | 이미 계약 예정인 업체라 문의 비용이 낮다 |

같이 본 것:

- **DeepFace**(여러 모델 래퍼, MIT): "래핑한 모델의 라이선스를 그대로 물려받으니 production 전에 각 모델 라이선스를 확인하라" 고 README 가 명시 [15]. 래퍼가 라이선스를 해결해 주지 않는다.
- 상용 API 3곳(AWS·Azure·Didit)은 **벡터를 밖으로 주지 않거나 확인이 안 된다.** 우리 매칭 엔진은 벡터를 직접 다뤄야 하므로(취향 벡터 × 상대 벡터), 이 셋은 "동일인 확인" 에는 쓸 수 있어도 **취향 매칭 입력으로는 구조상 맞지 않는다.**

### 2.1 왜 SFace 만 남는가

1. 코드와 가중치가 **둘 다** 상업 사용 가능 라이선스로 명시된 유일한 오픈 후보다. InsightFace 는 명시적으로 비상업, 나머지 오픈 후보는 "말이 없음" 인데 학습 데이터가 연구 전용이라 위험이 크다.
2. 모델이 작고(38.7MB, 정수 양자화판도 있음) CPU 로 빠르다 → 별도 서버를 쓰더라도 가장 싼 사양으로 된다.
3. OpenCV 본체 API(`FaceDetectorYN`, `FaceRecognizerSF`)가 지원하고, 공식 튜토리얼이 판정 기준값(코사인 0.363 / L2 1.128)과 112×112 정렬 규칙을 제공한다 [16][17].

남은 위험(3절·6절에도 정리): OpenCV Zoo 가 **배포 모델의 학습 데이터를 밝히지 않는다.** 원 논문은 연구 전용 데이터셋으로 실험했다.
"가중치 라이선스가 Apache-2.0" 인 것과 "학습 데이터 약관 위반이 없다" 는 것은 다른 문제이므로, 출시 전 법무 확인 항목으로 남긴다.
이 위험은 다른 오픈 모델 전부에 더 크게 있고, 상용 API 는 데이터 출처 자체가 비공개다.

---

## 3. "같은 사람 찾기" 와 "외모 취향" 은 다르다

| | 동일인 식별 (위 후보 전부) | 외모 취향 적합도 (우리가 원하는 것) |
|---|---|---|
| 모델이 배운 것 | "이 두 사진이 **같은 사람** 인가" | (아무 후보도 이걸 배우지 않았다) |
| 일부러 **무시하도록** 배운 것 | 조명, 각도, 표정, 헤어, 나이 변화 | 이 중 헤어·표정·분위기는 취향에 영향을 줄 수 있다 |
| 벡터 거리가 뜻하는 것 | 같은 사람일 확률 | 근거 없음 |

**현재 매칭 엔진 방식(내가 고른 얼굴들의 평균 벡터 vs 상대 벡터의 코사인)** 을 동일인 식별 임베딩에 그대로 적용하면, 수학적으로는
"**내가 고른 사람들과 같은 사람처럼 보이는가**" 에 가깝다. 이것이 취향과 어느 정도 겹칠 수는 있지만(예: 얼굴형·이목구비 비율이 비슷하면 가까워짐), 그렇다고 단정할 근거는 없다.

연구 근거를 찾아본 결과(요약은 검색 결과 기반이며 원문 접속이 이 환경에서 막혀 **원문 재확인 필요**):

- Rothe·Timofte·Van Gool, *Some Like It Hot — Visual Guidance for Preference Prediction* (CVPR 2016): 얼굴 CNN 특징 + 협업 필터링으로 **개인별** 끌림을 예측. 8,560명의 과거 선택을 학습에 씀 [18]. → "임베딩 **위에** 개인별 학습을 얹으면" 예측이 가능하다는 힌트. 벡터 거리 하나로 되는 게 아니다.
- *Classifying Online Dating Profiles on Tinder using FaceNet Facial Embeddings* (arXiv 1803.04347): FaceNet(동일인 식별) 임베딩을 입력으로 한 사용자의 like/dislike 분류를 시도 [19]. → 같은 방향의 시도가 있으나 결과 수치는 원문 확인 필요.
- 얼굴 매력도 예측 연구는 대부분 **별도의 평점 데이터로 다시 학습** 한다(SCUT-FBP 류). 동일인 임베딩 코사인 = 매력/취향 이라고 쓰는 공식 자료는 찾지 못했다.

정리: **동일인 식별 목적** 으로는 SFace 를 후보로 둘 수 있다. **취향 목적** 으로는 어떤 후보도 "적합하다는 근거" 가 없으므로 선정하지 않고, 4.3절 파일럿으로 "관계가 있는지" 부터 본다. 관계가 약하면 다음 단계는 (a) 임베딩 위에 사용자 선택 데이터로 작은 취향 모델을 학습하거나, (b) 얼굴 속성(attribute) 기반 접근을 다시 검토하는 것이다.

---

## 4. Windows 최소 실험

실행 방법·명령은 [`tools/face-embedding-experiment/README.md`](../tools/face-embedding-experiment/README.md). 아이폰으로 찍고 Windows 로 옮겨 돌린다. Apple 개발자 계정·실기기 빌드가 필요 없다.

### 4.1 무엇을 확인하나 (Issue #8 완료 조건 1·2)

| 실험 | 사진 | 성공 기준 |
|---|---|---|
| A. 같은 사람 안정성 | 본인 8~10장 (실내/실외, 낮/밤, 안경, 표정, 15° 옆) | 본인끼리 코사인 **최소값 ≥ 0.363** |
| B. 다른 사람 구분 | 동의한 지인 3명 이상 × 3장 | 다른 사람끼리 **최대값 < 0.363**, 그리고 A 최소값 − B 최대값 > 0 |
| (참고) 이 환경에서 OpenCV 샘플 2명·7장 | 반전·어둡게·15° 회전 변형 포함 | 같은 사람 0.842~0.954, 다른 사람 0.015~0.169, 틀린 쌍 0/15 — 도구가 동작함을 확인. 실제 셀카로 다시 해야 한다 |

주의: 160px 이하 작은 얼굴은 검출이 안 됐다(실험 로그). Didit reference image 가 작게 나오면 문제가 되므로, 실기기 E2E 후 실제 이미지 크기를 반드시 확인한다.

### 4.2 사진 준비

- 본인·지인 사진은 **실험 후 삭제**, 저장소 커밋 금지(도구 폴더 `.gitignore` 에 `images/` 포함).
- HEIC → JPG: 아이폰 `설정 > 카메라 > 포맷 > 높은 호환성`.
- 파일 이름 `사람라벨_번호.jpg` (예 `me_01.jpg`, `friendA_02.jpg`) — 도구가 라벨로 같은 사람을 묶는다.

### 4.3 취향 파일럿 (선택, 3절의 질문에 답하는 실험)

1. 합법적으로 쓸 수 있는 얼굴 사진 40~60장을 모은다. **주의**: FFHQ 는 CC BY-NC-SA 4.0 으로 상업 앱 자산엔 못 쓴다 [20]; 개인 PC 실험까지는 비상업이라 가능하다. 앱에 넣을 synthetic 자산은 별도 조사(라이선스 구매 등).
2. 30장을 보고 "끌린다 / 아니다" 를 기록한다. 끌린다 그룹의 벡터 평균을 만든다(현재 엔진의 `preferenceVectorFromChoices` 와 같은 방식).
3. 나머지 20장에 대해 평균 벡터와의 코사인 순위를 매기고, 본인의 실제 판단과 비교한다(끌린다 그룹이 위쪽에 몰리는지).
4. 순위가 뒤섞이면(무작위 수준) **"동일인 임베딩 거리 = 취향" 가설은 기각** → 3절의 (a)/(b) 로 간다. 1~2명의 결과로 앱 정책을 정하진 말고, "더 파볼 가치가 있는지" 만 판단한다.

---

## 5. 모델을 어디서 실행하나 (현재 Supabase 구조 기준)

| 위치 | 가능? | 근거 |
|---|---|---|
| **Supabase Edge Functions** (지금 모든 서버 로직이 있는 곳) | **공식 지원 밖 / 사실상 부적합** | Deno 런타임. 한도: 메모리 256MB, **CPU 시간 요청당 2초**, 함수 번들 20MB(CLI)/5MB(서버 번들) [21]. 내장 AI 는 텍스트 임베딩 `gte-small` 뿐이고 커스텀 ONNX 모델 지원 문서가 없다 [22][23]. 커뮤니티 시도에서는 384차원 이하 소형 모델만 겨우 돌았고 공식 답변 없음 [24]. SFace 38.7MB 는 번들 한도를 넘어 Storage 에서 매번 읽어 WASM 으로 초기화해야 하는데, 2초 CPU 안에 되는지 보장이 없다. |
| **Supabase Postgres (pgvector)** | **저장·검색은 가능** | `create extension vector`, `vector(128)` 컬럼, 코사인 연산자와 HNSW/IVFFlat 인덱스 [25]. 계산(임베딩 생성)은 못 한다. |
| 모바일 앱 안에서 실행 | 기술적으로 가능하지만 **부적합** | reference image 는 서버에만 있고(클라이언트 접근 차단), 클라이언트가 만든 벡터는 서버가 **신뢰할 수 없다**(임의 값 전송 가능). 다른 사용자 사진을 앱에 내려보내는 건 설계 원칙 위반. |
| **별도 서버 (컨테이너)** | **현실적 선택** | Python + OpenCV 를 그대로 돌린다. service role 로 `faces/<uid>/liveness/reference.jpg` 를 읽어 벡터와 모델 이름/버전을 DB 에 쓴다. |
| 개발자 Windows PC 에서 배치 실행 | 검증 단계에만 | 0원. 실사용자 데이터는 PC 로 내려받지 않는다(동의·보안). |

### 별도 서버가 필요한 이유와 비용이 생기는 시점

- 이유: 네이티브 ONNX/OpenCV 실행과 모델 상주 메모리가 필요한데, Edge Functions 는 그 용도로 설계되지 않았고(2초 CPU·번들 한도) 공식 지원도 없다.
- 언제부터 돈이 드나:
  - **조사·실험 단계(지금)**: 0원. Windows PC 에서 돌린다.
  - **staging 에 임베딩 서버를 올릴 때**: 컨테이너를 어디에 올리느냐에 따라. 예를 들어 Google Cloud Run 은 요청 없을 때 0 으로 줄고 월 200만 요청·18만 vCPU초 무료 구간이 있어 [26], 초기 트래픽(가입자 하루 수십 명, 1인당 임베딩 1회)이면 **무료 구간 안** 일 가능성이 높다. 단 계정 등록·결제수단 등록은 필요하다.
  - **Supabase 자체**: 임베딩과 무관하게 이미 Free(50만 Edge 호출/월) 로 시작하고, 커스텀 도메인·백업 등이 필요해지면 Pro $25/월 [27]. pgvector 는 추가 요금 없음.
  - 상용 API 로 가면 이미지당 과금(2절 표)이 승인 건마다 발생한다.
- 처리 흐름 제안(설계만, 구현 안 함): `didit-webhook` 승인 → `face_verifications` 에 `embedding_status='queued'` 표시 → 임베딩 서버가 주기적으로(또는 DB 웹훅으로) queued 행을 읽어 reference image 다운로드 → 벡터 + `embedding_model`(예 `sface_2021dec`) + `embedding_dim` + `embedded_at` 저장. **외모 매칭 동의가 없는 사용자는 큐에 넣지 않는다.** 모델을 바꾸면 `embedding_model` 이 다른 행을 전부 재계산(Issue #8 "재계산 전략").

---

## 6. 추천 후보 · 남은 불확실성 · 다음 행동

### 추천 후보 1개

**OpenCV Zoo SFace (face_recognition_sface_2021dec.onnx) + YuNet 검출기** — 단, **"동일인 식별 임베딩" 파이프라인 후보** 로서다.

선정 이유:
1. 코드·가중치 모두 상업 사용 가능 라이선스가 명시된 유일한 후보 (Apache-2.0 / MIT).
2. 0원, 작고 빠름(1장 약 20ms, CPU). 별도 서버를 써도 최소 사양.
3. OpenCV 본체가 API·튜토리얼·판정 기준값을 공식 제공.
4. 이 저장소 작업 환경에서 실제로 돌려 128차원 벡터와 동일인/타인 분리를 확인했다(4.1절).

**취향 매칭 목적으로는 선정하지 않는다.** 근거가 없어서다. 4.3절 파일럿 결과가 나오기 전엔 어떤 모델도 "취향 적합도 모델" 로 부르지 않는다.

### 남은 불확실성

1. **학습 데이터 약관**: OpenCV Zoo 가 배포 모델의 학습 데이터를 밝히지 않는다. 출시 전 법무 확인(또는 opencv_zoo 이슈로 질문).
2. **Didit reference image 의 실제 형태**: 해상도·크롭·품질 미확인 (실기기 E2E 전). 작으면 검출 실패 가능.
3. **취향과의 관계**: 3절. 파일럿 전엔 모름.
4. **취향 테스트 자산**: 임베딩을 쓰려면 일러스트 카드를 합법 synthetic 얼굴 사진으로 바꿔야 한다. 조달처·라이선스·비용 미조사.
5. **동의·법무**: 생체정보 별도 동의 문구, 보관 기간, 국외 이전(서버 위치) — `docs/face-liveness-didit.md` 10절 TODO 그대로 남아 있음.
6. **서버 위치·비용**: Cloud Run 등 무료 구간 수치는 검색 결과 기반이라 계약 시점에 공식 요금표로 재확인.
7. 원문 접속이 막혀 검색 요약으로 대체한 항목(연구 논문 수치, Didit 요금, Rekognition 요금 세부)은 링크에서 직접 재확인.

### 다음에 할 행동 (쉬운 순서)

1. **Windows 실험 A·B 실행** — `tools/face-embedding-experiment/README.md` 대로. 본인 셀카 10장 + 지인 3명. 결과 요약 줄 4개를 Issue #8 에 붙인다. (예상 소요: 설치 30분 + 촬영 30분)
2. **취향 파일럿 4.3** — 시간이 되면. "관계 있어 보임 / 무작위" 한 줄이면 충분하다.
3. **Issue #8 본문 정리** — `mockFeatureVector` 완료 조건은 이미 충족됨을 적고, "취향 자산 교체" 를 선행 조건에 추가.
4. **Didit 실기기 E2E(#7) 후** reference image 를 같은 도구로 다시 돌린다.
5. **선택 사항으로 묻기(돈 안 듦)**: opencv_zoo 저장소에 "SFace 배포 모델 학습 데이터" 를 이슈로 질문 / Didit 에 "임베딩 반환 API 유무·요금" 문의. 답이 오면 2절 표 갱신.
6. 위가 끝나면 그때 설계 회의: 별도 서버 vs 상용 API, pgvector 컬럼 설계(`embedding vector(128)`, `embedding_model`, `embedding_dim`, `embedded_at`), 동의 플래그.

---

## 출처

1. OpenCV Zoo — SFace README (Apache-2.0 명시, 정확도 표): https://github.com/opencv/opencv_zoo/blob/main/models/face_recognition_sface/README.md
2. OpenCV Zoo — YuNet README (MIT 명시): https://github.com/opencv/opencv_zoo/blob/main/models/face_detection_yunet/README.md
3. SFace 원 논문 저장소 (CASIA-WebFace·VGGFace2·MS-Celeb-1M 로 실험): https://github.com/zhongyy/SFace
4. InsightFace README — License 절: https://github.com/deepinsight/insightface
5. InsightFace python-package README — 모델 팩 표와 "non-commercial research purposes only": https://github.com/deepinsight/insightface/blob/master/python-package/README.md
6. facenet-pytorch README: https://github.com/timesler/facenet-pytorch
7. VGGFace2 라이선스 자료 엇갈림 (arXiv 2111.02374 등): https://arxiv.org/pdf/2111.02374
8. CASIA-WebFace 배포 서약서 (비상업 연구 전용): http://www.cbsr.ia.ac.cn/english/casia-webFace/casia-webfAce_AgreEmeNtS.pdf
9. AdaFace README: https://github.com/mk-minchul/AdaFace
10. MS-Celeb-1M 철회 보도: https://www.aljazeera.com/economy/2019/6/6/microsoft-removes-face-recognition-database-from-internet
11. Amazon Rekognition — 컬렉션 문서 ("extracts facial features into a feature vector … stores it in the collection"): https://docs.aws.amazon.com/rekognition/latest/dg/collections.html
12. Amazon Rekognition 요금: https://aws.amazon.com/rekognition/pricing/
13. Azure AI Face — Limited Access: https://learn.microsoft.com/en-us/legal/cognitive-services/computer-vision/limited-access-identity
14. Didit — Face Match 1:1 제품 페이지 / 임베딩 블로그: https://didit.me/products/face-match-1to1/ , https://didit.me/blog/face-embedding-vectors-explained/
15. DeepFace README — Licence 절: https://github.com/serengil/deepface
16. OpenCV 튜토리얼 "DNN-based Face Detection And Recognition" (코사인 0.363 / L2 1.128): https://github.com/opencv/opencv/blob/4.x/doc/tutorials/dnn/dnn_face/dnn_face.markdown
17. OpenCV `FaceRecognizerSF` 구현 (112×112 정렬): https://github.com/opencv/opencv/blob/4.x/modules/objdetect/src/face_recognize.cpp
18. Rothe, Timofte, Van Gool, CVPR 2016: https://openaccess.thecvf.com/content_cvpr_2016/html/Rothe_Some_Like_It_CVPR_2016_paper.html
19. Classifying Online Dating Profiles on Tinder using FaceNet Facial Embeddings: https://arxiv.org/abs/1803.04347
20. FFHQ 데이터셋 라이선스 (CC BY-NC-SA 4.0): https://github.com/NVlabs/ffhq-dataset
21. Supabase Edge Functions 한도: https://supabase.com/docs/guides/functions/limits
22. Supabase Edge Functions AI 모델: https://supabase.com/docs/guides/functions/ai-models
23. Supabase 블로그 "AI Inference now available in Supabase Edge Functions": https://supabase.com/blog/ai-inference-now-available-in-supabase-edge-functions
24. Supabase Discussion #34688 (커스텀 임베딩 모델 시도): https://github.com/orgs/supabase/discussions/34688
25. Supabase pgvector: https://supabase.com/docs/guides/database/extensions/pgvector
26. Google Cloud Run 요금: https://cloud.google.com/run/pricing
27. Supabase 요금: https://supabase.com/pricing
