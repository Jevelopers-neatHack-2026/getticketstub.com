"""Prism: a pastel holographic header card above a crisp white seat card, joined by a perforation
(holo direction; after the Tokyo 2020 swimming ticket).

    python scripts/stub-lab/gen/prism.py   -> public/stubs/prism/{front,back}.svg
"""
import math
from pathlib import Path

W, H = 480, 960
J = 500  # the perforation between the holo card and the seat card
OUT = Path(__file__).resolve().parents[3] / "public" / "stubs" / "prism"
INK = "#15161b"
GREY = "#6c6d76"
CARD = "#f7f7f4"
JP = "'Zen Kaku Gothic New', 'Space Grotesk', sans-serif"
GRO = "'Space Grotesk', 'Zen Kaku Gothic New', sans-serif"
R = 26  # outer corner
C = 15  # pinch at the perforation
HOLES = [(40, 40), (W - 40, 40)]


def f(v):
    return f"{v:.2f}".rstrip("0").rstrip(".")


def circle_path(cx, cy, r):
    return f"M{f(cx - r)} {f(cy)} a{f(r)} {f(r)} 0 1 0 {f(2 * r)} 0 a{f(r)} {f(r)} 0 1 0 {f(-2 * r)} 0Z"


def die():
    """Two rounded cards pinched at J (both cards round their corners into the join), two punch holes
    and a row of real perforation holes."""
    d = [
        f"M{R} 0 H{W - R} Q{W} 0 {W} {R}",
        f"V{J - C} A{C} {C} 0 0 1 {W - C} {J} A{C} {C} 0 0 1 {W} {J + C}",
        f"V{H - R} Q{W} {H} {W - R} {H} H{R} Q0 {H} 0 {H - R}",
        f"V{J + C} A{C} {C} 0 0 1 {C} {J} A{C} {C} 0 0 1 0 {J - C}",
        f"V{R} Q0 0 {R} 0Z",
    ]
    for x, y in HOLES:
        d.append(circle_path(x, y, 6.5))
    x = C + 12
    while x <= W - C - 12:
        d.append(f"M{f(x - 2.2)} {J - 0.9} h4.4 a0.9 0.9 0 0 1 0 1.8 h-4.4 a0.9 0.9 0 0 1 0 -1.8Z")
        x += 9
    return " ".join(d)


DIE = die()


def head():
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" data-foil="ink" data-holo="pastel" data-holo-print="#e4e2f2">\n')


def top_card_path(inset=0):
    """The holo card's outline (for the holo mask)."""
    return (f"M{R} 0 H{W - R} Q{W} 0 {W} {R} V{J - C} A{C} {C} 0 0 1 {W - C} {J} H{C} "
            f"A{C} {C} 0 0 1 0 {J - C} V{R} Q0 0 {R} 0Z")


def defs():
    return f'''  <defs>
    <radialGradient id="frost" cx="0.5" cy="0.42" r="0.7">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.34"/>
      <stop offset="0.6" stop-color="#ffffff" stop-opacity="0.12"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="edge" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.22"/>
      <stop offset="0.25" stop-color="#ffffff" stop-opacity="0"/>
      <stop offset="0.85" stop-color="#7d86b8" stop-opacity="0"/>
      <stop offset="1" stop-color="#7d86b8" stop-opacity="0.12"/>
    </linearGradient>
    <pattern id="grating" width="3.2" height="3.2" patternUnits="userSpaceOnUse" patternTransform="rotate(-32)">
      <rect width="3.2" height="1" fill="#fff"/>
    </pattern>
    <linearGradient id="caustic" gradientUnits="userSpaceOnUse" x1="0" y1="80" x2="480" y2="420">
      <stop offset="0.18" stop-color="#fff" stop-opacity="0"/>
      <stop offset="0.34" stop-color="#fff" stop-opacity="0.32"/>
      <stop offset="0.42" stop-color="#fff" stop-opacity="0.06"/>
      <stop offset="0.56" stop-color="#fff" stop-opacity="0"/>
      <stop offset="0.7" stop-color="#fff" stop-opacity="0.2"/>
      <stop offset="0.8" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="streak" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="480" y2="500">
      <stop offset="0.2" stop-color="#ff9ad5" stop-opacity="0"/>
      <stop offset="0.26" stop-color="#ff9ad5" stop-opacity="0.22"/>
      <stop offset="0.29" stop-color="#8fe9ff" stop-opacity="0.26"/>
      <stop offset="0.32" stop-color="#d7ff9a" stop-opacity="0"/>
      <stop offset="0.62" stop-color="#9ab0ff" stop-opacity="0"/>
      <stop offset="0.655" stop-color="#9ab0ff" stop-opacity="0.18"/>
      <stop offset="0.68" stop-color="#ffe59a" stop-opacity="0.2"/>
      <stop offset="0.71" stop-color="#ffe59a" stop-opacity="0"/>
    </linearGradient>
    <filter id="filmnoise" x="0" y="0" width="1" height="1" filterUnits="objectBoundingBox">
      <feTurbulence type="fractalNoise" baseFrequency="0.01 0.03" numOctaves="2" seed="21" result="n"/>
      <feColorMatrix in="n" type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 1.8 0 -0.75"/>
      <feComposite in2="SourceGraphic" operator="in"/>
    </filter>
    <linearGradient id="cardshade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#000" stop-opacity="0.05"/>
      <stop offset="0.06" stop-color="#000" stop-opacity="0"/>
    </linearGradient>
  </defs>
'''


