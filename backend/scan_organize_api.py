"""
스캔본 자동 정리 — FastAPI 라우터 (/api/scan-organize/*)

- PyMuPDF: 페이지 재배열·회전·블록 단위 처리 (pdf2image 대신 pixmap 사용)
- Gemini Vision: 이름·출석번호 OCR만 (기본: 페이지 상단 띠 한 장). API 키 필수.
- 문항 채점: **markBox(채점 네모)만** — 빈 시험지 PDF(template_pdf)와 픽셀 diff 후
  **빨간 색연필 채움**이 있으면 틀림. CV strip / Gemini 문항 채점 / 복합 diff 없음.
- L자·ArUco 등록 마크: 스캔 ↔ 템플릿 좌표 보정 (SCAN_ORGANIZE_REG_MARK=0 으로 끔)
- `POST /preview-grade-crops`: 채점 markBox 크롭·페이지 오버레이만 반환 (좌표 확인용)
- OCR 후처리: roster_json 명단으로 출석번호·이름 확정
- `SCAN_ORGANIZE_NAME_OCR_MODE=crop_then_header`(기본) | header | crop
  — 저장된 이름·번호 박스로 crop OCR 후, 실패 시 상단 띠(header) fallback
"""

from __future__ import annotations

import asyncio
import base64
import difflib
import io
import json
import struct
import os
import re
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import fitz  # PyMuPDF
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse, Response

from scan_registration_marks import (
    apply_affine_norm_box,
    apply_page_affine_norm_box,
    build_page_registration_affine,
    template_page_pt,
)

REGIONS_FILE = Path(__file__).resolve().parent / "data" / "pdf_regions.json"


def _scan_reg_mark_enabled() -> bool:
    raw = (os.environ.get("SCAN_ORGANIZE_REG_MARK") or "1").strip().lower()
    return raw not in ("0", "false", "no", "off")


def _problem_base_int(problem_number: Any) -> int:
    """채점·표시용 기본 문항 번호 (10-1 → 10, 보기·8~9 → 선행 숫자 또는 0)."""
    if isinstance(problem_number, bool):
        return 0
    if isinstance(problem_number, (int, float)):
        return int(problem_number)
    s = str(problem_number or "").strip()
    m = re.match(r"^(\d{1,2})", s)
    if m:
        return int(m.group(1))
    digits = re.sub(r"\D", "", s)
    if digits:
        try:
            return int(digits[:2])
        except ValueError:
            pass
    return 0


def _region_list_sort_key(region: dict[str, Any]) -> tuple:
    """page·문항번호 정렬 (보기 '8~9', '보기' 등 문자 라벨 허용)."""
    page = int(region.get("page") or 1)
    pn = region.get("problem_number")
    if isinstance(pn, bool):
        return (page, 2, 0, "")
    if isinstance(pn, (int, float)):
        return (page, 0, int(pn), "")
    s = str(pn or "").strip()
    m = re.match(r"^(\d{1,2})", s)
    base = int(m.group(1)) if m else 999
    return (page, 1, base, s)

GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models"
_DEFAULT_SCAN_GEMINI_MODELS = "gemini-2.5-flash-lite"

router = APIRouter(prefix="/api/scan-organize", tags=["scan-organize"])

_gemini_api_lock = asyncio.Lock()
_gemini_last_call_mono: float = 0.0


def _scan_gemini_model_candidates() -> list[str]:
    raw = (os.environ.get("GEMINI_VISION_MODELS") or os.environ.get("GEMINI_SCAN_MODELS") or "").strip()
    if not raw:
        raw = _DEFAULT_SCAN_GEMINI_MODELS
    parts = [p.strip() for p in raw.split(",") if p.strip()]
    seen: set[str] = set()
    out: list[str] = []
    for p in parts:
        if p not in seen:
            seen.add(p)
            out.append(p)
    return out if out else ["gemini-2.5-flash"]


def _resolve_scan_gemini_api_key(override: str | None) -> str:
    """요청으로 넘긴 키(AIza…) 우선, 없으면 서버 기본 키."""
    o = (override or "").strip()
    if o.startswith("AIza"):
        return o
    return (
        os.environ.get("REACT_APP_DEFAULT_GEMINI_KEY")
        or os.environ.get("GEMINI_API_KEY")
        or os.environ.get("GOOGLE_API_KEY")
        or ""
    ).strip()


def _scan_gemini_fallback_status(status_code: int) -> bool:
    """429는 모델 교체 없이 재시도만 — 교체 시 요청이 배로 늘어 난다."""
    return status_code >= 500 and status_code != 429


async def _gemini_throttle_before_call() -> None:
    """전역 최소 간격 — Gemini 호출은 _gemini_api_lock 안에서만."""
    global _gemini_last_call_mono
    try:
        min_iv = float((os.environ.get("SCAN_ORGANIZE_GEMINI_MIN_INTERVAL") or "0.9").strip())
    except ValueError:
        min_iv = 0.9
    min_iv = max(0.5, min(min_iv, 6.0))
    now = time.monotonic()
    wait_s = min_iv - (now - _gemini_last_call_mono)
    if wait_s > 0:
        await asyncio.sleep(wait_s)
    _gemini_last_call_mono = time.monotonic()


def _scan_gemini_max_retries() -> int:
    try:
        v = int((os.environ.get("SCAN_ORGANIZE_GEMINI_MAX_RETRIES") or "3").strip())
    except ValueError:
        v = 3
    return max(1, min(v, 5))


def _ocr_soft_fail(exc: BaseException) -> dict[str, Any]:
    msg = str(exc)
    if "429" in msg:
        return {
            "studentName": "",
            "studentNumber": None,
            "ocrError": "Gemini 할당량 초과(429). 채점 결과는 나왔을 수 있으니 표에서 출석번호를 수동 지정하세요.",
        }
    return {"studentName": "", "studentNumber": None, "ocrError": msg}


def _read_printed_text_in_norm_box(page: fitz.Page, box: dict[str, float]) -> str:
    """스캔 PDF에 글자 레이어가 있으면 박스 안 인쇄·숫자 추출(Gemini 생략용)."""
    pw = max(float(page.rect.width), 1.0)
    ph = max(float(page.rect.height), 1.0)
    x0 = float(box["x"]) * pw
    y0 = float(box["y"]) * ph
    x1 = (float(box["x"]) + float(box["w"])) * pw
    y1 = (float(box["y"]) + float(box["h"])) * ph
    parts: list[str] = []
    try:
        raw = page.get_text("dict")
    except Exception:
        return ""
    for block in raw.get("blocks") or []:
        if block.get("type") != 0:
            continue
        for line in block.get("lines") or []:
            for span in line.get("spans") or []:
                bbox = span.get("bbox")
                if not bbox or len(bbox) < 4:
                    continue
                cx = (float(bbox[0]) + float(bbox[2])) * 0.5
                cy = (float(bbox[1]) + float(bbox[3])) * 0.5
                if x0 <= cx <= x1 and y0 <= cy <= y1:
                    t = (span.get("text") or "").strip()
                    if t:
                        parts.append(t)
    return " ".join(parts).strip()


def _parse_student_number_from_text(text: str, roster_map: dict[int, str]) -> int | None:
    if not text:
        return None
    digits = re.findall(r"\d{1,3}", text)
    for d in digits:
        try:
            n = int(d)
        except ValueError:
            continue
        if n in roster_map:
            return n
        if 1 <= n <= 99:
            return n
    return None


def _try_header_ocr_without_gemini(
    doc: fitz.Document,
    pno: int,
    num_box: dict[str, float],
    roster: list[dict[str, Any]] | None,
) -> dict[str, Any] | None:
    """출석번호 칸에 인쇄 숫자만 있으면 Gemini 없이 확정."""
    roster_map = _roster_number_to_name(roster)
    if not roster_map:
        return None
    num_text = _read_printed_text_in_norm_box(doc[pno], num_box)
    sn = _parse_student_number_from_text(num_text, roster_map)
    if sn is None:
        return None
    sn = _resolve_roster_student_number(sn, roster_map) or sn
    name = roster_map.get(int(sn), "")
    return {"studentName": name, "studentNumber": int(sn)}


def _load_regions() -> dict[str, Any]:
    if not REGIONS_FILE.exists():
        return {"records": []}
    return json.loads(REGIONS_FILE.read_text("utf-8"))


def _default_name_region() -> dict[str, float]:
    return {"x": 0.05, "y": 0.02, "w": 0.38, "h": 0.085}


def _default_number_region() -> dict[str, float]:
    return {"x": 0.44, "y": 0.02, "w": 0.18, "h": 0.085}


def _pick_best_record_for_exam(records: list[dict], exam_name: str) -> dict | None:
    """exam_name 일치·regions·total_pages 우선, 최신 saved_at."""
    cands = [r for r in records if (r.get("exam_name") or "").strip() == exam_name.strip()]
    if not cands:
        return None
    return _pick_best_from_candidates(cands)


def _pick_best_record_for_pdf(records: list[dict], pdf_name: str) -> dict | None:
    """pdf_name 일치 레코드 중 regions·total_pages·saved_at 우선."""
    cands = [r for r in records if (r.get("pdf_name") or "").strip() == pdf_name.strip()]
    if not cands:
        return None
    return _pick_best_from_candidates(cands)


def _pick_best_from_candidates(cands: list[dict]) -> dict | None:
    def score(r: dict) -> tuple:
        regs = r.get("regions") or []
        tp = int(r.get("total_pages") or 0)
        saved = str(r.get("saved_at") or "")
        coord_bonus = 1 if (r.get("save_kind") or "") == "coordinates_dev" else 0
        return (coord_bonus, len(regs), tp, saved)

    cands.sort(key=score, reverse=True)
    return cands[0]


def _template_from_record(rec: dict) -> dict[str, Any]:
    """저장된 record를 그대로 노출. name/number_region은 실제 저장된 경우에만 포함하여,
    프론트엔드 체크리스트가 기본값을 '저장된 좌표'로 오인하지 않도록 한다."""
    name_r = rec.get("name_region") or rec.get("name_box")
    num_r = rec.get("student_number_region") or rec.get("number_region") or rec.get("number_box")
    name_region = None
    if isinstance(name_r, dict) and all(k in name_r for k in ("x", "y", "w", "h")):
        name_region = {k: float(name_r[k]) for k in ("x", "y", "w", "h")}
    number_region = None
    if isinstance(num_r, dict) and all(k in num_r for k in ("x", "y", "w", "h")):
        number_region = {k: float(num_r[k]) for k in ("x", "y", "w", "h")}
    regions = list(rec.get("regions") or [])
    regions.sort(key=_region_list_sort_key)
    out: dict[str, Any] = {
        "exam_name": rec.get("exam_name") or "",
        "pdf_name": rec.get("pdf_name") or "",
        "grade": rec.get("grade") or "",
        "semester": rec.get("semester") or "",
        "unit": rec.get("unit") or "",
        "total_pages": int(rec.get("total_pages") or 1),
        "page_width": float(rec.get("page_width") or 595),
        "page_height": float(rec.get("page_height") or 841),
        "regions": regions,
    }
    rm = rec.get("registrationMark")
    if isinstance(rm, dict) and rm:
        out["registrationMark"] = rm
    if name_region is not None:
        out["name_region"] = name_region
    if number_region is not None:
        out["student_number_region"] = number_region
    tpl_rel = (rec.get("template_pdf") or "").strip()
    if tpl_rel:
        out["template_pdf"] = tpl_rel
    return out


def _parse_slots_json(slots_raw: str) -> list[dict[str, Any]]:
    try:
        slots = json.loads(slots_raw)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"slots JSON 오류: {exc}") from exc
    if not isinstance(slots, list) or len(slots) == 0:
        raise HTTPException(status_code=400, detail="slots는 비어 있지 않은 배열이어야 합니다.")
    out = []
    for i, s in enumerate(slots):
        if not isinstance(s, dict):
            raise HTTPException(status_code=400, detail=f"slots[{i}]는 객체여야 합니다.")
        pi = int(s.get("physicalIndex", s.get("physical_index", i)))
        rot = int(s.get("rotation", s.get("rotate", 0)))
        if rot not in (0, 90, 180, 270):
            rot = ((rot % 360) + 360) % 360
            if rot not in (0, 90, 180, 270):
                rot = 0
        out.append({"physicalIndex": pi, "rotation": rot})
    return out


def _append_rotated_page(dst: fitz.Document, src: fitz.Document, src_pno: int, rotate: int) -> None:
    sp = src[src_pno]
    rot = int(rotate) % 360
    if rot in (0, 180):
        w, h = sp.rect.width, sp.rect.height
    else:
        w, h = sp.rect.height, sp.rect.width
    npage = dst.new_page(width=w, height=h)
    npage.show_pdf_page(npage.rect, src, src_pno, rotate=rot)


def _build_block_transformed_pdf(
    src_bytes: bytes,
    n: int,
    slots: list[dict[str, Any]],
) -> tuple[fitz.Document, int, list[str]]:
    """
    각 학생 블록(연속 n페이지)에 동일한 슬롯(물리 인덱스+회전) 적용.
    반환: (새 문서, 블록 수, 경고 목록)
    """
    if n < 1:
        raise ValueError("n은 1 이상이어야 합니다.")
    if len(slots) != n:
        raise ValueError(f"slots 길이({len(slots)})가 n({n})과 일치해야 합니다.")
    phys = [int(s["physicalIndex"]) for s in slots]
    if any(p < 0 or p >= n for p in phys):
        raise ValueError("physicalIndex는 0 이상 n-1 이하여야 합니다.")
    if len(set(phys)) != len(phys):
        raise ValueError("physicalIndex는 블록 내에서 중복 없이 매핑해야 합니다.")

    src = fitz.open(stream=src_bytes, filetype="pdf")
    warnings: list[str] = []
    total = src.page_count
    if total < n:
        src.close()
        raise ValueError(f"PDF 페이지 수({total})가 시험 페이지 수({n})보다 적습니다.")
    remainder = total % n
    if remainder:
        warnings.append(f"마지막 {remainder}페이지는 {n}페이지 블록에 들어가지 않아 제외되었습니다.")
    n_blocks = total // n

    dst = fitz.open()
    for b in range(n_blocks):
        base = b * n
        for k in range(n):
            slot = slots[k]
            src_pno = base + int(slot["physicalIndex"])
            _append_rotated_page(dst, src, src_pno, int(slot["rotation"]))
    src.close()
    return dst, n_blocks, warnings


def _page_png(doc: fitz.Document, pno: int, zoom: float = 1.8) -> bytes:
    page = doc[pno]
    mat = fitz.Matrix(zoom, zoom)
    pix = page.get_pixmap(matrix=mat, alpha=False)
    return pix.tobytes("png")


def _nx_ny_spec_to_region(
    spec: dict[str, Any],
    page_width_pt: float,
    page_height_pt: float,
    chars_wide: int,
) -> dict[str, float]:
    """
    ExamPdfStudentLabels와 동일: nx, ny = 입력칸 좌상단(페이지 너비·높이 대비 0~1),
    fontSizePt 기준 박스 크기(overlayInputBoxPx와 동일 계수).

    page_width_pt / page_height_pt 는 **좌표를 찍을 때와 같은 PDF 페이지**의 실제
    가로·세로(pt)여야 한다. pdf_regions의 템플릿 값과 스캔본 페이지 크기가 다르면
    w·h 비율이 어긋져 얇은 띠만 크롭되는 문제가 난다.
    """
    nx = float(spec["nx"])
    ny = float(spec["ny"])
    fs = float(spec["fontSizePt"])
    pw = max(float(page_width_pt), 1.0)
    ph = max(float(page_height_pt), 1.0)
    w = (fs * float(chars_wide) * 0.62) / pw
    h = (fs * 1.35) / ph
    return {"x": nx, "y": ny, "w": w, "h": h}


def _resolve_student_field_boxes_for_block(
    template: dict[str, Any],
    block_index: int,
    n: int,
    slots_p: list[dict[str, Any]],
    src: fitz.Document,
    doc: fitz.Document,
    reg_cache: dict[int, dict[str, Any]] | None,
) -> tuple[dict[str, float], dict[str, float], str, str]:
    """블록 첫 페이지 기준 이름·출석번호 OCR 크롭 박스(회전·L자 보정 반영)."""
    tpl_name_r = template.get("name_region")
    tpl_num_r = template.get("student_number_region")
    ns = template.get("nameSpec")
    att = template.get("attendanceSpec")

    first_page = block_index * n
    phys0 = first_page + int(slots_p[0]["physicalIndex"])
    rot0 = int(slots_p[0]["rotation"]) % 360
    sp0 = src[phys0]
    sw, sh = float(sp0.rect.width), float(sp0.rect.height)
    dst_r = doc[first_page].rect
    dw, dh = float(dst_r.width), float(dst_r.height)

    if isinstance(ns, dict) and all(k in ns for k in ("nx", "ny", "fontSizePt")):
        try:
            name_src_box = _nx_ny_spec_to_region(ns, sw, sh, 10)
            name_src_lbl = "examSpecs.nameSpec"
        except (TypeError, ValueError, KeyError):
            name_src_box = (
                {k: float(tpl_name_r[k]) for k in ("x", "y", "w", "h")}
                if isinstance(tpl_name_r, dict) and all(k in tpl_name_r for k in ("x", "y", "w", "h"))
                else _default_name_region()
            )
            name_src_lbl = "template.name_region" if isinstance(tpl_name_r, dict) else "default"
    elif isinstance(tpl_name_r, dict) and all(k in tpl_name_r for k in ("x", "y", "w", "h")):
        name_src_box = {k: float(tpl_name_r[k]) for k in ("x", "y", "w", "h")}
        name_src_lbl = "template.name_region"
    else:
        name_src_box = _default_name_region()
        name_src_lbl = "default"

    if isinstance(att, dict) and all(k in att for k in ("nx", "ny", "fontSizePt")):
        try:
            num_src_box = _nx_ny_spec_to_region(att, sw, sh, 3.6)  # 6*0.6 — 1~2자리 출석번호
            num_src_lbl = "examSpecs.attendanceSpec"
        except (TypeError, ValueError, KeyError):
            num_src_box = (
                {k: float(tpl_num_r[k]) for k in ("x", "y", "w", "h")}
                if isinstance(tpl_num_r, dict) and all(k in tpl_num_r for k in ("x", "y", "w", "h"))
                else _default_number_region()
            )
            num_src_lbl = (
                "template.student_number_region" if isinstance(tpl_num_r, dict) else "default"
            )
    elif isinstance(tpl_num_r, dict) and all(k in tpl_num_r for k in ("x", "y", "w", "h")):
        num_src_box = {k: float(tpl_num_r[k]) for k in ("x", "y", "w", "h")}
        num_src_lbl = "template.student_number_region"
    else:
        num_src_box = _default_number_region()
        num_src_lbl = "default"

    tw, th = template_page_pt(template, sw, sh)
    name_box = _map_norm_rect_src_to_dest(name_src_box, rot0, tw, th, dw, dh)
    num_box = _map_norm_rect_src_to_dest(num_src_box, rot0, tw, th, dw, dh)
    reg_aff_p1 = _registration_affine_for_page(reg_cache or {}, 1)
    if reg_aff_p1 is not None:
        name_box = _apply_registration_to_norm_box(
            name_box, reg_aff_p1, reg_cache or {}, 1, dw, dh
        )
        num_box = _apply_registration_to_norm_box(
            num_box, reg_aff_p1, reg_cache or {}, 1, dw, dh
        )
    return name_box, num_box, name_src_lbl, num_src_lbl


def _map_norm_rect_src_to_dest(
    box: dict[str, float],
    rot: int,
    sw: float,
    sh: float,
    dest_w: float,
    dest_h: float,
) -> dict[str, float]:
    """
    show_pdf_page(rotate=rot) 로 소스 페이지가 목적지에 올려질 때,
    소스 기준 정규화 사각형(x,y,w,h ∈ 0~1, y 아래로 증가)을
    목적지 페이지 정규화 좌표로 바꾼다(회전 후 축에 평행한 **바운딩 박스**).
    """
    rot = int(rot) % 360
    if rot not in (0, 90, 180, 270):
        rot = 0
    nx, ny, nw, nh = float(box["x"]), float(box["y"]), float(box["w"]), float(box["h"])
    sx0, sy0 = nx * sw, ny * sh
    sx1, sy1 = (nx + nw) * sw, (ny + nh) * sh
    corners = ((sx0, sy0), (sx1, sy0), (sx0, sy1), (sx1, sy1))
    pts: list[tuple[float, float]] = []
    for sx, sy in corners:
        if rot == 0:
            dx, dy = sx, sy
        elif rot == 90:
            dx, dy = sy, sw - sx
        elif rot == 180:
            dx, dy = sw - sx, sh - sy
        else:
            dx, dy = sh - sy, sx
        pts.append((dx, dy))
    minx = min(p[0] for p in pts)
    miny = min(p[1] for p in pts)
    maxx = max(p[0] for p in pts)
    maxy = max(p[1] for p in pts)
    dw = max(float(dest_w), 1.0)
    dh = max(float(dest_h), 1.0)
    return {
        "x": max(0.0, min(1.0, minx / dw)),
        "y": max(0.0, min(1.0, miny / dh)),
        "w": max(0.0, min(1.0, (maxx - minx) / dw)),
        "h": max(0.0, min(1.0, (maxy - miny) / dh)),
    }


def _scan_mark_region_pad() -> float:
    """저장된 문항 박스 바깥으로 붙이는 여백(박스 w·h 대비 비율, 상하좌우 각각)."""
    try:
        v = float((os.environ.get("SCAN_ORGANIZE_MARK_REGION_PAD") or "0.1").strip())
    except ValueError:
        v = 0.1
    return max(0.0, min(v, 0.25))


def _scan_mark_corner_fractions() -> tuple[float, float]:
    """패딩된 문항 박스에서 번호 띠 세로 높이 비율 등 (가로는 strip 전용, 세로만 사용)."""
    try:
        cw = float((os.environ.get("SCAN_ORGANIZE_MARK_CORNER_W") or "0.2").strip())
    except ValueError:
        cw = 0.2
    try:
        ch = float((os.environ.get("SCAN_ORGANIZE_MARK_CORNER_H") or "0.3").strip())
    except ValueError:
        ch = 0.3
    return max(0.05, min(cw, 0.5)), max(0.05, min(ch, 0.6))


