"""

스캔 보정용 네 모서리 L자 마크 — ExamPdfStudentLabels 와 동일 규격으로 검출·affine 보정.

"""



from __future__ import annotations



import io

import os

from typing import Any



import fitz



# scanRegistrationMarks.js 와 동일

REG_INSET_MM = float(os.environ.get("SCAN_REG_MARK_INSET_MM") or "4")

REG_ARM_MM = float(os.environ.get("SCAN_REG_MARK_ARM_MM") or "7")

REG_SEARCH_FRAC = float(os.environ.get("SCAN_REG_MARK_SEARCH_FRAC") or "0.09")

REG_MIN_HITS = max(3, min(4, int(os.environ.get("SCAN_REG_MARK_MIN_HITS") or "3")))

# ArUco (OpenCV DICT_4X4_50 by default, ids 10..13)
ARUCO_DICT_NAME = str(os.environ.get("SCAN_ARUCO_DICT") or "DICT_4X4_50").strip()
ARUCO_IDS = {
    "tl": int(os.environ.get("SCAN_ARUCO_TL") or "10"),
    "tr": int(os.environ.get("SCAN_ARUCO_TR") or "11"),
    "br": int(os.environ.get("SCAN_ARUCO_BR") or "12"),
    "bl": int(os.environ.get("SCAN_ARUCO_BL") or "13"),
}
ARUCO_SIZE_MM_DEFAULT = float(os.environ.get("SCAN_ARUCO_SIZE_MM") or "7")
# 7mm 마커: zoom 3~4에서 변 한 변 ≈40px — DICT_4X4_50 검출에 충분
ARUCO_DETECT_ZOOMS = (3.0, 4.0, 2.0, 5.0)


def _reg_mark_fit_model() -> str:

    """similarity(기본): 스케일·회전·이동만. affine: 비틀림 허용(스캔 코너 오검출 시 양쪽 밀림)."""

    raw = (os.environ.get("SCAN_REG_MARK_MODEL") or "similarity").strip().lower()

    return "affine" if raw in ("affine", "full", "6") else "similarity"





def _mm_to_pt(mm: float) -> float:

    return float(mm) * 72.0 / 25.4


def _aruco_print_config(template: dict[str, Any] | None) -> dict[str, float]:
    """인쇄·검출 공통 ArUco 규격 (scanRegistrationMarks.js 와 동일)."""
    rm = (template or {}).get("registrationMark") or {}
    ar = (rm.get("aruco") or {}) if isinstance(rm, dict) else {}
    return {
        "size_mm": float(ar.get("sizeMm") or ARUCO_SIZE_MM_DEFAULT),
        "border_mm": float(ar.get("borderMm") or 0.0),
    }


def _aruco_expected_inner_corners_norm(
    page_w: float,
    page_h: float,
    spec: dict[str, float] | None = None,
    template: dict[str, Any] | None = None,
) -> dict[str, tuple[float, float]]:
    """
    템플릿에 인쇄된 ArUco 마커의 '내부 코너' 기대 위치(정규화, 좌상단 원점·y↓).
    - scanRegistrationMarks.js 의 drawArucoMarkersOnPdfPage 배치와 동일한 기하를 따른다.
    - detect_aruco_registration_corners_norm 이 반환하는 코너 정의(내부 코너: tl→br, tr→bl, br→tl, bl→tr)에 맞춘다.
    """
    pw = max(float(page_w), 1.0)
    ph = max(float(page_h), 1.0)
    sp = spec or {"inset_mm": REG_INSET_MM, "arm_mm": REG_ARM_MM}
    inset = _mm_to_pt(float(sp.get("inset_mm") or REG_INSET_MM))

    cfg = _aruco_print_config(template)
    size_mm = cfg["size_mm"]
    border_mm = cfg["border_mm"]
    size = _mm_to_pt(size_mm)
    border = _mm_to_pt(border_mm)
    s = max(1.0, size + border * 2.0)

    def to_norm_top_left(px: float, py_pdf: float) -> tuple[float, float]:
        # PDF 좌표(py_pdf: y↑) → 정규화 좌표(y↓)
        return (float(px) / pw, 1.0 - float(py_pdf) / ph)

    # scanRegistrationMarks.js:
    # TL: x = inset - border, y = H - inset - s + border
    # TR: x = W - inset - s + border, y = H - inset - s + border
    # BL: x = inset - border, y = inset - border
    # BR: x = W - inset - s + border, y = inset - border
    x_tl = inset - border
    y_top = ph - inset + border
    y_bottom = ph - inset - s + border
    x_tr = pw - inset - s + border

    # 내부 코너:
    # tl: br => (x_tl + s, y_bottom)
    # tr: bl => (x_tr,       y_bottom)
    # br: tl => (x_tr,       (inset - border) + s)
    # bl: tr => (x_tl + s,   (inset - border) + s)
    y_bl_bottom = inset - border
    y_bl_top = y_bl_bottom + s

    return {
        "tl": to_norm_top_left(x_tl + s, y_bottom),
        "tr": to_norm_top_left(x_tr, y_bottom),
        "br": to_norm_top_left(x_tr, y_bl_top),
        "bl": to_norm_top_left(x_tl + s, y_bl_top),
    }





