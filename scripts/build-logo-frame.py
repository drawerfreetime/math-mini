"""Build transparent logo-frame.svg from ref/tital-no-text.svg (frame art only)."""
import re
from pathlib import Path

BRAND = Path(__file__).resolve().parents[1] / "public" / "brand"
SRC = BRAND / "ref" / "tital-no-text.svg"
OUT = BRAND / "logo-frame.svg"

WHITE_RECT = re.compile(
    r'<rect x="-144" width="1728" fill="#ffffff" y="-80\.999999" height="971\.999992" fill-opacity="1"/>'
)
# Sky gradient fill inside the frame (CSS background should show through).
GRADIENT_BLOCK = re.compile(
    r'<g clip-path="url\(#8bb256e8df\)"><path fill="url\(#b63bf7656c\)" d="M 0 0\.359375 L 0 809\.640625 L 1440 809\.640625 L 1440 0\.359375 Z M 0 0\.359375 " fill-rule="nonzero"/></g>'
)


def main() -> None:
    text = SRC.read_text(encoding="utf-8")
    text = WHITE_RECT.sub("", text)
    text = GRADIENT_BLOCK.sub("", text)
    # Drop unused sky gradient definition (large).
    text = re.sub(r"<linearGradient[^>]*id=\"b63bf7656c\"[\s\S]*?</linearGradient>", "", text)
    text = re.sub(r"\n{3,}", "\n", text)
    OUT.write_text(text, encoding="utf-8", newline="\n")
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")
    if WHITE_RECT.search(text):
        print("warn: white rects remain")
    if "b63bf7656c" in text:
        print("warn: gradient id still referenced")


if __name__ == "__main__":
    main()
