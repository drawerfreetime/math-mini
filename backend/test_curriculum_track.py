"""curriculum track.md 파싱·단원 연결 단위 테스트."""
from __future__ import annotations

import unittest
from pathlib import Path

from curriculum_track import (
    extract_track_context_for_stem,
    load_track_document,
    load_track_excerpt_for_stem,
    parse_track_sections,
)

_CURRICULUM_DIR = Path(__file__).resolve().parent / "curriculum"


class TestCurriculumTrack(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.track_text = load_track_document(_CURRICULUM_DIR)
        if not cls.track_text:
            raise unittest.SkipTest("curriculum/track.md 없음")

    def test_parse_sections(self):
        sections = parse_track_sections(self.track_text)
        self.assertGreaterEqual(len(sections), 4)
        self.assertTrue(any("자연수 계산" in "\n".join(s) for s in sections))

    def test_413_natural_number_track(self):
        ctx = extract_track_context_for_stem("4-1-3", self.track_text)
        self.assertIsNotNone(ctx)
        self.assertIn("4-1-3", ctx or "")
        self.assertIn("자연수 계산", ctx or "")
        self.assertNotIn("분수 계산 계열", ctx or "")

    def test_316_two_tracks(self):
        ctx = extract_track_context_for_stem("3-1-6", self.track_text)
        self.assertIsNotNone(ctx)
        self.assertIn("분수 계산", ctx or "")
        self.assertIn("소수 계산", ctx or "")

    def test_unknown_stem_empty(self):
        self.assertIsNone(extract_track_context_for_stem("4-1-2", self.track_text))

    def test_load_excerpt_from_dir(self):
        excerpt = load_track_excerpt_for_stem("5-1-5", _CURRICULUM_DIR)
        self.assertIsNotNone(excerpt)
        self.assertIn("5-1-5", excerpt or "")


class TestCurriculumTrackIntegration(unittest.TestCase):
    def test_load_unit_document_includes_track(self):
        from server import load_curriculum_unit_document

        text, summary = load_curriculum_unit_document("초4", "1학기", "3. 곱셈과 나눗셈")
        if text is None:
            self.skipTest("4-1-3.md 없음")
        self.assertIn("[수와 연산 계열 맥락 — track.md]", text)
        self.assertIn("track.md", summary)


if __name__ == "__main__":
    unittest.main()