def registration_spec_from_template(template: dict[str, Any] | None) -> dict[str, float]:

    rm = (template or {}).get("registrationMark") or {}

    return {

        "inset_mm": float(rm.get("insetMm") or REG_INSET_MM),

        "arm_mm": float(rm.get("armMm") or REG_ARM_MM),

    }





def template_corners_norm(page_w: float, page_h: float, spec: dict[str, float] | None = None) -> dict[str, tuple[float, float]]:

    sp = spec or {"inset_mm": REG_INSET_MM, "arm_mm": REG_ARM_MM}

    pw = max(float(page_w), 1.0)

    ph = max(float(page_h), 1.0)

    ix = _mm_to_pt(sp["inset_mm"]) / pw

    iy = _mm_to_pt(sp["inset_mm"]) / ph

    return {

        "tl": (ix, iy),

        "tr": (1.0 - ix, iy),

        "bl": (ix, 1.0 - iy),

        "br": (1.0 - ix, 1.0 - iy),

    }





def template_page_pt(template: dict[str, Any] | None, fallback_w: float, fallback_h: float) -> tuple[float, float]:

    """pdf_regions / 템플릿에 저장된 페이지 크기(pt)."""

    if not template:

        return max(float(fallback_w), 1.0), max(float(fallback_h), 1.0)

    tw = float(template.get("page_width") or template.get("pageWidth") or 0)

    th = float(template.get("page_height") or template.get("pageHeight") or 0)

    if tw < 10 or th < 10:

        return max(float(fallback_w), 1.0), max(float(fallback_h), 1.0)

    return tw, th





def rescale_template_norm_box_to_page(

    box: dict[str, float],

    template_w: float,

    template_h: float,

    page_w: float,

    page_h: float,

) -> dict[str, float]:

    """템플릿 PDF 기준 정규화 좌표 → 다른 페이지 크기의 정규화 좌표(물리 위치 유지)."""

    tw = max(float(template_w), 1.0)

    th = max(float(template_h), 1.0)

    pw = max(float(page_w), 1.0)

    ph = max(float(page_h), 1.0)

    sx = tw / pw

    sy = th / ph

    return {

        "x": float(box["x"]) * sx,

        "y": float(box["y"]) * sy,

        "w": float(box["w"]) * sx,

        "h": float(box["h"]) * sy,

    }





def _search_frac_for_page(pw: float, ph: float) -> float:

    """작은 스캔·저해상도일 때 검색창을 약간 넓힌다."""

    base = REG_SEARCH_FRAC

    if min(pw, ph) < 520:

        return min(0.14, base * 1.25)

    return base





def _crop_page_norm_to_gray(page: fitz.Page, box: dict[str, float], zoom: float = 2.0):

    from PIL import Image

    import numpy as np



    rect = page.rect

    x0 = float(box["x"]) * rect.width + rect.x0

    y0 = float(box["y"]) * rect.height + rect.y0

    x1 = x0 + float(box["w"]) * rect.width

    y1 = y0 + float(box["h"]) * rect.height

    clip = fitz.Rect(x0, y0, x1, y1)

    pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), clip=clip, alpha=False)

    arr = np.asarray(Image.open(io.BytesIO(pix.tobytes("png"))).convert("L"), dtype=np.float32)

    return arr, x0, y0, x1, y1





