"""Premiere: night-sky stock, gold-foil orbital line work, a ruled programme card (cinema direction).

    python scripts/stub-lab/gen/premiere.py   -> public/stubs/premiere/{front,back}.svg

Front: a framed poster face. Cast in tracked serif caps, a foil orbit + bezel behind the cut-out,
a horizon glow, the title in Cormorant caps (shrinks to fit three lines), a short footer.
Back: the programme card. Same sky + glow, the title in the same serif, one value colour on one
baseline grid, and ornaments only in cells that never hold text (review cell edge, barcode cell).
"""
import math, random
from pathlib import Path
from die import scalloped

W, H = 480, 960
OUT = Path(__file__).resolve().parents[3] / "public" / "stubs" / "premiere"
DIE = scalloped(W, H, r=8, pitch=32, corner=14, edges="tb")
GOLD = "#c9a24f"
LABEL = "#b8914a"   # flat gold ink for field labels
IVORY = "#ece2cc"   # the one value colour
STOCK = "#0c0b0a"
MONO = "'Chakra Petch', 'Barlow Condensed', sans-serif"
SERIF = "'Cormorant Garamond', 'Bodoni Moda', serif"

def head(extra=""):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" data-foil="gold" {extra}>\n'


def starfield(seed, n, ok, ymax=600, fade=700):
    """Stars only where ok(x, y) says the stock is free of text."""
    rnd = random.Random(seed)
    out = []
    for _ in range(n * 4):
        if len(out) >= n:
            break
        x, y = rnd.uniform(6, W - 6), rnd.uniform(14, ymax)
        if not ok(x, y):
            continue
        r = rnd.choice([0.45, 0.55, 0.65, 0.75, 0.9, 1.15])
        o = rnd.uniform(0.25, 0.9) * max(0.15, 1 - y / fade)
        out.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r}" fill="#fff6e0" opacity="{o:.2f}"/>')
    return "".join(out)


def inside(x, y, boxes):
    return any(x0 <= x <= x1 and y0 <= y <= y1 for x0, y0, x1, y1 in boxes)


# shared sky so the faces read as one object
SKY = f'''<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#05060d"/>
      <stop offset="0.30" stop-color="#121320"/>
      <stop offset="0.47" stop-color="#2e2419"/>
      <stop offset="0.56" stop-color="#7d5a2c"/>
      <stop offset="0.63" stop-color="#2b2015"/>
      <stop offset="0.74" stop-color="{STOCK}"/>
    </linearGradient>'''


def frame(x0, y0, x1, y1, notch=9, gap_top=None, gap_bot=None):
    """Double keyline frame with concave (cinema-ticket) corners; optional centred breaks."""
    def outline(inset, w):
        a, b, c, d = x0 + inset, y0 + inset, x1 - inset, y1 - inset
        n = notch + inset * 0.0
        top = f"M{a + n} {b} H{c - n}" if not gap_top else f"M{a + n} {b} H{gap_top[0]} M{gap_top[1]} {b} H{c - n}"
        bot = f"M{c - n} {d} H{a + n}" if not gap_bot else f"M{c - n} {d} H{gap_bot[1]} M{gap_bot[0]} {d} H{a + n}"
        p = (f"{top} A{n} {n} 0 0 0 {c} {b + n} V{d - n} A{n} {n} 0 0 0 {c - n} {d} "
             f"{bot} A{n} {n} 0 0 0 {a} {d - n} V{b + n} A{n} {n} 0 0 0 {a + n} {b}")
        return f'<path d="{p}" fill="none" stroke="{GOLD}" stroke-width="{w}"/>'
    return outline(0, 1.1) + outline(4, 0.5)


