"""Screenshot SVG stub templates from /stub-lab and build one contact sheet per template.

    python scripts/stub-lab/shoot.py premiere noir      # selected templates
    python scripts/stub-lab/shoot.py --all              # every template in templates.ts
    python scripts/stub-lab/shoot.py prism --base http://localhost:3100

Output: out/stub-lab/<id>/<shot>.png and out/stub-lab/<id>/sheet.png (the sheet the grader sees).
Shots: front + back (concert, light at rest), front with the light raking (finish), front in print
mode, ballet + hoops fronts (other categories) and the stress / short data on both faces.
"""
import argparse, os, re, sys
from pathlib import Path
from playwright.sync_api import sync_playwright
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "out" / "stub-lab"

SHOTS = [
    ("front", "front", "concert", "screen", "rest"),
    ("back", "back", "concert", "screen", "rest"),
    ("front-tilt", "front", "concert", "screen", "tilt"),
    ("back-tilt", "back", "concert", "screen", "tilt"),
    ("front-print", "front", "concert", "print", "rest"),
    ("front-ballet", "front", "ballet", "screen", "rest"),
    ("front-hoops", "front", "hoops", "screen", "rest"),
    ("front-festival", "front", "festival", "screen", "rest"),
    ("front-stress", "front", "stress", "screen", "rest"),
    ("back-stress", "back", "stress", "screen", "rest"),
    ("front-short", "front", "short", "screen", "rest"),
]


def template_ids():
    src = (ROOT / "src/customer/studio/stub/svg/templates.ts").read_text(encoding="utf8")
    return re.findall(r'id:\s*"([a-z0-9-]+)"', src)


def landscape(tid):
    src = (ROOT / "src/customer/studio/stub/svg/templates.ts").read_text(encoding="utf8")
    m = re.search(r'id:\s*"%s".*?orientation:\s*"(\w+)"' % tid, src, re.S)
    return bool(m and m.group(1) == "landscape")


def shoot(page, base, tid, errors):
    d = OUT / tid
    d.mkdir(parents=True, exist_ok=True)
    land = landscape(tid)
    w = 1100 if land else 480
    for name, face, data, mode, light in SHOTS:
        url = f"{base}/stub-lab?t={tid}&face={face}&data={data}&mode={mode}&light={light}&w={w}"
        page.goto(url)
        try:
            page.wait_for_selector("#stub svg[data-ready]", timeout=20000)
        except Exception:
            alert = page.locator("[role=alert]")
            errors.append(f"{tid}/{name}: not ready" + (f" ({alert.first.inner_text()})" if alert.count() else ""))
        page.evaluate("""() => document.querySelectorAll('body *').forEach(e => {
            const p = getComputedStyle(e).position;
            if (p === 'fixed' && !e.querySelector('#stub') && !e.closest('#stub')) e.style.visibility = 'hidden';
        })""")
        page.wait_for_function("document.fonts.status === 'loaded'")
        page.wait_for_timeout(500)
        page.locator("#stub").screenshot(path=str(d / f"{name}.png"))
    sheet(tid, land)


def sheet(tid, land):
    d = OUT / tid
    ims = {n: Image.open(d / f"{n}.png").convert("RGB") for n, *_ in SHOTS if (d / f"{n}.png").exists()}
    try:
        font = ImageFont.truetype("arial.ttf", 22)
    except OSError:
        font = ImageFont.load_default()
    cols = 3 if land else 6
    tw = 640 if land else 300
    cells = []
    for n, im in ims.items():
        im = im.resize((tw, int(im.height * tw / im.width)))
        cells.append((n, im))
    ch = max(im.height for _, im in cells) + 40
    rows = (len(cells) + cols - 1) // cols
    S = Image.new("RGB", (cols * (tw + 20) + 20, rows * (ch + 20) + 20), (34, 32, 30))
    dr = ImageDraw.Draw(S)
    for i, (n, im) in enumerate(cells):
        x = 20 + (i % cols) * (tw + 20)
        y = 20 + (i // cols) * (ch + 20)
        dr.text((x, y), n, fill=(230, 220, 200), font=font)
        S.paste(im, (x, y + 34))
    S.save(d / "sheet.png")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ids", nargs="*")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--base", default=os.environ.get("STUB_LAB_BASE", "http://localhost:3100"))
    a = ap.parse_args()
    ids = template_ids() if a.all or not a.ids else a.ids
    errors = []
    with sync_playwright() as p:
        b = p.chromium.launch()
        page = b.new_page(viewport={"width": 1200, "height": 1100}, device_scale_factor=2)
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        for tid in ids:
            shoot(page, a.base, tid, errors)
            print(f"{tid}: {OUT / tid / 'sheet.png'}")
        b.close()
    for e in errors:
        print("ERROR", e, file=sys.stderr)
    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