# ------------------------------------------------------------------ shared drawing bits
def emblem(cx, cy, s=1.0):
    """A small orbit-globe badge: ellipse ring around a ruled sphere."""
    rx, ry = 34 * s, 12 * s
    g = [f'<g fill="none" stroke="{INK}" stroke-width="{f(1.4 * s)}">',
         f'<ellipse cx="{cx}" cy="{cy}" rx="{f(rx)}" ry="{f(ry)}"/>',
         f'<ellipse cx="{cx}" cy="{cy}" rx="{f(rx - 6 * s)}" ry="{f(ry - 3.6 * s)}" stroke-width="{f(0.9 * s)}"/>',
         f'<circle cx="{cx}" cy="{cy}" r="{f(9 * s)}"/>',
         f'<ellipse cx="{cx}" cy="{cy}" rx="{f(4 * s)}" ry="{f(9 * s)}" stroke-width="{f(0.9 * s)}"/>',
         f'<path d="M{f(cx - 9 * s)} {cy} H{f(cx + 9 * s)} M{f(cx - rx - 8 * s)} {cy} H{f(cx - rx - 2 * s)} M{f(cx + rx + 2 * s)} {cy} H{f(cx + rx + 8 * s)}" stroke-width="{f(0.9 * s)}"/>',
         '</g>']
    return "".join(g)


def punch_rings():
    return "".join(f'<circle cx="{x}" cy="{y}" r="9" fill="none" stroke="{INK}" stroke-width="1.3"/>' for x, y in HOLES)


def label(x, y, jp, en, anchor="start", jp_size=7, en_size=8.5):
    """A bilingual micro-label: Japanese over English, set tight."""
    a = f' text-anchor="{anchor}"' if anchor != "start" else ""
    return (f'<text x="{x}" y="{y - 10}"{a} font-family="{JP}" font-size="{jp_size}" font-weight="500" fill="{INK}" letter-spacing="0.6">{jp}</text>'
            f'<text x="{x}" y="{y}"{a} font-family="{GRO}" font-size="{en_size}" font-weight="700" fill="{INK}" letter-spacing="0.9">{en}</text>')


def inline_label(x, y, jp, en):
    """Micro-print label on one line: 価格 PRICE:"""
    return (f'<text x="{x}" y="{y}" fill="{INK}"><tspan font-family="{JP}" font-size="6.8" font-weight="500">{jp}</tspan>'
            f'<tspan dx="3" font-family="{GRO}" font-size="7.4" font-weight="700" letter-spacing="0.6">{en}</tspan></text>')


def placeholder_value(slot, x, y, size, fit, cover_w=0, cover_h=0, extra="", anchor="start"):
    """A value that prints an em-dash when the slot is empty."""
    a = f' text-anchor="{anchor}"' if anchor != "start" else ""
    return (f'<text data-slot="{slot}" data-default="—" x="{x}" y="{y}"{a} font-family="{JP}" font-size="{size}" font-weight="700" fill="{INK}" '
            f'style="font-variant-numeric: lining-nums tabular-nums" data-fit="{fit}" data-min="{f(size * 0.45)}" {extra}>.</text>')