# ------------------------------------------------------------------ front: the poster face
def ring(CX, CY, RR, inner=True):
    """Foil orbit: a ring with a milled bezel of ticks (catches the sheen), optional inner orbit + meridian."""
    ticks = []
    for i in range(120):
        a = math.radians(i * 3)
        r0, r1 = RR + 3, RR + (13 if i % 10 == 0 else 7)
        ticks.append(f"M{CX + r0 * math.cos(a):.2f} {CY + r0 * math.sin(a):.2f} L{CX + r1 * math.cos(a):.2f} {CY + r1 * math.sin(a):.2f}")
    out = [f'<circle cx="{CX}" cy="{CY}" r="{RR}" stroke-width="1.6"/>',
           f'<circle cx="{CX}" cy="{CY}" r="{RR + 18}" stroke-width="0.5"/>',
           f'<path d="{" ".join(ticks)}" stroke-width="0.75"/>']
    if inner:
        out += [f'<circle cx="{CX}" cy="{CY}" r="{RR - 40}" stroke-width="0.7" stroke-dasharray="2 4"/>',
                f'<path d="M40 {CY} H{CX + RR + 30}" stroke-width="0.7"/>',
                f'<circle cx="{CX + RR + 30}" cy="{CY}" r="3.2" fill="{GOLD}" stroke="none"/>']
    # a small planet riding the ring at ten o'clock
    a = math.radians(225)
    px, py = CX + RR * math.cos(a), CY + RR * math.sin(a)
    out.append(f'<circle cx="{px:.1f}" cy="{py:.1f}" r="3" fill="{GOLD}" stroke="none"/>')
    out.append(f'<circle cx="{px:.1f}" cy="{py:.1f}" r="7.5" stroke-width="0.7"/>')
    return "\n      ".join(out)


