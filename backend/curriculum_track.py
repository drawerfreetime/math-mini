"""수와 연산 계열 track.md — 단원 검토 시 선행학습·난이도 맥락."""
from __future__ import annotations

import re
from pathlib import Path

_TRACK_UNIT_RE = re.compile(r"^\((\d-\d-\d+)\)")
_SECTION_HEADER_RE = re.compile(r"^\d+\.\s")

TRACK_CONTEXT_HEADER = (
    "[수와 연산 계열 맥락 — track.md]\n"
    "아래는 해당 단원이 속한 수와 연산 학습 계열입니다. goal_alignment_ok 판단 시 참고하세요.\n"
    "· 문제에 뒤 단원 개념이 필수이면 선행학습 → goal_alignment_ok false\n"
    "· 앞 단원만으로 충분히 풀리면 단원 목표 미달 → goal_alignment_ok false\n"
    "· 도형·측정·규칙성 등 다른 영역 단원은 이 맥락이 없을 수 있습니다."
)


def _read_text_flex(path: Path) -> str | None:
    for enc in ("utf-8-sig", "utf-8", "cp949"):
        try:
            return path.read_text(encoding=enc)
        except (OSError, UnicodeDecodeError):
            continue
    return None


def load_track_document(curriculum_dir: Path) -> str | None:
    path = curriculum_dir / "track.md"
    if not path.is_file():
        return None
    raw = _read_text_flex(path)
    if not raw or not raw.strip():
        return None
    return raw.strip()


def parse_track_sections(track_text: str) -> list[list[str]]:
    """track.md를 계열(섹션)별 줄 목록으로 나눈다."""
    sections: list[list[str]] = []
    current: list[str] = []
    for line in track_text.splitlines():
        stripped = line.strip()
        if _SECTION_HEADER_RE.match(stripped) and current:
            sections.append(current)
            current = [line]
        elif stripped or current:
            current.append(line)
    if current:
        sections.append(current)
    return sections


def _section_unit_stems(section_lines: list[str]) -> set[str]:
    stems: set[str] = set()
    for line in section_lines:
        m = _TRACK_UNIT_RE.match(line.strip())
        if m:
            stems.add(m.group(1))
    return stems


def extract_track_context_for_stem(stem: str, track_text: str) -> str | None:
    """단원 코드(예: 4-1-3)가 속한 수와 연산 계열만 발췌한다. 없으면 None."""
    stem = (stem or "").strip()
    if not stem or not (track_text or "").strip():
        return None

    matching: list[str] = []
    for section in parse_track_sections(track_text):
        if stem in _section_unit_stems(section):
            matching.append("\n".join(section).strip())

    if not matching:
        return None

    body = "\n\n".join(matching)
    return f"{TRACK_CONTEXT_HEADER}\n\n{body}"


def load_track_excerpt_for_stem(stem: str, curriculum_dir: Path) -> str | None:
    track_text = load_track_document(curriculum_dir)
    if not track_text:
        return None
    return extract_track_context_for_stem(stem, track_text)