def _ink_centroid_norm(

    page: fitz.Page,

    exp_x: float,

    exp_y: float,

    search_frac: float = REG_SEARCH_FRAC,

) -> tuple[float, float] | None:

    """기대 꼭짓점 주변에서 어두운 잉크(인쇄 L) 무게중심."""

    try:

        import numpy as np

    except ImportError:

        return None

    sw = max(0.02, min(0.14, search_frac))

    sh = sw

    x0 = max(0.0, exp_x - sw)

    y0 = max(0.0, exp_y - sh)

    x1 = min(1.0, exp_x + sw)

    y1 = min(1.0, exp_y + sh)

    if x1 <= x0 or y1 <= y0:

        return None

    try:

        arr, _, _, _, _ = _crop_page_norm_to_gray(page, {"x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0}, zoom=2.5)

    except Exception:

        return None

    h, w = arr.shape

    if h < 8 or w < 8:

        return None

    ink = 255.0 - arr

    thr = float(np.percentile(ink, 58))

    mask = ink >= max(thr, 22.0)

    if int(mask.sum()) < 12:

        return None

    ys, xs = np.nonzero(mask)

    cx = x0 + (float(xs.mean()) / max(w - 1, 1)) * (x1 - x0)

    cy = y0 + (float(ys.mean()) / max(h - 1, 1)) * (y1 - y0)

    return (cx, cy)





def _corner_score_weights(corner_key: str) -> tuple[float, float, str]:

    """페이지 모서리에 가장 가까운 L 꼭짓점 — 코너별 점수 (min/max)."""

    if corner_key == "tl":

        return 1.0, 1.0, "min"

    if corner_key == "tr":

        return -1.0, 1.0, "min"

    if corner_key == "bl":

        return 1.0, -1.0, "min"

    return -1.0, -1.0, "max"





def _ink_l_vertex_norm(

    page: fitz.Page,

    exp_x: float,

    exp_y: float,

    corner_key: str,

    search_frac: float = REG_SEARCH_FRAC,

) -> tuple[float, float] | None:

    """

    L자 **안쪽 꼭짓점**(두 선 교차) — 잉크 픽셀 중 페이지 모서리에 가장 가까운 점.

    무게중심은 팔 안쪽으로 밀려 전체 박스가 왼쪽·위로 어긋나는 원인이 된다.

    """

    try:

        import numpy as np

    except ImportError:

        return _ink_centroid_norm(page, exp_x, exp_y, search_frac)



    sw = max(0.02, min(0.14, search_frac))

    sh = sw

    x0 = max(0.0, exp_x - sw)

    y0 = max(0.0, exp_y - sh)

    x1 = min(1.0, exp_x + sw)

    y1 = min(1.0, exp_y + sh)

    if x1 <= x0 or y1 <= y0:

        return None

    try:

        arr, _, _, _, _ = _crop_page_norm_to_gray(

            page, {"x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0}, zoom=3.0

        )

    except Exception:

        return None

    h, w = arr.shape

    if h < 8 or w < 8:

        return None

    ink = 255.0 - arr

    thr = float(np.percentile(ink, 50))

    mask = ink >= max(thr, 16.0)

    if int(mask.sum()) < 10:

        return None

    ys, xs = np.nonzero(mask)

    px = x0 + (xs.astype(np.float64) / max(w - 1, 1)) * (x1 - x0)

    py = y0 + (ys.astype(np.float64) / max(h - 1, 1)) * (y1 - y0)

    # 코너별로 x·y를 분리해 잡음 (대각 합만 쓰면 가로가 왼쪽으로 밀림)
    if corner_key == "tl":
        idx = int(np.lexsort((py, px))[0])
    elif corner_key == "tr":
        idx = int(np.lexsort((py, -px))[0])
    elif corner_key == "bl":
        idx = int(np.lexsort((-py, px))[0])
    else:
        idx = int(np.lexsort((-py, -px))[0])
    vx, vy = float(px[idx]), float(py[idx])

    if (vx - exp_x) ** 2 + (vy - exp_y) ** 2 > (sw * 1.35) ** 2:

        return _ink_centroid_norm(page, exp_x, exp_y, search_frac)

    return (vx, vy)





def detect_registration_corners_norm(

    page: fitz.Page,

    spec: dict[str, float] | None = None,

) -> dict[str, tuple[float, float]]:

    pw = max(float(page.rect.width), 1.0)

    ph = max(float(page.rect.height), 1.0)

    tpl = template_corners_norm(pw, ph, spec)

    search = _search_frac_for_page(pw, ph)

    out: dict[str, tuple[float, float]] = {}

    for key, (ex, ey) in tpl.items():

        hit = _ink_l_vertex_norm(page, ex, ey, key, search_frac=search)

        if hit is not None:

            out[key] = hit

    return out


def _aruco_detector_params(
    page_w_pt: float,
    page_h_pt: float,
    *,
    zoom: float,
    size_mm: float,
):
    """7mm 인쇄 규격에 맞춘 OpenCV ArUco 검출 파라미터."""
    try:
        import cv2  # type: ignore
    except Exception:
        return None
    if not hasattr(cv2, "aruco"):
        return None
    try:
        params = cv2.aruco.DetectorParameters()
    except Exception:
        try:
            return cv2.aruco.DetectorParameters_create()
        except Exception:
            return None

    pw_px = max(float(page_w_pt) * float(zoom), 1.0)
    ph_px = max(float(page_h_pt) * float(zoom), 1.0)
    page_w_mm = max(float(page_w_pt) * 25.4 / 72.0, 1.0)
    side_px = max(16.0, pw_px * (float(size_mm) / page_w_mm))
    peri_px = 4.0 * side_px
    page_peri = 2.0 * (pw_px + ph_px)
    # OpenCV 기본 0.03은 7mm@zoom2에서 탈락 → 마커 둘레 비율로 산출
    params.minMarkerPerimeterRate = max(0.005, min(0.035, (peri_px * 0.4) / page_peri))
    params.maxMarkerPerimeterRate = 4.0
    params.adaptiveThreshWinSizeMin = 3
    params.adaptiveThreshWinSizeMax = 23
    params.adaptiveThreshWinSizeStep = 4
    try:
        params.cornerRefinementMethod = cv2.aruco.CORNER_REFINE_SUBPIX
    except Exception:
        pass
    return params


def _page_gray_array(page: fitz.Page, zoom: float):
    """스캔 페이지 → 그레이스케일 ndarray (ArUco 검출용)."""
    try:
        import numpy as np
        from PIL import Image
    except Exception:
        return None, 0, 0

    mat = fitz.Matrix(float(zoom), float(zoom))
    pix = page.get_pixmap(matrix=mat, alpha=False)
    img = Image.open(io.BytesIO(pix.tobytes("png"))).convert("L")
    arr = np.array(img)
    h, w = arr.shape[:2]
    return arr, int(w), int(h)


def _aruco_dict_by_name(name: str):
    try:
        import cv2  # type: ignore
    except Exception:
        return None
    n = (name or "").strip()
    if not hasattr(cv2, "aruco"):
        return None
    try:
        key = getattr(cv2.aruco, n)
    except Exception:
        key = getattr(cv2.aruco, "DICT_4X4_50", None)
    try:
        return cv2.aruco.getPredefinedDictionary(key)
    except Exception:
        return None


def _aruco_inner_corners_norm(
    id_to_corners: dict[int, Any],
    img_w: int,
    img_h: int,
) -> dict[str, tuple[float, float]]:
    """
    id→코너 배열을 페이지 모서리별 '내부 코너'(정규화, 좌상단·y↓)로 변환.
    OpenCV 코너 순서 [tl, tr, br, bl] 기준 내부 코너:
    tl→br, tr→bl, br→tl, bl→tr
    """
    w = max(int(img_w), 1)
    h = max(int(img_h), 1)

    def _pick(c, key: str) -> tuple[float, float]:
        pts = c.reshape(4, 2)
        if key == "tl":
            p = pts[2]
        elif key == "tr":
            p = pts[3]
        elif key == "br":
            p = pts[0]
        else:
            p = pts[1]
        return float(p[0]) / w, float(p[1]) / h

    out: dict[str, tuple[float, float]] = {}
    for key in ("tl", "tr", "br", "bl"):
        c = id_to_corners.get(int(ARUCO_IDS[key]))
        if c is not None:
            out[key] = _pick(c, key)
    return out


def _detect_aruco_ids_on_gray(
    arr,
    *,
    page_w_pt: float,
    page_h_pt: float,
    zoom: float,
    size_mm: float,
) -> dict[int, Any]:
    """그레이 이미지에서 id10..13 마커 코너 배열만 검출."""
    try:
        import cv2  # type: ignore
    except Exception:
        return {}
    if not hasattr(cv2, "aruco"):
        return {}

    aruco_dict = _aruco_dict_by_name(ARUCO_DICT_NAME)
    if aruco_dict is None:
        return {}

    params = _aruco_detector_params(page_w_pt, page_h_pt, zoom=zoom, size_mm=size_mm)
    try:
        if params is not None and hasattr(cv2.aruco, "ArucoDetector"):
            detector = cv2.aruco.ArucoDetector(aruco_dict, params)
            corners, ids, _ = detector.detectMarkers(arr)
        elif params is not None:
            corners, ids, _ = cv2.aruco.detectMarkers(arr, aruco_dict, parameters=params)
        else:
            corners, ids, _ = cv2.aruco.detectMarkers(arr, aruco_dict)
    except Exception:
        return {}

    if ids is None or len(ids) == 0:
        return {}
    return {int(i): c for i, c in zip(ids.flatten().tolist(), corners)}


def detect_aruco_registration_corners_norm(
    page: fitz.Page,
    *,
    zoom: float = 3.0,
    template: dict[str, Any] | None = None,
) -> dict[str, tuple[float, float]]:
    """단일 배율에서 ArUco 4코너 내부 꼭짓점(정규화) 검출."""
    arr, w, h = _page_gray_array(page, zoom)
    if arr is None or w < 1 or h < 1:
        return {}
    cfg = _aruco_print_config(template)
    pw = max(float(page.rect.width), 1.0)
    ph = max(float(page.rect.height), 1.0)
    ids = _detect_aruco_ids_on_gray(
        arr, page_w_pt=pw, page_h_pt=ph, zoom=zoom, size_mm=cfg["size_mm"]
    )
    return _aruco_inner_corners_norm(ids, w, h)


def detect_aruco_registration_best(
    page: fitz.Page,
    template: dict[str, Any] | None = None,
) -> tuple[dict[str, tuple[float, float]], str]:
    """
    여러 렌더 배율로 ArUco 검출. REG_MIN_HITS 이상이면 즉시 반환.
    Returns: (corners_norm, found_model_tag)
    """
    for zoom in ARUCO_DETECT_ZOOMS:
        found = detect_aruco_registration_corners_norm(page, zoom=float(zoom), template=template)
        if len(found) >= REG_MIN_HITS:
            return found, f"aruco@{zoom:g}"
    return {}, "aruco"




def _fit_affine_pt(

    src_pts: list[tuple[float, float]],

    dst_pts: list[tuple[float, float]],

) -> tuple[float, float, float, float, float, float] | None:

    """src → dst  affine (pt): x' = a*x + b*y + tx,  y' = c*x + d*y + ty"""

    if len(src_pts) < 3 or len(src_pts) != len(dst_pts):

        return None

    try:

        import numpy as np

    except ImportError:

        return None

    rows: list[list[float]] = []

    rhs: list[float] = []

    for (sx, sy), (dx, dy) in zip(src_pts, dst_pts):

        rows.append([sx, sy, 1.0, 0.0, 0.0, 0.0])

        rows.append([0.0, 0.0, 0.0, sx, sy, 1.0])

        rhs.extend([dx, dy])

    M = np.array(rows, dtype=np.float64)

    b = np.array(rhs, dtype=np.float64)

    try:

        sol, _, _, _ = np.linalg.lstsq(M, b, rcond=None)

    except Exception:

        return None

    return tuple(float(x) for x in sol)





def _fit_similarity_pt(

    src_pts: list[tuple[float, float]],

    dst_pts: list[tuple[float, float]],

) -> tuple[float, float, float, float, float, float] | None:

    """src → dst 유사변환 (pt)."""

    if len(src_pts) < 2 or len(src_pts) != len(dst_pts):

        return None

    try:

        import numpy as np

    except ImportError:

        return None

    rows: list[list[float]] = []

    rhs: list[float] = []

    for (sx, sy), (dx, dy) in zip(src_pts, dst_pts):

        rows.append([sx, -sy, 1.0, 0.0])

        rows.append([sy, sx, 0.0, 1.0])

        rhs.extend([dx, dy])

    M = np.array(rows, dtype=np.float64)

    b = np.array(rhs, dtype=np.float64)

    try:

        sol, _, _, _ = np.linalg.lstsq(M, b, rcond=None)

    except Exception:

        return None

    a, bb, tx, ty = (float(sol[0]), float(sol[1]), float(sol[2]), float(sol[3]))

    return (a, -bb, tx, bb, a, ty)





def _reg_affine_tolerances() -> dict[str, float]:
    def _f(name: str, default: float) -> float:
        try:
            return float((os.environ.get(name) or str(default)).strip())
        except (TypeError, ValueError):
            return default

    return {
        # NOTE: 실사용 스캔본은 프린터 스케일/여백(캡처)로 인해
        # 템플릿 대비 scale/shift가 꽤 커질 수 있다.
        # 문항 영역 정확도가 목적이므로 기본 허용치를 보수→실용으로 완화한다.
        # (여전히 resid(코너 잔차)가 크면 오검출로 보고 거부)
        "scale": _f("SCAN_REG_MARK_MAX_SCALE_DEV", 0.25),
        "rot_deg": _f("SCAN_REG_MARK_MAX_ROT_DEG", 12.0),
        "shift_frac": _f("SCAN_REG_MARK_MAX_SHIFT_FRAC", 0.20),
        "resid_frac": _f("SCAN_REG_MARK_MAX_RESID_FRAC", 0.03),
    }


def _neutralize_affine_scale(
    aff: tuple[float, float, float, float, float, float],
    src_pts: list[tuple[float, float]],
    dst_pts: list[tuple[float, float]],
) -> tuple[float, float, float, float, float, float]:
    """
    affine 선형부의 **배율 성분을 1로 정규화**하고(회전은 유지), 이동을 다시 맞춘다.

    같은 용지를 스캔한 것이므로 실제 배율은 1이다. 검출 잡음으로 생긴 0.96~0.98배
    수축은 페이지 아래로 갈수록 박스를 위로 끌어올리는 누적 오차의 원인이므로 제거한다.
    꼭짓점 중심(centroid) 대응은 유지해 위치·회전 보정 효과는 남긴다.
    """
    import math

    a, b, tx, c, d, ty = aff
    sx = math.hypot(a, c)
    sy = math.hypot(b, d)
    if sx <= 1e-6 or sy <= 1e-6:
        return aff
    # 평균 배율로 양 축을 동일하게 정규화(이방성 왜곡도 함께 억제)
    s = (sx + sy) / 2.0
    if abs(s - 1.0) < 1e-3:
        return aff
    a_n, b_n, c_n, d_n = a / s, b / s, c / s, d / s
    # centroid(src) → centroid(dst) 가 유지되도록 이동 재계산
    n = max(len(src_pts), 1)
    scx = sum(p[0] for p in src_pts) / n
    scy = sum(p[1] for p in src_pts) / n
    dcx = sum(p[0] for p in dst_pts) / n
    dcy = sum(p[1] for p in dst_pts) / n
    tx_n = dcx - (a_n * scx + b_n * scy)
    ty_n = dcy - (c_n * scx + d_n * scy)
    return (a_n, b_n, tx_n, c_n, d_n, ty_n)


def _affine_is_sane(
    aff: tuple[float, float, float, float, float, float],
    src_pts: list[tuple[float, float]],
    dst_pts: list[tuple[float, float]],
    page_w: float,
    page_h: float,
) -> bool:
    """
    템플릿과 스캔은 같은 규격이므로 affine은 거의 항등이어야 한다.
    스케일·회전·이동이 과하거나 코너 잔차가 크면(꼭짓점 오검출) 거부한다.
    """
    import math

    a, b, tx, c, d, ty = aff
    tol = _reg_affine_tolerances()
    pw = max(float(page_w), 1.0)
    ph = max(float(page_h), 1.0)

    scale_x = math.hypot(a, c)
    scale_y = math.hypot(b, d)
    if abs(scale_x - 1.0) > tol["scale"] or abs(scale_y - 1.0) > tol["scale"]:
        return False

    rot = math.degrees(math.atan2(c, a))
    if abs(rot) > tol["rot_deg"]:
        return False

    if abs(tx) > tol["shift_frac"] * pw or abs(ty) > tol["shift_frac"] * ph:
        return False

    max_resid = tol["resid_frac"] * max(pw, ph)
    for (sx, sy), (dx, dy) in zip(src_pts, dst_pts):
        mx, my = apply_affine_pt_point(sx, sy, aff)
        if math.hypot(mx - dx, my - dy) > max_resid:
            return False
    return True


def build_page_registration_affine(

    page: fitz.Page,

    template: dict[str, Any] | None = None,

) -> dict[str, Any]:

    """

    스캔 페이지에서 «L이 있어야 할 위치»(src) → 검출 위치(dst) affine.

    문항 박스는 이미 스캔 pt 좌표이므로, 템플릿 pt가 아닌 **이 페이지(pt)** 기준으로 맞춘다.

    """

    spec = registration_spec_from_template(template)

    # 스캔본의 페이지(pt). (스캔 PDF는 물리 페이지 경계를 기준으로 잡힌다)
    pw = max(float(page.rect.width), 1.0)
    ph = max(float(page.rect.height), 1.0)

    # 템플릿(원본 PDF)의 페이지(pt). (문항 좌표는 이 좌표계를 기준으로 저장됨)
    tw, th = template_page_pt(template, pw, ph)

    # ★ 핵심: "기대 코너"는 스캔 페이지(pw/ph) 기준이 아니라 템플릿(tw/th) 기준이어야 한다.
    # 인쇄 시 축소/여백(Scale-to-fit 등)이 들어가면, 스캔 페이지 경계(물리 종이)와 PDF 경계가 달라져
    # pw/ph로 계산한 ix/iy(4mm inset)가 현실과 어긋난다.
    # 따라서 템플릿 정규화 코너(exp_norm) → 스캔 정규화 코너(found_norm)로 직접 변환을 맞춘다.
    found, found_model = detect_aruco_registration_best(page, template)
    if len(found) < REG_MIN_HITS:
        found = detect_registration_corners_norm(page, spec)
        found_model = "l_mark"
        exp = template_corners_norm(tw, th, spec)
    else:
        exp = _aruco_expected_inner_corners_norm(tw, th, spec, template=template)

    keys = [k for k in ("tl", "tr", "br", "bl") if k in found]

    if len(keys) < REG_MIN_HITS:

        return {
            "hits": len(keys),
            "affine": None,
            "model": "none",
            "pagePt": (pw, ph),
            "templatePt": (tw, th),
            "foundModel": found_model,
            # 워핑/디버그용: 검출 코너(정규화)와 기대 코너(정규화)
            "found": {k: [float(found[k][0]), float(found[k][1])] for k in keys},
            "expected": {k: [float(exp[k][0]), float(exp[k][1])] for k in keys},
        }

    # 변환은 "정규화 공간(0~1)"에서 맞춘다.
    src = [(float(exp[k][0]), float(exp[k][1])) for k in keys]
    dst = [(float(found[k][0]), float(found[k][1])) for k in keys]

    model = _reg_mark_fit_model()
    if model == "affine":
        aff = _fit_affine_pt(src, dst)
        model_name = "affine4pt_norm"
    else:
        aff = _fit_similarity_pt(src, dst)
        model_name = "similarity4pt_norm"

    if aff is None:

        return {
            "hits": len(keys),
            "affine": None,
            "model": "none",
            "pagePt": (pw, ph),
            "templatePt": (tw, th),
            "foundModel": found_model,
            "found": {k: [float(found[k][0]), float(found[k][1])] for k in keys},
            "expected": {k: [float(exp[k][0]), float(exp[k][1])] for k in keys},
        }

    # 정규화 공간에서는 스케일 중립화가 오히려 "프린터 축소" 같은 정상 변형을 지워버릴 수 있어
    # 기본적으로 수행하지 않는다. (필요하면 환경변수로 tol을 낮춰 _affine_is_sane 로 거른다.)

    # 정규화 공간이므로 page_w/h=1 기준으로 sanity check
    if not _affine_is_sane(aff, src, dst, 1.0, 1.0):
        # L자 꼭짓점 오검출 → 비정상 affine(특정 페이지만 아래로 밀림 등) 폐기.
        return {
            "hits": len(keys),
            "affine": None,
            "model": "rejected",
            "pagePt": (pw, ph),
            "templatePt": (tw, th),
            "foundModel": found_model,
            "found": {k: [float(found[k][0]), float(found[k][1])] for k in keys},
            "expected": {k: [float(exp[k][0]), float(exp[k][1])] for k in keys},
        }

    return {

        "hits": len(keys),

        "affine": aff,

        "model": model_name,

        "corners": keys,

        "pagePt": (pw, ph),

        "templatePt": (tw, th),

        "foundModel": found_model,
        # 워핑/디버그용: 검출 코너(정규화)와 기대 코너(정규화)
        "found": {k: [float(found[k][0]), float(found[k][1])] for k in keys},
        "expected": {k: [float(exp[k][0]), float(exp[k][1])] for k in keys},

    }





def apply_affine_pt_point(x: float, y: float, aff: tuple[float, float, float, float, float, float]) -> tuple[float, float]:

    a, b, tx, c, d, ty = aff

    return (a * x + b * y + tx, c * x + d * y + ty)





def apply_affine_norm_point(x: float, y: float, aff: tuple[float, float, float, float, float, float]) -> tuple[float, float]:

    a, b, tx, c, d, ty = aff

    return (a * x + b * y + tx, c * x + d * y + ty)





def apply_page_affine_norm_box(

    box: dict[str, float],

    aff: tuple[float, float, float, float, float, float],

    page_w: float,

    page_h: float,

) -> dict[str, float]:

    """pt 공간 affine을 페이지 정규화 박스에 적용."""

    pw = max(float(page_w), 1.0)

    ph = max(float(page_h), 1.0)

    x, y, w, h = float(box["x"]), float(box["y"]), float(box["w"]), float(box["h"])

    pts = [

        apply_affine_pt_point(x * pw, y * ph, aff),

        apply_affine_pt_point((x + w) * pw, y * ph, aff),

        apply_affine_pt_point(x * pw, (y + h) * ph, aff),

        apply_affine_pt_point((x + w) * pw, (y + h) * ph, aff),

    ]

    xs = [p[0] / pw for p in pts]

    ys = [p[1] / ph for p in pts]

    x0, x1 = min(xs), max(xs)

    y0, y1 = min(ys), max(ys)

    x0 = max(0.0, min(1.0, x0))

    y0 = max(0.0, min(1.0, y0))

    x1 = max(0.0, min(1.0, x1))

    y1 = max(0.0, min(1.0, y1))

    return {"x": x0, "y": y0, "w": max(0.0, x1 - x0), "h": max(0.0, y1 - y0)}





def apply_affine_norm_box(

    box: dict[str, float],

    aff: tuple[float, float, float, float, float, float],

) -> dict[str, float]:

    """정규화 공간 affine (레거시·pagePt 없을 때)."""

    x, y, w, h = float(box["x"]), float(box["y"]), float(box["w"]), float(box["h"])

    pts = [

        apply_affine_norm_point(x, y, aff),

        apply_affine_norm_point(x + w, y, aff),

        apply_affine_norm_point(x, y + h, aff),

        apply_affine_norm_point(x + w, y + h, aff),

    ]

    xs = [p[0] for p in pts]

    ys = [p[1] for p in pts]

    x0, x1 = min(xs), max(xs)

    y0, y1 = min(ys), max(ys)

    x0 = max(0.0, min(1.0, x0))

    y0 = max(0.0, min(1.0, y0))

    x1 = max(0.0, min(1.0, x1))

    y1 = max(0.0, min(1.0, y1))

    return {"x": x0, "y": y0, "w": max(0.0, x1 - x0), "h": max(0.0, y1 - y0)}