def checker(x, y, cols=14, rows=2, s=5.2):
    out = []
    for r in range(rows):
        for c in range(cols):
            if (r + c) % 2 == 0:
                out.append(f'<rect x="{f(x + c * s)}" y="{f(y + r * s)}" width="{s}" height="{s}"/>')
    return f'<g fill="{INK}">{"".join(out)}</g>'


def brackets(x0, y0, x1, y1, L=9, w=1.3):
    p = (f"M{x0} {y0 + L} V{y0} H{x0 + L} M{x1 - L} {y0} H{x1} V{y0 + L} "
         f"M{x1} {y1 - L} V{y1} H{x1 - L} M{x0 + L} {y1} H{x0} V{y1 - L}")
    return f'<path d="{p}" fill="none" stroke="{INK}" stroke-width="{w}"/>'


def stamp(cx, cy, r=30):
    """Circular keepsake stamp: ring, circular micro-type, a wave and the orbit mark."""
    ring_text = "TICKETSTUB · KEEPSAKE · NO ENTRY · "
    return f'''<g>
      <circle cx="{cx}" cy="{cy}" r="{r}" fill="none" stroke="{INK}" stroke-width="1.4"/>
      <circle cx="{cx}" cy="{cy}" r="{r - 9}" fill="none" stroke="{INK}" stroke-width="0.7"/>
      <path id="stampring" d="M{cx - (r - 6.6)} {cy} a{r - 6.6} {r - 6.6} 0 1 1 {2 * (r - 6.6)} 0 a{r - 6.6} {r - 6.6} 0 1 1 {-2 * (r - 6.6)} 0" fill="none"/>
      <text font-family="{GRO}" font-size="5.8" font-weight="700" fill="{INK}"><textPath href="#stampring" textLength="{f(2 * 3.14159 * (r - 6.6) - 3)}" lengthAdjust="spacing">{ring_text}</textPath></text>
      <ellipse cx="{cx}" cy="{cy}" rx="15" ry="5.4" fill="none" stroke="{INK}" stroke-width="1.2" transform="rotate(-14 {cx} {cy})"/>
      <circle cx="{cx}" cy="{cy}" r="6" fill="{INK}"/>
      <circle cx="{cx + 13.6}" cy="{cy - 4.6}" r="1.8" fill="{INK}"/>
    </g>'''


def holo_and_frost():
    """Holo film over the top card, then a frost so it reads as pearly film rather than a rainbow."""
    tc = top_card_path()
    return f'''  <g data-layer="paper">
    <rect width="{W}" height="{H}" fill="#e9ebf3"/>
    <rect y="{J}" width="{W}" height="{H - J}" fill="{CARD}"/>
  </g>
  <g data-layer="holo">
    <path d="{tc}" fill="#fff"/>
  </g>
  <g data-layer="paper">
    <path d="{tc}" fill="url(#frost)"/>
    <path d="{tc}" fill="url(#caustic)"/>
    <path d="{tc}" fill="url(#edge)"/>
    <path d="{tc}" fill="url(#streak)" style="mix-blend-mode: multiply"/>
    <path d="{tc}" fill="url(#grating)" opacity="0.09"/>
    <path d="{tc}" fill="#fff" filter="url(#filmnoise)" opacity="0.14"/>
    <rect width="{W}" height="{J}" fill="#fff" filter="url(#ts-grain-light)" opacity="0.18"/>
    <rect y="{J}" width="{W}" height="{H - J}" fill="url(#cardshade)"/>
  </g>
'''


def grain_top():
    return f'''  <g data-layer="paper" pointer-events="none">
    <rect y="{J}" width="{W}" height="{H - J}" fill="#000" filter="url(#ts-grain)" opacity="0.07"/>
  </g>
'''


DIELINE = f'  <path data-layer="dieline" d="{DIE}" fill="none" fill-rule="evenodd" clip-rule="evenodd" stroke="#ec008c" stroke-width="0.5"/>\n'


