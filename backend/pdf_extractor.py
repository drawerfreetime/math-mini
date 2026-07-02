"""
pdf_extractor.py — 초등 수학 시험지 OCR 엔진 v2

개선 사항:
  1. 2단(2-Column) 레이아웃 처리 — 중앙 기준 왼쪽 열 → 오른쪽 열 순
  2. 문항 번호 감지 최적화   — 숫자+점/괄호(1. 2. 1) 2))만 문항 구분자로 인정
  3. 선지(Options) 보호       — ①②③ 등 원문자는 현재 문항의 options[] 배열로 분류
  4. 이미지-문항 매칭 고도화  — y좌표 구간(q[n].y0 ~ q[n+1].y0) 기반 정밀 할당
  5. 디버깅 로그              — [Found Question N at y=...] / 선지 / 이미지 매칭 출력

★ 개인정보 보호 ★
  PDF 내 수치·도형 정보만 처리하며 어떤 학생 정보도 취급하지 않습니다.
"""

import re
import sys
import base64
import pdfplumber
import fitz  # PyMuPDF

# Windows CP949 터미널에서 UTF-8 문자 print 시 UnicodeEncodeError 방지
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")


# ─────────────────────────────────────────────────────────────
# 패턴 정의
# ─────────────────────────────────────────────────────────────

# ① 문항 번호: 1~2자리 숫자 + 점 또는 닫는괄호  (예: 1. / 2) / 10.)
#   ※ 선지에 쓰이는 원문자(①②...)는 여기서 제외
Q_NUM_RE = re.compile(r'^(\d{1,2})[.)]\s*(.*)', re.DOTALL)

# ② 선지 번호: 원문자 ①~⑩ (초등 수학은 보통 ①~⑤ 이내)
CIRCLE_CHARS   = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳"
CIRCLE_TO_INT  = {c: i + 1 for i, c in enumerate(CIRCLE_CHARS)}
CIRCLE_OPT_RE  = re.compile(
    r'^([①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳])\s*(.*)',
    re.DOTALL,
)


# ─────────────────────────────────────────────────────────────
# 헬퍼 함수
# ─────────────────────────────────────────────────────────────

def _detect_qnum(text: str):
    """문항 번호 감지 → (번호, 나머지텍스트) | None"""
    m = Q_NUM_RE.match(text.strip())
    if m:
        return int(m.group(1)), m.group(2).strip()
    return None


def _detect_option(text: str):
    """선지 번호 감지 → (번호, 나머지텍스트) | None"""
    text = text.strip()
    if not text:
        return None
    m = CIRCLE_OPT_RE.match(text)
    if m:
        num = CIRCLE_TO_INT[m.group(1)]
        return num, m.group(2).strip()
    return None


def _words_to_lines(words, y_tol: int = 4) -> list[dict]:
    """
    pdfplumber extract_words() 결과를 y좌표 기준으로 줄 단위로 묶는다.
    같은 top 좌표(±y_tol) → 동일 줄, 왼쪽부터 오른쪽 순으로 결합.
    """
    if not words:
        return []
    buckets: dict[int, list] = {}
    for w in words:
        key = round(w["top"] / y_tol) * y_tol
        buckets.setdefault(key, []).append(w)

    lines = []
    for key in sorted(buckets):
        ws = sorted(buckets[key], key=lambda w: w["x0"])
        lines.append({
            "text": " ".join(w["text"] for w in ws),
            "x0":   min(w["x0"]     for w in ws),
            "y0":   min(w["top"]    for w in ws),
            "x1":   max(w["x1"]     for w in ws),
            "y1":   max(w["bottom"] for w in ws),
        })
    return lines


def _two_column_order(lines: list[dict], page_width: float) -> list[dict]:
    """
    2단 레이아웃 정렬:
      왼쪽 열(x0 < 페이지 중앙)을 위→아래로 먼저,
      이후 오른쪽 열(x0 >= 페이지 중앙)을 위→아래로.

    단이 하나뿐인 시험지(A4 전체 너비 사용)는 자동으로 전체가
    '왼쪽 열'에 포함되어 위→아래 정렬로 동작한다.
    """
    cx = page_width / 2
    left  = sorted([l for l in lines if l["x0"] <  cx], key=lambda l: l["y0"])
    right = sorted([l for l in lines if l["x0"] >= cx], key=lambda l: l["y0"])
    return left + right


# ─────────────────────────────────────────────────────────────
# 메인 추출 함수
# ─────────────────────────────────────────────────────────────

