"""
server.py — FastAPI 백엔드(최소)

남기는 기능:
- /api/regions* : 문항 영역 좌표(pdf_regions.json) 저장/조회
- /api/scan-organize* : 스캔본 자동정리 (scan_organize_api.router)

삭제된 기능(요청 반영):
- parse-problem, exam-ocr, 변형/검수, Claude/Gemini 자동 OCR 파이프라인 전체
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from scan_organize_api import router as scan_organize_router

BACKEND_DIR = Path(__file__).resolve().parent
DATA_DIR = BACKEND_DIR / "data"
REGIONS_FILE = DATA_DIR / "pdf_regions.json"


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _read_regions_records() -> list[dict[str, Any]]:
    if not REGIONS_FILE.exists():
        return []
    try:
        data = json.loads(REGIONS_FILE.read_text(encoding="utf-8"))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"pdf_regions.json 파싱 실패: {exc}") from exc
    if isinstance(data, dict) and isinstance(data.get("records"), list):
        return data["records"]
    if isinstance(data, list):
        return data
    return []


def _write_regions_records(records: list[dict[str, Any]]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    payload = {"records": records}
    REGIONS_FILE.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _upsert_record_by_pdf_name(records: list[dict[str, Any]], rec: dict[str, Any]) -> tuple[list[dict[str, Any]], int]:
    pdf_name = str(rec.get("pdf_name") or "").strip()
    if not pdf_name:
        raise HTTPException(status_code=400, detail="pdf_name이 필요합니다.")
    replaced = 0
    out: list[dict[str, Any]] = []
    for r in records:
        if str(r.get("pdf_name") or "").strip() == pdf_name:
            replaced += 1
            continue
        out.append(r)
    out.append(rec)
    return out, replaced


app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(scan_organize_router)


@app.get("/api/pdf/health")
async def pdf_health():
    return {"ok": True}


@app.get("/api/regions")
async def list_regions():
    records = _read_regions_records()
    return {"ok": True, "records": records}


@app.post("/api/regions")
async def upsert_regions_record(request: Request):
    """호환용: save-coordinates와 동일 동작(레코드 전체 업서트)."""
    body = await request.json()
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="JSON 객체가 필요합니다.")
    body = {**body, "saved_at": _utc_now_iso()}
    records = _read_regions_records()
    out, replaced = _upsert_record_by_pdf_name(records, body)
    _write_regions_records(out)
    return {"ok": True, "replaced": replaced}


@app.post("/api/regions/save-coordinates")
async def save_coordinates(request: Request):
    body = await request.json()
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="JSON 객체가 필요합니다.")
    if not isinstance(body.get("regions"), list) or not body["regions"]:
        raise HTTPException(status_code=400, detail="regions 배열이 필요합니다.")
    rec = {**body, "saved_at": _utc_now_iso()}
    records = _read_regions_records()
    out, replaced = _upsert_record_by_pdf_name(records, rec)
    _write_regions_records(out)
    return JSONResponse({"ok": True, "replaced": replaced})


@app.post("/api/regions/student-fields")
async def save_student_fields(request: Request):
    """학생별 시험지 인쇄에서 저장한 이름/번호 칸을 pdf_regions 레코드에 병합."""
    body = await request.json()
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="JSON 객체가 필요합니다.")
    pdf_name = str(body.get("pdf_name") or "").strip()
    if not pdf_name:
        raise HTTPException(status_code=400, detail="pdf_name이 필요합니다.")

    records = _read_regions_records()
    existing = None
    rest: list[dict[str, Any]] = []
    for r in records:
        if str(r.get("pdf_name") or "").strip() == pdf_name:
            existing = r
        else:
            rest.append(r)

    merged = {
        **(existing or {}),
        **body,
        "pdf_name": pdf_name,
        "saved_at": _utc_now_iso(),
    }
    rest.append(merged)
    _write_regions_records(rest)
    return {"ok": True}