# ------------------------------------------------------------------ front
def front():
    s = head() + defs() + holo_and_frost()
    TB = 332  # title baseline (grows upward)
    OCX, OCY, ORX, ORY = W / 2, TB - 76, 218, 58  # the orbit ring, centred in the gap between title lines
    ROT = f"rotate(-9 {OCX} {OCY})"
    pt = lambda t: (OCX + ORX * math.cos(math.radians(t)), OCY + ORY * math.sin(math.radians(t)))
    T0, T1 = 150, 196  # the stretch of ring that passes in FRONT of the letters (lower left), like ref 08
    (ax, ay), (bx, by) = pt(T0), pt(T1)
    FRONT_ARC = f"M{ax:.2f} {ay:.2f} A{ORX} {ORY} 0 0 1 {bx:.2f} {by:.2f}"
    BACK_ARC = f"M{bx:.2f} {by:.2f} A{ORX} {ORY} 0 1 1 {ax:.2f} {ay:.2f}"
    PX, PY = pt(150)
    s += f'''  <g data-layer="ink">
    {punch_rings()}
    {emblem(W / 2, 54)}
    <text data-slot="subtitle" x="{W / 2}" y="106" text-anchor="middle" font-family="{GRO}" font-size="12.5" font-weight="600" letter-spacing="1.8" fill="{INK}" data-case="upper" data-fit="404" data-min="6.6">.</text>
    <text data-slot="date" data-hide-if="subtitle" x="{W / 2}" y="106" text-anchor="middle" font-family="{GRO}" font-size="12.5" font-weight="600" letter-spacing="1.8" fill="{INK}" data-case="upper">.</text>
    <mask id="titlecut" maskUnits="userSpaceOnUse" x="0" y="0" width="{W}" height="{J}">
      <rect width="{W}" height="{J}" fill="#fff"/>
      <path d="{FRONT_ARC}" fill="none" stroke="#000" stroke-width="7.5" stroke-linecap="round" transform="{ROT}"/>
    </mask>
    <filter id="lineblob" x="-10%" y="-20%" width="120%" height="140%" filterUnits="objectBoundingBox">
      <feMorphology in="SourceAlpha" operator="dilate" radius="18 7" result="d"/>
      <feFlood flood-color="#000"/>
      <feComposite in2="d" operator="in"/>
    </filter>
    <mask id="behind" maskUnits="userSpaceOnUse" x="0" y="0" width="{W}" height="{J}">
      <rect width="{W}" height="{J}" fill="#fff"/>
      <use href="#titletext" filter="url(#lineblob)"/>
    </mask>
    <path d="{BACK_ARC}" fill="none" stroke="{INK}" stroke-width="2.6" transform="{ROT}" mask="url(#behind)"/>
    <text id="titletext" data-slot="title" mask="url(#titlecut)" x="{W / 2}" y="{TB}" text-anchor="middle" font-family="{JP}" font-size="112" font-weight="900" letter-spacing="-1.2" fill="{INK}" style="font-variant-numeric: lining-nums" data-case="upper" data-wrap="356" data-lines="4" data-leading="0.94" data-anchor="bottom" data-min="26">.</text>
    <path d="{FRONT_ARC}" fill="none" stroke="{INK}" stroke-width="2.6" transform="{ROT}"/>
    <circle cx="{PX:.2f}" cy="{PY:.2f}" r="4.5" fill="{INK}" transform="{ROT}"/>
    <text data-slot="categoryLabel" x="{W / 2}" y="392" text-anchor="middle" font-family="{GRO}" font-size="17" font-weight="600" letter-spacing="3" fill="{INK}" data-prefix="+   " data-suffix="   +">.</text>
    <text data-slot="kicker" x="{W / 2}" y="430" text-anchor="middle" font-family="{JP}" font-size="11" font-weight="500" letter-spacing="2.4" fill="{INK}" data-case="upper" data-fit="300" data-min="7">.</text>
    <rect x="{W / 2 - 70}" y="442" width="140" height="10" rx="5" fill="none" stroke="{INK}" stroke-width="1.6"/>
    <rect x="{W / 2 - 64}" y="445.6" width="38" height="2.8" rx="1.4" fill="{INK}"/>
  </g>
'''
    # ---- the seat card
    s += f'''  <g data-layer="ink">
    <rect x="0" y="530" width="11" height="26" fill="{INK}"/>
    <text x="40" y="535" fill="{INK}"><tspan font-family="{JP}" font-size="7" font-weight="500">会場</tspan><tspan dx="4" font-family="{GRO}" font-size="7.8" font-weight="700" letter-spacing="0.9">VENUE</tspan><tspan data-slot="city" dx="6" font-family="{GRO}" font-size="7.8" font-weight="600" letter-spacing="1.2" fill="{GREY}" data-case="upper" data-prefix="/  ">.</tspan></text>
    <text data-slot="venue" x="40" y="559" font-family="{GRO}" font-size="21" font-weight="700" letter-spacing="0.6" fill="{INK}" data-case="upper" data-wrap="268" data-lines="3" data-leading="1.04" data-min="11">.</text>
    {label(40, 631, "開演時間", "START TIME")}
    {placeholder_value("time", 104, 632, 22, 110, 112, 19)}
    <text data-slot="day" x="420" y="568" text-anchor="end" font-family="{JP}" font-size="48" font-weight="700" letter-spacing="-0.5" fill="{INK}">.</text>
    <text data-slot="month" x="420" y="606" text-anchor="end" font-family="{JP}" font-size="28" font-weight="700" letter-spacing="1" fill="{INK}">.</text>
    <text x="420" y="630" text-anchor="end" fill="{INK}" font-family="{GRO}" font-size="8" font-weight="600" letter-spacing="1.4"><tspan data-slot="weekday">.</tspan><tspan>  ·  </tspan><tspan data-slot="year">.</tspan></text>
    <g fill="{INK}"><rect x="428" y="536" width="4" height="4"/><rect x="428" y="550" width="4" height="4"/><rect x="428" y="576" width="4" height="4"/><rect x="428" y="590" width="4" height="4"/></g>
  </g>
'''
    # grid
    GT, GB = 652, 806
    cells = [("ゲート", "GATE", "gate", 40, 711), ("区画", "SECTION", "section", 252, 711),
             ("列", "ROW", "row", 40, 779), ("座席", "SEAT", "seat", 252, 779)]
    grid = [f'<path d="M24 {GT} H456 M24 {GB} H456 M24 {GT} V{GB} M456 {GT} V{GB}" fill="none" stroke="{INK}" stroke-width="1.3"/>',
            f'<path d="M240 {GT + 18} V{GB - 18}" stroke="{INK}" stroke-width="0.7" stroke-dasharray="1.5 3"/>']
    for jp, en, slot, x, y in cells:
        grid.append(label(x + 16, y - 6, jp, en))
        grid.append(placeholder_value(slot, x + 90, y, 36, 104, 104, 30))
    frame = grid.pop(0)
    s += f'''  <g data-layer="ink">
    {frame}
    <g data-show-if="section">{''.join(grid)}</g>
    <g data-hide-if="section">
      <text x="{W / 2}" y="{GT + 44}" text-anchor="middle" font-family="{JP}" font-size="9" font-weight="500" letter-spacing="6" fill="{INK}">一般入場</text>
      <text x="{W / 2}" y="{GT + 86}" text-anchor="middle" font-family="{JP}" font-size="34" font-weight="900" letter-spacing="0.5" fill="{INK}">GENERAL ADMISSION</text>
      <path d="M{W / 2 - 60} {GT + 104} H{W / 2 + 60}" stroke="{INK}" stroke-width="0.8"/>
      <text x="{W / 2}" y="{GT + 124}" text-anchor="middle" font-family="{GRO}" font-size="8.5" font-weight="600" letter-spacing="2.4" fill="{INK}">UNRESERVED · STANDING &amp; SEATED</text>
      <text data-slot="gate" x="44" y="{GB - 12}" font-family="{GRO}" font-size="7.6" font-weight="700" letter-spacing="1" fill="{INK}" data-prefix="GATE  " data-case="upper">.</text>
      <text data-slot="seat" x="436" y="{GB - 12}" text-anchor="end" font-family="{GRO}" font-size="7.6" font-weight="700" letter-spacing="1" fill="{INK}" data-prefix="SEAT  " data-case="upper">.</text>
    </g>
  </g>
'''
    # micro print, checker, barcode, stamp
    s += f'''  <g data-layer="ink">
    {inline_label(40, 834, "日付", "DATE:")}<text data-slot="dateDots" x="94" y="834" font-family="{GRO}" font-size="7.6" font-weight="500" letter-spacing="0.5" fill="{INK}">.</text>
    {inline_label(40, 848, "種別", "TYPE:")}<text data-slot="categoryLabel" x="94" y="848" font-family="{GRO}" font-size="7.6" font-weight="500" letter-spacing="0.5" fill="{INK}">.</text>
    {inline_label(190, 834, "価格", "PRICE:")}<text data-slot="price" data-default="—" x="246" y="834" font-family="{GRO}" font-size="7.6" font-weight="500" letter-spacing="0.5" fill="{INK}" data-fit="84">.</text>
    {inline_label(190, 848, "入場", "ADMIT:")}<text data-slot="admit" data-default="ADMIT ONE" x="246" y="848" font-family="{GRO}" font-size="7.6" font-weight="500" letter-spacing="0.5" fill="{INK}" data-case="upper" data-fit="84">.</text>
    {checker(40, 864)}
    <g data-slot="barcode" data-w="150" data-h="21" data-color="{INK}" transform="translate(122 863)"></g>
    <text data-slot="serial" x="122" y="896" font-family="{GRO}" font-size="7" font-weight="500" letter-spacing="2.6" fill="{INK}">.</text>
    {brackets(358, 818, 442, 902)}
    {stamp(400, 860)}
    <path d="M40 912 H330" stroke="{INK}" stroke-width="0.6"/>
    <text x="40" y="927" fill="{INK}"><tspan font-family="{JP}" font-size="6.8" font-weight="500">無断転売禁止</tspan><tspan dx="5" font-family="{GRO}" font-size="6.8" font-weight="600" letter-spacing="0.9">COMMEMORATIVE KEEPSAKE · NOT VALID FOR ENTRY</tspan></text>
  </g>
'''
    s += grain_top() + DIELINE + "</svg>\n"
    return s