def front():
    A_C = (W / 2, 400, 168)   # ring when there is art
    N_C = (W / 2, 472, 204)   # ring when there is none (it frames the title)
    AY, AH = 180, 430         # art slot

    def ok(x, y):
        if inside(x, y, [(34, 46, W - 34, 158), (0, 0, W, 36), (50, 400, W - 50, 600)]):
            return False
        return 14 < x < W - 14 and not (abs(x - 18) < 8 or abs(x - (W - 18)) < 8)

    stars = starfield(40, 150, ok, ymax=560, fade=680)
    sparks = []
    rnd = random.Random(7)
    while len(sparks) < 12:
        x, y = rnd.uniform(30, W - 30), rnd.uniform(170, 380)
        if ok(x, y):
            sparks.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="1.2" fill="#bfe8f0" opacity="0.75"/>')

    # billing starts at people2: people1 is the headliner, who is usually the title already
    billing = "".join(
        f'<text data-slot="people{i + 2}" x="{W/2}" y="{76 + i * 22}" text-anchor="middle" font-family="{SERIF}" '
        f'font-weight="600" font-size="15" letter-spacing="3.3" data-case="upper" data-fit="372" data-min="9" data-fit-group="billing">.</text>'
        for i in range(4))
    TITLE = f'text-anchor="middle" font-family="{SERIF}" font-weight="600" data-case="upper" data-anchor="bottom" style="font-variant-numeric: lining-nums"'

    s = head()
    s += f'''  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#05060d"/>
      <stop offset="0.32" stop-color="#121424"/>
      <stop offset="0.62" stop-color="#110f13"/>
      <stop offset="0.8" stop-color="{STOCK}"/>
    </linearGradient>
    <radialGradient id="dawn" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#ffe0a0" stop-opacity="0.78"/>
      <stop offset="0.22" stop-color="#e8a34e" stop-opacity="0.46"/>
      <stop offset="0.55" stop-color="#b9772f" stop-opacity="0.14"/>
      <stop offset="1" stop-color="#b9772f" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="foot" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#e8a34e" stop-opacity="0.34"/>
      <stop offset="0.5" stop-color="#b9772f" stop-opacity="0.12"/>
      <stop offset="1" stop-color="#b9772f" stop-opacity="0"/>
    </radialGradient>
    <filter id="duotone" color-interpolation-filters="sRGB">
      <feColorMatrix type="matrix" values="0.30 0.59 0.11 0 0  0.30 0.59 0.11 0 0  0.30 0.59 0.11 0 0  0 0 0 1 0"/>
      <feComponentTransfer>
        <feFuncR type="table" tableValues="0.02 0.24 0.66 1.0"/>
        <feFuncG type="table" tableValues="0.02 0.17 0.48 0.91"/>
        <feFuncB type="table" tableValues="0.03 0.10 0.26 0.70"/>
      </feComponentTransfer>
    </filter>
    <linearGradient id="fadeV" gradientUnits="userSpaceOnUse" x1="0" y1="{AY}" x2="0" y2="{AY + AH}">
      <stop offset="0" stop-color="#fff"/>
      <stop offset="0.8" stop-color="#fff"/>
      <stop offset="0.99" stop-color="#000"/>
    </linearGradient>
    <mask id="fade" maskUnits="userSpaceOnUse" x="0" y="0" width="{W}" height="{H}">
      <rect width="{W}" height="{H}" fill="url(#fadeV)"/>
    </mask>
  </defs>
  <g data-layer="paper">
    <rect width="{W}" height="{H}" fill="{STOCK}"/>
    <rect width="{W}" height="{H}" fill="url(#sky)"/>
    <g>{stars}{''.join(sparks)}</g>
    <ellipse data-show-if="art" cx="{W/2}" cy="{A_C[1] + A_C[2] + 10}" rx="300" ry="170" fill="url(#dawn)"/>
    <ellipse data-hide-if="art" cx="{W/2}" cy="{N_C[1] + N_C[2] + 6}" rx="300" ry="150" fill="url(#dawn)"/>
    <ellipse cx="{W/2}" cy="{H + 30}" rx="380" ry="150" fill="url(#foot)"/>
  </g>
  <g data-layer="foil" fill="none" stroke="{GOLD}">
    {frame(18, 24, W - 18, 904, gap_top=(150, 330), gap_bot=(218, 262))}
    <g data-show-if="art">
      {ring(*A_C)}
    </g>
    <g data-hide-if="art">
      {ring(*N_C, inner=False)}
    </g>
    <path d="M240 15 L244 24 L240 33 L236 24 Z" fill="{GOLD}" stroke="none"/>
  </g>
  <g data-layer="art" mask="url(#fade)" data-show-if="art">
    <image data-slot="art" x="40" y="{AY}" width="400" height="{AH}" preserveAspectRatio="xMidYMax meet" filter="url(#duotone)"/>
  </g>
  <g data-layer="paper">
    <rect width="{W}" height="{H}" fill="#fff" filter="url(#ts-grain-light)" opacity="0.10"/>
  </g>
  <g data-layer="foil" fill="{GOLD}">
    <text data-slot="edition" x="226" y="28" text-anchor="end" font-family="{MONO}" font-size="9.5" font-weight="600" letter-spacing="1.4">.</text>
    <text data-slot="year" x="254" y="28" font-family="{MONO}" font-size="9.5" font-weight="600" letter-spacing="1.4" data-prefix="(" data-suffix=")">.</text>
    {billing}
    <g data-hide-if="people2">
      <text data-slot="categoryLabel" x="{W/2}" y="98" text-anchor="middle" font-family="{SERIF}" font-weight="600" font-size="15" letter-spacing="4.5">.</text>
      <path d="M150 93 H200 M280 93 H330" stroke="{GOLD}" stroke-width="0.7" fill="none"/>
    </g>
    <text data-show-if="art" data-slot="title" x="{W/2}" y="768" {TITLE} font-size="100" letter-spacing="6.5" data-wrap="384" data-lines="3" data-leading="0.92" data-min="30">.</text>
    <text data-hide-if="art" data-slot="title" x="{W/2}" y="{N_C[1] + 78}" {TITLE} font-size="74" letter-spacing="4.5" data-wrap="350" data-lines="4" data-leading="1.08" data-min="21">.</text>
    <path d="M166 792 H232 M248 792 H314" stroke="{GOLD}" stroke-width="0.9" fill="none"/>
    <path d="M240 787 L245 792 L240 797 L235 792 Z"/>
    <path d="M247 896 A9 9 0 1 0 247 912 A6 8.6 0 0 1 247 896 Z"/>
    <path d="M222 904 H230 M250 904 H258" stroke="{GOLD}" stroke-width="0.9" fill="none"/>
  </g>
  <g data-layer="ink" fill="{IVORY}" font-family="{MONO}">
    <text data-slot="subtitle" x="{W/2}" y="822" text-anchor="middle" font-size="12" font-weight="500" letter-spacing="3" data-case="upper" data-wrap="390" data-lines="2" data-leading="1.35" data-min="9.5" data-default="Admit One">.</text>
    <text data-slot="date" x="{W/2}" y="862" text-anchor="middle" font-size="11" letter-spacing="2.4" opacity="0.85">.</text>
    <text data-slot="place" x="{W/2}" y="879" text-anchor="middle" font-size="11" letter-spacing="2.2" opacity="0.85" data-case="upper" data-fit="400" data-min="8">.</text>
    <text x="{W/2}" y="936" text-anchor="middle" font-size="8" letter-spacing="0.9" opacity="0.6">© TICKETSTUB · COMMEMORATIVE KEEPSAKE · NOT VALID FOR ENTRY</text>
  </g>
  <path data-layer="dieline" d="{DIE}" fill="none" stroke="#ec008c" stroke-width="0.5"/>
</svg>
'''
    return s