def extract_questions(pdf_path: str) -> list[dict]:
    """
    PDF 파일에서 문항을 분리하여 JSON 배열로 반환.

    Returns:
        [
          {
            "id":        int,             # 문항 번호
            "text":      str,             # 문항 본문
            "options":   [               # 선지 목록 (원문자로 표시된 것)
                           {"num": int, "text": str}, ...
                         ],
            "bbox":      {               # 문항 시작 위치 (pdfplumber 좌표계)
                           "page": int,
                           "x0": float, "y0": float,
                           "x1": float, "y1": float
                         },
            "image_b64": str | None      # "data:image/png;base64,..." 또는 null
          },
          ...
        ]
    """

    # ────────────────────────────────────────
    # Step 1: pdfplumber — 텍스트 + 좌표 추출
    #         2단 레이아웃 순서로 정렬
    # ────────────────────────────────────────
    all_lines: list[dict] = []

    with pdfplumber.open(pdf_path) as pdf:
        for page_idx, page in enumerate(pdf.pages):
            words = page.extract_words(
                x_tolerance=3,
                y_tolerance=3,
                keep_blank_chars=False,
                use_text_flow=True,
            )
            lines = _words_to_lines(words)
            ordered = _two_column_order(lines, page.width)
            for line in ordered:
                all_lines.append({"page": page_idx, **line})

    if not all_lines:
        print("[PDF] WARNING: no text found (scanned image PDF?)")
        return []

    print(f"[PDF] text lines extracted: {len(all_lines)}")

    # ────────────────────────────────────────
    # Step 2: 문항 분리 (선지 보호 포함)
    # ────────────────────────────────────────
    questions: list[dict] = []
    current:   dict | None = None
    seen_nums: set[int]    = set()   # 중복 문항 번호 방지

    for line in all_lines:
        raw = line["text"].strip()
        if not raw:
            continue

        # ── 문항 번호 감지 ──
        q_det = _detect_qnum(raw)
        if q_det:
            q_num, remaining = q_det

            # ── 중복/역행 번호 필터링 ──
            # 문항 번호는 단조 증가해야 함 (1→2→3…)
            # 현재 진행 중인 번호보다 작거나 같으면 본문 텍스트로 처리
            # (예: "답: 3." / "그림 1." 등이 문항 번호로 오인되는 것 방지)
            last_id = current["id"] if current else 0
            if q_num in seen_nums or (q_num < last_id):
                if current:
                    current["text"] += "\n" + raw
                continue
            # q_num == last_id + 1 이 아니더라도 처음 등장하는 번호면 허용
            # (1번 건너뛰거나 번호가 불연속적인 시험지 대응)

            if current:
                questions.append(current)

            seen_nums.add(q_num)
            print(f"[Found Question {q_num} at y={line['y0']:.1f}  page={line['page']}]")

            current = {
                "id":      q_num,
                "text":    remaining,
                "options": [],
                "bbox": {
                    "page": line["page"],
                    "x0":   line["x0"],
                    "y0":   line["y0"],
                    "x1":   line["x1"],
                    "y1":   line["y1"],
                },
                "_end_y":    line["y1"],
                "image_b64": None,
            }
            continue

        # 문항이 아직 시작되지 않은 경우 (헤더·제목 등)
        if current is None:
            continue

        # ── 선지(원문자) 감지 ──
        opt_det = _detect_option(raw)
        if opt_det:
            opt_num, opt_text = opt_det
            current["options"].append({"num": opt_num, "text": opt_text})
            print(f"   [option {opt_num}] {opt_text[:40]}")
        else:
            # 일반 본문 텍스트
            current["text"] += "\n" + raw

        # bbox y1 확장 (같은 페이지 내)
        if line["page"] == current["bbox"]["page"]:
            current["_end_y"]     = max(current["_end_y"],     line["y1"])
            current["bbox"]["y1"] = current["_end_y"]
            current["bbox"]["x1"] = max(current["bbox"]["x1"], line["x1"])

    if current:
        questions.append(current)

    print(f"\n[PDF] total questions extracted: {len(questions)}")
    for q in questions:
        opt_cnt = len(q["options"])
        preview = q['text'][:50].replace('\n', ' ')
        print(f"  Q{q['id']:2d}: options={opt_cnt}  | {preview!r}")

    # ────────────────────────────────────────
    # Step 3: PyMuPDF — 이미지 추출 & 정밀 매칭
    # ────────────────────────────────────────
    # 페이지별로 문항을 y0 오름차순 정렬 → 구간 매칭 준비
    qs_by_page: dict[int, list[dict]] = {}
    for q in questions:
        p = q["bbox"]["page"]
        qs_by_page.setdefault(p, []).append(q)
    for p in qs_by_page:
        qs_by_page[p].sort(key=lambda q: q["bbox"]["y0"])

    doc = fitz.open(pdf_path)
    for page_idx in range(len(doc)):
        page_fitz = doc[page_idx]
        page_qs   = qs_by_page.get(page_idx, [])

        for img_info in page_fitz.get_images(full=True):
            xref = img_info[0]
            rects = page_fitz.get_image_rects(xref)
            if not rects:
                continue

            rect    = rects[0]
            img_y   = (rect.y0 + rect.y1) / 2
            img_w   = rect.x1 - rect.x0
            img_h   = rect.y1 - rect.y0

            # 너무 작은 이미지(아이콘·불릿 등) 무시
            if img_w < 20 or img_h < 20:
                continue

            try:
                base_img = doc.extract_image(xref)
                img_b64  = base64.b64encode(base_img["image"]).decode()
                img_ext  = base_img.get("ext", "png")
                data_uri = f"data:image/{img_ext};base64,{img_b64}"
            except Exception:
                continue

            assigned = None

            # ── y구간 기반 매칭 ──
            # 이미지 y_center가 q[n].bbox.y0 ~ q[n+1].bbox.y0 사이이면 q[n]에 할당
            for i, q in enumerate(page_qs):
                q_start = q["bbox"]["y0"]
                q_end   = page_qs[i + 1]["bbox"]["y0"] if i + 1 < len(page_qs) else float("inf")

                if q_start <= img_y < q_end:
                    assigned = q
                    break

            # 구간 매칭 실패 시 최근접 문항(fallback)
            if assigned is None and page_qs:
                assigned = min(page_qs, key=lambda q: abs(img_y - q["bbox"]["y0"]))

            if assigned and assigned["image_b64"] is None:
                assigned["image_b64"] = data_uri
                print(f"   [image -> Q{assigned['id']}]  "
                      f"img_y={img_y:.1f}, size={img_w:.0f}x{img_h:.0f}")

    doc.close()

    # 내부 필드 정리
    for q in questions:
        q.pop("_end_y", None)

    return questions
