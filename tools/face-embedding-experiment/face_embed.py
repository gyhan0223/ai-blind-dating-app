#!/usr/bin/env python3
"""
얼굴 임베딩 최소 실험 도구 (개발자 PC 전용 — 서버/앱 코드가 아니다).

한 장의 사진 → 얼굴 검출(YuNet) → 정렬·크롭(112x112) → 특징 벡터(SFace, 128차원)
를 뽑아 보고, 사진 여러 장끼리 코사인 유사도를 비교한다.

모델은 OpenCV Zoo 의 SFace(Apache-2.0) + YuNet(MIT) 를 쓴다.
설명과 실행 방법: tools/face-embedding-experiment/README.md

사용법
  python face_embed.py embed  <이미지>                     # 벡터 1개 출력 (JSON)
  python face_embed.py embed  <이미지> --out vec.json       # 파일로 저장
  python face_embed.py compare <폴더>                       # 폴더 안 사진 전부 쌍별 유사도 표
  python face_embed.py compare <폴더> --csv result.csv      # CSV 로 저장

폴더 안 파일 이름 규칙(compare 용): "<사람라벨>_<아무거나>.jpg"
  예) me_01.jpg, me_02.jpg, friendA_01.jpg …  → 같은 라벨 = 같은 사람으로 집계한다.
"""
from __future__ import annotations

import argparse
import csv
import itertools
import json
import os
import sys
from pathlib import Path

try:
    import cv2
    import numpy as np
except ImportError:  # pragma: no cover
    print("opencv-python 과 numpy 가 필요합니다:  pip install -r requirements.txt", file=sys.stderr)
    raise

# OpenCV 5.x 가 새 그래프 엔진 관련 WARN 을 매 호출마다 찍는다 — 실험 출력만 남기기 위해 오류 이상만 표시
try:
    cv2.utils.logging.setLogLevel(cv2.utils.logging.LOG_LEVEL_ERROR)
except AttributeError:  # 구버전 OpenCV
    pass

HERE = Path(__file__).resolve().parent
MODEL_DIR = HERE / "models"
DETECTOR_MODEL = MODEL_DIR / "face_detection_yunet_2023mar.onnx"
RECOGNIZER_MODEL = MODEL_DIR / "face_recognition_sface_2021dec.onnx"

# OpenCV 공식 튜토리얼(dnn_face) 이 제시하는 "같은 사람" 판정 기준값.
# 코사인 유사도 >= 0.363  또는  L2 거리 <= 1.128  이면 동일인으로 본다.
COSINE_SAME_PERSON = 0.363
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}


def _require_models() -> None:
    missing = [p for p in (DETECTOR_MODEL, RECOGNIZER_MODEL) if not p.exists()]
    if missing:
        names = ", ".join(p.name for p in missing)
        print(
            f"모델 파일이 없습니다: {names}\n"
            f"  {MODEL_DIR} 폴더에 내려받으세요. 방법은 README.md 의 '2. 모델 내려받기' 참고.",
            file=sys.stderr,
        )
        sys.exit(2)


def _load_models(score_threshold: float = 0.9):
    _require_models()
    detector = cv2.FaceDetectorYN.create(
        str(DETECTOR_MODEL),
        "",
        (320, 320),
        score_threshold=score_threshold,
        nms_threshold=0.3,
        top_k=5000,
    )
    recognizer = cv2.FaceRecognizerSF.create(str(RECOGNIZER_MODEL), "")
    return detector, recognizer


def _read_image(path: Path) -> np.ndarray:
    # 한글/공백 경로에서도 안전하게 읽기 위해 imdecode 사용
    data = np.fromfile(str(path), dtype=np.uint8)
    img = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError(f"이미지를 읽을 수 없습니다: {path}")
    # 너무 큰 사진은 긴 변 1280 으로 줄인다 (검출 속도/안정성)
    h, w = img.shape[:2]
    longest = max(h, w)
    if longest > 1280:
        scale = 1280 / longest
        img = cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
    return img


def _detect_faces(detector, img: np.ndarray) -> np.ndarray:
    h, w = img.shape[:2]
    detector.setInputSize((w, h))
    _, faces = detector.detect(img)
    if faces is None:
        return np.zeros((0, 15), dtype=np.float32)
    return faces


def _pick_largest(faces: np.ndarray) -> np.ndarray:
    # faces 행: x, y, w, h, 5개 랜드마크(x,y)*5, score
    areas = faces[:, 2] * faces[:, 3]
    return faces[int(np.argmax(areas))]


def embed_image(path: Path, detector, recognizer) -> dict:
    """사진 1장 → {"vector": [...128], "faces_detected": n, "bbox": [...], "score": s}"""
    img = _read_image(path)
    faces = _detect_faces(detector, img)
    if len(faces) == 0:
        return {"file": str(path), "faces_detected": 0, "vector": None}
    face = _pick_largest(faces)
    aligned = recognizer.alignCrop(img, face)  # 112x112 정렬 크롭
    feat = recognizer.feature(aligned)  # shape (1, 128)
    vec = feat.flatten().astype(float)
    return {
        "file": str(path),
        "faces_detected": int(len(faces)),
        "bbox": [float(v) for v in face[:4]],
        "detect_score": float(face[14]),
        "dim": int(vec.shape[0]),
        "vector": vec.tolist(),
    }


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    na, nb = np.linalg.norm(a), np.linalg.norm(b)
    if na == 0 or nb == 0:
        return float("nan")
    return float(np.dot(a, b) / (na * nb))