def _scan_mark_left_page_fraction() -> float:
    """문항 박스 왼쪽으로 더 넓히는 비율(페이지 너비 대비). 번호·빨간 표시 여백 포함."""
    try:
        v = float((os.environ.get("SCAN_ORGANIZE_MARK_LEFT_PAD") or "0.06").strip())
    except ValueError:
        v = 0.06
    return max(0.04, min(v, 0.10))


def _scan_mark_number_left_margin() -> float:
    """빨간 띠 왼쪽 끝이 문항(초록) 박스 왼쪽선보다 살짝만 바깥 — 번호를 좌상단에 둠."""
    try:
        v = float((os.environ.get("SCAN_ORGANIZE_MARK_NUMBER_LEFT") or "0.015").strip())
    except ValueError:
        v = 0.015
    return max(0.0, min(v, 0.05))


def _scan_mark_strip_max_number_w() -> float:
    """PDF 텍스트 span이 '9. 5월…' 전체 줄일 때 번호 부분만 쓰도록 가로 상한."""
    try:
        v = float((os.environ.get("SCAN_ORGANIZE_MARK_STRIP_NUM_W") or "0.048").strip())
    except ValueError:
        v = 0.048
    return max(0.02, min(v, 0.08))


def _scan_mark_strip_max_w() -> float:
    """채점 띠(빨간 박스) 전체 가로 상한 — 페이지 너비 비율."""
    # cv(로컬 빨간펜)는 7번처럼 표시가 번호 오른쪽으로 멀리 찍히는 경우가 있어
    # 너무 좁게 잡으면 '표시가 있는데도 O' 누락이 생긴다. 기본을 완만히 확장.
    default = "0.18" if _scan_grade_engine() == "cv" else "0.14"
    try:
        v = float((os.environ.get("SCAN_ORGANIZE_MARK_STRIP_MAX_W") or default).strip())
    except ValueError:
        v = float(default)
    return max(0.09, min(v, 0.22))


def _scan_mark_strip_min_h() -> float:
    try:
        v = float((os.environ.get("SCAN_ORGANIZE_MARK_STRIP_MIN_H") or "0.065").strip())
    except ValueError:
        v = 0.065
    return max(0.05, min(v, 0.12))


def _clip_number_span_norm(span: dict[str, Any]) -> dict[str, Any]:
    """인쇄 줄 전체 bbox → 번호·체크 띠에 맞게 좌표만 잘라냄."""
    s = dict(span)
    max_nw = _scan_mark_strip_max_number_w()
    w = max(0.008, float(s.get("w") or 0.02))
    if w > max_nw:
        s["w"] = max_nw
    h = max(0.008, float(s.get("h") or 0.012))
    s["h"] = max(0.010, min(h, 0.045))
    return s


def _clamp_mark_strip_box(box: dict[str, float]) -> dict[str, float]:
    x, y, w, h = float(box["x"]), float(box["y"]), float(box["w"]), float(box["h"])
    max_w = _scan_mark_strip_max_w()
    if w > max_w:
        w = max_w
    min_h = _scan_mark_strip_min_h()
    if h < min_h:
        h = min_h
    x = max(0.0, min(x, 1.0 - w))
    y = max(0.0, min(y, 1.0 - h))
    return {"x": x, "y": y, "w": w, "h": h}


def _scan_mark_strip_into_region_w() -> float:
    """번호 띠 오른쪽 끝: 문항 박스 왼쪽에서 안쪽으로 들어가는 페이지 너비 비율."""
    # cv: 체크·V 표시가 번호 왼쪽 여백부터 번호 오른쪽까지 넓게 찍히므로 0.16으로 충분히 확보.
    # 인쇄 빨간 도형(1번 반원 등)은 bbox_frac 필터로 제거한다.
    default = "0.16" if _scan_grade_engine() == "cv" else "0.12"
    try:
        v = float((os.environ.get("SCAN_ORGANIZE_MARK_STRIP_INTO_W") or os.environ.get("SCAN_ORGANIZE_MARK_STRIP_W") or default).strip())
    except ValueError:
        v = float(default)
    return max(0.05, min(v, 0.2))


def _scan_mark_strip_height_frac() -> float:
    """채점 띠 세로 높이 = 패딩된 문항 박스 높이 × 이 비율."""
    default = "0.34" if _scan_grade_engine() == "cv" else "0.42"
    try:
        v = float((os.environ.get("SCAN_ORGANIZE_MARK_STRIP_H") or default).strip())
    except ValueError:
        v = float(default)
    return max(0.22, min(v, 0.65))


def _scan_mark_top_band_frac() -> float:
    """일반 문항: 박스 **왼쪽 위 번호 줄**만 채점 띠로 쓸 때, 문항 박스 높이 중 상단 비율."""
    try:
        v = float((os.environ.get("SCAN_ORGANIZE_MARK_TOP_BAND") or "0.30").strip())
    except ValueError:
        v = 0.30
    return max(0.12, min(v, 0.45))


def _scan_mark_strip_y_pad_above_frac() -> float:
    """띠를 앵커 박스 위로 소폭만 확장(박스 높이 대비). 크면 윗문항 (1) 체크가 아래 문항에 걸림."""
    try:
        v = float((os.environ.get("SCAN_ORGANIZE_MARK_STRIP_Y_PAD") or "0.04").strip())
    except ValueError:
        v = 0.04
    return max(0.0, min(v, 0.12))


def _scan_mark_strip_max_above_top_frac() -> float:
    """문항 박스 y(맨 위)보다 위로 허용할 페이지 높이 비율.
    선생님이 문항 번호 위쪽 빈 공간(문항 경계 바로 위 갭)에 체크를 찍는 경우가 많아
    0.025(2.5%) 정도 위로 확장해야 누락이 없다. y_floor(이전 문항 하단)로 이전 문항 침범은 방지.
    """
    try:
        v = float((os.environ.get("SCAN_ORGANIZE_MARK_STRIP_MAX_ABOVE_TOP") or "0.025").strip())
    except ValueError:
        v = 0.025
    return max(0.0, min(v, 0.06))


def _scan_mark_strip_neighbor_gap_frac() -> float:
    try:
        v = float((os.environ.get("SCAN_ORGANIZE_MARK_STRIP_NEIGHBOR_GAP") or "0.004").strip())
    except ValueError:
        v = 0.004
    return max(0.0, min(v, 0.015))


def _mark_strip_y0_floor(
    region: dict[str, Any],
    page_regions: list[dict[str, Any]] | None,
) -> float:
    """같은 페이지에서 바로 위에 있는 문항 박스 하단 — 그 아래부터 띠 시작."""
    if not page_regions:
        return 0.0
    page = int(region.get("page") or 1)
    ry = float(region["y"])
    rx, rw = float(region["x"]), float(region["w"])
    my_base = _problem_base_int(region.get("problem_number"))
    floor = 0.0
    # 2열(좌/우) 문제에서 반대 열을 floor로 잡아 띠가 밀리는 것을 막기 위해
    # x 중심으로 column을 먼저 분류한다. (문항별 하드코딩 없음)
    x_mid = rx + rw * 0.5
    col = "left" if x_mid < 0.5 else "right"
    for r in page_regions:
        if int(r.get("page") or 1) != page:
            continue
        if (r.get("groupRole") or "") == "passage":
            continue
        if _problem_base_int(r.get("problem_number")) == my_base and abs(float(r["y"]) - ry) < 0.002:
            continue
        r_x = float(r["x"])
        r_w = float(r["w"])
        r_mid = r_x + r_w * 0.5
        if ("left" if r_mid < 0.5 else "right") != col:
            continue
        r_bottom = float(r["y"]) + float(r["h"])
        # floor는 "현재 문항 윗변(ry) 위에 끝나는" 박스만 사용한다.
        # (박스가 약간 겹칠 때, 위 문항 bottom이 ry 아래로 내려와 띠가 불필요하게 아래로 밀리는 버그 방지)
        if r_bottom > ry + 0.0015:
            continue
        # 같은 열 안에서도, 띠 간섭은 보통 "바로 위" 문항에서만 생긴다.
        # 너무 위 문항을 floor로 잡지 않도록 수직 거리 제한을 둔다.
        if (ry - r_bottom) > 0.11:
            continue
        # x가 거의 안 겹치면 다른 박스로 간주
        ov = _norm_x_overlap(rx, rw, r_x, r_w)
        if ov < 0.22:
            continue
        floor = max(floor, r_bottom)
    if floor <= 0:
        return 0.0
    return floor + _scan_mark_strip_neighbor_gap_frac()


def _scan_grade_crop_mode() -> str:
    """채점 크롭: markBox(채점 네모)만 사용."""
    return "markbox"


def _region_has_mark_box(region: dict[str, Any] | None) -> bool:
    mb = (region or {}).get("markBox")
    if not isinstance(mb, dict):
        return False
    try:
        w = float(mb.get("w") or 0)
        h = float(mb.get("h") or 0)
    except (TypeError, ValueError):
        return False
    return w > 0 and h > 0


def _regions_have_mark_boxes(regions: list[dict[str, Any]] | None) -> bool:
    return any(_region_has_mark_box(r) for r in (regions or []))


def _region_mark_box_norm(region: dict[str, Any]) -> dict[str, float] | None:
    mb = region.get("markBox")
    if not isinstance(mb, dict):
        return None
    try:
        x, y, w, h = float(mb["x"]), float(mb["y"]), float(mb["w"]), float(mb["h"])
    except (KeyError, TypeError, ValueError):
        return None
    if w <= 0 or h <= 0:
        return None
    return {"x": x, "y": y, "w": w, "h": h}


def _grade_crop_use_mark_box(region: dict[str, Any] | None = None, regions: list[dict[str, Any]] | None = None) -> bool:
    mode = _scan_grade_crop_mode()
    if mode == "markbox":
        return True
    if mode == "strip":
        return False
    if mode == "region":
        return False
    # auto: 문항에 markBox가 저장돼 있으면 채점 네모 우선
    if region is not None:
        return _region_has_mark_box(region)
    return _regions_have_mark_boxes(regions)


def _grade_crop_use_mark_strip(region: dict[str, Any] | None = None, regions: list[dict[str, Any]] | None = None) -> bool:
    return not _grade_crop_use_mark_box(region=region, regions=regions)


def _grade_crop_prefers_mark_strip(registration_aligned: bool, region: dict[str, Any] | None = None) -> bool:
    """markBox가 있으면 네모 크롭. CV·Gemini 공통."""
    if _grade_crop_use_mark_box(region=region):
        return False
    if _scan_grade_engine() == "cv":
        return True
    if registration_aligned and _scan_grade_crop_mode() == "region":
        return False
    return _grade_crop_use_mark_strip(region=region)


def _report_grade_crop_mode(regions: list[dict[str, Any]] | None = None) -> str:
    if _regions_have_mark_boxes(regions) and _scan_grade_crop_mode() in ("auto", "markbox"):
        return "markbox"
    return "strip" if _grade_crop_use_mark_strip(regions=regions) else "region"


def _scan_grade_scan_pad_frac() -> float:
    """스캔·인쇄 오차용 — 채점 크롭만 상하좌우로 약간 확장(저장 박스 대비). 0이면 끔."""
    try:
        v = float((os.environ.get("SCAN_ORGANIZE_GRADE_SCAN_PAD") or "0.02").strip())
    except ValueError:
        v = 0.02
    return max(0.0, min(v, 0.06))


def _region_norm_box(region: dict[str, Any]) -> dict[str, float]:
    return {
        "x": float(region["x"]),
        "y": float(region["y"]),
        "w": float(region["w"]),
        "h": float(region["h"]),
    }


def _mm_to_pt(mm: float) -> float:
    return float(mm) * 72.0 / 25.4


def _registration_inset_mm() -> float:
    try:
        return float((os.environ.get("SCAN_REG_MARK_INSET_MM") or "4").strip())
    except Exception:
        return 4.0


def _template_registration_inset_mm(template: dict[str, Any] | None) -> float:
    if not isinstance(template, dict):
        return _registration_inset_mm()
    rm = template.get("registrationMark")
    if isinstance(rm, dict):
        try:
            v = float(rm.get("insetMm") or rm.get("inset_mm") or 0)
        except Exception:
            v = 0.0
        if v > 0:
            return v
    return _registration_inset_mm()


def _l_frame_to_page_norm_box(region: dict[str, Any], template: dict[str, Any]) -> dict[str, float] | None:
    """
    L자 4개(안쪽 꼭짓점)로 정의되는 내부 사각형 기준 상대 좌표(l_x,l_y,l_w,l_h ∈ 0~1)를
    페이지 정규화 박스(x,y,w,h)로 환산한다.
    """
    if not all(k in region for k in ("l_x", "l_y", "l_w", "l_h")):
        return None
    try:
        lx = float(region["l_x"])
        ly = float(region["l_y"])
        lw = float(region["l_w"])
        lh = float(region["l_h"])
    except Exception:
        return None
    pw = max(float(template.get("page_width") or 595), 1.0)
    ph = max(float(template.get("page_height") or 841), 1.0)
    inset_pt = _mm_to_pt(_template_registration_inset_mm(template))
    ix = max(0.0, min(0.25, inset_pt / pw))
    iy = max(0.0, min(0.25, inset_pt / ph))
    lW = max(1e-9, 1.0 - 2.0 * ix)
    lH = max(1e-9, 1.0 - 2.0 * iy)
    x = ix + lx * lW
    y = iy + ly * lH
    w = lw * lW
    h = lh * lH
    x0 = max(0.0, min(1.0, x))
    y0 = max(0.0, min(1.0, y))
    x1 = max(0.0, min(1.0, x + w))
    y1 = max(0.0, min(1.0, y + h))
    return {"x": x0, "y": y0, "w": max(0.0, x1 - x0), "h": max(0.0, y1 - y0)}


def _region_norm_box_with_template(region: dict[str, Any], template: dict[str, Any] | None) -> dict[str, float]:
    """
    템플릿/프론트에서 저장한 문항 박스(정규화).

    - 기본은 x,y,w,h(페이지 기준 정규화)를 신뢰한다. (UI에서 직접 그린 값)
    - l_x..(L자 내부 프레임 기준 좌표)는 coord_frame이 명시된 경우에만 사용한다.
      프린터/스캔 축소·여백·규격 변경 등으로 L자 inset이 미묘하게 달라지면,
      l_x.. → x,y 환산이 **상수 오프셋**을 만들어 전체 박스가 한쪽으로 밀릴 수 있다.
    """
    has_xywh = all(k in region for k in ("x", "y", "w", "h"))
    coord_frame = str(region.get("coord_frame") or "").strip().lower()

    use_l_frame = (
        not has_xywh
        or coord_frame.startswith("l_mark")
        or coord_frame.startswith("l-mark")
        or coord_frame.startswith("registration")
    )

    if use_l_frame and isinstance(template, dict):
        alt = _l_frame_to_page_norm_box(region, template)
        if alt is not None:
            return alt

    # fallback: page norm box
    return _region_norm_box(region)


def _scan_grade_anchor_enabled() -> bool:
    """스캔 PDF 텍스트에서 문항 번호를 찾아 페이지별 (dx,dy) 영점 보정."""
    raw = (os.environ.get("SCAN_ORGANIZE_GRADE_ANCHOR") or "1").strip().lower()
    return raw not in ("0", "false", "no", "off")


def _scan_grade_anchor_move_box() -> bool:
    """
    앵커(번호 위치) 보정으로 **문항(초록) 박스 자체를 옮길지** 여부. 기본 OFF.

    이미지 스캔에서는 번호 위치 검출(mode=image)이 불안정해 박스를 통째로
    위/아래로 잘못 끌어내려(예: 한 학생만 전체 상향) 오히려 정렬을 망친다.
    저장 박스+L자 등록 보정만으로 충분히 맞으므로 기본적으로 박스는 건드리지 않는다.
    """
    raw = (os.environ.get("SCAN_ORGANIZE_GRADE_ANCHOR_MOVE_BOX") or "0").strip().lower()
    return raw in ("1", "true", "yes", "on")


def _scan_grade_anchor_min_hits() -> int:
    try:
        v = int((os.environ.get("SCAN_ORGANIZE_GRADE_ANCHOR_MIN") or "2").strip())
    except ValueError:
        v = 2
    return max(1, min(v, 8))


def _scan_grade_anchor_max_shift() -> float:
    try:
        v = float((os.environ.get("SCAN_ORGANIZE_GRADE_ANCHOR_MAX_SHIFT") or "0.07").strip())
    except ValueError:
        v = 0.07
    return max(0.02, min(v, 0.12))


def _anchor_left_search_page_frac() -> float:
    """저장 박스 왼쪽 밖의 인쇄 문항번호(13. 등) 검색 폭."""
    try:
        v = float((os.environ.get("SCAN_ORGANIZE_ANCHOR_LEFT_SEARCH") or "0").strip())
    except ValueError:
        v = 0.0
    if v > 0:
        return max(0.08, min(v, 0.18))
    return max(0.11, _scan_mark_left_page_fraction() + 0.05)


def _anchor_expected_number_xy(mapped_box: dict[str, float]) -> tuple[float, float]:
    """템플릿 박스는 보통 '번호.' 다음 줄부터 — 번호는 박스 왼쪽 바깥."""
    return (
        max(0.0, float(mapped_box["x"]) - 0.014),
        float(mapped_box["y"]) + float(mapped_box["h"]) * 0.04,
    )


def _anchor_search_box_for_region(mapped_box: dict[str, float]) -> dict[str, float]:
    left = _anchor_left_search_page_frac()
    rx, ry, rw, rh = (
        float(mapped_box["x"]),
        float(mapped_box["y"]),
        float(mapped_box["w"]),
        float(mapped_box["h"]),
    )
    x0 = max(0.0, rx - left)
    x1 = min(1.0, rx + rw * 0.10)
    # 종이 크기 차이로 박스가 위/아래로 밀려도 같은 번호를 찾도록 세로를 넉넉히.
    # 번호는 problem_number 정확 일치로만 채택되므로 창을 넓혀도 오검출 위험이 낮다.
    y0 = max(0.0, ry - max(rh * 0.6, 0.06))
    y1 = min(1.0, ry + max(rh * 0.5, 0.05))
    return {"x": x0, "y": y0, "w": max(0.025, x1 - x0), "h": max(0.025, y1 - y0)}


def _parse_leading_problem_number_text(s: str) -> int | None:
    t = (s or "").strip()
    if not t:
        return None
    for pat in (
        r"^(\d{1,2})\s*[.)）\]}:：、]",
        r"^(\d{1,2})\s*$",
        r"^(\d{1,2})\b",
    ):
        m = re.match(pat, t)
        if m:
            num = int(m.group(1))
            if 1 <= num <= 50:
                return num
    return None


def _shift_norm_box(box: dict[str, float], dx: float, dy: float) -> dict[str, float]:
    x, y, w, h = float(box["x"]), float(box["y"]), float(box["w"]), float(box["h"])
    return {
        "x": max(0.0, min(1.0 - w, x + dx)),
        "y": max(0.0, min(1.0 - h, y + dy)),
        "w": w,
        "h": h,
    }


def _median_float(vals: list[float]) -> float:
    if not vals:
        return 0.0
    s = sorted(vals)
    mid = len(s) // 2
    if len(s) % 2:
        return float(s[mid])
    return float((s[mid - 1] + s[mid]) / 2.0)


def _clamp_anchor_offset(dx: float, dy: float) -> tuple[float, float]:
    cap = _scan_grade_anchor_max_shift()
    return (max(-cap, min(cap, dx)), max(-cap, min(cap, dy)))


def _point_in_norm_rect(px: float, py: float, box: dict[str, float]) -> bool:
    return (
        float(box["x"]) <= px <= float(box["x"]) + float(box["w"])
        and float(box["y"]) <= py <= float(box["y"]) + float(box["h"])
    )


def _page_number_spans_norm(page: fitz.Page) -> list[dict[str, Any]]:
    """페이지 인쇄 텍스트에서 문항 번호로 보이는 span 목록(정규화 좌표)."""
    pw = max(float(page.rect.width), 1.0)
    ph = max(float(page.rect.height), 1.0)
    out: list[dict[str, Any]] = []
    try:
        raw = page.get_text("dict")
    except Exception:
        return out
    for block in raw.get("blocks") or []:
        if block.get("type") != 0:
            continue
        for line in block.get("lines") or []:
            for span in line.get("spans") or []:
                text = (span.get("text") or "").strip()
                num = _parse_leading_problem_number_text(text)
                if num is None:
                    continue
                bbox = span.get("bbox")
                if not bbox or len(bbox) < 4:
                    continue
                x0, y0, x1, y1 = float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3])
                out.append(
                    _clip_number_span_norm(
                        {
                            "num": num,
                            "x": x0 / pw,
                            "y": y0 / ph,
                            "w": max(0.0, (x1 - x0) / pw),
                            "h": max(0.0, (y1 - y0) / ph),
                            "text": text,
                        }
                    )
                )
    return out


def _scan_image_anchor_enabled() -> bool:
    """순수 이미지 스캔(PDF 텍스트 없음)일 때 왼쪽 번호 줄 밝기로 앵커."""
    raw = (os.environ.get("SCAN_ORGANIZE_IMAGE_ANCHOR") or "1").strip().lower()
    return raw not in ("0", "false", "no", "off")


