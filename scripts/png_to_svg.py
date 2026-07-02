import base64
from pathlib import Path

brand = Path(__file__).resolve().parents[1] / "public" / "brand"
pairs = [
    ("Student_login.png", "student_login.svg"),
    ("Teacher_login.png", "teacher_login.svg"),
]

for png_name, svg_name in pairs:
    png = brand / png_name
    data = base64.b64encode(png.read_bytes()).decode("ascii")
    w, h = 750, 250
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" '
        f'width="{w}" height="{h}" role="img" aria-hidden="true">\n'
        f'  <image width="{w}" height="{h}" href="data:image/png;base64,{data}"/>\n'
        f"</svg>\n"
    )
    (brand / svg_name).write_text(svg, encoding="utf-8")
    print(f"Wrote {svg_name} ({len(svg)} bytes)")