def label_of(path: Path) -> str:
    stem = path.stem
    return stem.split("_", 1)[0] if "_" in stem else stem


def cmd_embed(args: argparse.Namespace) -> int:
    detector, recognizer = _load_models(args.score_threshold)
    result = embed_image(Path(args.image), detector, recognizer)
    if result["vector"] is None:
        print(json.dumps({"error": "no_face_detected", **result}, ensure_ascii=False, indent=2))
        return 1
    text = json.dumps(result, ensure_ascii=False, indent=2)
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
        print(f"저장: {args.out}  (얼굴 {result['faces_detected']}개 검출, 벡터 {result['dim']}차원)")
    else:
        print(text)
    return 0


def cmd_compare(args: argparse.Namespace) -> int:
    folder = Path(args.folder)
    files = sorted(p for p in folder.iterdir() if p.suffix.lower() in IMAGE_EXTS)
    if len(files) < 2:
        print("비교하려면 이미지가 2장 이상 필요합니다.", file=sys.stderr)
        return 2
    detector, recognizer = _load_models(args.score_threshold)

    vectors: dict[Path, np.ndarray] = {}
    skipped: list[str] = []
    for p in files:
        r = embed_image(p, detector, recognizer)
        if r["vector"] is None:
            skipped.append(p.name)
            continue
        if r["faces_detected"] > 1:
            print(f"경고: {p.name} 에서 얼굴 {r['faces_detected']}개 검출 — 가장 큰 얼굴만 사용", file=sys.stderr)
        vectors[p] = np.asarray(r["vector"], dtype=np.float64)

    if skipped:
        print("얼굴을 못 찾아 건너뜀: " + ", ".join(skipped), file=sys.stderr)
    if len(vectors) < 2:
        print("얼굴이 검출된 이미지가 2장 미만입니다.", file=sys.stderr)
        return 1

    rows: list[dict] = []
    for a, b in itertools.combinations(vectors.keys(), 2):
        same = label_of(a) == label_of(b)
        sim = cosine(vectors[a], vectors[b])
        rows.append(
            {
                "a": a.name,
                "b": b.name,
                "same_label": same,
                "cosine": round(sim, 4),
                "judged_same": sim >= COSINE_SAME_PERSON,
            }
        )

    # 표 출력
    print(f"{'A':28} {'B':28} {'같은사람?':8} {'코사인':>7}  판정(>= {COSINE_SAME_PERSON})")
    for r in sorted(rows, key=lambda r: (-int(r["same_label"]), -r["cosine"])):
        mark = "동일" if r["judged_same"] else "다름"
        flag = "" if r["judged_same"] == r["same_label"] else "  <-- 라벨과 불일치"
        print(f"{r['a'][:28]:28} {r['b'][:28]:28} {'예' if r['same_label'] else '아니오':8} {r['cosine']:7.4f}  {mark}{flag}")

    same_vals = [r["cosine"] for r in rows if r["same_label"]]
    diff_vals = [r["cosine"] for r in rows if not r["same_label"]]
    print()
    if same_vals:
        print(f"같은 사람 쌍  {len(same_vals):3d}개: 평균 {np.mean(same_vals):.3f}  최소 {np.min(same_vals):.3f}  최대 {np.max(same_vals):.3f}")
    if diff_vals:
        print(f"다른 사람 쌍  {len(diff_vals):3d}개: 평균 {np.mean(diff_vals):.3f}  최소 {np.min(diff_vals):.3f}  최대 {np.max(diff_vals):.3f}")
    if same_vals and diff_vals:
        gap = float(np.min(same_vals) - np.max(diff_vals))
        print(f"간격(같은 사람 최소 - 다른 사람 최대): {gap:+.3f}  → 양수면 임계값 하나로 완전히 갈라진다")
        errors = sum(1 for r in rows if r["judged_same"] != r["same_label"])
        print(f"기준값 {COSINE_SAME_PERSON} 으로 틀린 쌍: {errors}/{len(rows)}")

    if args.csv:
        with open(args.csv, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)
        print(f"CSV 저장: {args.csv}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--score-threshold", type=float, default=0.9, help="얼굴 검출 신뢰도 하한 (기본 0.9)")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_embed = sub.add_parser("embed", help="이미지 1장의 얼굴 벡터 출력")
    p_embed.add_argument("image")
    p_embed.add_argument("--out", help="JSON 저장 경로")
    p_embed.set_defaults(func=cmd_embed)

    p_cmp = sub.add_parser("compare", help="폴더 안 이미지 쌍별 코사인 유사도")
    p_cmp.add_argument("folder")
    p_cmp.add_argument("--csv", help="CSV 저장 경로")
    p_cmp.set_defaults(func=cmd_compare)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