def _image_find_number_span_near_region(
    page: fitz.Page,
    problem_number: int,
    mapped_box: dict[str, float],
) -> dict[str, Any] | None:
    """
    텍스트 레이어 없는 스캔본: 문항 박스 왼쪽 위에서 인쇄 번호 줄(어두운 행) y 추정.
    """
    try:
        from PIL import Image
        import numpy as np
    except ImportError:
        return None
    left = _anchor_left_search_page_frac()
    rx, ry, rw, rh = (
        float(mapped_box["x"]),
        float(mapped_box["y"]),
        float(mapped_box["w"]),
        float(mapped_box["h"]),
    )
    y0 = max(0.0, ry - min(0.14, rh * 0.55))
    y1 = min(1.0, ry + rh * 0.10)
    x0 = max(0.0, rx - left)
    x1 = min(1.0, rx + 0.028)
    if y1 <= y0 or x1 <= x0:
        return None
    try:
        png = _crop_fitz_page_norm_to_png(
            page,
            {"x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0},
            zoom=2.0,
        )
        arr = np.asarray(Image.open(io.BytesIO(png)).convert("L"), dtype=np.float32)
    except Exception:
        return None
    h, w = arr.shape
    if h < 10 or w < 6:
        return None
    col_w = max(5, int(w * 0.55))
    ink = 255.0 - arr[:, :col_w].mean(axis=1)
    if h >= 7:
        k = np.ones(7, dtype=np.float32) / 7.0
        ink = np.convolve(ink, k, mode="same")
    search_end = max(2, int(h * 0.75))
    row_idx = int(np.argmax(ink[:search_end]))
    peak = float(ink[row_idx])
    if peak < float(np.median(ink)) + 10.0:
        return None
    span_y = y0 + (row_idx / max(h - 1, 1)) * (y1 - y0)
    row_ink = 255.0 - arr[row_idx, :col_w]
    med = float(np.median(row_ink))
    thresh = max(med + 12.0, peak * 0.45)
    hit_cols = np.where(row_ink >= thresh)[0]
    if hit_cols.size:
        num_col = int(hit_cols[0])
    else:
        num_col = int(np.argmax(row_ink))
    span_x = x0 + (num_col / max(w - 1, 1)) * (x1 - x0)
    return _clip_number_span_norm(
        {
            "num": int(problem_number),
            "x": span_x,
            "y": span_y,
            "w": min(_scan_mark_strip_max_number_w(), (x1 - x0) * 0.35),
            "h": max(0.012, (y1 - y0) * 0.14),
            "text": str(problem_number),
            "anchorSource": "image",
        }
    )


def _span_trustworthy_for_strip(
    span: dict[str, Any],
    mapped_box: dict[str, float],
    *,
    registration_aligned: bool = False,
) -> bool:
    """
    감지한 번호 span이 문항(초록) 박스 왼쪽 근처에 있어야 채택(잔차 보정용).
    dest 페이지 좌표의 번호 위치는 스캔 실제 위치이므로 L자 보정 여부와 무관하게 쓴다.
    가로(x)만 검사 — 세로 드리프트(번호가 위/아래로 밀림)는 보정 대상이라 거르지 않는다.
    """
    rx, rw = float(mapped_box["x"]), float(mapped_box["w"])
    sx = float(span["x"])
    left_allow = _scan_mark_left_page_fraction() + 0.02
    if sx < rx - left_allow:
        return False
    if sx > rx + rw * 0.14:
        return False
    return True


def _find_number_span_near_region(
    page: fitz.Page,
    problem_number: int,
    mapped_box: dict[str, float],
    *,
    registration_aligned: bool = False,
    text_spans_ok: bool = True,
) -> dict[str, Any] | None:
    """문항번호 위치: PDF 텍스트(좌표 신뢰 시) → 이미지(스캔) 추정."""
    exp_x, exp_y = _anchor_expected_number_xy(mapped_box)
    search = _anchor_search_box_for_region(mapped_box)
    best: dict[str, Any] | None = None
    best_dist = 1e18
    if text_spans_ok:
        for sp in _page_number_spans_norm(page):
            if int(sp["num"]) != int(problem_number):
                continue
            clipped = _clip_number_span_norm(sp)
            if not _span_trustworthy_for_strip(
                clipped, mapped_box, registration_aligned=registration_aligned
            ):
                continue
            cx = float(clipped["x"]) + float(clipped["w"]) * 0.5
            cy = float(clipped["y"]) + float(clipped["h"]) * 0.5
            if not _point_in_norm_rect(cx, cy, search):
                continue
            dist = (cx - exp_x) ** 2 + (cy - exp_y) ** 2
            if dist < best_dist:
                best_dist = dist
                best = dict(clipped)
        if best is not None:
            best["anchorSource"] = "text"
            return best
    if _scan_image_anchor_enabled():
        found = _image_find_number_span_near_region(page, problem_number, mapped_box)
        if found is None:
            return None
        clipped = _clip_number_span_norm(found)
        if _span_trustworthy_for_strip(
            clipped, mapped_box, registration_aligned=registration_aligned
        ):
            return clipped
    return None


def _clamp_strip_x_to_mapped(
    strip: dict[str, float],
    mapped_box: dict[str, float],
) -> dict[str, float]:
    """
    빨간 띠 가로 위치를 문항(초록) 박스 **왼쪽 모서리(=번호 위치)에서 시작**해
    오른쪽으로 뻗게 고정. 번호가 빨간 띠 좌상단에 오도록 한다.
    """
    rx, rw = float(mapped_box["x"]), float(mapped_box["w"])
    into = _scan_mark_strip_into_region_w()
    max_w = _scan_mark_strip_max_w()
    left_margin = _scan_mark_number_left_margin()
    x0 = max(0.0, rx - left_margin)
    x1 = min(1.0, rx + into)
    w = min(max(0.03, x1 - x0), max_w)
    x1 = min(1.0, x0 + w)
    out = dict(strip)
    out["x"] = x0
    out["w"] = max(0.008, x1 - x0)
    return _clamp_mark_strip_box(out)


def _merge_span_y_into_strip(
    geom_strip: dict[str, float],
    span: dict[str, Any],
    mapped_box: dict[str, float],
) -> dict[str, float]:
    """가로는 초록 박스 기준, 세로만 인쇄·스캔 번호 줄에 맞춤."""
    sy = float(span["y"])
    ry = float(mapped_box["y"])
    rh = float(mapped_box["h"])
    y0 = max(float(geom_strip["y"]), sy - 0.006)
    y0 = max(y0, ry - _scan_mark_strip_max_above_top_frac())
    y0 = min(y0, ry + rh * 0.08)
    h = max(float(geom_strip["h"]), _scan_mark_strip_min_h())
    cap = ry + rh * max(_scan_mark_top_band_frac() * 1.15, 0.28)
    y1 = min(1.0, y0 + h, cap)
    if y1 <= y0 + 0.012:
        y1 = min(1.0, y0 + _scan_mark_strip_min_h())
    merged = dict(geom_strip)
    merged["y"] = y0
    merged["h"] = max(0.008, y1 - y0)
    return _clamp_strip_x_to_mapped(merged, mapped_box)


def _anchor_delta_for_region(
    page: fitz.Page,
    problem_number: int,
    mapped_box: dict[str, float],
    *,
    registration_aligned: bool = False,
) -> tuple[float, float] | None:
    """인쇄 문항번호 위치와 템플릿 기대 위치 차이 (dx, dy)."""
    best = _find_number_span_near_region(
        page,
        problem_number,
        mapped_box,
        registration_aligned=registration_aligned,
        text_spans_ok=not registration_aligned,
    )
    if best is None:
        return None
    exp_x, exp_y = _anchor_expected_number_xy(mapped_box)
    return (float(best["x"]) - exp_x, float(best["y"]) - exp_y)


def _fit_page_strip_model(
    samples: list[tuple[float, float, float]],
    page: fitz.Page,
    min_hits: int,
) -> dict[str, Any]:
    """
    페이지 전체 스캔 오차 모델 — 문항 박스는 건드리지 않고 채점 띠만 이동.
    samples: (region_y, dx, dy) 각 문항에서 번호 위치로 측정한 편차.
    model=linear: dy(y) = dy_intercept + dy_slope * y  (아래로 갈수록 드리프트 일반화)
    model=translate: dy, dx 상수 (표본 적을 때)
    """
    hits = len(samples)
    mode = "none"
    if hits and not _page_number_spans_norm(page):
        mode = "image"
    elif hits:
        mode = "text"
    empty: dict[str, Any] = {
        "dx": 0.0,
        "dy": 0.0,
        "dy_slope": 0.0,
        "dy_intercept": 0.0,
        "hits": hits,
        "model": "none",
        "anchorMode": mode if hits else "none",
    }
    if hits < min_hits:
        return empty
    dx_med = _median_float([s[1] for s in samples])
    cap = _scan_grade_anchor_max_shift()
    dx_med = max(-cap, min(cap, dx_med))
    if hits >= 3:
        try:
            import numpy as np

            ry = np.array([s[0] for s in samples], dtype=np.float64)
            dy = np.array([s[2] for s in samples], dtype=np.float64)
            coef, _, _, _ = np.linalg.lstsq(
                np.column_stack([np.ones_like(ry), ry]), dy, rcond=None
            )
            intercept = float(coef[0])
            slope = float(coef[1])
            slope = max(-0.12, min(0.12, slope))
            intercept = max(-cap, min(cap, intercept))
            return {
                "dx": dx_med,
                "dy": intercept,
                "dy_slope": slope,
                "dy_intercept": intercept,
                "hits": hits,
                "model": "linear",
                "anchorMode": mode,
            }
        except Exception:
            pass
    dy_med = _median_float([s[2] for s in samples])
    _, dy_med = _clamp_anchor_offset(dx_med, dy_med)
    return {
        "dx": dx_med,
        "dy": dy_med,
        "dy_slope": 0.0,
        "dy_intercept": dy_med,
        "hits": hits,
        "model": "translate",
        "anchorMode": mode,
    }


def _strip_shift_at_region_y(page_model: dict[str, Any], region_y: float) -> tuple[float, float]:
    """채점 띠에만 적용할 (dx, dy). 문항 저장 박스 좌표는 변경하지 않음."""
    if not page_model or int(page_model.get("hits") or 0) < 1:
        return (0.0, 0.0)
    dx = float(page_model.get("dx") or 0.0)
    if (page_model.get("model") or "") == "linear" and int(page_model.get("hits") or 0) >= 3:
        dy = float(page_model.get("dy_intercept") or 0.0) + float(
            page_model.get("dy_slope") or 0.0
        ) * float(region_y)
    else:
        dy = float(page_model.get("dy") or 0.0)
    return _clamp_anchor_offset(dx, dy)


def _build_block_page_anchor_offsets(
    block_index: int,
    n: int,
    slots: list[dict[str, Any]],
    src: fitz.Document,
    dst: fitz.Document,
    regions: list[dict[str, Any]],
    template: dict[str, Any] | None = None,
    reg_cache: dict[int, dict[str, Any]] | None = None,
) -> dict[int, dict[str, Any]]:
    """
    페이지별 채점 띠 보정 모델. 저장 문항 영역(초록)은 고정, 빨간 띠만 이동.
    """
    out: dict[int, dict[str, Any]] = {}
    if not _scan_grade_anchor_enabled():
        return out
    min_hits = _scan_grade_anchor_min_hits()
    b = int(block_index)
    pages = sorted(
        {int(r.get("page") or 1) for r in _regions_for_grading(regions)},
    )
    for page_num in pages:
        p_rel = page_num - 1
        if p_rel < 0 or p_rel >= n:
            continue
        pno = b * n + p_rel
        page = dst[pno]
        samples: list[tuple[float, float, float]] = []
        for reg in _regions_on_page(regions, page_num):
            if (reg.get("groupRole") or "") == "passage":
                continue
            pn = _problem_base_int(reg.get("problem_number"))
            if pn < 1:
                continue
            reg_aff = _registration_affine_for_page(reg_cache or {}, page_num)
            reg_aligned = reg_aff is not None
            mapped = _grade_box_for_block_page(
                reg,
                b,
                n,
                slots,
                src,
                dst,
                apply_scan_pad=False,
                template=template,
                reg_affine=reg_aff,
                reg_cache=reg_cache,
            )
            delta = _anchor_delta_for_region(
                page, pn, mapped, registration_aligned=reg_aligned
            )
            if delta is not None:
                samples.append((float(mapped["y"]), float(delta[0]), float(delta[1])))
        out[page_num] = _fit_page_strip_model(samples, page, min_hits)
    return out


def _page_strip_model(
    anchor_cache: dict[int, dict[str, Any]],
    page_num: int,
) -> dict[str, Any]:
    return dict(anchor_cache.get(int(page_num)) or {})


def _anchor_correct_mapped_box(
    mapped: dict[str, float],
    strip_model: dict[str, Any] | None,
    registration_aligned: bool,
) -> dict[str, float]:
    """
    L자 보정이 없을 때, 인쇄 문항번호 위치로 측정한 선형 dy(절편+기울기·y)로
    문항(초록) 박스 자체를 스캔 내용에 맞춘다.
    종이 크기·스캔 스케일 차이로 '아래로 갈수록 커지는' 세로 드리프트를 잡는다.
    모델은 L자 보정을 적용한 박스 기준으로 측정된 잔차이므로, L자 보정 여부와
    무관하게 한 번만 적용한다(이중 보정 아님).
    """
    if not _scan_grade_anchor_move_box():
        # 기본값: 문항(초록) 박스는 저장 좌표+L자 등록 보정 그대로 둔다.
        return mapped
    if not strip_model:
        return mapped
    dx, dy = _strip_shift_at_region_y(strip_model, float(mapped["y"]))
    if dx == 0.0 and dy == 0.0:
        return mapped
    return _shift_norm_box(mapped, dx, dy)


def _scan_grade_snap_top_enabled() -> bool:
    """저장 박스 윗변이 인쇄된 문항 제목 줄보다 아래면, 제목 줄까지 위로 올린다(일반 동작)."""
    raw = (os.environ.get("SCAN_ORGANIZE_GRADE_SNAP_TOP") or "1").strip().lower()
    return raw not in ("0", "false", "no", "off")


def _scan_grade_snap_top_max() -> float:
    """윗변을 위로 올릴 수 있는 최대 폭(페이지 높이 비율). 한 줄(≈4.5%) 정도만."""
    try:
        v = float((os.environ.get("SCAN_ORGANIZE_GRADE_SNAP_TOP_MAX") or "0.045").strip())
    except ValueError:
        v = 0.045
    return max(0.0, min(v, 0.09))


def _detect_heading_top_norm(
    page: fitz.Page, box: dict[str, float], max_up: float, *, y_floor: float = 0.0
) -> float | None:
    """
    박스 윗변(ry) **바로 위 번호 열**에서, ry에 가장 가까운 잉크 덩어리의 윗변 y(정규화).

    - 번호 열만 본다(본문은 보통 더 들여쓰기) → 윗 문항 본문을 잘못 잡지 않음
    - ry에서 위로 올라가며 '가장 가까운' 덩어리만 잡는다 → 윗 문항(공백 너머)은 무시
    - 인쇄 문항이 이미 윗변에 있으면 gap≈0 → 변화 없음
    """
    if max_up <= 0:
        return None
    try:
        import io

        import numpy as np
        from PIL import Image
    except ImportError:
        return None
    rect = page.rect
    rx = float(box["x"])
    rw = float(box["w"])
    ry = float(box["y"])
    x0 = max(0.0, rx - 0.012)
    x1 = min(1.0, rx + min(0.06, rw * 0.5))
    # 위 문항(바로 위)의 번호/잉크를 heading으로 오인해 "현재 문항" 박스를 위로 끌어올리는 것을 방지:
    # floor(바로 위 문항 bottom) 아래 구간만 스캔한다.
    y0 = max(0.0, ry - max_up, float(y_floor or 0.0))
    y1 = min(1.0, ry + 0.006)
    if x1 <= x0 or y1 <= y0:
        return None
    clip = fitz.Rect(x0 * rect.width, y0 * rect.height, x1 * rect.width, y1 * rect.height)
    try:
        pix = page.get_pixmap(matrix=fitz.Matrix(3.0, 3.0), clip=clip, alpha=False)
        arr = np.asarray(
            Image.open(io.BytesIO(pix.tobytes("png"))).convert("L"), dtype=np.float32
        )
    except Exception:
        return None
    h, w = arr.shape
    if h < 8 or w < 6:
        return None
    rowink = (255.0 - arr).mean(axis=1)
    thr = max(float(np.median(rowink)) + 14.0, 18.0)
    inky = rowink >= thr

    def row_to_y(i: int) -> float:
        return y0 + (i / max(h - 1, 1)) * (y1 - y0)

    bottom = None
    for i in range(h - 1, -1, -1):
        if inky[i]:
            bottom = i
            break
    if bottom is None:
        return None
    if (ry - row_to_y(bottom)) > max_up:
        return None
    gap_tol = max(2, int(h * 0.02))
    top_i = bottom
    run = 0
    for i in range(bottom - 1, -1, -1):
        if inky[i]:
            top_i = i
            run = 0
        else:
            run += 1
            if run > gap_tol:
                break
    return row_to_y(top_i)


def _snap_box_top_to_heading(
    page: fitz.Page,
    box: dict[str, float],
    page_regions: list[dict[str, Any]] | None = None,
    *,
    region: dict[str, Any] | None = None,
) -> dict[str, float]:
    """문항(초록) 박스 윗변을 인쇄된 제목 줄까지 위로만 끌어올린다(아래로는 안 내림)."""
    if not _scan_grade_snap_top_enabled():
        return box
    max_up = _scan_grade_snap_top_max()
    y_floor = 0.0
    if page_regions:
        try:
            # heading 탐지는 "바로 위 문항" 영역을 넘어가지 않게 제한한다.
            page_num = int((page_regions[0].get("page") if isinstance(page_regions[0], dict) else None) or 1)
            floor_region = region if isinstance(region, dict) else {"page": page_num, **box}
            if "page" not in floor_region:
                floor_region = {"page": page_num, **floor_region}
            y_floor = _mark_strip_y0_floor(floor_region, page_regions)
        except Exception:
            y_floor = 0.0
    head = _detect_heading_top_norm(page, box, max_up, y_floor=y_floor)
    if head is None:
        return box
    ry = float(box["y"])
    target = max(0.0, head - 0.004)
    gap = ry - target
    if gap <= 0.006 or gap > max_up:
        return box
    return {
        "x": float(box["x"]),
        "y": target,
        "w": float(box["w"]),
        "h": float(box["h"]) + gap,
    }


def _build_block_page_registration_cache(
    block_index: int,
    n: int,
    slots: list[dict[str, Any]],
    dst: fitz.Document,
    regions: list[dict[str, Any]],
    template: dict[str, Any] | None,
) -> dict[int, dict[str, Any]]:
    """페이지별 L자 마크 → affine (저장 좌표계를 스캔에 맞춤)."""
    out: dict[int, dict[str, Any]] = {}
    if not _scan_reg_mark_enabled():
        return out
    b = int(block_index)
    pages = sorted({int(r.get("page") or 1) for r in _regions_for_grading(regions)})
    for page_num in pages:
        p_rel = page_num - 1
        if p_rel < 0 or p_rel >= n:
            continue
        pno = b * n + p_rel
        out[page_num] = build_page_registration_affine(dst[pno], template)
    return out


def _registration_affine_for_page(
    reg_cache: dict[int, dict[str, Any]],
    page_num: int,
) -> tuple[float, float, float, float, float, float] | None:
    entry = reg_cache.get(int(page_num)) or {}
    aff = entry.get("affine")
    if aff and isinstance(aff, (list, tuple)) and len(aff) == 6:
        return tuple(float(x) for x in aff)
    return None


def _registration_page_pt_for_page(
    reg_cache: dict[int, dict[str, Any]],
    page_num: int,
    fallback_w: float,
    fallback_h: float,
) -> tuple[float, float]:
    entry = reg_cache.get(int(page_num)) or {}
    pt = entry.get("pagePt")
    if pt and isinstance(pt, (list, tuple)) and len(pt) == 2:
        return max(float(pt[0]), 1.0), max(float(pt[1]), 1.0)
    return max(float(fallback_w), 1.0), max(float(fallback_h), 1.0)


def _apply_registration_to_norm_box(
    box: dict[str, float],
    reg_affine: tuple[float, float, float, float, float, float] | None,
    reg_cache: dict[int, dict[str, Any]],
    page_num: int,
    page_w: float,
    page_h: float,
) -> dict[str, float]:
    if reg_affine is None:
        return box
    pw, ph = _registration_page_pt_for_page(reg_cache, page_num, page_w, page_h)
    model = str((reg_cache.get(int(page_num)) or {}).get("model") or "")
    # model이 *_pt이면 pt 공간 affine(좌표=pt)로 간주.
    # *_norm이면 0~1 정규화 공간 affine 이므로 apply_affine_norm_box 로 적용한다.
    if model.endswith("pt"):
        return apply_page_affine_norm_box(box, reg_affine, pw, ph)
    return apply_affine_norm_box(box, reg_affine)


def _grade_box_for_block_page(
    reg: dict[str, Any],
    block_index: int,
    n: int,
    slots: list[dict[str, Any]],
    src: fitz.Document,
    dst: fitz.Document,
    *,
    apply_scan_pad: bool,
    template: dict[str, Any] | None = None,
    reg_affine: tuple[float, float, float, float, float, float] | None = None,
    reg_cache: dict[int, dict[str, Any]] | None = None,
) -> dict[str, float]:
    """
    템플릿 저장 좌표 → (템플릿·스캔 페이지 크기 보정) → 회전·슬롯 → L자 affine.
    """
    p_rel = int(reg.get("page") or 1) - 1
    page_num = int(reg.get("page") or 1)
    if p_rel < 0 or p_rel >= n:
        return _region_norm_box(reg)
    slot = slots[p_rel]
    rot = int(slot.get("rotation", slot.get("rotate", 0))) % 360
    src_pno = int(block_index) * n + int(slot["physicalIndex"])
    if src_pno < 0 or src_pno >= src.page_count:
        return _region_norm_box(reg)
    sp = src[src_pno]
    sw, sh = float(sp.rect.width), float(sp.rect.height)
    pno = int(block_index) * n + p_rel
    dp = dst[pno]
    dw, dh = float(dp.rect.width), float(dp.rect.height)
    box = _region_norm_box_with_template(reg, template)
    # 문항 좌표는 정규화(0~1)이므로 회전 매핑의 소스 크기는 **스캔 소스 페이지**여야
    # 한다. 템플릿 pt(595×841 등)를 쓰면 스캔 페이지 크기가 다른 쪽(예: 2페이지)에서
    # template/scan 비율 스케일이 걸려 아래로 갈수록 커지는 하향 이동이 생긴다.
    mapped = _map_norm_rect_src_to_dest(box, rot, sw, sh, dw, dh)
    if reg_affine is not None:
        mapped = _apply_registration_to_norm_box(
            mapped, reg_affine, reg_cache or {}, page_num, dw, dh
        )
    if apply_scan_pad and _scan_grade_scan_pad_frac() > 0:
        mapped = _expand_norm_region(mapped, _scan_grade_scan_pad_frac())
    return mapped


def _grade_mark_box_for_block_page(
    reg: dict[str, Any],
    block_index: int,
    n: int,
    slots: list[dict[str, Any]],
    src: fitz.Document,
    dst: fitz.Document,
    *,
    apply_scan_pad: bool,
    template: dict[str, Any] | None = None,
    reg_affine: tuple[float, float, float, float, float, float] | None = None,
    reg_cache: dict[int, dict[str, Any]] | None = None,
) -> dict[str, float] | None:
    """pdf_regions markBox → 회전·L자 affine 적용한 스캔 좌표."""
    mb = _region_mark_box_norm(reg)
    if mb is None:
        return None
    # markBox는 UI에서 페이지 정규화(0~1)로 저장됨. coord_frame=l_mark_* 이면
    # _region_norm_box_with_template 이 l_x.. 를 쓰며 markBox x,y 가 무시된다.
    fake = {k: v for k, v in reg.items() if not str(k).startswith("l_")}
    fake.pop("coord_frame", None)
    fake.update(mb)
    fake["coord_frame"] = "page_norm"
    return _grade_box_for_block_page(
        fake,
        block_index,
        n,
        slots,
        src,
        dst,
        apply_scan_pad=apply_scan_pad,
        template=template,
        reg_affine=reg_affine,
        reg_cache=reg_cache,
    )


def _expand_norm_region(box: dict[str, float], pad_frac: float) -> dict[str, float]:
    """정규화 문항 박스를 상하좌우 pad_frac만큼 확장(페이지 0~1 클램프). 타이트한 번호 박스+V 표시용."""
    x, y, w, h = float(box["x"]), float(box["y"]), float(box["w"]), float(box["h"])
    if pad_frac <= 0:
        return {"x": x, "y": y, "w": w, "h": h}
    px, py = w * pad_frac, h * pad_frac
    x0 = max(0.0, x - px)
    y0 = max(0.0, y - py)
    x1 = min(1.0, x + w + px)
    y1 = min(1.0, y + h + py)
    return {"x": x0, "y": y0, "w": max(0.0, x1 - x0), "h": max(0.0, y1 - y0)}


def _student_field_ocr_crop_pad_frac() -> float:
    """이름·출석번호 OCR 크롭 — 박스 w·h 대비 상하좌우 여유(기본 10%)."""
    try:
        v = float((os.environ.get("SCAN_ORGANIZE_NAME_CROP_PAD_FRAC") or "0.10").strip())
    except ValueError:
        v = 0.10
    return max(0.0, min(v, 0.25))


def _student_field_crop_box(box: dict[str, float]) -> dict[str, float]:
    """저장된 이름/번호 칸에 OCR용 겉 여유를 두고 크롭할 정규화 박스."""
    return _expand_norm_region(box, _student_field_ocr_crop_pad_frac())


def _student_field_ocr_zoom() -> float:
    """이름·출석번호 Gemini 크롭 해상도 — 작은 pt·일반체 인쇄도 픽셀 높이 확보."""
    try:
        v = float((os.environ.get("SCAN_ORGANIZE_STUDENT_FIELD_ZOOM") or "2.5").strip())
    except ValueError:
        v = 2.5
    return max(2.0, min(v, 4.0))


def _norm_x_overlap(ax: float, aw: float, bx: float, bw: float) -> float:
    """가로 겹침 비율(0~1, 두 박스 중 narrower 기준)."""
    a1, a2 = ax, ax + aw
    b1, b2 = bx, bx + bw
    inter = max(0.0, min(a2, b2) - max(a1, b1))
    denom = max(min(aw, bw), 1e-6)
    return inter / denom


def _scan_mark_merged_skip_top_frac() -> float:
    """보기+문항이 한 박스로 합쳐진 것으로 보일 때, 띠 시작 y 오프셋(박스 높이 비율)."""
    try:
        v = float((os.environ.get("SCAN_ORGANIZE_MARK_MERGED_SKIP_TOP") or "0.38").strip())
    except ValueError:
        v = 0.38
    return max(0.2, min(v, 0.65))


def _scan_mark_tall_region_h() -> float:
    try:
        v = float((os.environ.get("SCAN_ORGANIZE_MARK_TALL_REGION_H") or "0.17").strip())
    except ValueError:
        v = 0.17
    return max(0.12, min(v, 0.35))


def _find_passage_above(region: dict[str, Any], page_regions: list[dict[str, Any]] | None) -> dict[str, Any] | None:
    """영역 수동 선택에서 저장한 groupId·groupRole=passage — **같은 페이지**에서만, 문항 박스 바로 위."""
    if not page_regions:
        return None
    page = int(region.get("page") or 1)
    ry = float(region["y"])
    rx, rw = float(region["x"]), float(region["w"])
    gid = region.get("groupId")
    best: dict[str, Any] | None = None
    best_bottom = -1.0
    for r in page_regions:
        if int(r.get("page") or 1) != page:
            continue
        if (r.get("groupRole") or "") != "passage":
            continue
        if gid is not None and r.get("groupId") != gid:
            continue
        py = float(r["y"])
        ph = float(r["h"])
        bottom = py + ph
        if bottom > ry + 0.025:
            continue
        if _norm_x_overlap(rx, rw, float(r["x"]), float(r["w"])) < 0.25:
            continue
        if bottom > best_bottom:
            best_bottom = bottom
            best = r
    return best


def _mark_strip_anchor_box(
    region: dict[str, Any],
    page_regions: list[dict[str, Any]] | None = None,
) -> dict[str, float]:
    """
    채점 띠용 유효 박스.
    - 일반 문항·다른 쪽 묶음 소문항(9번 등): 문항 박스 **왼쪽 위**(ry) 번호 줄.
    - 같은 쪽에 passage가 저장돼 있고 문항 박스 **바로 아래**에 이어질 때만: 보기 아래 번호 줄.
    문항 박스 높이로 보기 위치를 추정하지 않는다.
    """
    rx = float(region["x"])
    ry = float(region["y"])
    rw = float(region["w"])
    rh = float(region["h"])
    role = (region.get("groupRole") or "").strip()

    if role == "passage":
        return {"x": rx, "y": ry, "w": rw, "h": rh}

    band = _scan_mark_top_band_frac()
    ey = ry
    eh = min(rh, max(rh * band, 0.055))

    # 저장된 보기(passage)가 **이 페이지·이 groupId**에서 문항 직전에 있을 때만 아래로 내림
    passage = _find_passage_above(region, page_regions)
    if passage is not None:
        py_end = float(passage["y"]) + float(passage["h"])
        gap = ry - py_end
        if 0 <= gap < 0.12:
            ey = max(ry, py_end - rh * 0.02)
            eh = max(rh * 0.2, (ry + rh) - ey)
            eh = min(eh, max(rh * band * 1.5, 0.055))

    pad = _scan_mark_region_pad()
    px = rw * pad
    py_up = min(eh * pad, eh * 0.06)
    py_down = eh * pad
    return {
        "x": max(0.0, rx - px),
        "y": max(ry, ey - py_up),
        "w": min(1.0 - max(0.0, rx - px), rw + 2 * px),
        "h": min(1.0 - max(ry, ey - py_up), eh + py_up + py_down),
    }


def _crop_fitz_page_norm_to_png(page: fitz.Page, box: dict[str, float], zoom: float = 2.0) -> bytes:
    rect = page.rect
    x0 = float(box["x"]) * rect.width + rect.x0
    y0 = float(box["y"]) * rect.height + rect.y0
    x1 = x0 + float(box["w"]) * rect.width
    y1 = y0 + float(box["h"]) * rect.height
    clip = fitz.Rect(x0, y0, x1, y1)
    mat = fitz.Matrix(zoom, zoom)
    pix = page.get_pixmap(matrix=mat, clip=clip, alpha=False)
    return pix.tobytes("png")


def _crop_pil_image_norm_to_png(image, box: dict[str, float]) -> bytes:
    """
    PIL.Image 에서 0~1 정규화 박스를 잘라 PNG bytes 반환.
    (워핑된 페이지에서 크롭할 때 사용)
    """
    import io

    from PIL import Image

    if image is None:
        raise ValueError("image is None")
    if not isinstance(image, Image.Image):
        raise TypeError("image must be PIL.Image")

    W, H = image.size
    x0 = int(round(float(box["x"]) * W))
    y0 = int(round(float(box["y"]) * H))
    x1 = int(round((float(box["x"]) + float(box["w"])) * W))
    y1 = int(round((float(box["y"]) + float(box["h"])) * H))
    x0 = max(0, min(W - 1, x0))
    y0 = max(0, min(H - 1, y0))
    x1 = max(x0 + 1, min(W, x1))
    y1 = max(y0 + 1, min(H, y1))

    crop = image.crop((x0, y0, x1, y1)).convert("RGB")
    buf = io.BytesIO()
    crop.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def _crop_norm_page_to_png(doc: fitz.Document, pno: int, box: dict[str, float], zoom: float = 2.0) -> bytes:
    return _crop_fitz_page_norm_to_png(doc[pno], box, zoom=zoom)


def _scan_reg_mark_warp_enabled() -> bool:
    raw = (os.environ.get("SCAN_REG_MARK_WARP") or "0").strip().lower()
    return raw in ("1", "true", "yes", "on")


def _warp_page_image_to_template_if_possible(
    page: fitz.Page,
    reg_entry: dict[str, Any] | None,
    template: dict[str, Any] | None,
    *,
    zoom: float = 2.0,
):
    """
    L자 4점(검출) → 템플릿 기대 4점으로 homography warp.
    성공 시 PIL.Image(RGB) 반환, 실패 시 None.
    """
    if not _scan_reg_mark_warp_enabled():
        return None
    if not isinstance(reg_entry, dict):
        return None

    found = reg_entry.get("found")
    expected = reg_entry.get("expected")
    if not (isinstance(found, dict) and isinstance(expected, dict)):
        return None

    keys = ["tl", "tr", "br", "bl"]
    if any(k not in found for k in keys) or any(k not in expected for k in keys):
        return None

    try:
        import cv2  # type: ignore
        import numpy as np
        from PIL import Image
        import io
    except Exception:
        return None

    # 1) 소스 페이지 렌더 → RGB 이미지
    mat = fitz.Matrix(float(zoom), float(zoom))
    pix = page.get_pixmap(matrix=mat, alpha=False)
    src_img = Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB")
    src_w, src_h = src_img.size

    # 2) 출력 크기(템플릿 pt 기준) 결정
    tpt = reg_entry.get("templatePt")
    if isinstance(tpt, (list, tuple)) and len(tpt) == 2:
        tw, th = float(tpt[0]), float(tpt[1])
    else:
        tw = float((template or {}).get("page_width") or (template or {}).get("pageWidth") or page.rect.width)
        th = float((template or {}).get("page_height") or (template or {}).get("pageHeight") or page.rect.height)
    out_w = max(1, int(round(tw * float(zoom))))
    out_h = max(1, int(round(th * float(zoom))))

    def _norm_xy(v):
        x = float(v[0])
        y = float(v[1])
        return x, y

    src_pts = np.float32([(_norm_xy(found[k])[0] * src_w, _norm_xy(found[k])[1] * src_h) for k in keys])
    dst_pts = np.float32([(_norm_xy(expected[k])[0] * out_w, _norm_xy(expected[k])[1] * out_h) for k in keys])

    Hm = cv2.getPerspectiveTransform(src_pts, dst_pts)
    src_arr = np.array(src_img)  # RGB
    warped = cv2.warpPerspective(
        src_arr,
        Hm,
        (out_w, out_h),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(255, 255, 255),
    )
    return Image.fromarray(warped, mode="RGB")


def _mark_strip_norm_from_number_span(
    span: dict[str, Any],
    region: dict[str, float],
    page_regions: list[dict[str, Any]] | None = None,
) -> dict[str, float]:
    """인쇄 문항번호 span 기준 — 번호가 잘리지 않게 띠를 번호에 맞춤."""
    into_w = _scan_mark_strip_into_region_w()
    sx, sy = float(span["x"]), float(span["y"])
    sw = max(0.012, float(span.get("w") or 0.01))
    sh = max(0.010, float(span.get("h") or 0.01))
    x0 = max(0.0, sx - 0.010)
    x1 = min(1.0, sx + sw + into_w)
    ry_top = float(region["y"])
    y0 = max(0.0, sy - 0.004)
    y0 = max(y0, ry_top - _scan_mark_strip_max_above_top_frac())
    y_floor = _mark_strip_y0_floor(region, page_regions)
    if y_floor > 0:
        y0 = max(y0, y_floor)
    strip_h = max(
        _scan_mark_strip_min_h(),
        sh * 3.5,
        float(region.get("h") or 0.1) * _scan_mark_strip_height_frac() * 0.55,
    )
    y1 = min(1.0, y0 + strip_h)
    box = {"x": x0, "y": y0, "w": max(0.008, x1 - x0), "h": max(0.008, y1 - y0)}
    return _clamp_strip_x_to_mapped(_clamp_mark_strip_box(box), region)


def _problem_mark_strip_norm(
    region: dict[str, float],
    page_regions: list[dict[str, Any]] | None = None,
) -> dict[str, float]:
    """문항 번호·채점 표시용 정규화 크롭(박스 왼쪽 여백 ~ 번호 열)."""
    anchor = _mark_strip_anchor_box(region, page_regions)
    ex = float(anchor["x"])
    ey = float(anchor["y"])
    ew = float(anchor["w"])
    eh = float(anchor["h"])
    left_pad = _scan_mark_left_page_fraction()
    into_w = _scan_mark_strip_into_region_w()
    strip_h_frac = _scan_mark_strip_height_frac()
    y_pad = _scan_mark_strip_y_pad_above_frac()
    # 번호·빨간 V는 박스 왼쪽 여백에 있는 경우가 많아, 박스 x보다 왼쪽을 넉넉히 포함
    x0 = max(0.0, ex - left_pad)
    x1 = min(1.0, max(ex + 0.02, ex - left_pad) + into_w)
    ry_top = float(region["y"])
    above_frac = _scan_mark_strip_max_above_top_frac()  # 0.025: 문항 위 갭에 찍힌 체크 포함
    y0 = max(0.0, ey - eh * y_pad)
    # 앵커 기반 y0가 너무 낮으면(문항 상단 가까이가 아니면), 위로 당긴다.
    # 이렇게 하면 문항 번호 바로 위 갭에 찍힌 선생님 체크도 포함됨.
    # (이전 문항 표시가 새어 들어오는 것은 아래 y_floor로 방지)
    if y0 > ry_top - above_frac:
        y0 = max(0.0, ry_top - above_frac)
    y_floor = _mark_strip_y0_floor(region, page_regions)
    if y_floor > 0:
        y0 = max(y0, y_floor)
    strip_h = max(eh * strip_h_frac, 0.055)
    y1 = min(1.0, y0 + strip_h)
    # 인접 문항 번호·채점표가 아래로 새지 않도록 이 문항 상단 띠 높이로 상한
    cap = float(region["y"]) + float(region.get("h") or 0.1) * max(
        _scan_mark_top_band_frac() * 1.15, 0.28
    )
    y1 = min(y1, cap)
    if y1 <= y0 + 0.012:
        y1 = min(1.0, y0 + 0.055)
    box = {"x": x0, "y": y0, "w": max(0.008, x1 - x0), "h": max(0.008, y1 - y0)}
    return _clamp_strip_x_to_mapped(_clamp_mark_strip_box(box), region)


def _problem_mark_strip_crop_png(
    doc: fitz.Document,
    pno: int,
    region: dict[str, float],
    zoom: float = 2.5,
    page_regions: list[dict[str, Any]] | None = None,
) -> bytes:
    """문항 번호 줄(박스 왼쪽 3~5% + 번호 열) — 빨간 V·√·슬래시 등 감지용."""
    return _crop_norm_page_to_png(doc, pno, _problem_mark_strip_norm(region, page_regions), zoom=zoom)


def _problem_grade_crop_norm(
    region: dict[str, Any],
    page_regions: list[dict[str, Any]] | None = None,
    mapped_box: dict[str, float] | None = None,
    mapped_mark_box: dict[str, float] | None = None,
    *,
    apply_scan_pad: bool = True,
    page_strip_model: dict[str, Any] | None = None,
    registration_aligned: bool = False,
    page: fitz.Page | None = None,
) -> dict[str, float]:
    """채점 크롭. markBox 저장 시 네모 안 색칠 감지, 없으면 번호 띠."""
    base = mapped_box if mapped_box is not None else _region_norm_box(region)
    use_mark_box = _grade_crop_use_mark_box(region)
    if use_mark_box:
        mb = mapped_mark_box
        if mb is None:
            raw_mb = _region_mark_box_norm(region)
            if raw_mb is not None and mapped_box is not None and all(
                k in region for k in ("x", "y")
            ):
                try:
                    rx = float(region["x"])
                    ry = float(region["y"])
                    mb = {
                        "x": float(mapped_box["x"]) + (float(raw_mb["x"]) - rx),
                        "y": float(mapped_box["y"]) + (float(raw_mb["y"]) - ry),
                        "w": float(raw_mb["w"]),
                        "h": float(raw_mb["h"]),
                    }
                except (KeyError, TypeError, ValueError):
                    mb = None
            elif raw_mb is not None and mapped_box is None:
                mb = raw_mb
        if mb is not None:
            out = dict(mb)
            if apply_scan_pad:
                pad = min(_scan_grade_scan_pad_frac(), 0.008)
                if pad > 0:
                    out = _expand_norm_region(out, pad)
            return out
    use_strip = _grade_crop_prefers_mark_strip(registration_aligned, region=region)
    if apply_scan_pad and _scan_grade_scan_pad_frac() > 0:
        pad = _scan_grade_scan_pad_frac()
        if use_strip:
            pad = min(pad, 0.012)
        base = _expand_norm_region(base, pad)
    if registration_aligned and not use_strip:
        return base
    if use_strip:
        fake = {**region, **base}
        strip = _problem_mark_strip_norm(fake, page_regions)
        return _clamp_strip_x_to_mapped(strip, base)
    return base


def _problem_grade_crop_png(
    doc: fitz.Document,
    pno: int,
    region: dict[str, float],
    zoom: float = 2.0,
    page_regions: list[dict[str, Any]] | None = None,
    crop_box: dict[str, float] | None = None,
    *,
    page_image=None,
) -> bytes:
    """채점 표시 감지용 크롭(문항 박스 전체 또는 번호 띠)."""
    box = crop_box if crop_box is not None else _problem_grade_crop_norm(region, page_regions)
    if page_image is not None:
        return _crop_pil_image_norm_to_png(page_image, box)
    return _crop_norm_page_to_png(doc, pno, box, zoom=zoom)


def _regions_for_grading(regions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """채점·O/X 대상: passage 제외 + markBox가 있는 문항만."""
    return [
        r
        for r in regions
        if (r.get("groupRole") or "") != "passage" and _region_mark_box_norm(r) is not None
    ]


def _regions_on_page(regions: list[dict[str, Any]], page: int) -> list[dict[str, Any]]:
    return [r for r in regions if int(r.get("page") or 1) == int(page)]


def _effective_strip_model(
    anchor_cache: dict[int, dict[str, Any]],
    reg_cache: dict[int, dict[str, Any]],
    page_num: int,
) -> dict[str, Any]:
    """
    번호 위치 기반 선형 보정 모델. 앵커는 L자 affine을 적용한 박스 기준으로 측정되므로
    (잔차 보정) L자 성공 페이지에서도 그대로 적용한다 — 균일 스케일 L자가 못 잡는
    아래쪽 비균일 세로 드리프트(예: 13·20번)를 마저 잡기 위함.
    """
    return _page_strip_model(anchor_cache, page_num)


def _collect_grade_crops_for_block(
    doc: fitz.Document,
    n: int,
    block_index: int,
    regions: list[dict[str, Any]],
    slots: list[dict[str, Any]],
    src: fitz.Document,
    template: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """한 학생 블록의 문항별 채점 크롭(Gemini 호출 없음)."""
    out: list[dict[str, Any]] = []
    b = int(block_index)
    reg_cache = _build_block_page_registration_cache(b, n, slots, doc, regions, template)
    anchor_cache = _build_block_page_anchor_offsets(
        b, n, slots, src, doc, regions, template=template, reg_cache=reg_cache
    )
    for reg in _regions_for_grading(regions):
        p_rel = int(reg.get("page") or 1) - 1
        if p_rel < 0 or p_rel >= n:
            continue
        pno = b * n + p_rel
        page_num = int(reg.get("page") or 1)
        page_regs = _regions_on_page(regions, page_num)
        strip_model = _effective_strip_model(anchor_cache, reg_cache, page_num)
        reg_aff = _registration_affine_for_page(reg_cache, page_num)
        reg_aligned = reg_aff is not None
        try:
            mapped = _grade_box_for_block_page(
                reg,
                b,
                n,
                slots,
                src,
                doc,
                apply_scan_pad=False,
                template=template,
                reg_affine=reg_aff,
                reg_cache=reg_cache,
            )
            mapped = _anchor_correct_mapped_box(mapped, strip_model, reg_aligned)
            mapped = _snap_box_top_to_heading(doc[pno], mapped, page_regs, region=reg)
            mapped_mb = _grade_mark_box_for_block_page(
                reg,
                b,
                n,
                slots,
                src,
                doc,
                apply_scan_pad=False,
                template=template,
                reg_affine=reg_aff,
                reg_cache=reg_cache,
            )
            if mapped_mb is not None:
                mapped_mb = _anchor_correct_mapped_box(mapped_mb, strip_model, reg_aligned)
            crop_box = _problem_grade_crop_norm(
                reg,
                page_regs,
                mapped_box=mapped,
                mapped_mark_box=mapped_mb,
                apply_scan_pad=True,
                page_strip_model=strip_model,
                registration_aligned=reg_aligned,
                page=doc[pno],
            )
            png = _problem_grade_crop_png(
                doc, pno, reg, page_regions=page_regs, crop_box=crop_box
            )
            use_mark_box = _grade_crop_use_mark_box(reg)
            entry: dict[str, Any] = {
                "problemNumber": _problem_base_int(reg.get("problem_number")),
                "page": int(reg.get("page") or 1),
                "cropBase64": base64.b64encode(png).decode("utf-8"),
                "stripNorm": {k: round(crop_box[k], 4) for k in ("x", "y", "w", "h")},
                "gradeCropMode": "markbox" if use_mark_box else ("strip" if _grade_crop_prefers_mark_strip(reg_aligned, region=reg) else "region"),
            }
            if all(k in reg for k in ("x", "y", "w", "h")):
                entry["regionNorm"] = {
                    k: round(mapped[k], 4) for k in ("x", "y", "w", "h")
                }
            out.append(entry)
        except Exception:
            continue
    out.sort(key=lambda x: (int(x.get("page") or 1), int(x.get("problemNumber") or 0)))
    return out


def _draw_norm_rect(
    shape: fitz.Shape,
    rect: fitz.Rect,
    box: dict[str, float],
    *,
    color: tuple[float, float, float],
    width: float,
    dashes: str | None = None,
) -> None:
    x0 = float(box["x"]) * rect.width
    y0 = float(box["y"]) * rect.height
    x1 = x0 + float(box["w"]) * rect.width
    y1 = y0 + float(box["h"]) * rect.height
    shape.draw_rect(fitz.Rect(x0, y0, x1, y1))
    if dashes:
        shape.finish(color=color, width=width, dashes=dashes)
    else:
        shape.finish(color=color, width=width)


def _page_grade_overlay_png(
    doc: fitz.Document,
    pno: int,
    regions_on_page: list[dict[str, Any]],
    slots: list[dict[str, Any]],
    block_index: int,
    n: int,
    src: fitz.Document,
    anchor_cache: dict[int, dict[str, Any]] | None = None,
    reg_cache: dict[int, dict[str, Any]] | None = None,
    template: dict[str, Any] | None = None,
    zoom: float = 1.15,
    student_name_box: dict[str, float] | None = None,
    student_number_box: dict[str, float] | None = None,
) -> bytes:
    """문항 박스(초록) + 채점 크롭(빨강) + 이름·번호 OCR 칸(파랑·보라) 페이지 PNG."""
    page = doc[pno]
    rect = page.rect
    shape = page.new_shape()
    page_num = int(regions_on_page[0].get("page") or 1) if regions_on_page else 1
    for reg in regions_on_page:
        if not all(k in reg for k in ("x", "y", "w", "h")):
            continue
        strip_model = _effective_strip_model(anchor_cache or {}, reg_cache or {}, page_num)
        reg_aff = _registration_affine_for_page(reg_cache or {}, page_num)
        reg_aligned = reg_aff is not None
        strip_preview = _grade_crop_prefers_mark_strip(reg_aligned)
        if (reg.get("groupRole") or "") == "passage":
            mapped = _grade_box_for_block_page(
                reg,
                block_index,
                n,
                slots,
                src,
                doc,
                apply_scan_pad=False,
                template=template,
                reg_affine=reg_aff,
                reg_cache=reg_cache,
            )
            mapped = _anchor_correct_mapped_box(mapped, strip_model, reg_aligned)
            _draw_norm_rect(
                shape, rect, mapped, color=(0.55, 0.45, 0.1), width=1.0, dashes="[4 3]"
            )
            continue
        mapped = _grade_box_for_block_page(
            reg,
            block_index,
            n,
            slots,
            src,
            doc,
            apply_scan_pad=False,
            template=template,
            reg_affine=reg_aff,
            reg_cache=reg_cache,
        )
        mapped = _anchor_correct_mapped_box(mapped, strip_model, reg_aligned)
        mapped = _snap_box_top_to_heading(page, mapped, regions_on_page, region=reg)
        mapped_mb = _grade_mark_box_for_block_page(
            reg,
            block_index,
            n,
            slots,
            src,
            doc,
            apply_scan_pad=False,
            template=template,
            reg_affine=reg_aff,
            reg_cache=reg_cache,
        )
        if mapped_mb is not None:
            mapped_mb = _anchor_correct_mapped_box(mapped_mb, strip_model, reg_aligned)
        crop_box = _problem_grade_crop_norm(
            reg,
            regions_on_page,
            mapped_box=mapped,
            mapped_mark_box=mapped_mb,
            apply_scan_pad=True,
            page_strip_model=strip_model,
            registration_aligned=reg_aligned,
            page=page,
        )
        if strip_preview:
            _draw_norm_rect(
                shape, rect, mapped, color=(0.1, 0.55, 0.2), width=0.9, dashes="[3 2]"
            )
        else:
            _draw_norm_rect(shape, rect, mapped, color=(0.1, 0.55, 0.2), width=1.2)
        _draw_norm_rect(
            shape, rect, crop_box, color=(0.85, 0.1, 0.1), width=1.2 if strip_preview else 1.0,
            dashes=None if strip_preview else "[3 2]",
        )
    if student_name_box and all(k in student_name_box for k in ("x", "y", "w", "h")):
        _draw_norm_rect(
            shape,
            rect,
            student_name_box,
            color=(0.05, 0.45, 0.85),
            width=1.5,
            dashes="[6 3]",
        )
    if student_number_box and all(k in student_number_box for k in ("x", "y", "w", "h")):
        _draw_norm_rect(
            shape,
            rect,
            student_number_box,
            color=(0.55, 0.15, 0.75),
            width=1.5,
            dashes="[6 3]",
        )
    shape.commit()
    mat = fitz.Matrix(zoom, zoom)
    pix = page.get_pixmap(matrix=mat, alpha=False)
    return pix.tobytes("png")


def _problem_corner_crop_png(doc: fitz.Document, pno: int, region: dict[str, float], zoom: float = 2.5) -> bytes:
    """호환 별칭 — 번호 띠 크롭과 동일."""
    return _problem_mark_strip_crop_png(doc, pno, region, zoom=zoom)


def _shrink_png_bytes(png_bytes: bytes, max_side: int = 900) -> tuple[bytes, str]:
    """PNG 바이트를 Pillow로 축소 (선택)."""
    try:
        from PIL import Image
    except ImportError:
        return png_bytes, "image/png"
    im = Image.open(io.BytesIO(png_bytes)).convert("RGB")
    w, h = im.size
    m = max(w, h)
    if m <= max_side:
        buf = io.BytesIO()
        im.save(buf, format="PNG", optimize=True)
        return buf.getvalue(), "image/png"
    scale = max_side / m
    im2 = im.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    im2.save(buf, format="PNG", optimize=True)
    return buf.getvalue(), "image/png"


def _extract_json_object(text: str) -> dict[str, Any]:
    """
    Gemini/Claude가 "JSON 한 개만"을 지키지 못하고 앞뒤로 텍스트를 붙이거나
    여러 JSON을 연속 출력하는 경우가 있다.

    - 정규식 r"\\{[\\s\\S]*\\}" 는 *가장 마지막* `}` 까지 잡아 `Extra data`를 유발한다.
    - JSONDecoder.raw_decode 로 "첫 JSON 객체"만 안전하게 파싱하고 나머지는 무시한다.
    """
    t = (text or "").strip()
    if not t:
        raise ValueError("빈 OCR 응답")

    # 코드펜스/마크다운이 끼는 경우 제거 (```json ... ```)
    t = re.sub(r"^```(?:json)?\\s*", "", t.strip(), flags=re.IGNORECASE)
    t = re.sub(r"\\s*```\\s*$", "", t.strip())

    # 첫 '{'부터 raw_decode로 파싱(뒤에 텍스트/다른 JSON이 있어도 무시)
    start = t.find("{")
    if start < 0:
        raise ValueError("JSON 객체를 찾을 수 없습니다.")
    dec = json.JSONDecoder()
    try:
        obj, _end = dec.raw_decode(t[start:])
    except json.JSONDecodeError:
        # 혹시 앞부분에 '{'가 여러 번 등장할 수 있어 재시도
        for i in range(start + 1, len(t)):
            if t[i] != "{":
                continue
            try:
                obj, _end = dec.raw_decode(t[i:])
                break
            except json.JSONDecodeError:
                obj = None
        if obj is None:
            raise
    if not isinstance(obj, dict):
        raise ValueError("JSON 최상위가 객체(dict)가 아닙니다.")
    return obj


async def _call_gemini_vision_pngs(
    api_key: str,
    images_png: list[bytes],
    user_text: str,
    *,
    max_output_tokens: int,
    max_side_per_image: int = 900,
) -> str:
    """여러 PNG(inline_data 순서) + 텍스트 프롬프트 → 모델 텍스트 응답."""
    try:
        import httpx
    except ImportError as exc:
        raise RuntimeError("httpx 패키지가 필요합니다.") from exc

    parts: list[dict[str, Any]] = []
    for raw in images_png:
        shrunk, _mime = _shrink_png_bytes(raw, max_side=max_side_per_image)
        b64 = base64.b64encode(shrunk).decode("utf-8")
        parts.append({"inline_data": {"mime_type": "image/png", "data": b64}})
    parts.append({"text": user_text})

    payload: dict[str, Any] = {
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {
            "temperature": 0.1,
            "maxOutputTokens": max_output_tokens,
            "responseMimeType": "application/json",
        },
    }
    timeout = httpx.Timeout(90.0, connect=30.0)
    models = _scan_gemini_model_candidates()
    last_fallback_code: int | None = None
    max_retries = _scan_gemini_max_retries()

    async with _gemini_api_lock:
        await _gemini_throttle_before_call()

        for model in models:
            url = f"{GEMINI_API_BASE}/{model}:generateContent?key={api_key}"
            resp = None
            for attempt in range(max_retries):
                async with httpx.AsyncClient(timeout=timeout) as client:
                    resp = await client.post(url, json=payload)
                if resp.status_code == 429 and attempt < max_retries - 1:
                    wait_s = min(30.0, 6.0 * (2**attempt))
                    print(
                        f"[scan-organize] model={model} HTTP 429 — {wait_s:.0f}s 후 재시도 "
                        f"({attempt + 1}/{max_retries})"
                    )
                    await asyncio.sleep(wait_s)
                    continue
                if resp.status_code == 503 and attempt < max_retries - 1:
                    wait_s = min(12.0, 3.0 * (2**attempt))
                    print(f"[scan-organize] model={model} HTTP 503 — {wait_s:.0f}s 후 재시도")
                    await asyncio.sleep(wait_s)
                    continue
                break

            if resp is None:
                raise RuntimeError("Gemini 스캔 정리: 응답 없음")

            if resp.status_code == 429:
                last_fallback_code = 429
                break

            if _scan_gemini_fallback_status(resp.status_code):
                last_fallback_code = resp.status_code
                continue

            if resp.status_code != 200:
                try:
                    err_txt = str(resp.json())[:240]
                except Exception:
                    err_txt = resp.text[:240]
                if resp.status_code in (400, 404):
                    print(f"[scan-organize] model={model} 거절({resp.status_code}) → 다음: {err_txt[:100]}")
                    continue
                raise ValueError(f"Gemini 스캔 정리 실패 ({resp.status_code}): {err_txt}")

            data = resp.json()
            candidates = data.get("candidates") or []
            if not candidates:
                raise ValueError(f"Gemini 응답에 candidates 없음: {str(data)[:200]}")

            text = ""
            for part in candidates[0].get("content", {}).get("parts", []) or []:
                t = part.get("text")
                if t:
                    text += t
            if (text or "").strip():
                print(f"[scan-organize] Gemini OK model={model}")
                return text.strip()

    if last_fallback_code == 429:
        raise RuntimeError(
            "Gemini API 할당량 초과(429). 1~2분 후 다시 시도하세요. "
            "채점(O/X)은 완료됐을 수 있으며, 출석번호는 결과 표에서 수동 지정할 수 있습니다."
        )
    if last_fallback_code is not None:
        raise RuntimeError(f"Gemini 스캔 정리: 일시 오류 {last_fallback_code}")
    raise RuntimeError("Gemini 스캔 정리: 사용 가능한 비전 모델이 없습니다.")


def _roster_number_to_name(roster: list[dict[str, Any]] | None) -> dict[int, str]:
    """출석번호 → 실명 (교사 기기 명단, OCR 후처리용)."""
    out: dict[int, str] = {}
    if not roster:
        return out
    for item in roster:
        name = str(item.get("name") or "").strip()
        try:
            num = int(item.get("number"))
        except (TypeError, ValueError):
            continue
        if name and num > 0:
            out[num] = name
    return out


def _normalize_person_name(name: str) -> str:
    """이름 비교용: 공백·흔한 구분자 제거."""
    s = re.sub(r"[\s·・.]+", "", str(name or "").strip())
    return s


def _names_close_enough(ocr_name: str, roster_name: str) -> bool:
    """OCR 이름이 명단 이름과 거의 같을 때만 True (한글 2자 이상)."""
    a = _normalize_person_name(ocr_name)
    b = _normalize_person_name(roster_name)
    if not a or not b:
        return False
    if a == b:
        return True
    if len(a) >= 2 and len(b) >= 2 and (a in b or b in a):
        return True
    if len(a) >= 2 and len(b) >= 2:
        return difflib.SequenceMatcher(None, a, b).ratio() >= 0.84
    return False


def _resolve_roster_student_number(
    raw_number: int | None,
    roster_map: dict[int, str],
) -> int | None:
    """
    OCR 출석번호를 명단에 있는 번호로 확정.
    - 명단에 있으면 그대로
    - 3자리 등이면 끝 1~2자리가 명단에 유일하게 맞을 때만 보정
    """
    if raw_number is None or raw_number <= 0:
        return None
    if raw_number in roster_map:
        return raw_number
    s = str(raw_number)
    hits: list[int] = []
    for width in (2, 1):
        if len(s) < width:
            continue
        tail = int(s[-width:])
        if tail in roster_map and tail not in hits:
            hits.append(tail)
    if len(hits) == 1:
        return hits[0]
    return None


def _unique_roster_match_by_name(ocr_name: str, roster_map: dict[int, str]) -> int | None:
    """번호를 못 읽었을 때 이름이 명단 학생과 유일하게 거의 일치하면 출석번호 반환."""
    if not _normalize_person_name(ocr_name):
        return None
    matched = [num for num, rname in roster_map.items() if _names_close_enough(ocr_name, rname)]
    if len(matched) == 1:
        return matched[0]
    return None


def _resolve_ocr_with_roster(ocr: dict[str, Any], roster: list[dict[str, Any]] | None) -> dict[str, Any]:
    """
    Gemini OCR 결과를 명단 기준으로 정리.
    1) 출석번호를 명단에 있는 값으로 확정
    2) 번호가 맞으면 이름은 명단에서 채움 (OCR 이름 환각 방지)
    3) 번호가 없을 때만, 이름이 명단과 거의 같고 한 명뿐이면 번호·이름 모두 명단에서 확정
    """
    roster_map = _roster_number_to_name(roster)
    out = dict(ocr)
    raw_name = str(ocr.get("studentName") or "").strip()
    raw_num = ocr.get("studentNumber")
    try:
        raw_num_i = int(raw_num) if raw_num is not None and raw_num != "" else None
    except (TypeError, ValueError):
        raw_num_i = None
    if raw_num_i is not None and raw_num_i <= 0:
        raw_num_i = None

    out["ocrNameRaw"] = raw_name
    out["ocrNumberRaw"] = raw_num_i

    if not roster_map:
        out["nameSource"] = "ocr" if raw_name else ""
        out["numberSource"] = "ocr" if raw_num_i is not None else ""
        return out

    resolved_num = _resolve_roster_student_number(raw_num_i, roster_map)

    if resolved_num is not None:
        roster_name = roster_map[resolved_num]
        out["studentNumber"] = resolved_num
        out["numberSource"] = "roster" if resolved_num != raw_num_i else "ocr"
        out["studentName"] = roster_name
        if raw_name and _names_close_enough(raw_name, roster_name):
            out["nameSource"] = "ocr+roster"
        else:
            out["nameSource"] = "roster"
            if raw_name and not _names_close_enough(raw_name, roster_name):
                out["ocrNameDiscarded"] = raw_name
        return out

    # 번호를 명단에서 확정하지 못함 — OCR 번호는 교사 수정용으로 유지
    out["studentNumber"] = raw_num_i
    out["numberSource"] = "ocr" if raw_num_i is not None else ""

    by_name = _unique_roster_match_by_name(raw_name, roster_map)
    if by_name is not None:
        out["studentNumber"] = by_name
        out["studentName"] = roster_map[by_name]
        out["numberSource"] = "roster_by_name"
        out["nameSource"] = "roster_by_name"
        return out

    # 번호·유일 이름 매칭 실패 — 명단과 확정되지 않은 OCR 이름은 비움(환각 방지)
    out["studentName"] = ""
    out["nameSource"] = ""
    if raw_name:
        out["ocrNameDiscarded"] = raw_name
    return out


def _format_roster_block(roster: list[dict[str, Any]] | None) -> str:
    """명단 후보를 프롬프트에 끼워 넣을 텍스트로 변환. 빈 명단이면 빈 문자열."""
    if not roster:
        return ""
    lines: list[str] = []
    for item in roster:
        name = str(item.get("name") or "").strip()
        try:
            num = int(item.get("number"))
        except (TypeError, ValueError):
            continue
        if not name or num <= 0:
            continue
        lines.append(f"- {num}번: {name}")
    if not lines:
        return ""
    body = "\n".join(lines)
    return (
        "\n이 학급의 학생 후보 명단(번호 → 이름):\n"
        f"{body}\n"
        "\n이름·번호 결정 규칙(엄격):\n"
        "- 이미지에 손글씨나 인쇄로 적힌 글자가 분명히 보이고, 그 글자들이 명단의 한 이름과 글자 단위로 일치할 때만 "
        "그 명단의 정확한 이름을 studentName으로 적는다.\n"
        "- 이미지가 비어 있거나 글자가 거의 안 보이거나, 보이는 글자가 명단의 어느 이름과도 분명히 일치하지 않으면 "
        "studentName은 무조건 빈 문자열(\"\")로 둔다.\n"
        "- 명단의 첫 번째 이름이나 임의의 이름을 기본값/대표값으로 고르는 것은 절대 금지한다. "
        "확신이 없으면 반드시 빈 문자열을 반환해야 한다.\n"
        "- **studentNumber를 우선** 읽는다: 이미지에 숫자가 명확히 보이고 명단의 번호와 일치할 때만 그 숫자를 적는다. "
        "보이지 않거나 확실하지 않으면 null. 두 자리를 넘는 숫자가 보이면 학년·반·번호가 함께 적힌 형태일 수 있으므로, "
        "명단에 있는 1~2자리 출석번호와 일치하는 부분만 studentNumber로 사용한다.\n"
        "- studentName은 보조: 번호를 읽었으면 이름은 비워도 된다(서버가 명단에서 채움). "
        "이름만 읽을 때는 명단과 글자가 거의 같을 때만 적는다.\n"
    )


def _scan_name_ocr_mode() -> str:
    m = (os.environ.get("SCAN_ORGANIZE_NAME_OCR_MODE") or "crop_then_header").strip().lower()
    if m in ("header", "crop", "crop_then_header"):
        return m
    return "crop_then_header"


def _has_trusted_name_number_boxes(name_src_lbl: str, num_src_lbl: str) -> bool:
    """pdf_regions·examSpecs 등으로 박스가 확정된 경우(기본값 제외)."""
    return name_src_lbl != "default" and num_src_lbl != "default"


def _crop_ocr_needs_header_fallback(ocr: dict[str, Any], prep: dict[str, Any]) -> bool:
    """좁은 칸 crop OCR이 번호를 확정하지 못했을 때 상단 띠로 재시도."""
    if prep.get("crop_error"):
        return True
    if not prep.get("name_png") and not prep.get("num_png"):
        return True
    if ocr.get("ocrError"):
        return True
    sn = ocr.get("studentNumber")
    if sn is None or sn == "":
        return True
    return False


def _scan_header_fraction() -> float:
    try:
        v = float((os.environ.get("SCAN_ORGANIZE_HEADER_FRACTION") or "0.26").strip())
    except ValueError:
        v = 0.26
    return max(0.08, min(v, 0.48))


def _scan_debug_grade_crops() -> bool:
    """개발용: SCAN_ORGANIZE_DEBUG_GRADE_CROPS=1 시 1번 블록 채점 크롭 미리보기."""
    raw = (os.environ.get("SCAN_ORGANIZE_DEBUG_GRADE_CROPS") or "0").strip().lower()
    return raw not in ("0", "false", "no", "off")


def _scan_organize_gemini_concurrency() -> int:
    """이름 OCR — 기본 1(순차). Gemini는 _gemini_api_lock 으로 동시 1건만."""
    try:
        v = int((os.environ.get("SCAN_ORGANIZE_GEMINI_CONCURRENCY") or "1").strip())
    except ValueError:
        v = 1
    return max(1, min(v, 2))


def _scan_grade_engine() -> str:
    """cv=빨간펜 픽셀(빠름·기본), gemini=비전 AI(느림·429 위험)."""
    raw = (os.environ.get("SCAN_ORGANIZE_GRADE_ENGINE") or "cv").strip().lower()
    if raw in ("gemini", "ai", "vision"):
        return "gemini"
    return "cv"


def _scan_grade_cv_workers() -> int:
    try:
        v = int((os.environ.get("SCAN_ORGANIZE_GRADE_CV_WORKERS") or "8").strip())
    except ValueError:
        v = 8
    return max(2, min(v, 16))


def _strip_analyze_roi_fracs() -> tuple[float, float]:
    """번호 띠 크롭 중 실제 O/X 판정에 쓰는 좌상단 ROI(가로·세로 비율).
    가로: 번호 오른쪽까지 체크가 붙는 경우를 고려해 0.65까지 허용.
          (인쇄 빨강 도형은 strip이 좁게 잘려 있어 ROI 안에 안 들어옴)
    세로: 번호 줄만 보면 충분히 확인 가능하므로 상단 55%만.
    """
    try:
        wf = float((os.environ.get("SCAN_ORGANIZE_MARK_STRIP_ANALYZE_W_FRAC") or "0.65").strip())
    except ValueError:
        wf = 0.65
    try:
        hf = float((os.environ.get("SCAN_ORGANIZE_MARK_STRIP_ANALYZE_H_FRAC") or "0.55").strip())
    except ValueError:
        hf = 0.55
    return max(0.40, min(wf, 0.80)), max(0.32, min(hf, 0.68))


def _strip_analyze_roi(arr):
    """번호 줄·왼쪽 여백만 — 아래 인쇄 도형·오른쪽 표는 제외."""
    import numpy as np

    h, w = arr.shape[:2]
    if h < 4 or w < 4:
        return arr
    wf, hf = _strip_analyze_roi_fracs()
    cw = max(20, int(w * wf))
    ch = max(14, int(h * hf))
    return np.asarray(arr[:ch, :cw], dtype=arr.dtype)


def _detect_handwritten_red_components(arr) -> bool:
    """
    연결 요소로 '손글씨 빨간펜'만 인정. 인쇄 빨간 도형(큰 면·꽉 찬 색칠)은 제외.
    - ROI 가장자리에 닿는 컴포넌트(인쇄 도형이 strip 경계로 잘린 조각)는 제외.
    - 최소 ratio 조건으로 매우 적은 인쇄 잉크 조각을 배제.
    """
    try:
        import cv2  # type: ignore
        import numpy as np
    except Exception:
        return False

    roi = _strip_analyze_roi(arr)
    mask = (_red_pen_mask(roi).astype(np.uint8)) * 255
    h, w = mask.shape[:2]
    if h < 6 or w < 8:
        return False
    try:
        nlab, labels, stats, cents = cv2.connectedComponentsWithStats(mask, connectivity=8)
    except Exception:
        return False
    roi_area = float(h * w)
    # 손글씨 표시 최소 면적 비율: 너무 적으면 인쇄 흔적이나 잡음
    MIN_RATIO = 0.0018
    for lab in range(1, nlab):
        x, y, bw, bh, area = stats[lab]
        if area < 18:
            continue
        bbox_area = int(bw) * int(bh)
        if bbox_area <= 0:
            continue
        ratio = area / roi_area
        # 너무 적은 픽셀 → 인쇄 잉크 흔적
        if ratio < MIN_RATIO:
            continue
        bbox_frac = bbox_area / roi_area
        fill = float(area) / float(bbox_area)
        # 인쇄 도형(크고 꽉 찬 면)
        if bbox_frac > 0.070 or area > 7000:
            continue
        if fill > 0.52:
            continue
        # ROI 가장자리(오른쪽·아래)에 닿는 컴포넌트 = 인쇄 도형이 경계로 잘린 조각
        if int(x) + int(bw) >= w - 1:
            continue
        if int(y) + int(bh) >= h - 1:
            continue
        # 너무 넓은 수평 덩어리(인쇄 선/표 등)
        if bw > w * 0.58 and fill > 0.28:
            continue
        return True
    return False


def _red_pen_mask(arr):
    r = arr[..., 0]
    g = arr[..., 1]
    b = arr[..., 2]
    # NOTE:
    # - 실제 채점은 '진한 빨강'만 쓰지 않고, 분홍/주황/연한 빨강 등 스캔·조명에 따라 색이 크게 흔들린다.
    # - 너무 엄격하면 7번처럼 가는 V/체크가 축소(thumbnail) 과정에서 사라져 누락되므로,
    #   색 마스크는 넉넉히 잡고, 이후 bbox/ratio 필터로 오탐을 줄인다.
    red = (r >= 120) & (r - g >= 18) & (r - b >= 18)
    orange = (r >= 165) & (g >= 70) & (g <= 210) & (b <= 130) & (r - b >= 45)
    pink = (r >= 135) & (b >= 70) & (r - g >= 14) & (r - b >= 8)
    return red | orange | pink


def _dark_ink_mask(arr):
    """
    검정펜/연필/짙은 잉크 마스크.
    - 채점 표시가 '빨강'이 아닐 수 있어(검정 X, /, V, √ 등) 보조 판정으로 사용한다.
    - 인쇄 글자(문항 번호/기호)도 검정이므로, 이후 bbox/ratio/밀도 필터로 과도한 오탐을 억제한다.
    """
    import numpy as np

    # luminance (sRGB)
    r = arr[..., 0].astype(np.float32)
    g = arr[..., 1].astype(np.float32)
    b = arr[..., 2].astype(np.float32)
    gray = (0.299 * r + 0.587 * g + 0.114 * b).astype(np.float32)

    # "진한" 픽셀만: 너무 밝으면 종이/인쇄 회색과 섞여 오탐이 커진다.
    # 스캔 밝기/대비 편차를 위해 퍼센타일 기반으로 보정하되 상한(<=92)로 고정.
    try:
        p = float(np.percentile(gray, 10))
    except Exception:
        p = 80.0
    thr = min(92.0, max(48.0, p))
    return gray <= thr


def _mark_box_inner_roi(arr, border_frac: float = 0.22):
    """인쇄 테두리를 제외한 네모 내부."""
    import numpy as np

    h, w = arr.shape[:2]
    if h < 6 or w < 6:
        return arr
    m = max(0.12, min(float(border_frac), 0.35))
    y0, y1 = int(h * m), max(int(h * m) + 1, int(h * (1.0 - m)))
    x0, x1 = int(w * m), max(int(w * m) + 1, int(w * (1.0 - m)))
    if y1 <= y0 or x1 <= x0:
        return arr
    return np.asarray(arr[y0:y1, x0:x1], dtype=arr.dtype)


def _inner_dark_ratio(arr, *, lum_thr: float = 195.0, border_frac: float = 0.22) -> float:
    """네모 내부(테두리 제외) 어두운 픽셀 비율."""
    import numpy as np

    inner = _mark_box_inner_roi(arr, border_frac)
    if inner.size == 0:
        return 0.0
    if inner.ndim == 2:
        gray = inner.astype(np.float32)
    else:
        gray = (
            0.299 * inner[..., 0].astype(np.float32)
            + 0.587 * inner[..., 1].astype(np.float32)
            + 0.114 * inner[..., 2].astype(np.float32)
        )
    return float((gray < lum_thr).mean())


def _inner_red_ratio(arr, border_frac: float = 0.22) -> float:
    import numpy as np

    inner = _mark_box_inner_roi(arr, border_frac)
    if inner.size == 0 or inner.ndim < 3:
        return 0.0
    mask = _red_pen_mask(inner.astype(np.int16))
    return float(mask.mean())


def _inner_red_bbox_fill(arr, border_frac: float = 0.22) -> tuple[float, float]:
    """(내부 빨강 비율, 빨강 픽셀 bbox 대비 채움도). 가는 √/V는 fill이 낮다."""
    import numpy as np

    inner = _mark_box_inner_roi(arr, border_frac)
    if inner.size == 0 or inner.ndim < 3:
        return 0.0, 0.0
    mask = _red_pen_mask(inner.astype(np.int16))
    count = int(mask.sum())
    if count < 6:
        return float(mask.mean()), 0.0
    ys, xs = np.nonzero(mask)
    ba = (int(xs.max()) - int(xs.min()) + 1) * (int(ys.max()) - int(ys.min()) + 1)
    return float(mask.mean()), count / max(float(ba), 1.0)


def _detect_filled_mark_box_png(
    png_bytes: bytes,
    tpl_png_bytes: bytes | None = None,
) -> bool:
    """
    채점 네모(markBox) 안 **색칠·채움** 여부. True=틀림(표시 있음).
    빨간펜 V/체크가 아니라 네모 칸 전체를 색칠한 경우를 감지한다.
    """
    try:
        from PIL import Image
        import numpy as np
    except ImportError:
        return False
    if not png_bytes:
        return False
    try:
        im = Image.open(io.BytesIO(png_bytes)).convert("RGB")
    except Exception:
        return False
    im.thumbnail((480, 480), Image.Resampling.BILINEAR)
    arr = np.asarray(im, dtype=np.uint8)
    if arr.size == 0:
        return False

    scan_dark = _inner_dark_ratio(arr)
    scan_red = _inner_red_ratio(arr)
    _, scan_red_fill = _inner_red_bbox_fill(arr)

    tpl_dark = 0.0
    tpl_red = 0.0
    tpl_red_fill = 0.0
    if tpl_png_bytes:
        try:
            tim = Image.open(io.BytesIO(tpl_png_bytes)).convert("RGB")
            tim.thumbnail((480, 480), Image.Resampling.BILINEAR)
            tarr = np.asarray(tim, dtype=np.uint8)
            tpl_dark = _inner_dark_ratio(tarr)
            tpl_red = _inner_red_ratio(tarr)
            _, tpl_red_fill = _inner_red_bbox_fill(tarr)
        except Exception:
            tpl_dark = 0.0
            tpl_red = 0.0
            tpl_red_fill = 0.0

    delta_dark = scan_dark - tpl_dark
    delta_red = scan_red - tpl_red
    delta_red_fill = scan_red_fill - tpl_red_fill

    # 템플릿 대비 내부가 눈에 띄게 어두워짐(연필·색연필·색칠)
    if delta_dark >= 0.07 and scan_dark >= 0.13:
        return True
    # 빨간 √/V(맞음 표시)는 가늘어 fill이 낮음 — 네모 색칠(틀림)만 잡는다
    if delta_red >= 0.10 and scan_red >= 0.14 and (
        scan_red_fill >= 0.38 or delta_red_fill >= 0.22 or scan_red >= 0.24
    ):
        return True
    # 템플릿 없을 때 절대 임계
    if tpl_png_bytes is None:
        if scan_dark >= 0.22:
            return True
        if scan_red >= 0.20 and scan_red_fill >= 0.35:
            return True
    return False


def _mark_box_red_fill_wrong(
    scan_arr: "np.ndarray",
    tpl_arr: "np.ndarray",
    scan_box: dict[str, float],
    tpl_box: dict[str, float] | None = None,
) -> bool:
    """
    채점 네모(markBox) — 빈 시험지 대비 **빨간 색연필** 표시(색칠·V 등) 여부.
    True = 틀림, False = 맞음(비어 있음).
    scan_box: 스캔 페이지 정규화 좌표, tpl_box: 템플릿 페이지 정규화 좌표.
    """
    try:
        import numpy as np
    except ImportError:
        return False

    pair = _diff_crop_arrays(scan_arr, tpl_arr, scan_box, tpl_box)
    if pair is None:
        return False
    scan_crop, tpl_crop = pair

    scan_inner = _mark_box_inner_roi(scan_crop.astype(np.int16))
    tpl_inner = _mark_box_inner_roi(tpl_crop.astype(np.int16))
    if scan_inner.size == 0 or scan_inner.ndim < 3:
        return False

    roi_area = float(scan_inner.shape[0] * scan_inner.shape[1])
    if roi_area <= 0:
        return False

    scan_red = _inner_red_ratio(scan_inner)
    tpl_red = _inner_red_ratio(tpl_inner)
    _, scan_fill = _inner_red_bbox_fill(scan_inner)
    _, tpl_fill = _inner_red_bbox_fill(tpl_inner)
    delta_red = scan_red - tpl_red
    delta_fill = scan_fill - tpl_fill
    # 색칠·굵은 V 모두: 템플릿 대비 빨간 비율·채움도 증가
    if delta_red >= 0.035 and scan_red >= 0.06 and (
        delta_fill >= 0.06 or scan_fill >= 0.10 or delta_red >= 0.07
    ):
        return True

    scan_f = scan_inner.astype(np.float32)
    tpl_f = tpl_inner.astype(np.float32)
    scan_g = 0.299 * scan_f[..., 0] + 0.587 * scan_f[..., 1] + 0.114 * scan_f[..., 2]
    tpl_g = 0.299 * tpl_f[..., 0] + 0.587 * tpl_f[..., 1] + 0.114 * tpl_f[..., 2]
    diff_mask = (tpl_g - scan_g) >= 9.0
    red_mask = _red_pen_mask(scan_inner)
    new_red = diff_mask & red_mask
    count = int(new_red.sum())
    min_px = max(8, int(roi_area * 0.003))
    if count >= min_px and (count / roi_area) >= 0.008:
        return True

    return False


def _diff_mark_box_filled(
    scan_arr: "np.ndarray",
    tpl_arr: "np.ndarray",
    box: dict[str, float],
    tpl_box: dict[str, float] | None = None,
) -> bool:
    """호환 별칭 — markBox 빨간 색연필 diff."""
    return _mark_box_red_fill_wrong(scan_arr, tpl_arr, box, tpl_box)


def _grade_markbox_items_sync(
    tpl_pdf_path: Path,
    items: list[dict[str, Any]],
    scan_page_arr_cache: dict[int, Any],
    zoom: float = 2.0,
) -> list[bool | None]:
    """문항별 markBox diff. None=정렬·렌더 실패."""
    marks: list[bool | None] = []
    for item in items:
        pno = int(item["pno"])
        tpl_idx = int(item["tpl_page_idx"])
        scan_box = item.get("scan_box") or item.get("crop_box")
        tpl_box = item.get("tpl_box") or scan_box
        if not isinstance(scan_box, dict):
            marks.append(None)
            continue
        s_arr = scan_page_arr_cache.get(pno)
        t_arr = _get_template_page_array(tpl_pdf_path, tpl_idx, zoom)
        if s_arr is None or t_arr is None:
            marks.append(None)
            continue
        try:
            marks.append(_mark_box_red_fill_wrong(s_arr, t_arr, scan_box, tpl_box))
        except Exception:
            marks.append(None)
    return marks


def _pil_rgb_to_png_bytes(arr) -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.fromarray(arr).save(buf, format="PNG")
    return buf.getvalue()


def _detect_ink_grade_mark(mask, *, aspect: float) -> bool:
    """
    색 마스크(빨강/검정 공통) → 채점 표식 여부 판정.
    True=표시 있음.
    """
    import numpy as np

    count = int(mask.sum())
    if count <= 0:
        return False

    h_m, w_m = mask.shape
    page_area = float(mask.size)
    ratio = count / page_area

    # 아주 희박하면 표식으로 보기 어렵다.
    if ratio < 0.00075 and count < 55:
        return False

    ys, xs = np.nonzero(mask)
    x0, x1 = int(xs.min()), int(xs.max())
    y0, y1 = int(ys.min()), int(ys.max())
    bbox_area = (x1 - x0 + 1) * (y1 - y0 + 1)
    bbox_frac = bbox_area / page_area
    fill = count / max(bbox_area, 1)

    # 너무 크면(도형/인쇄 영역 전체) 표식으로 보기 어렵다.
    if bbox_frac > 0.18 or ratio > 0.075:
        return False

    # 너무 꽉 찬 덩어리는 '색칠/인쇄 도형' 가능성이 커서 제외
    if fill > 0.70 and bbox_frac > 0.01:
        return False

    # 띠 크롭은 왼쪽(번호 주변) 위주여야 한다. 다만 너무 강하면 누락이 생겨 약하게만 적용.
    if aspect >= 1.02 and w_m > 10:
        left_n = int(w_m * 0.55)
        left_count = int(mask[:, :left_n].sum())
        if left_count < count * 0.20 and count < 140:
            return False

    # 가늘고 작은 표식(특히 /, √)은 bbox_frac가 작을 수 있어 너무 과하게 자르지 않는다.
    if bbox_frac < 0.00035 and count < 65:
        return False

    # 인쇄 잉크 조각(비율이 매우 낮음) 배제 — 오리지널 로직의 ratio 하한 유지
    if ratio < 0.00145 and count < 70:
        return False

    return True


def _template_pdf_path_for_record(template: dict[str, Any] | None) -> Path | None:
    """pdf_regions.json 레코드에서 저장된 원본 시험지 PDF 경로를 반환."""
    if not isinstance(template, dict):
        return None
    rel = template.get("template_pdf")
    if not rel:
        return None
    base = REGIONS_FILE.parent
    p = (base / str(rel)).resolve()
    if p.exists() and p.suffix.lower() == ".pdf":
        return p
    return None


def _resolve_template_pdf_path(template: dict[str, Any]) -> Path | None:
    """template_json 또는 pdf_regions 레코드에서 빈 시험지 PDF 경로."""
    direct = _template_pdf_path_for_record(template)
    if direct is not None:
        return direct
    records = (_load_regions().get("records") or [])
    pdf_name = str(template.get("pdf_name") or "").strip()
    exam_name = str(template.get("exam_name") or "").strip()
    rec = None
    if pdf_name:
        rec = _pick_best_record_for_pdf(records, pdf_name)
    if rec is None and exam_name:
        rec = _pick_best_record_for_exam(records, exam_name)
    if rec is not None:
        return _template_pdf_path_for_record(rec)
    return None


def _render_template_page_to_array(
    template_pdf_path: Path,
    page_index: int,
    zoom: float,
) -> "np.ndarray | None":
    """원본 시험지 PDF 특정 페이지를 지정 zoom으로 렌더링해 RGB numpy 배열 반환."""
    try:
        import numpy as np
        from PIL import Image
    except ImportError:
        return None
    try:
        tdoc = fitz.open(str(template_pdf_path))
        if page_index < 0 or page_index >= len(tdoc):
            return None
        mat = fitz.Matrix(float(zoom), float(zoom))
        pix = tdoc[page_index].get_pixmap(matrix=mat, alpha=False)
        arr = np.asarray(
            Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB"),
            dtype=np.uint8,
        )
        return arr
    except Exception:
        return None


def _diff_crop_arrays(
    scan_arr: "np.ndarray",
    tpl_arr: "np.ndarray",
    scan_box: dict[str, float],
    tpl_box: dict[str, float] | None = None,
) -> "tuple[np.ndarray, np.ndarray] | None":
    """scan/tpl 전체 배열에서 각각 box 영역만 크롭하여 같은 크기로 맞춰 반환."""
    try:
        import numpy as np
        from PIL import Image
    except ImportError:
        return None

    tpl_box = tpl_box if tpl_box is not None else scan_box
    sh, sw = scan_arr.shape[:2]
    th, tw = tpl_arr.shape[:2]

    x0 = max(0, int(float(scan_box.get("x", 0)) * sw))
    y0 = max(0, int(float(scan_box.get("y", 0)) * sh))
    x1 = min(sw, int((float(scan_box.get("x", 0)) + float(scan_box.get("w", 1))) * sw))
    y1 = min(sh, int((float(scan_box.get("y", 0)) + float(scan_box.get("h", 1))) * sh))
    if x1 <= x0 or y1 <= y0:
        return None

    scan_crop = scan_arr[y0:y1, x0:x1]

    tx0 = max(0, int(float(tpl_box.get("x", 0)) * tw))
    ty0 = max(0, int(float(tpl_box.get("y", 0)) * th))
    tx1 = min(tw, int((float(tpl_box.get("x", 0)) + float(tpl_box.get("w", 1))) * tw))
    ty1 = min(th, int((float(tpl_box.get("y", 0)) + float(tpl_box.get("h", 1))) * th))
    if tx1 <= tx0 or ty1 <= ty0:
        return None

    tpl_crop = tpl_arr[ty0:ty1, tx0:tx1]

    sc_h, sc_w = scan_crop.shape[:2]
    tc_h, tc_w = tpl_crop.shape[:2]
    if sc_h != tc_h or sc_w != tc_w:
        try:
            tpl_crop = np.asarray(
                Image.fromarray(tpl_crop).resize((sc_w, sc_h), Image.Resampling.BILINEAR),
                dtype=np.uint8,
            )
        except Exception:
            return None

    return scan_crop, tpl_crop


def _diff_has_new_ink(
    scan_arr: "np.ndarray",
    tpl_arr: "np.ndarray",
    box: dict[str, float],
    *,
    diff_threshold: int = 28,
    fill_cap: float = 0.55,
) -> bool:
    """
    스캔과 원본 템플릿 차분 → 새로 생긴 잉크가 **빨간색 계열**인지 판정.

    두 단계 필터:
      1. diff: 원본과 스캔의 차분으로 새 잉크(학생·선생님 손글씨) 위치를 추출.
              → 인쇄된 내용(빨간 도형 포함)은 양쪽에 같이 있으므로 차분이 0.
      2. 색상: diff에서 찾은 새 잉크 픽셀 중 빨간/주황/분홍 계열만 선택.
              → 학생 연필 필기(회색/검정)는 제외되고 선생님 빨간 체크만 남음.

    선생님이 어느 위치에 체크해도, 색연필이 연하게 찍혀도 동작.
    학생 필기가 아무리 많아도 색으로 자동 분리.
    """
    try:
        import numpy as np
    except ImportError:
        return False

    pair = _diff_crop_arrays(scan_arr, tpl_arr, box)
    if pair is None:
        return False
    scan_crop, tpl_crop = pair
    sc_h, sc_w = scan_crop.shape[:2]
    roi_area = float(sc_h * sc_w)

    # 1단계: 새 잉크 마스크 (스캔이 템플릿보다 어두운 픽셀)
    scan_f = scan_crop.astype(np.float32)
    tpl_f = tpl_crop.astype(np.float32)
    scan_g = 0.299 * scan_f[..., 0] + 0.587 * scan_f[..., 1] + 0.114 * scan_f[..., 2]
    tpl_g = 0.299 * tpl_f[..., 0] + 0.587 * tpl_f[..., 1] + 0.114 * tpl_f[..., 2]
    new_ink_mask = (tpl_g - scan_g) >= float(diff_threshold)  # True = 새 잉크

    # 전체 새 잉크가 너무 많으면 정렬 오류 등 오탐
    if new_ink_mask.sum() / max(roi_area, 1.0) > fill_cap:
        return False

    # 2단계: 새 잉크 중 빨강/주황/분홍 계열만 (선생님 색연필)
    # 학생 연필(회색/검정)은 R≈G≈B 이므로 자연스럽게 제외됨
    r = scan_crop[..., 0].astype(np.int16)
    g = scan_crop[..., 1].astype(np.int16)
    b = scan_crop[..., 2].astype(np.int16)
    # _red_pen_mask와 동일 조건 (scan crop에서 직접)
    red   = (r >= 120) & (r - g >= 18) & (r - b >= 18)
    orange = (r >= 165) & (g >= 70) & (g <= 210) & (b <= 130) & (r - b >= 45)
    pink  = (r >= 135) & (b >= 70) & (r - g >= 14) & (r - b >= 8)
    color_mask = red | orange | pink

    # diff AND color: "새로 생긴 빨간 픽셀"만
    teacher_check = new_ink_mask & color_mask
    count = int(teacher_check.sum())

    # 최소 픽셀 수 (색연필은 얇으므로 낮게 설정)
    min_px = max(12, int(roi_area * 0.0006))
    return count >= min_px


# 페이지별 템플릿 렌더 캐시 (process 한 번 안에서만 재사용)
_tpl_render_cache: dict[str, dict[int, "np.ndarray"]] = {}


def _get_template_page_array(
    template_pdf_path: Path,
    page_index: int,
    zoom: float,
) -> "np.ndarray | None":
    key = str(template_pdf_path)
    if key not in _tpl_render_cache:
        _tpl_render_cache[key] = {}
    if page_index not in _tpl_render_cache[key]:
        arr = _render_template_page_to_array(template_pdf_path, page_index, zoom)
        _tpl_render_cache[key][page_index] = arr  # type: ignore[assignment]
    return _tpl_render_cache[key].get(page_index)


def _clear_template_render_cache() -> None:
    _tpl_render_cache.clear()


def _template_mark_box_png(
    tpl_pdf_path: Path,
    page_index: int,
    region: dict[str, Any],
    zoom: float = 2.5,
) -> bytes | None:
    """원본 시험지 PDF에서 markBox 영역 크롭(채점 네모 비교용)."""
    mb = _region_mark_box_norm(region)
    if mb is None:
        return None
    arr = _get_template_page_array(tpl_pdf_path, page_index, zoom)
    if arr is None:
        return None
    try:
        return _crop_pil_image_norm_to_png(arr, mb)
    except Exception:
        return None


def _detect_red_grade_mark_png(png_bytes: bytes, tpl_png_bytes: bytes | None = None) -> bool:
    """
    채점 크롭에 **손글씨** 표시가 있는지 로컬 판정. True=틀림(표시 있음).
    - markBox(정사각형에 가까움): 네모 안 색칠·채움 감지
    - strip(가로로 긴 띠): 빨간펜 V/√/슬래시 감지
    """
    try:
        from PIL import Image
        import numpy as np
    except ImportError:
        return False
    if not png_bytes:
        return False
    # markBox+템플릿 비교 경로 — 가로가 약간 긴 네모도 번호 띠(strip)로 오인하지 않음
    if tpl_png_bytes is not None:
        return _detect_filled_mark_box_png(png_bytes, tpl_png_bytes)
    try:
        im = Image.open(io.BytesIO(png_bytes)).convert("RGB")
    except Exception:
        return False
    # 얇은 V/체크(√)는 너무 작게 줄이면 픽셀이 사라진다.
    im.thumbnail((640, 640), Image.Resampling.BILINEAR)
    w, h = im.size
    arr = np.asarray(im, dtype=np.int16)
    if arr.size == 0:
        return False
    aspect = float(w) / max(float(h), 1.0)
    # 번호 띠만 strip(가로로 긴 밴드). 채점 네모(~1.0~1.5)는 markBox 색칠 감지
    is_strip = aspect >= 2.25

    if not is_strip:
        return _detect_filled_mark_box_png(png_bytes, tpl_png_bytes)

    # 번호 띠: 오른쪽 가장자리(인쇄 빨간 도형이 strip 경계로 잘린 조각)를 제외
    try:
        cut_frac = float(
            (os.environ.get("SCAN_ORGANIZE_MARK_STRIP_ANALYZE_W_FRAC") or "0.92").strip()
        )
    except ValueError:
        cut_frac = 0.92
    cut = max(24, int(w * cut_frac))
    arr = arr[:, :cut]
    w = arr.shape[1]

    red_mask = _red_pen_mask(arr)
    count = int(red_mask.sum())
    if count < 18:
        return False

    h_m, w_m = red_mask.shape
    page_area = float(red_mask.size)
    ratio = count / page_area
    ys, xs = np.nonzero(red_mask)
    x0_r, x1_r = int(xs.min()), int(xs.max())
    y0_r, y1_r = int(ys.min()), int(ys.max())
    bbox_area = (x1_r - x0_r + 1) * (y1_r - y0_r + 1)
    bbox_frac = bbox_area / page_area
    fill = count / max(bbox_area, 1)

    # 인쇄 도형: bbox가 크고 꽉 찬 덩어리
    if bbox_frac > 0.13 or fill > 0.58 or ratio > 0.042:
        return False

    # 번호 띠: 표시는 왼쪽(번호 근처)에 있어야 한다.
    # 오른쪽 끝에만 몰린 픽셀은 인접 문항 표시나 인쇄 내용일 가능성
    if is_strip and w_m > 8:
        left_n = int(w_m * 0.52)
        left_count = int(red_mask[:, :left_n].sum())
        if left_count < count * 0.35 and count < 110:
            return False
        right_n = max(1, w_m - int(w_m * 0.17))
        right_count = int(red_mask[:, right_n:].sum())
        right_ratio = right_count / page_area
        if right_ratio > 0.0022 and ratio < 0.007:
            return False

    if bbox_frac < 0.00055 and count < 52:
        return False

    return ratio >= 0.00145 or (count >= 70 and bbox_frac <= 0.11)


def _grade_corners_cv_sync(
    corner_pngs: list[bytes],
    tpl_pngs: list[bytes | None] | None = None,
) -> list[bool]:
    if not corner_pngs:
        return []
    tpls = tpl_pngs if tpl_pngs is not None else [None] * len(corner_pngs)
    if len(tpls) < len(corner_pngs):
        tpls = list(tpls) + [None] * (len(corner_pngs) - len(tpls))
    workers = min(_scan_grade_cv_workers(), len(corner_pngs))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        return list(pool.map(_detect_red_grade_mark_png, corner_pngs, tpls))


def _scan_grade_batch_size() -> int:
    """학생 1명당 채점 API 호출에 넣을 문항 이미지 수(문항 20개 → 2~3회로 분할)."""
    try:
        v = int((os.environ.get("SCAN_ORGANIZE_GRADE_BATCH_SIZE") or "8").strip())
    except ValueError:
        v = 8
    return max(4, min(v, 12))


async def _ocr_block_limited(
    sem: asyncio.Semaphore,
    name_png: bytes,
    num_png: bytes,
    api_key: str,
    roster: list[dict[str, Any]] | None,
) -> dict[str, Any]:
    async with sem:
        try:
            return await _ocr_name_number(name_png, num_png, api_key, roster)
        except Exception as exc:
            traceback.print_exc()
            return {"studentName": "", "studentNumber": None, "ocrError": str(exc)}


async def _ocr_header_limited(
    header_png: bytes,
    api_key: str,
    roster: list[dict[str, Any]] | None,
    layout_hint: str,
) -> dict[str, Any]:
    try:
        return await _ocr_header_name_number(header_png, api_key, roster, layout_hint)
    except RuntimeError as exc:
        if "429" in str(exc):
            print(f"[scan-organize] 이름 OCR 429 — 이 학생은 출석번호 수동 지정: {exc}")
            return _ocr_soft_fail(exc)
        traceback.print_exc()
        return _ocr_soft_fail(exc)
    except Exception as exc:
        traceback.print_exc()
        return _ocr_soft_fail(exc)


async def _grade_block_cv(
    corner_pngs: list[bytes],
    tpl_pngs: list[bytes | None] | None = None,
) -> list[bool]:
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _grade_corners_cv_sync, corner_pngs, tpl_pngs)


async def _grade_block_limited(
    sem: asyncio.Semaphore,
    corner_pngs: list[bytes],
    prob_nums: list[int],
    api_key: str,
    block_index_one_based: int,
    tpl_pngs: list[bytes | None] | None = None,
) -> tuple[list[bool] | None, str | None]:
    if not corner_pngs:
        return [], None
    if _scan_grade_engine() == "cv":
        try:
            marks = await _grade_block_cv(corner_pngs, tpl_pngs)
            return marks, None
        except Exception as exc:
            traceback.print_exc()
            return None, f"블록 {block_index_one_based} 로컬 채점 오류: {exc}"
    async with sem:
        try:
            marks = await _grade_corners(corner_pngs, prob_nums, api_key)
            return marks, None
        except Exception as exc:
            traceback.print_exc()
            msg = str(exc)
            if "429" in msg:
                msg = f"블록 {block_index_one_based} — Gemini 할당량 초과(429). 채점 미확정"
            else:
                msg = f"블록 {block_index_one_based} 채점 AI 오류: {exc}"
            return None, msg


async def _ocr_header_name_number(
    header_png: bytes,
    api_key: str,
    roster: list[dict[str, Any]] | None = None,
    layout_hint: str = "",
) -> dict[str, Any]:
    """페이지 상단 띠(전체 너비) 한 장으로 이름·출석번호 동시 인식 — 좁은 크롭 좌표 오차에 강함."""
    roster_block = _format_roster_block(roster)
    hint = ""
    if (layout_hint or "").strip():
        hint = f"\n선생님이 원본 시험지에서 지정한 대략 위치(스캔과 어긋날 수 있음): {layout_hint.strip()}\n"
    prompt = (
        "이 이미지는 시험지 **한 장의 맨 위쪽(머리글 영역)**만 잘라 낸 것이다. "
        "학생 **이름**(한글)과 **출석번호**(숫자)를 찾아라. "
        "시험지에 **인쇄된** 이름·번호는 보통 **일반(굵지 않은) 고딕체**이며, 획이 붙어 보여도 "
        "한글 자모·숫자를 구분해 읽어라. 인쇄된 학교명·학년·문항 번호는 학생 이름이 아니다.\n"
        f"{roster_block}{hint}"
        "반드시 JSON 한 개만 출력한다. 다른 텍스트 금지.\n"
        "출력 형식:\n"
        '{"studentName":"읽은 이름 또는 빈 문자열","studentNumber":정수 또는 null}\n'
        "\n"
        "- studentNumber는 출석번호 숫자만. 읽을 수 없으면 null.\n"
        "- 이름을 확신할 수 없으면 studentName은 \"\".\n"
    )
    text = await _call_gemini_vision_pngs(
        api_key, [header_png], prompt, max_output_tokens=400, max_side_per_image=720
    )
    data = _extract_json_object(text)
    sn = data.get("studentNumber")
    if sn is not None and sn != "":
        try:
            sn = int(sn)
        except (TypeError, ValueError):
            sn = None
    else:
        sn = None
    return {"studentName": str(data.get("studentName") or "").strip(), "studentNumber": sn}


async def _ocr_name_number(
    name_png: bytes,
    num_png: bytes,
    api_key: str,
    roster: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    roster_block = _format_roster_block(roster)
    prompt = (
        "두 이미지는 시험지의 이름 칸(첫 번째)과 출석번호 칸(두 번째)이다.\n"
        "인쇄된 글씨는 **일반(굵지 않은) 고딕체**일 수 있다. 획이 붙어 보여도 한글·숫자를 "
        "정확히 구분해 읽어라. 반드시 JSON 한 개만 출력한다. 다른 텍스트 금지.\n"
        f"{roster_block}\n"
        "출력 형식:\n"
        '{"studentName":"읽은 이름 또는 빈 문자열","studentNumber":정수 또는 null}\n'
        "\n"
        "- studentNumber는 숫자만. 읽을 수 없으면 null.\n"
        "- 이름을 확신할 수 없으면 studentName은 \"\".\n"
    )
    text = await _call_gemini_vision_pngs(
        api_key, [name_png, num_png], prompt, max_output_tokens=300, max_side_per_image=1024
    )
    data = _extract_json_object(text)
    sn = data.get("studentNumber")
    if sn is not None and sn != "":
        try:
            sn = int(sn)
        except (TypeError, ValueError):
            sn = None
    else:
        sn = None
    return {"studentName": str(data.get("studentName") or "").strip(), "studentNumber": sn}


def _scan_grade_max_side() -> int:
    try:
        v = int((os.environ.get("SCAN_ORGANIZE_GRADE_MAX_SIDE") or "480").strip())
    except ValueError:
        v = 480
    return max(320, min(v, 720))


async def _grade_corners_one_batch(
    corner_pngs: list[bytes],
    problem_numbers: list[int],
    api_key: str,
) -> list[bool]:
    """문항 이미지 한 묶음에 대한 채점 판정."""
    if not corner_pngs:
        return []
    max_side = _scan_grade_max_side()
    mode = _scan_grade_crop_mode()
    if mode == "region":
        lines = "\n".join(
            [f"이미지 {i + 1}: **문항 {problem_numbers[i]}번** 영역 전체" for i in range(len(corner_pngs))]
        )
        prompt = f"""{lines}

각 이미지는 초등 수학 시험지에서 **해당 문항 번호의 문항 영역 전체**(지문·풀이·소문항 (1)(2)·답안 줄 포함)를 잘라 낸 것이다.
선생님이 **틀린 문항에만** 손으로 그리는 채점 표시를 **이 문항 영역 안 어디든** 찾는다. 아래는 모두 **틀림(true)** 후보이다:
- 빨간펜·검은펜 **V자**, **슬래시(/)**, **X**, **동그라미**, **체크(√, ✓)** — (1)(2) 답안·번호·풀이 위 등
- **√(루트/체크 기호)** 도 이 시험에서는 **틀림 표시**이다. (정답 표시가 아님)
- 연필·볼펜 손글씨도 동일

**이 문항 번호에 해당하는 내용에 붙은 표시만** 판단한다. 바로 위·아래 **다른 문항 번호** 글자 근처에 겹쳐 보이는 표시는, 이 이미지 문항 번호의 지문·답안·소문항과 무관하면 **무시**한다.
**인쇄된 빨간색**(교과서 도형·표·숫자 카드·로고)은 채점 표시가 **아님** → 반드시 false.
**맞음(false)**: 이 문항 영역에 채점 표시가 전혀 없음, 학생 풀이·계산만 있음, 인쇄 글자·도형만 있음, 스캔 얼룩·연한 흔적만 있음, 애매·불확실.

반드시 JSON만 출력:
{{"marks":[true,false,...]}}

marks[i]: 이 요청의 이미지 i+1 — **해당 문항 영역 안**에 틀림 채점 표시가 분명히 보일 때만 true.
marks 배열 길이는 **{len(corner_pngs)}** 이다.
"""
    else:
        lines = "\n".join(
            [f"이미지 {i + 1}: 문항 {problem_numbers[i]}번 번호·채점 표시 줄" for i in range(len(corner_pngs))]
        )
        prompt = f"""{lines}

각 이미지는 초등 수학 시험지에서 **문항 번호와 그 왼쪽 여백**만 잘라 낸 것이다.
선생님이 **틀린 문항에만** 손으로 그리는 채점 표시를 찾는다. 아래는 모두 **틀림(true)** 후보이다:
- 빨간펜·검은펜 **V자**, **슬래시(/)**, **X**, **동그라미**, **체크(√, ✓)** — 번호 위·옆·덮어쓴 것
- **√(루트/체크 기호)** 도 이 시험에서는 **틀림 표시**이다. (정답 표시가 아님)
- 연필·볼펜 손글씨도 동일

**맞음(false)**: 채점 표시가 전혀 없음, 인쇄된 번호·문항 글자·도형만 있음, 스캔 얼룩·연한 흔적만 있음, 애매·불확실.
**인쇄 빨강·인접 문항 번호 옆 표시**는 이 문항 번호와 무관하면 false.

반드시 JSON만 출력:
{{"marks":[true,false,...]}}

marks[i]: 이 요청의 이미지 i+1 — **이 문항 번호 줄·왼쪽 여백**에 손글씨 채점(빨간 V·√·슬래시 등)이 **분명히** 보일 때만 true.
marks 배열 길이는 **{len(corner_pngs)}** 이다.
"""
    shrunk_pngs = [_shrink_png_bytes(raw, max_side=max_side)[0] for raw in corner_pngs]
    text = await _call_gemini_vision_pngs(
        api_key,
        shrunk_pngs,
        prompt,
        max_output_tokens=max(400, min(1200, 80 + len(corner_pngs) * 12)),
        max_side_per_image=max_side,
    )
    data = _extract_json_object(text)
    arr = data.get("marks")
    if not isinstance(arr, list):
        return [False] * len(corner_pngs)
    out: list[bool] = []
    for i in range(len(corner_pngs)):
        v = arr[i] if i < len(arr) else False
        out.append(bool(v))
    return out


async def _grade_corners(corner_pngs: list[bytes], problem_numbers: list[int], api_key: str) -> list[bool]:
    """각 채점 크롭 판정 — 문항 많으면 여러 번 나눠 호출(429·용량 완화)."""
    if not corner_pngs:
        return []
    batch = _scan_grade_batch_size()
    out: list[bool] = []
    for start in range(0, len(corner_pngs), batch):
        chunk_pngs = corner_pngs[start : start + batch]
        chunk_nums = problem_numbers[start : start + batch]
        part = await _grade_corners_one_batch(chunk_pngs, chunk_nums, api_key)
        out.extend(part)
    return out


@router.get("/exams")
def list_exam_templates():
    data = _load_regions()
    records = data.get("records") or []
    keys: set[tuple[str, str]] = set()
    for r in records:
        en = (r.get("exam_name") or "").strip()
        pn = (r.get("pdf_name") or "").strip()
        if en:
            keys.add(("exam", en))
        if pn:
            keys.add(("pdf", pn))
    templates = []
    for kind, name in sorted(keys, key=lambda x: x[1]):
        br = (
            _pick_best_record_for_exam(records, name)
            if kind == "exam"
            else _pick_best_record_for_pdf(records, name)
        )
        if br:
            templates.append(_template_from_record(br))
    return JSONResponse({"templates": templates})


@router.post("/preview-slots")
async def preview_slots(
    file: UploadFile = File(...),
    n: int = Form(...),
    slots: str = Form(...),
):
    """첫 번째 학생 블록(앞 n페이지)만 슬롯 변환 후 썸네일 PNG(base64) 배열."""
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="PDF 파일이 비어 있습니다.")
    slots_p = _parse_slots_json(slots)
    if len(slots_p) != n:
        raise HTTPException(status_code=400, detail=f"slots 길이가 n({n})과 다릅니다.")
    src = fitz.open(stream=raw, filetype="pdf")
    if src.page_count < n:
        src.close()
        raise HTTPException(status_code=400, detail=f"PDF가 {n}페이지 미만입니다.")
    tmp = fitz.open()
    for k in range(n):
        s = slots_p[k]
        src_pno = int(s["physicalIndex"])
        if src_pno < 0 or src_pno >= n:
            src.close()
            tmp.close()
            raise HTTPException(status_code=400, detail=f"physicalIndex 범위 오류: {src_pno}")
        _append_rotated_page(tmp, src, src_pno, int(s["rotation"]))
    src.close()
    thumbs_b64 = []
    for i in range(tmp.page_count):
        png = _page_png(tmp, i, zoom=1.2)
        thumbs_b64.append(base64.b64encode(png).decode("utf-8"))
    tmp.close()
    return JSONResponse({"thumbnailsBase64": thumbs_b64})


@router.post("/preview-grade-crops")
async def preview_grade_crops(
    file: UploadFile = File(...),
    n: int = Form(...),
    slots: str = Form(...),
    template_json: str = Form(...),
    block_index: int = Form(0),
):
    """
    Gemini·API 키 없이 채점 크롭만 반환 (좌표·스캔 정렬 확인용).
    슬롯 변환은 /process 와 동일; AI 호출·PDF 재조립 없음.
    """
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="PDF가 비어 있습니다.")
    try:
        template = json.loads(template_json)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"template_json: {exc}") from exc

    slots_p = _parse_slots_json(slots)
    src = fitz.open(stream=raw, filetype="pdf")
    try:
        doc, n_blocks, warns = _build_block_transformed_pdf(raw, n, slots_p)
    except ValueError as ve:
        src.close()
        raise HTTPException(status_code=400, detail=str(ve)) from ve

    bi = int(block_index)
    if bi < 0 or bi >= n_blocks:
        doc.close()
        src.close()
        raise HTTPException(status_code=400, detail=f"block_index는 0..{n_blocks - 1} 이어야 합니다.")

    regions = sorted(list(template.get("regions") or []), key=_region_list_sort_key)
    reg_cache = _build_block_page_registration_cache(bi, n, slots_p, doc, regions, template)
    anchor_cache = _build_block_page_anchor_offsets(
        bi, n, slots_p, src, doc, regions, template=template, reg_cache=reg_cache
    )
    crops = _collect_grade_crops_for_block(doc, n, bi, regions, slots_p, src, template)

    name_box, num_box, name_src_lbl, num_src_lbl = _resolve_student_field_boxes_for_block(
        template, bi, n, slots_p, src, doc, reg_cache
    )
    first_pno = bi * n
    student_field_crops: list[dict[str, Any]] = []
    try:
        name_png = _crop_norm_page_to_png(
            doc, first_pno, _student_field_crop_box(name_box), zoom=_student_field_ocr_zoom()
        )
        student_field_crops.append(
            {
                "kind": "name",
                "label": "이름",
                "cropBase64": base64.b64encode(name_png).decode("utf-8"),
            }
        )
    except Exception:
        pass
    try:
        num_png = _crop_norm_page_to_png(
            doc, first_pno, _student_field_crop_box(num_box), zoom=_student_field_ocr_zoom()
        )
        student_field_crops.append(
            {
                "kind": "number",
                "label": "출석번호",
                "cropBase64": base64.b64encode(num_png).decode("utf-8"),
            }
        )
    except Exception:
        pass

    pages_in_block = sorted({int(r.get("page") or 1) for r in regions})
    if 1 not in pages_in_block:
        pages_in_block = sorted(set(pages_in_block) | {1})
    page_overlays: list[dict[str, Any]] = []
    for p in pages_in_block:
        p_rel = p - 1
        if p_rel < 0 or p_rel >= n:
            continue
        pno = bi * n + p_rel
        regs_on_page = [r for r in regions if int(r.get("page") or 1) == p]
        try:
            png = _page_grade_overlay_png(
                doc,
                pno,
                regs_on_page,
                slots_p,
                bi,
                n,
                src,
                anchor_cache=anchor_cache,
                reg_cache=reg_cache,
                template=template,
                student_name_box=name_box if p == 1 else None,
                student_number_box=num_box if p == 1 else None,
            )
            page_overlays.append(
                {
                    "page": p,
                    "overlayBase64": base64.b64encode(png).decode("utf-8"),
                }
            )
        except Exception:
            continue

    doc.close()
    src.close()
    return JSONResponse(
        {
            "ok": True,
            "warnings": warns,
            "nBlocks": n_blocks,
            "blockIndex": bi,
            "crops": crops,
            "studentFieldCrops": student_field_crops,
            "nameBox": name_box,
            "numberBox": num_box,
            "nameSource": name_src_lbl,
            "numberSource": num_src_lbl,
            "pageOverlays": page_overlays,
            "gradeCropMode": "markbox",
            "gradeScanPadFrac": _scan_grade_scan_pad_frac(),
            "gradeAnchorEnabled": _scan_grade_anchor_enabled(),
            "pageAnchorOffsets": anchor_cache,
            "registrationMarkEnabled": _scan_reg_mark_enabled(),
            "pageRegistration": reg_cache,
            "markStripLeftPad": _scan_mark_left_page_fraction(),
            "markStripIntoRegionW": _scan_mark_strip_into_region_w(),
            "markStripHeightFrac": _scan_mark_strip_height_frac(),
            "markStripYPadAbove": _scan_mark_strip_y_pad_above_frac(),
            "examName": template.get("exam_name") or template.get("examName") or "",
            "regionCount": len(regions),
        }
    )


