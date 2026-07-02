import re
from pathlib import Path

path = Path(__file__).resolve().parents[1] / "public" / "brand" / "logo-title.svg"
text = path.read_text(encoding="utf-8")
stripped = re.sub(r'\s*<use[^>]*href="#img1"[^>]*/>\s*', "\n", text)
if stripped != text:
    path.write_text(stripped, encoding="utf-8", newline="\n")
    print("removed png overlay")
else:
    print("no use tag found")