# ------------------------------------------------------------------ back
def back():
    s = head() + defs() + holo_and_frost()
    s += f'''  <g data-layer="ink">
    {punch_rings()}
    {emblem(W / 2, 54, 0.8)}
    <text x="{W / 2}" y="102" text-anchor="middle" fill="{INK}"><tspan font-family="{JP}" font-size="9" font-weight="500" letter-spacing="1.5">思い出</tspan><tspan dx="6" font-family="{GRO}" font-size="10" font-weight="700" letter-spacing="2.6">THE NIGHT, IN ONE LINE</tspan></text>
    <g fill="none" stroke="{INK}">
      <ellipse cx="{W / 2}" cy="250" rx="214" ry="102" stroke-width="1.1" transform="rotate(-8 {W / 2} 250)"/>
      <ellipse cx="{W / 2}" cy="250" rx="188" ry="84" stroke-width="0.6" stroke-dasharray="1.5 3.5" transform="rotate(-8 {W / 2} 250)"/>
    </g>
    <circle cx="{W / 2 + 200}" cy="{250 - 66}" r="4" fill="{INK}"/>
    <text data-slot="tagline" x="{W / 2}" y="238" text-anchor="middle" font-family="{JP}" font-size="27" font-weight="700" letter-spacing="-0.2" fill="{INK}" data-wrap="286" data-lines="3" data-leading="1.22" data-min="13" data-prefix="“" data-suffix="”">.</text>
    <text data-slot="title" x="{W / 2}" y="394" text-anchor="middle" font-family="{GRO}" font-size="13" font-weight="700" letter-spacing="2.6" fill="{INK}" data-case="upper" data-wrap="360" data-lines="2" data-leading="1.3" data-anchor="bottom" data-min="9" data-prefix="—  ">.</text>
    <text x="{W / 2}" y="412" text-anchor="middle" font-family="{GRO}" font-size="9" font-weight="500" letter-spacing="1.8" fill="{INK}"><tspan data-slot="date">.</tspan><tspan>  ·  </tspan><tspan data-slot="categoryLabel">.</tspan></text>
    <rect x="{W / 2 - 70}" y="442" width="140" height="10" rx="5" fill="none" stroke="{INK}" stroke-width="1.6"/>
    <rect x="{W / 2 + 26}" y="445.6" width="38" height="2.8" rx="1.4" fill="{INK}"/>
  </g>
'''
    # line-up + QR
    rows = []
    for i in range(5):
        y = 566 + i * 23
        rows.append(f'<g data-show-if="people{i + 1}"><text x="40" y="{y}" font-family="{GRO}" font-size="8" font-weight="600" letter-spacing="1" fill="{GREY}">{i + 1:02d}</text>'
                    f'<text data-slot="people{i + 1}" x="62" y="{y}" font-family="{GRO}" font-size="13.5" font-weight="600" fill="{INK}" data-fit="230" data-min="8" data-fit-group="lineup">.</text></g>')
    s += f'''  <g data-layer="ink">
    <rect x="0" y="530" width="11" height="26" fill="{INK}"/>
    <text x="40" y="540" fill="{INK}"><tspan font-family="{JP}" font-size="7" font-weight="500">出演</tspan><tspan dx="4" font-family="{GRO}" font-size="7.8" font-weight="700" letter-spacing="0.9">LINE-UP</tspan></text>
    <path d="M40 549 H296" stroke="{INK}" stroke-width="0.6"/>
    {''.join(rows)}
    {brackets(326, 530, 440, 644)}
    <g data-slot="qr" data-size="98" data-color="{INK}" transform="translate(334 538)"></g>
    <text x="383" y="662" text-anchor="middle" fill="{INK}"><tspan font-family="{JP}" font-size="6.8" font-weight="500">記念</tspan><tspan dx="3" font-family="{GRO}" font-size="7" font-weight="700" letter-spacing="0.8">SCAN THE KEEPSAKE</tspan></text>
    <path d="M24 680 H456" stroke="{INK}" stroke-width="1.3"/>
  </g>
'''
    rating = []
    for i in range(5):
        cx = 150 + i * 38
        rating.append(f'<circle cx="{cx}" cy="707" r="10" fill="none" stroke="{INK}" stroke-width="1.2"/>'
                      f'<ellipse cx="{cx}" cy="707" rx="15" ry="4" fill="none" stroke="{INK}" stroke-width="0.7" transform="rotate(-14 {cx} 707)"/>')
    s += f'''  <g data-layer="ink">
    {label(40, 712, "評価", "RATING")}
    {''.join(rating)}
    <text x="440" y="711" text-anchor="end" font-family="{GRO}" font-size="10" font-weight="600" letter-spacing="1" fill="{INK}">(    / 5)</text>
    {label(40, 754, "感想", "REVIEW")}
    <path d="M104 756 H440 M40 786 H440" stroke="{INK}" stroke-width="0.8" stroke-dasharray="1.5 3"/>
    <path d="M24 806 H456" stroke="{INK}" stroke-width="1.3"/>
    {label(40, 838, "番号", "SERIAL")}
    <text data-slot="serial" x="104" y="839" font-family="{JP}" font-size="17" font-weight="700" letter-spacing="2.4" fill="{INK}" data-fit="190">.</text>
    {label(306, 838, "版", "EDITION")}
    {placeholder_value("edition", 440, 839, 17, 96, 96, 15, anchor="end")}
    {checker(40, 862, cols=26, rows=2, s=4)}
    <g data-slot="barcode" data-w="120" data-h="16" data-color="{INK}" transform="translate(320 860)"></g>
    <path d="M40 896 H440" stroke="{INK}" stroke-width="0.6"/>
    <text x="40" y="912" fill="{INK}"><tspan font-family="{JP}" font-size="6.8" font-weight="500">無断転売禁止</tspan><tspan dx="5" font-family="{GRO}" font-size="6.8" font-weight="600" letter-spacing="0.9">COMMEMORATIVE KEEPSAKE · NOT VALID FOR ENTRY</tspan></text>
    <text x="40" y="926" font-family="{GRO}" font-size="6.8" font-weight="500" letter-spacing="0.9" fill="{GREY}">PRINTED BY TICKETSTUB · HOLOGRAPHIC FILM ON 350GSM WHITE</text>
  </g>
'''
    s += grain_top() + DIELINE + "</svg>\n"
    # the back has no stamp; keep data-show-if placeholders card-coloured like the front
    return s


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "front.svg").write_text(front(), encoding="utf8")
    (OUT / "back.svg").write_text(back(), encoding="utf8")
    print("wrote", OUT)