def _parse_roster_json(raw: str) -> list[dict[str, Any]]:
    """프론트엔드에서 보낸 명단(JSON 배열) → 정수 번호·이름 리스트. 잘못된 항목은 조용히 버린다."""
    if not raw:
        return []
    try:
        arr = json.loads(raw)
    except Exception:
        return []
    if not isinstance(arr, list):
        return []
    out: list[dict[str, Any]] = []
    for item in arr:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        num = item.get("number")
        try:
            num_i = int(num)
        except (TypeError, ValueError):
            continue
        if not name or num_i <= 0:
            continue
        out.append({"name": name, "number": num_i})
    return out


@router.post("/process")
async def process_full(
    file: UploadFile = File(...),
    n: int = Form(...),
    slots: str = Form(...),
    template_json: str = Form(...),
    gemini_api_key: str = Form(""),
    roster_json: str = Form(""),
):
    """
    전체 PDF 처리 + 학생별 1페이지 이름·번호 OCR + markBox 빨간색연필 diff 채점.
    template_json: _template_from_record 결과와 동일 스키마 (regions, name_region, template_pdf, …)
    gemini_api_key: (선택) 교사 Gemini 키 — **이름·번호 OCR 전용**. 채점에는 사용하지 않음.
    roster_json: (선택) `[{"name":"홍길동","number":1}, ...]`
    """
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="PDF가 비어 있습니다.")
    gem_key = _resolve_scan_gemini_api_key(gemini_api_key)
    if not gem_key:
        raise HTTPException(
            status_code=400,
            detail="Gemini API 키가 없습니다. 교사 대시보드에서 Gemini 키를 저장하거나, 서버에 REACT_APP_DEFAULT_GEMINI_KEY(또는 GEMINI_API_KEY)를 설정하세요.",
        )
    try:
        template = json.loads(template_json)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"template_json: {exc}") from exc

    roster = _parse_roster_json(roster_json)

    slots_p = _parse_slots_json(slots)
    try:
        doc, n_blocks, warns = _build_block_transformed_pdf(raw, n, slots_p)
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve)) from ve

    regions = sorted(list(template.get("regions") or []), key=_region_list_sort_key)
    gradable_regions = _regions_for_grading(regions)
    n_passage_excluded = len(
        [r for r in regions if (r.get("groupRole") or "") != "passage"]
    )
    if n_passage_excluded > len(gradable_regions):
        warns.append(
            "markBox가 없는 문항은 채점에서 제외됩니다. "
            "PDFRegionSelector에서 채점 네모(markBox)를 저장했는지 확인하세요."
        )
    tpl_pdf_path_global = _resolve_template_pdf_path(template)
    if tpl_pdf_path_global is None:
        warns.append(
            "빈 시험지 PDF(template_pdf)가 없어 markBox 채점을 할 수 없습니다. "
            "PDFRegionSelector에서 시험지 PDF를 함께 저장하세요."
        )

    students_out: list[dict[str, Any]] = []
    debug_name_crop_b64: str = ""
    debug_number_crop_b64: str = ""
    debug_header_crop_b64: str = ""
    debug_grade_crops: list[dict[str, Any]] = []
    collect_grade_crop_debug = _scan_debug_grade_crops()

    name_box_used: dict[str, float] | None = None
    number_box_used: dict[str, float] | None = None
    name_source_used = "default"
    number_source_used = "default"

    name_ocr_mode = _scan_name_ocr_mode()
    header_frac = _scan_header_fraction()

    block_preps: list[dict[str, Any]] = []
    block_anchor_caches: list[dict[int, dict[str, Any]]] = []
    block_reg_caches: list[dict[int, dict[str, Any]]] = []

    src_ref = fitz.open(stream=raw, filetype="pdf")
    try:
        for b in range(n_blocks):
            reg_c = _build_block_page_registration_cache(
                b, n, slots_p, doc, regions, template
            )
            block_reg_caches.append(reg_c)
            block_anchor_caches.append(
                _build_block_page_anchor_offsets(
                    b, n, slots_p, src_ref, doc, regions, template=template, reg_cache=reg_c
                )
            )
            first_page = b * n
            phys0 = first_page + int(slots_p[0]["physicalIndex"])
            if phys0 < 0 or phys0 >= src_ref.page_count:
                raise HTTPException(status_code=400, detail=f"슬롯 0 physicalIndex 오류: 블록 {b + 1}")

            name_box, num_box, name_src_lbl, num_src_lbl = _resolve_student_field_boxes_for_block(
                template, b, n, slots_p, src_ref, doc, block_reg_caches[b]
            )

            if b == 0:
                name_box_used = name_box
                number_box_used = num_box
                name_source_used = name_src_lbl
                number_source_used = num_src_lbl

            layout_hint = (
                f"이름 입력은 보통 왼쪽 위, 출석번호는 그 오른쪽. "
                f"(참고 정규화 박스: 이름 x={name_box['x']:.3f} y={name_box['y']:.3f}, "
                f"번호 x={num_box['x']:.3f} y={num_box['y']:.3f})"
            )

            header_png: bytes = b""
            if name_ocr_mode in ("header", "crop_then_header"):
                try:
                    header_png = _crop_norm_page_to_png(
                        doc,
                        first_page,
                        {"x": 0.0, "y": 0.0, "w": 1.0, "h": header_frac},
                        zoom=2.0,
                    )
                    if b == 0:
                        try:
                            debug_header_crop_b64 = base64.b64encode(header_png).decode("utf-8")
                        except Exception:
                            debug_header_crop_b64 = ""
                except Exception as exc:
                    traceback.print_exc()
                    header_png = b""
                    if b == 0:
                        debug_header_crop_b64 = ""

            name_png: bytes
            num_png: bytes
            crop_err: str | None = None
            try:
                sf_zoom = _student_field_ocr_zoom()
                name_png = _crop_norm_page_to_png(
                    doc, first_page, _student_field_crop_box(name_box), zoom=sf_zoom
                )
                num_png = _crop_norm_page_to_png(
                    doc, first_page, _student_field_crop_box(num_box), zoom=sf_zoom
                )
                if b == 0 and name_ocr_mode in ("crop", "crop_then_header"):
                    try:
                        debug_name_crop_b64 = base64.b64encode(name_png).decode("utf-8")
                        debug_number_crop_b64 = base64.b64encode(num_png).decode("utf-8")
                    except Exception:
                        debug_name_crop_b64 = ""
                        debug_number_crop_b64 = ""
            except Exception as exc:
                traceback.print_exc()
                name_png = b""
                num_png = b""
                crop_err = str(exc)
                if b == 0 and name_ocr_mode in ("crop", "crop_then_header"):
                    debug_name_crop_b64 = ""
                    debug_number_crop_b64 = ""

            trusted_boxes = _has_trusted_name_number_boxes(name_src_lbl, num_src_lbl)

            mark_strip_pngs: list[bytes] = []
            mark_tpl_pngs: list[bytes | None] = []
            prob_nums: list[int] = []
            markbox_grade_items: list[dict[str, Any]] = []
            tpl_pdf_path = tpl_pdf_path_global
            grade_zoom = 2.0

            if b == 0 and collect_grade_crop_debug:
                debug_grade_crops = _collect_grade_crops_for_block(
                    doc, n, 0, regions, slots_p, src_ref, template
                )
            anchor_cache = block_anchor_caches[b] if b < len(block_anchor_caches) else {}
            reg_cache = block_reg_caches[b] if b < len(block_reg_caches) else {}
            scan_page_arr_cache: dict[int, Any] = {}
            for reg in gradable_regions:
                p_rel = int(reg.get("page") or 1) - 1
                if p_rel < 0 or p_rel >= n:
                    continue
                pno = b * n + p_rel
                page_num = int(reg.get("page") or 1)
                page_regs = _regions_on_page(regions, page_num)
                strip_model = _effective_strip_model(anchor_cache, reg_cache, page_num)
                reg_aff = _registration_affine_for_page(reg_cache, page_num)
                reg_aligned = reg_aff is not None
                try:
                    mapped = _grade_box_for_block_page(
                        reg,
                        b,
                        n,
                        slots_p,
                        src_ref,
                        doc,
                        apply_scan_pad=False,
                        template=template,
                        reg_affine=reg_aff,
                        reg_cache=reg_cache,
                    )
                    mapped = _anchor_correct_mapped_box(mapped, strip_model, reg_aligned)
                    mapped_mb = _grade_mark_box_for_block_page(
                        reg,
                        b,
                        n,
                        slots_p,
                        src_ref,
                        doc,
                        apply_scan_pad=False,
                        template=template,
                        reg_affine=reg_aff,
                        reg_cache=reg_cache,
                    )
                    if mapped_mb is None:
                        continue
                    mapped_mb = _anchor_correct_mapped_box(mapped_mb, strip_model, reg_aligned)
                    crop_box = _problem_grade_crop_norm(
                        reg,
                        page_regs,
                        mapped_box=mapped,
                        mapped_mark_box=mapped_mb,
                        apply_scan_pad=True,
                        page_strip_model=strip_model,
                        registration_aligned=reg_aligned,
                        page=doc[pno],
                    )
                    prob_nums.append(_problem_base_int(reg.get("problem_number")))

                    tpl_mb = _region_mark_box_norm(reg)
                    tpl_box = tpl_mb
                    if tpl_mb is not None and _scan_grade_scan_pad_frac() > 0:
                        pad = min(_scan_grade_scan_pad_frac(), 0.008)
                        tpl_box = _expand_norm_region(tpl_mb, pad)

                    if tpl_pdf_path is not None:
                        if pno not in scan_page_arr_cache:
                            try:
                                import numpy as np
                                from PIL import Image as _PILImage

                                _pix = doc[pno].get_pixmap(
                                    matrix=fitz.Matrix(grade_zoom, grade_zoom), alpha=False
                                )
                                scan_page_arr_cache[pno] = np.asarray(
                                    _PILImage.open(io.BytesIO(_pix.tobytes("png"))).convert("RGB"),
                                    dtype=np.uint8,
                                )
                            except Exception:
                                scan_page_arr_cache[pno] = None
                        markbox_grade_items.append(
                            {
                                "pno": pno,
                                "tpl_page_idx": p_rel,
                                "scan_box": crop_box,
                                "tpl_box": tpl_box or crop_box,
                            }
                        )
                except Exception:
                    continue

            markbox_marks: list[bool | None] = []
            if tpl_pdf_path is not None and markbox_grade_items:
                markbox_marks = _grade_markbox_items_sync(
                    tpl_pdf_path, markbox_grade_items, scan_page_arr_cache, zoom=grade_zoom
                )
            elif prob_nums:
                markbox_marks = [None] * len(prob_nums)

            try:
                thumb_b64 = base64.b64encode(_page_png(doc, first_page, zoom=1.0)).decode("utf-8")
            except Exception:
                thumb_b64 = ""

            text_ocr: dict[str, Any] | None = None
            if roster and name_ocr_mode in ("header", "crop_then_header"):
                try:
                    text_ocr = _try_header_ocr_without_gemini(doc, first_page, num_box, roster)
                except Exception:
                    text_ocr = None

            block_preps.append(
                {
                    "b": b,
                    "name_ocr_mode": name_ocr_mode,
                    "has_trusted_boxes": trusted_boxes,
                    "header_png": header_png,
                    "layout_hint": layout_hint,
                    "name_png": name_png,
                    "num_png": num_png,
                    "prob_nums": prob_nums,
                    "markbox_marks": markbox_marks,
                    "thumb_b64": thumb_b64,
                    "crop_error": crop_err,
                    "text_ocr": text_ocr,
                    "first_page": first_page,
                    "num_box": num_box,
                }
            )
    finally:
        src_ref.close()

    conc = _scan_organize_gemini_concurrency()
    sem = asyncio.Semaphore(conc)
    t0 = time.monotonic()
    print(
        f"[scan-organize] 블록 {n_blocks}개 · 이름 OCR 순차(Gemini) · "
        f"채점=markBox 빨간색연필 diff (API 없음)"
    )

    async def _ocr_from_prep(prep: dict[str, Any]) -> dict[str, Any]:
        cached = prep.get("text_ocr")
        if isinstance(cached, dict) and cached.get("studentNumber") is not None:
            out = dict(cached)
            out["nameOcrAttempt"] = "text_layer"
            return out

        mode = prep.get("name_ocr_mode") or "crop_then_header"
        trusted = bool(prep.get("has_trusted_boxes"))

        async def _run_header() -> dict[str, Any]:
            hp = prep.get("header_png") or b""
            if not hp:
                return {
                    "studentName": "",
                    "studentNumber": None,
                    "ocrError": prep.get("crop_error") or "머리글(상단) 영역 크롭 실패",
                    "nameOcrAttempt": "header",
                }
            ocr = await _ocr_header_limited(
                hp, gem_key, roster, str(prep.get("layout_hint") or "")
            )
            ocr["nameOcrAttempt"] = "header"
            return ocr

        async def _run_crop() -> dict[str, Any]:
            if not prep.get("name_png") and not prep.get("num_png"):
                return {
                    "studentName": "",
                    "studentNumber": None,
                    "ocrError": prep.get("crop_error") or "이름·번호 영역 크롭 실패",
                    "nameOcrAttempt": "crop",
                }
            async with sem:
                try:
                    ocr = await _ocr_name_number(
                        prep["name_png"], prep["num_png"], gem_key, roster
                    )
                    ocr["nameOcrAttempt"] = "crop"
                    return ocr
                except RuntimeError as exc:
                    if "429" in str(exc):
                        out = _ocr_soft_fail(exc)
                        out["nameOcrAttempt"] = "crop"
                        return out
                    traceback.print_exc()
                    out = _ocr_soft_fail(exc)
                    out["nameOcrAttempt"] = "crop"
                    return out
                except Exception as exc:
                    traceback.print_exc()
                    out = _ocr_soft_fail(exc)
                    out["nameOcrAttempt"] = "crop"
                    return out

        if mode == "header":
            return await _run_header()

        if mode == "crop":
            return await _run_crop()

        # crop_then_header: 저장된 박스 없으면 상단만
        if not trusted:
            return await _run_header()

        crop_ocr = await _run_crop()
        if not _crop_ocr_needs_header_fallback(crop_ocr, prep):
            return crop_ocr

        header_ocr = await _run_header()
        header_ocr["nameOcrAttempt"] = "header_fallback"
        return header_ocr

    ocr_results: list[dict[str, Any]] = []
    for idx, prep in enumerate(block_preps):
        if idx > 0 and idx % 5 == 0:
            print(f"[scan-organize] 이름 OCR 진행 {idx}/{len(block_preps)}…")
        ocr_results.append(await _ocr_from_prep(prep))

    _clear_template_render_cache()
    elapsed = time.monotonic() - t0
    print(f"[scan-organize] OCR+채점 완료 {elapsed:.1f}s")

    for i, prep in enumerate(block_preps):
        b = int(prep["b"])
        ocr = _resolve_ocr_with_roster(ocr_results[i], roster)

        markbox_marks: list[bool | None] = prep.get("markbox_marks") or []
        prob_nums: list[int] = prep["prob_nums"]
        grade_failed = tpl_pdf_path_global is None or not prob_nums
        if not grade_failed and markbox_marks and all(m is None for m in markbox_marks):
            grade_failed = True

        results = []
        total_c = 0
        for j, pn in enumerate(prob_nums):
            wrong_val = markbox_marks[j] if j < len(markbox_marks) else None
            if wrong_val is None:
                results.append({"problemNumber": pn, "correct": None, "gradeUnknown": True})
                continue
            wrong = bool(wrong_val)
            correct = not wrong
            if correct:
                total_c += 1
            results.append(
                {"problemNumber": pn, "correct": correct, "gradeSource": "markbox_red_diff"}
            )

        students_out.append(
            {
                "blockIndex": b,
                "studentName": ocr.get("studentName", ""),
                "studentNumber": ocr.get("studentNumber"),
                "gradeFailed": grade_failed,
                "ocrError": ocr.get("ocrError"),
                "ocrNameRaw": ocr.get("ocrNameRaw"),
                "ocrNumberRaw": ocr.get("ocrNumberRaw"),
                "nameSource": ocr.get("nameSource") or "",
                "numberSource": ocr.get("numberSource") or "",
                "ocrNameDiscarded": ocr.get("ocrNameDiscarded"),
                "nameOcrAttempt": ocr.get("nameOcrAttempt") or "",
                "thumbnailBase64": prep["thumb_b64"],
                "results": results,
                "totalCorrect": total_c,
                "totalCount": len(results),
            }
        )

    pdf_bytes = doc.tobytes(deflate=True)
    doc.close()

    # JSON에 PDF를 base64로 넣으면 응답이 ~33% 팽창하고, 브라우저가 통째로 JSON.parse
    # 하느라 Gemini가 끝난 뒤에도 수 분간 UI가 멈춘 것처럼 보일 수 있음.
    # → UTF-8 JSON 길이(4바이트 big-endian) + JSON + 원시 PDF 바이트.
    meta: dict[str, Any] = {
        "ok": True,
        "warnings": warns,
        "nBlocks": n_blocks,
        "students": students_out,
        "examMeta": {
            "examName": template.get("exam_name") or template.get("examName") or "",
            "grade": template.get("grade") or "",
            "semester": template.get("semester") or "",
            "unit": template.get("unit") or "",
        },
        "ocrBoxesUsed": {
            "nameOcrMode": name_ocr_mode,
            "headerFraction": header_frac
            if name_ocr_mode in ("header", "crop_then_header")
            else None,
            "nameBox": name_box_used or _default_name_region(),
            "nameSource": name_source_used,
            "numberBox": number_box_used or _default_number_region(),
            "numberSource": number_source_used,
            "rosterCount": len(roster),
            "firstBlockNameCropBase64": debug_name_crop_b64,
            "firstBlockNumberCropBase64": debug_number_crop_b64,
            "firstBlockHeaderCropBase64": debug_header_crop_b64,
            "gradeCropMode": "markbox",
            "gradeEngine": "markbox_red_diff",
            "gradeScanPadFrac": _scan_grade_scan_pad_frac(),
            "gradeAnchorEnabled": _scan_grade_anchor_enabled(),
            "pageAnchorOffsets": block_anchor_caches[0] if block_anchor_caches else {},
            "registrationMarkEnabled": _scan_reg_mark_enabled(),
            "pageRegistration": block_reg_caches[0] if block_reg_caches else {},
            "markStripLeftPad": _scan_mark_left_page_fraction(),
            "markStripIntoRegionW": _scan_mark_strip_into_region_w(),
            "markStripHeightFrac": _scan_mark_strip_height_frac(),
            "markStripYPadAbove": _scan_mark_strip_y_pad_above_frac(),
            "firstBlockGradeCrops": debug_grade_crops,
            "gradeCropDebugEnabled": collect_grade_crop_debug,
        },
    }
    json_bytes = json.dumps(meta, ensure_ascii=False).encode("utf-8")
    body = struct.pack(">I", len(json_bytes)) + json_bytes + pdf_bytes
    print(f"[scan-organize] process 응답: JSON {len(json_bytes)} B + PDF {len(pdf_bytes)} B (raw {len(body)} B)")
    return Response(
        content=body,
        media_type="application/vnd.math.scan-organize+json-pdf;version=1",
    )


@router.post("/build-sorted-pdf")
async def build_sorted_pdf(
    file: UploadFile = File(...),
    n: int = Form(...),
    block_order: str = Form(...),
):
    """이미 변환된 PDF(블록 연속)에서 블록 순서만 재배열."""
    raw = await file.read()
    try:
        order = json.loads(block_order)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not isinstance(order, list):
        raise HTTPException(status_code=400, detail="block_order는 배열이어야 합니다.")
    src = fitz.open(stream=raw, filetype="pdf")
    total = src.page_count
    if total % n != 0:
        src.close()
        raise HTTPException(status_code=400, detail="페이지 수가 n의 배수가 아닙니다.")
    n_blocks = total // n
    if len(order) != n_blocks or sorted(order) != list(range(n_blocks)):
        src.close()
        raise HTTPException(status_code=400, detail="block_order는 0..B-1 순열이어야 합니다.")

    dst = fitz.open()
    for bi in order:
        base = int(bi) * n
        for j in range(n):
            _append_rotated_page(dst, src, base + j, 0)
    src.close()
    out = dst.tobytes(deflate=True)
    dst.close()
    return Response(content=out, media_type="application/pdf")