# ------------------------------------------------------------------ back: the programme card
L, R = 36, 444  # card frame
Y_TOP, Y_BOT = 60, 886
RULES = [196, 342, 394, 528, 600, 682]


def back_ornaments():
    """Gold line work confined to cells/zones that never carry text."""
    p = []

    def c(cx, cy, r, w=1.0, dash=None):
        da = f' stroke-dasharray="{dash}"' if dash else ""
        p.append(f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="none" stroke="{GOLD}" stroke-width="{w}"{da}/>')

    def dot(cx, cy, r):
        p.append(f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="{GOLD}"/>')

    # review cell, right end: record-groove orbits rising from beyond the right edge
    p.append('<g clip-path="url(#reviewCell)">')
    for i, r in enumerate(range(22, 84, 6)):
        c(486, 461, r, 0.9 if i % 3 == 0 else 0.5)
    p.append(f'<path d="M352 461 H{R}" stroke="{GOLD}" stroke-width="0.6" fill="none"/>')
    dot(404, 461, 4.5)
    c(404, 461, 9, 0.8)
    p.append('</g>')
    # date/time cell, right end: four phases of the moon
    for i, ph in enumerate([0.0, 0.5, 1.0, 1.5]):
        x, y, r = 360 + i * 21, 575, 6.5
        c(x, y, r, 0.8)
        if ph == 1.0:
            dot(x, y, r)
        elif ph == 0.5:
            p.append(f'<path d="M{x} {y - r} A{r} {r} 0 0 1 {x} {y + r} Z" fill="{GOLD}"/>')
        elif ph == 1.5:
            p.append(f'<path d="M{x} {y - r} A{r} {r} 0 0 0 {x} {y + r} Z" fill="{GOLD}"/>')
    # barcode cell, left: a small orbit system tucked into the corner
    p.append('<g clip-path="url(#tagCell)">')
    for r, w in [(70, 1.0), (54, 0.6), (40, 0.6)]:
        c(L, Y_BOT, r, w)
    c(L, Y_BOT, 26, 0.6, "2 3")
    dot(L + 49, Y_BOT - 49, 4)
    c(L + 49, Y_BOT - 49, 9, 0.8)
    p.append('</g>')
    # barcode cell, right: the big crescent and its orbit
    cx, cy, r = 384, 802, 36
    p.append(f'<ellipse cx="{cx}" cy="{cy}" rx="50" ry="13" fill="none" stroke="{GOLD}" stroke-width="0.7" transform="rotate(-14 {cx} {cy})"/>')
    c(cx, cy, r, 1.1)
    p.append(f'<path d="M{cx} {cy - r} A{r} {r} 0 0 1 {cx} {cy + r} A{r * 0.58:.1f} {r} 0 0 0 {cx} {cy - r} Z" fill="{GOLD}"/>')
    return "\n    ".join(p)


def back():
    lab = f'font-family="{MONO}" font-size="12" font-weight="500" fill="{LABEL}"'
    val = f'font-family="{MONO}" font-size="12.5" font-weight="400" fill="{IVORY}"'
    big = f'font-family="{MONO}" font-weight="600" fill="{IVORY}"'
    dash = f'stroke="{GOLD}" stroke-width="0.8" stroke-dasharray="2.5 3" fill="none"'
    rule = f'stroke="{GOLD}" stroke-width="1" fill="none"'
    VX = 128  # value column
    VW = R - 16 - VX

    rating = []
    for i in range(5):
        cx = 150 + i * 38
        rating.append(f'<circle cx="{cx}" cy="368" r="13" fill="none" stroke="{GOLD}" stroke-width="1.1"/>'
                      f'<circle cx="{cx}" cy="368" r="8.5" fill="none" stroke="{GOLD}" stroke-width="0.6"/>'
                      f'<path d="M{cx - 13} 368 H{cx + 13}" stroke="{GOLD}" stroke-width="0.6"/>'
                      f'<path d="M{cx + 1} 360.5 A7.5 7.5 0 0 1 {cx + 1} 375.5 A4.4 7.5 0 0 0 {cx + 1} 360.5 Z" fill="{GOLD}"/>')
    brand = []
    letters = "TICKETSTUB"
    bx = R - len(letters) * 11
    for i, ch in enumerate(letters):
        x = bx + i * 11
        brand.append(f'<rect x="{x}" y="904" width="10" height="14" fill="none" stroke="{GOLD}" stroke-width="0.8"/>'
                     f'<text x="{x + 5}" y="915" text-anchor="middle" font-family="{MONO}" font-size="9.5" font-weight="700">{ch}</text>')

    # stars only in the margins and the head/foot strips, never on text
    text_boxes = [(L - 2, 30, 250, 52), (330, 30, R + 2, 52), (L - 2, 896, 160, 924), (bx - 4, 900, R + 4, 922)]

    def ok(x, y):
        if inside(x, y, text_boxes):
            return False
        in_margin = x < L - 6 or x > R + 6
        in_strip = (14 < y < Y_TOP - 6) or (Y_BOT + 6 < y < 944)
        return (in_margin and 14 < y < 944) or (in_strip and 10 < x < W - 10)

    stars = starfield(12, 95, ok, ymax=944, fade=1500)

    s = head()
    s += f'''  <defs>
    {SKY}
    <linearGradient id="skyBack" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#070810"/>
      <stop offset="0.45" stop-color="#0e0d12"/>
      <stop offset="0.80" stop-color="{STOCK}"/>
      <stop offset="1" stop-color="#1a130c"/>
    </linearGradient>
    <radialGradient id="glowBack" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#e8a34e" stop-opacity="0.38"/>
      <stop offset="0.5" stop-color="#b9772f" stop-opacity="0.14"/>
      <stop offset="1" stop-color="#b9772f" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="nightBack" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#1d2645" stop-opacity="0.75"/>
      <stop offset="1" stop-color="#1d2645" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="reviewCell"><rect x="{L}" y="{RULES[2]}" width="{R - L}" height="{RULES[3] - RULES[2]}"/></clipPath>
    <clipPath id="tagCell"><rect x="{L}" y="{RULES[5]}" width="{R - L}" height="{Y_BOT - RULES[5]}"/></clipPath>
  </defs>
  <g data-layer="paper">
    <rect width="{W}" height="{H}" fill="url(#skyBack)"/>
    <ellipse cx="{W/2}" cy="{H + 10}" rx="360" ry="190" fill="url(#glowBack)"/>
    <ellipse cx="{W/2}" cy="-20" rx="420" ry="260" fill="url(#nightBack)"/>
    <g>{stars}</g>
    <rect width="{W}" height="{H}" fill="#fff" filter="url(#ts-grain-light)" opacity="0.08"/>
  </g>
  <g data-layer="foil" fill="{GOLD}">
    {back_ornaments()}
    <rect x="{L}" y="{Y_TOP}" width="{R - L}" height="{Y_BOT - Y_TOP}" fill="none" stroke="{GOLD}" stroke-width="1.3"/>
    <text x="{L + 2}" y="45" font-family="{MONO}" font-size="11" font-weight="700" letter-spacing="1.2">TICKETSTUB ORIGINAL TICKET</text>
    <text data-slot="edition" x="{R - 2}" y="45" text-anchor="end" font-family="{MONO}" font-size="11" font-weight="700" letter-spacing="1">.</text>
    <text data-slot="title" x="{W/2}" y="148" text-anchor="middle" font-family="{SERIF}" font-size="38" font-weight="600" letter-spacing="2.6" data-case="upper" data-wrap="340" data-lines="3" data-leading="1.08" data-anchor="bottom" data-min="13" style="font-variant-numeric: lining-nums">.</text>
    <path d="M{L} {RULES[0]} H{R} M{L} {RULES[1]} H{R} M{L} {RULES[2]} H{R} M{L} {RULES[3]} H{R} M{L} {RULES[4]} H{R} M{L} {RULES[5]} H{R}" {rule}/>
    {''.join(rating)}
    <path d="M{L + 16} 448 H340 M{L + 16} 476 H340 M{L + 16} 504 H340" {dash}/>
    <path d="M240 {RULES[3]} V{RULES[4]}" {dash}/>
    <path d="M172 {RULES[4]} V{RULES[5]} M308 {RULES[4]} V{RULES[5]}" {dash}/>
    <g data-slot="barcode" data-w="204" data-h="40" transform="translate(110 768)"></g>
    <text x="{L + 2}" y="916" font-family="{MONO}" font-size="12" font-weight="700" letter-spacing="0.6">KEEP THE NIGHT™</text>
    {''.join(brand)}
  </g>
  <g data-layer="ink">
    <text x="{L + 16}" y="88" {lab}>Title</text>
    <text data-slot="year" x="{R - 16}" y="88" text-anchor="end" {val} data-prefix="(" data-suffix=")">.</text>
    <text data-slot="subtitle" x="{W/2}" y="177" text-anchor="middle" font-family="{SERIF}" font-style="italic" font-size="17" font-weight="500" fill="{IVORY}" data-wrap="370" data-lines="1" data-min="10.5">.</text>
    <text x="{L + 16}" y="222" {lab}>Event</text><text data-slot="kicker" x="{VX}" y="222" {val} data-default="—" data-fit="{VW}" data-min="9">.</text>
    <text x="{L + 16}" y="242" {lab}>Venue</text><text data-slot="venue" x="{VX}" y="242" {val} data-default="—" data-fit="{VW}" data-min="9">.</text>
    <text x="{L + 16}" y="262" {lab}>City</text><text data-slot="city" x="{VX}" y="262" {val} data-default="—" data-fit="{VW}" data-min="9">.</text>
    <text x="{L + 16}" y="282" {lab}>With</text><text data-slot="peopleAll" x="{VX}" y="282" {val} data-default="—" data-wrap="{VW}" data-lines="3" data-leading="1.6" data-min="12.5">.</text>
    <text x="{L + 16}" y="372" {lab}>Rating</text>
    <text x="{R - 16}" y="372" text-anchor="end" {val}>(   / 5)</text>
    <text x="{L + 16}" y="420" {lab}>Review</text>
    <text x="{L + 16}" y="552" {lab}>Date</text><text x="256" y="552" {lab}>Time</text>
    <text data-slot="dateDots" x="{L + 16}" y="584" {big} font-size="19" letter-spacing="1" data-default="—">.</text>
    <text data-slot="time" x="256" y="584" {big} font-size="19" letter-spacing="1" data-default="—">.</text>
    <text x="104" y="626" text-anchor="middle" {lab}>Section</text>
    <text x="240" y="626" text-anchor="middle" {lab}>Row</text>
    <text x="376" y="626" text-anchor="middle" {lab}>Seat</text>
    <text data-slot="section" data-default="—" x="104" y="664" text-anchor="middle" {big} font-size="24" data-fit="118">—</text>
    <text data-slot="row" data-default="—" x="240" y="664" text-anchor="middle" {big} font-size="24" data-fit="118">—</text>
    <text data-slot="seat" data-default="—" x="376" y="664" text-anchor="middle" {big} font-size="24" data-fit="118">—</text>
    <text data-slot="tagline" x="{W/2}" y="720" text-anchor="middle" font-family="{SERIF}" font-style="italic" font-size="18" font-weight="500" fill="{IVORY}" data-wrap="320" data-lines="2" data-leading="1.28" data-min="12.5" data-prefix="“" data-suffix="”">.</text>
    <text data-slot="serial" x="212" y="826" text-anchor="middle" font-family="{MONO}" font-size="9.5" letter-spacing="3" fill="{LABEL}">.</text>
    <text x="{W/2}" y="868" text-anchor="middle" font-family="{MONO}" font-size="8" letter-spacing="1" fill="{IVORY}" opacity="0.55">COMMEMORATIVE KEEPSAKE · NOT VALID FOR ENTRY</text>
  </g>
  <path data-layer="dieline" d="{DIE}" fill="none" stroke="#ec008c" stroke-width="0.5"/>
</svg>
'''
    return s


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "front.svg").write_text(front(), encoding="utf8")
    (OUT / "back.svg").write_text(back(), encoding="utf8")
    print("wrote", OUT)
