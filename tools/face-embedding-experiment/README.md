# 얼굴 임베딩 최소 실험 (Windows, 개발자 PC 전용)

사진 한 장을 넣으면 **얼굴 특징 벡터(숫자 128개)** 가 나오는지, 그리고 **같은 사람 사진끼리는 가깝고 다른 사람과는 먼지** 를
내 PC 에서 확인하는 도구다. 서버·앱 코드가 아니며 production 에 배포하지 않는다. 배경과 모델 선정 이유는
[`docs/face-embedding-model-research.md`](../../docs/face-embedding-model-research.md) 에 있다.

- 얼굴 찾기: **YuNet** (OpenCV Zoo, MIT) → 얼굴 위치 + 눈·코·입 5점
- 특징 벡터: **SFace** (OpenCV Zoo, Apache-2.0) → 112×112 정렬 크롭 → 128차원 벡터
- 같은 사람 판정 기준(OpenCV 공식 튜토리얼 값): 코사인 유사도 **0.363 이상**

> 이 도구는 "같은 사람인가" 를 확인하는 실험이다. 외모 **취향** 에 맞는지는 이 숫자로 판단할 수 없다 (연구 문서 3절).

## 1. 준비 (PowerShell)

```powershell
# Python 3.11 이상 (https://www.python.org/downloads/windows/  설치 시 "Add python.exe to PATH" 체크)
python --version

cd <저장소 경로>\tools\face-embedding-experiment
python -m venv .venv
.\.venv\Scripts\Activate.ps1          # 실행 정책 오류가 나면: Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
pip install -r requirements.txt
```

## 2. 모델 내려받기 (2개, 약 39MB)

```powershell
New-Item -ItemType Directory -Force models | Out-Null
Invoke-WebRequest -Uri "https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx" -OutFile "models\face_recognition_sface_2021dec.onnx"
Invoke-WebRequest -Uri "https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx" -OutFile "models\face_detection_yunet_2023mar.onnx"
Get-ChildItem models      # sface ≈ 38.7MB, yunet ≈ 0.23MB 이어야 한다 (몇 백 바이트면 LFS 포인터 — 위 media.* 주소인지 확인)
```

모델 파일은 `.gitignore` 로 커밋되지 않는다. 출처: https://github.com/opencv/opencv_zoo (각 폴더의 LICENSE 확인).

## 3. 사진 준비

사진은 `images\` 폴더(커밋 안 됨)에 넣고 파일 이름을 **`<사람라벨>_<번호>.jpg`** 로 붙인다. 같은 라벨 = 같은 사람으로 집계한다.

| 묶음 | 목적 | 수량 | 어떻게 |
|---|---|---|---|
| A. 본인 | 같은 사람이면 벡터가 안정적인지 | 8~10장 | 아이폰 전면 카메라로 정면 셀카. 실내/실외, 낮/밤, 안경 유무, 무표정/웃음, 살짝 옆(15°)을 섞는다. 얼굴이 사진에서 세로 200px 이상 나오게 |
| B. 지인 | 다른 사람과 구분되는지 | 3명 이상 × 3장 | **본인이 동의한** 가족·친구. 조건은 A 와 같게 |
| C. 취향 파일럿(선택) | 취향과 벡터 거리가 관계있는지 | 40~60장 | 연구 문서 4.3절 — 합법적으로 쓸 수 있는 얼굴 이미지만 (FFHQ 등 연구용 데이터셋은 상업 앱 자산으로 못 쓴다) |

아이폰 → Windows 전송: 케이블 연결 후 사진 앱, 또는 iCloud 웹. HEIC 로 저장되면 `설정 > 카메라 > 포맷 > 높은 호환성` 으로 바꾸고 다시 찍거나,
Windows 사진 앱에서 JPG 로 내보낸다 (이 도구는 HEIC 를 읽지 못한다).

실험이 끝나면 **실제 사람 사진은 지운다.** 저장소에는 절대 커밋하지 않는다 (`.gitignore` 에 `images/` 포함).

## 4. 실행

```powershell
# 사진 1장 → 벡터 (JSON). 얼굴을 못 찾으면 종료 코드 1
python face_embed.py embed images\me_01.jpg
python face_embed.py embed images\me_01.jpg --out results\me_01.json

# 폴더 안 사진 전부 쌍별 비교 + 요약
New-Item -ItemType Directory -Force results | Out-Null
python face_embed.py compare images --csv results\compare.csv
```

`compare` 출력 예 (이 저장소 작업 환경에서 OpenCV 샘플 사진 2명·7장으로 돌린 실제 결과):

```
같은 사람 쌍    7개: 평균 0.892  최소 0.842  최대 0.954
다른 사람 쌍    8개: 평균 0.122  최소 0.015  최대 0.169
간격(같은 사람 최소 - 다른 사람 최대): +0.673  → 양수면 임계값 하나로 완전히 갈라진다
기준값 0.363 으로 틀린 쌍: 0/15
```

성공 기준:

- 같은 사람 쌍의 **최소값이 0.363 이상**, 다른 사람 쌍의 **최대값이 0.363 미만** (간격이 양수)
- 사진 한 장당 얼굴이 1개만 검출됨 (2개 이상이면 경고가 뜨고 가장 큰 얼굴만 쓴다)
- 160px 이하의 아주 작은 얼굴은 검출이 안 될 수 있다 → 그런 사진은 결과에서 빠지고 "건너뜀" 으로 표시된다

## 5. 자주 나는 문제

| 증상 | 원인/해결 |
|---|---|
| `모델 파일이 없습니다` | 2절 다시. 파일 크기가 수백 바이트면 LFS 포인터를 받은 것 |
| `no_face_detected` | 얼굴이 너무 작거나 어둡거나 옆모습. `--score-threshold 0.7` 로 낮춰 볼 수 있다 (오검출 증가) |
| 한글 경로에서 읽기 실패 | 스크립트는 `imdecode` 로 한글 경로를 지원한다. 그래도 안 되면 영문 경로로 옮긴다 |
| OpenCV 5.x 에서 `setPreferableTarget` WARN | 무해. 스크립트가 로그 레벨을 낮춰 숨긴다 |
| pip 설치 실패 | `python -m pip install --upgrade pip` 후 재시도. 회사 프록시면 `--proxy` 옵션 |

## 6. 이 실험이 답하지 않는 것

- Didit 이 실제로 내려주는 reference image 의 해상도·크롭 형태 (실기기 E2E 전까지 모름) → 지금은 셀카로 대체하고, 실제 이미지가 나오면 같은 도구로 다시 돌린다
- 외모 취향 적합도 — 4.3절 파일럿을 따로 해야 하며, 이 도구의 "동일" 판정과는 무관하다
- 서버(Supabase/별도 서버)에서 얼마나 걸리는지 — 이 환경(4코어 Xeon, 네이티브 OpenCV) 기준 모델 로드 약 0.5초, 사진 1장 검출+정렬+임베딩 약 20ms. 서버 실행 환경은 연구 문서 5절
