"""Wildcard: festival poster stub. A duotone performer inside a gold-foil frame of flames, stars and a
sunburst, vertical letter columns and a hot-pink display title; kraft back with a ruled info card and map.

    python scripts/stub-lab/gen/wildcard.py   -> public/stubs/wildcard/{front,back}.svg
"""
import math, random
from pathlib import Path

W, H = 480, 960
OUT = Path(__file__).resolve().parents[3] / "public" / "stubs" / "wildcard"
GOLD = "#c9a24f"
PINK = "#ff3d7f"
CHAR = "#16131a"
CREAM = "#f3e6c8"
KRAFT = "#c49a5e"
INK = "#2a1a0e"
DISP = "'Big Shoulders Display', 'Oswald', 'Arial Narrow', sans-serif"
MONO = "'JetBrains Mono', 'Courier New', monospace"

B = 20            # frame band
PERF = 151        # perforation line between header strip and body
HEAD = (B, B, W - 2 * B, 118)            # x, y, w, h  (header strip panel)
BODY = (B, 164, W - 2 * B, H - 164 - B)  # main panel


def f(v):
    return f"{v:.2f}".rstrip("0").rstrip(".")


# ------------------------------------------------------------------ shapes
def die():
    """Rounded-step corners (a quarter bite) and round notches at the perforation."""
    c, n = 20, 12
    return (f"M{c} 0 H{W-c} A{c} {c} 0 0 0 {W} {c} V{PERF-n} A{n} {n} 0 0 0 {W} {PERF+n} "
            f"V{H-c} A{c} {c} 0 0 0 {W-c} {H} H{c} A{c} {c} 0 0 0 0 {H-c} V{PERF+n} "
            f"A{n} {n} 0 0 0 0 {PERF-n} V{c} A{c} {c} 0 0 0 {c} 0Z")


def notch_rect(x, y, w, h, c=12):
    """Rectangle with concave (bitten) corners, the panel shape that echoes the die."""
    return (f"M{f(x+c)} {f(y)} H{f(x+w-c)} A{c} {c} 0 0 0 {f(x+w)} {f(y+c)} V{f(y+h-c)} "
            f"A{c} {c} 0 0 0 {f(x+w-c)} {f(y+h)} H{f(x+c)} A{c} {c} 0 0 0 {f(x)} {f(y+h-c)} "
            f"V{f(y+c)} A{c} {c} 0 0 0 {f(x+c)} {f(y)}Z")


# Hand-drawn flame (100 x 216 box, tail at 36,216): curling split tongues, two detached flicks and
# negative-space cuts (evenodd), after the tattoo flames of ref 05.
FLAME = ("M36 216 C44 198 24 186 18 166 C14 148 24 126 20 108 C18 92 10 82 0 80 C-4 80 -6 86 -3 90 C-8 82 -2 72 8 72 C22 72 30 86 30 102 C30 110 32 116 36 120 C38 96 30 66 36 44 C40 22 52 10 66 6 C74 4 80 8 80 14 C80 20 74 22 72 18 C74 14 70 12 64 16 C54 24 52 44 56 62 C58 74 62 80 62 90 C68 76 72 66 74 54 C75 46 72 40 68 36 C78 38 84 46 82 56 C88 48 92 40 92 30 C100 44 100 64 94 82 C90 96 82 108 84 126 C88 160 72 196 36 216Z M52 178 C44 174 40 162 44 152 C46 158 50 158 50 152 C50 146 54 140 58 136 C62 150 62 172 52 178Z M46 108 C42 86 46 62 56 46 C52 66 52 88 56 110 C53 113 48 113 46 108Z M84 6 C90 -2 96 -2 100 2 C94 2 90 6 88 12 C86 10 84 8 84 6Z M10 50 C6 42 8 34 14 30 C12 38 14 44 18 48 C15 50 12 51 10 50Z")


def fh(x, y, s=1.0, rot=0, flip=False, sy=1.0):
    """Place the flame with its tail at x, y."""
    sx = -s if flip else s
    return (f'<path d="{FLAME}" fill-rule="evenodd" fill="{GOLD}" '
            f'transform="translate({f(x)} {f(y)}) rotate({rot}) scale({f(sx)} {f(s*sy)}) translate(-36 -216)"/>')


def sparkle(x, y, r, op=1.0):
    k = r * 0.16
    o = f' opacity="{op}"' if op < 1 else ""
    return (f'<path d="M{f(x)} {f(y-r)} C{f(x+k)} {f(y-k)} {f(x+k)} {f(y-k)} {f(x+r)} {f(y)} '
            f'C{f(x+k)} {f(y+k)} {f(x+k)} {f(y+k)} {f(x)} {f(y+r)} C{f(x-k)} {f(y+k)} {f(x-k)} {f(y+k)} {f(x-r)} {f(y)} '
            f'C{f(x-k)} {f(y-k)} {f(x-k)} {f(y-k)} {f(x)} {f(y-r)}Z" fill="{GOLD}"{o}/>')


def star5(cx, cy, R, r=None, fill=GOLD, stroke=None, sw=1):
    r = r or R * 0.42
    pts = []
    for i in range(10):
        a = -math.pi / 2 + i * math.pi / 5
        rr = R if i % 2 == 0 else r
        pts.append(f"{f(cx + rr * math.cos(a))},{f(cy + rr * math.sin(a))}")
    st = f' stroke="{stroke}" stroke-width="{sw}" stroke-linejoin="round"' if stroke else ""
    return f'<polygon points="{" ".join(pts)}" fill="{fill}"{st}/>'


def sunburst(cx, cy, r0, r1, n=56):
    out = []
    for i in range(n):
        a = 2 * math.pi * i / n
        long = i % 2 == 0
        R = r1 if long else r1 * 0.78
        hw = (0.011 if long else 0.006)
        p1 = (cx + r0 * math.cos(a - hw * 0.4), cy + r0 * math.sin(a - hw * 0.4))
        p2 = (cx + R * math.cos(a - hw), cy + R * math.sin(a - hw))
        p3 = (cx + R * math.cos(a + hw), cy + R * math.sin(a + hw))
        p4 = (cx + r0 * math.cos(a + hw * 0.4), cy + r0 * math.sin(a + hw * 0.4))
        out.append(f"M{f(p1[0])} {f(p1[1])}L{f(p2[0])} {f(p2[1])}L{f(p3[0])} {f(p3[1])}L{f(p4[0])} {f(p4[1])}Z")
    return f'<path d="{"".join(out)}" fill="{GOLD}"/>'


def sunrise_mark(hx, hy, hw, hh):
    """A sun rising over its own horizon rule, kept inside the strip's keyline."""
    sx0, sy0 = hx + hw - 72, hy + hh - 18
    rays = sunburst(sx0, sy0, 30, 58, 36)
    return (f'<clipPath id="sunclip"><rect x="{hx+8}" y="{hy+8}" width="{hw-16}" height="{sy0-hy-8}"/></clipPath>'
            f'<g clip-path="url(#sunclip)"><circle cx="{sx0}" cy="{sy0}" r="19"/>'
            f'<circle cx="{sx0}" cy="{sy0}" r="24" fill="none" stroke="{GOLD}" stroke-width="0.8"/>{rays}</g>'
            f'<path d="M{sx0-74} {sy0} H{sx0+52}" stroke="{GOLD}" stroke-width="0.9" fill="none"/>'
            f'<path d="M{sx0-50} {sy0+5} H{sx0+30} M{sx0-26} {sy0+9} H{sx0+8}" stroke="{GOLD}" stroke-width="0.6" fill="none"/>')


def head(extra=""):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" data-foil="gold" {extra}>\n'


# ------------------------------------------------------------------ front: the poster
def front():
    hx, hy, hw, hh = HEAD
    bx, by, bw, bh = BODY
    rnd = random.Random(5)
    specks = []
    for _ in range(80):
        x, y = rnd.uniform(bx + 70, bx + bw - 70), rnd.uniform(by + 10, by + 420)
        specks.append(f'<circle cx="{f(x)}" cy="{f(y)}" r="{rnd.choice([0.5,0.6,0.8,1])}" fill="{CREAM}" opacity="{rnd.uniform(.15,.5):.2f}"/>')
    cx, cy = 248, 452  # sun centre, behind the performer
    TB = by + bh - 114  # title baseline (bottom line)

    flames = [
        fh(100, 576, 0.64, rot=-4), fh(380, 576, 0.64, rot=4, flip=True),
        fh(150, 582, 0.38, rot=4, flip=True), fh(332, 584, 0.36, rot=-4),
        fh(112, 456, 0.36, rot=-20), fh(374, 404, 0.4, rot=18, flip=True),
    ]
    sunrise = sunrise_mark(hx, hy, hw, hh)
    sparkles = [sparkle(366, 236, 12), sparkle(392, 268, 5.5), sparkle(78, 360, 7), sparkle(368, 418, 5),
                sparkle(196, 206, 4.5), sparkle(408, 484, 6.5), sparkle(278, 190, 3.5, .8)]
    frame = f'M0 0H{W}V{H}H0Z ' + notch_rect(hx, hy, hw, hh, 12) + " " + notch_rect(bx, by, bw, bh, 14)
    perf = "".join(f'<circle cx="{f(x)}" cy="{PERF}" r="1.6"/>' for x in range(22, W - 20, 8))
    col = (f'font-family="{DISP}" font-weight="800" fill="{PINK}" font-size="19" letter-spacing="9" writing-mode="vertical-rl" '
           f'style="text-orientation: upright; font-variant-numeric: lining-nums" data-fit="400" data-min="11"')
    title = (f'text-anchor="middle" font-family="{DISP}" font-weight="900" font-size="132" letter-spacing="1" '
             f'style="font-variant-numeric: lining-nums" data-case="upper" data-wrap="360" data-lines="4" '
             f'data-leading="0.98" data-anchor="bottom" data-min="28"')

    s = head()
    s += f'''  <defs>
    <clipPath id="bodyclip"><path d="{notch_rect(bx, by, bw, bh, 14)}"/></clipPath>
    <clipPath id="headclip"><path d="{notch_rect(hx, hy, hw, hh, 12)}"/></clipPath>
    <radialGradient id="sun" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#ffb24a" stop-opacity="0.92"/>
      <stop offset="0.4" stop-color="#d9672c" stop-opacity="0.5"/>
      <stop offset="1" stop-color="#6e1f2c" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="panel" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1c171f"/>
      <stop offset="0.55" stop-color="#221a1d"/>
      <stop offset="1" stop-color="#120f13"/>
    </linearGradient>
    <radialGradient id="rayfade" gradientUnits="userSpaceOnUse" cx="{cx}" cy="{cy}" r="330">
      <stop offset="0.3" stop-color="#fff"/>
      <stop offset="1" stop-color="#000"/>
    </radialGradient>
    <mask id="raymask" maskUnits="userSpaceOnUse" x="0" y="0" width="{W}" height="{H}">
      <rect width="{W}" height="{H}" fill="url(#rayfade)"/>
    </mask>
    <linearGradient id="laneG" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="{W}" y2="0">
      <stop offset="0.11" stop-color="#000"/><stop offset="0.2" stop-color="#fff"/>
      <stop offset="0.8" stop-color="#fff"/><stop offset="0.89" stop-color="#000"/>
    </linearGradient>
    <linearGradient id="floorG" gradientUnits="userSpaceOnUse" x1="0" y1="{by+bh-380}" x2="0" y2="{by+bh-290}">
      <stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/>
    </linearGradient>
    <mask id="lanemask" maskUnits="userSpaceOnUse" x="0" y="0" width="{W}" height="{H}">
      <rect width="{W}" height="{H}" fill="url(#laneG)"/>
    </mask>
    <mask id="floormask" maskUnits="userSpaceOnUse" x="0" y="0" width="{W}" height="{H}">
      <rect width="{W}" height="{H}" fill="url(#floorG)"/>
    </mask>
    <filter id="duo" color-interpolation-filters="sRGB">
      <feColorMatrix type="matrix" values="0.30 0.59 0.11 0 0  0.30 0.59 0.11 0 0  0.30 0.59 0.11 0 0  0 0 0 1 0"/>
      <feComponentTransfer>
        <feFuncR type="table" tableValues="0.08 0.34 0.84 1.0 1.0"/>
        <feFuncG type="table" tableValues="0.07 0.12 0.40 0.72 0.94"/>
        <feFuncB type="table" tableValues="0.10 0.15 0.18 0.30 0.72"/>
      </feComponentTransfer>
    </filter>
    <linearGradient id="fadeG" gradientUnits="userSpaceOnUse" x1="0" y1="470" x2="0" y2="584">
      <stop offset="0" stop-color="#fff"/>
      <stop offset="1" stop-color="#000"/>
    </linearGradient>
    <linearGradient id="fadeX" gradientUnits="userSpaceOnUse" x1="{bx}" y1="0" x2="{bx+bw}" y2="0">
      <stop offset="0" stop-color="#000"/><stop offset="0.1" stop-color="#fff"/>
      <stop offset="0.9" stop-color="#fff"/><stop offset="1" stop-color="#000"/>
    </linearGradient>
    <mask id="fade" maskUnits="userSpaceOnUse" x="0" y="0" width="{W}" height="{H}">
      <rect width="{W}" height="{H}" fill="url(#fadeG)"/>
    </mask>
    <linearGradient id="foot" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#16121a" stop-opacity="0"/>
      <stop offset="0.2" stop-color="#18131a" stop-opacity="0.75"/>
      <stop offset="0.32" stop-color="#17121a"/>
      <stop offset="1" stop-color="#120f13"/>
    </linearGradient>
    <clipPath id="frameclip"><path clip-rule="evenodd" d="{frame}"/></clipPath>
    <filter id="brushL" x="0" y="0" width="1" height="1" filterUnits="objectBoundingBox">
      <feTurbulence type="fractalNoise" baseFrequency="0.003 1.1" numOctaves="2" seed="4"/>
      <feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 0.95  0 0 0 0 0.8  1.6 0 0 0 -0.7"/>
    </filter>
    <filter id="brushD" x="0" y="0" width="1" height="1" filterUnits="objectBoundingBox">
      <feTurbulence type="fractalNoise" baseFrequency="0.004 0.9" numOctaves="2" seed="9"/>
      <feColorMatrix type="matrix" values="0 0 0 0 0.25  0 0 0 0 0.16  0 0 0 0 0.05  0 1.6 0 0 -0.7"/>
    </filter>
    <mask id="fadex" maskUnits="userSpaceOnUse" x="0" y="0" width="{W}" height="{H}">
      <rect width="{W}" height="{H}" fill="url(#fadeX)"/>
    </mask>
  </defs>
  <g data-layer="paper">
    <rect width="{W}" height="{H}" fill="#b98c4a"/>
    <path d="{notch_rect(hx, hy, hw, hh, 12)}" fill="url(#panel)"/>
    <path d="{notch_rect(bx, by, bw, bh, 14)}" fill="url(#panel)"/>
    <g clip-path="url(#bodyclip)">
      <circle cx="{cx}" cy="{cy}" r="240" fill="url(#sun)"/>
      {''.join(specks)}
      <circle cx="116" cy="222" r="32" fill="{CREAM}"/>
      <circle cx="106" cy="213" r="5" fill="#dccba6" opacity="0.75"/>
      <circle cx="128" cy="232" r="7" fill="#dccba6" opacity="0.6"/>
      <circle cx="122" cy="204" r="2.6" fill="#dccba6" opacity="0.7"/>
      <circle cx="101" cy="238" r="3.3" fill="#dccba6" opacity="0.55"/>
    </g>
  </g>
  <g data-layer="foil" fill="{GOLD}">
    <g mask="url(#lanemask)"><g mask="url(#floormask)"><g mask="url(#raymask)" opacity="0.7">{sunburst(cx, cy, 128, 470, 72)}</g></g></g>
    <circle cx="{cx}" cy="{cy}" r="120" fill="none" stroke="{GOLD}" stroke-width="1.1"/>
    <circle cx="{cx}" cy="{cy}" r="112" fill="none" stroke="{GOLD}" stroke-width="0.6" stroke-dasharray="1.2 3.4"/>
    <circle cx="116" cy="222" r="38" fill="none" stroke="{GOLD}" stroke-width="0.7"/>
    {sparkle(cx, cy, 64)}
    <circle cx="{cx}" cy="{cy}" r="16" fill="none" stroke="{GOLD}" stroke-width="0.8"/>
    <circle cx="{cx}" cy="{cy}" r="58" fill="none" stroke="{GOLD}" stroke-width="0.6" stroke-dasharray="0.8 3"/>
  </g>
  <g data-layer="art" clip-path="url(#bodyclip)" mask="url(#fadex)">
    <g mask="url(#fade)">
      <image data-slot="art" x="52" y="238" width="376" height="520" preserveAspectRatio="xMidYMid meet" filter="url(#duo)"/>
    </g>
  </g>
  <g data-layer="paper">
    <rect x="{bx}" y="440" width="{bw}" height="{by+bh-440}" fill="url(#foot)" clip-path="url(#bodyclip)"/>
    <rect width="{W}" height="{H}" fill="#fff" filter="url(#ts-grain-light)" opacity="0.07"/>
    <rect width="{W}" height="{H}" fill="#000" filter="url(#ts-grain)" opacity="0.10"/>
  </g>
  <g data-layer="foil" fill="{GOLD}">
    <path d="{frame}" fill-rule="evenodd" fill="{GOLD}"/>
    <path d="{notch_rect(hx+5, hy+5, hw-10, hh-10, 9)}" fill="none" stroke="{GOLD}" stroke-width="0.8"/>
    <path d="{notch_rect(bx+5, by+5, bw-10, bh-10, 11)}" fill="none" stroke="{GOLD}" stroke-width="0.8"/>
    <g clip-path="url(#bodyclip)">{''.join(flames)}{''.join(sparkles)}</g>
    <g clip-path="url(#headclip)">{sunrise}{sparkle(hx+hw-150, hy+50, 5)}{sparkle(hx+hw-128, hy+70, 3)}</g>
    <text data-slot="admit" data-default="Admit one" x="{hx+20}" y="{hy+30}" font-family="{MONO}" font-size="8.5" font-weight="700" letter-spacing="2.4" data-case="upper" data-fit="180">.</text>
    <text data-slot="edition" x="{hx+hw-20}" y="{hy+30}" text-anchor="end" font-family="{MONO}" font-size="8.5" font-weight="700" letter-spacing="1.6" data-fit="120">.</text>
    <text data-slot="title" x="{W/2+1.2}" y="{TB+1.4}" {title}>.</text>
    <path d="M{bx+70} {TB+18} H{W/2-14} M{W/2+14} {TB+18} H{bx+bw-70}" stroke="{GOLD}" stroke-width="0.9" fill="none"/>
    {star5(W/2, TB+18, 6)}
  </g>
  <g data-layer="ink" fill="#1a1418">
    <g clip-path="url(#frameclip)" data-screen-only="">
      <rect width="{W}" height="{H}" fill="#c9a24f" opacity="0.28"/>
      <rect width="{W}" height="{H}" fill="#fff" filter="url(#brushL)" opacity="0.5"/>
      <rect width="{W}" height="{H}" fill="#000" filter="url(#brushD)" opacity="0.5"/>
    </g>
    <g opacity="0.6">{perf}</g>
  </g>
  <g data-layer="ink">
    <text data-slot="categoryLabel" x="{hx+18}" y="{hy+84}" font-family="{DISP}" font-weight="800" fill="{PINK}" font-size="44" letter-spacing="13" data-fit="250" data-min="22">.</text>
    <text data-slot="kicker" data-default="Commemorative stub" x="{hx+20}" y="{hy+102}" font-family="{MONO}" font-size="8" font-weight="500" letter-spacing="2.2" fill="{CREAM}" opacity="0.72" data-case="upper" data-fit="250">.</text>
    <text x="44" y="{by+30}" {col}><tspan data-slot="date">.</tspan></text>
    <text x="436" y="{by+30}" {col}><tspan data-slot="weekday">.</tspan><tspan data-slot="time" data-prefix=" · ">.</tspan></text>
    <text data-slot="title" x="{W/2}" y="{TB}" fill="{PINK}" {title}>.</text>
    <text data-slot="subtitle" x="{W/2}" y="{TB+48}" text-anchor="middle" font-family="{MONO}" font-size="10" font-weight="600" letter-spacing="2.2" fill="{CREAM}" data-case="upper" data-wrap="384" data-lines="2" data-leading="1.3" data-anchor="bottom" data-min="7.5">.</text>
    <text data-show-if="subtitle" x="{W/2}" y="{TB+66}" text-anchor="middle" font-family="{MONO}" font-size="9" letter-spacing="1.4" fill="{CREAM}" opacity="0.75" data-wrap="384" data-lines="2" data-leading="1.3" data-min="7"><tspan data-slot="date">.</tspan><tspan> · </tspan><tspan data-slot="place" data-case="upper">.</tspan></text>
    <text data-hide-if="subtitle" x="{W/2}" y="{TB+46}" text-anchor="middle" font-family="{MONO}" font-size="9" letter-spacing="1.4" fill="{CREAM}" opacity="0.75" data-wrap="384" data-lines="2" data-leading="1.3" data-min="7"><tspan data-slot="date">.</tspan><tspan> · </tspan><tspan data-slot="place" data-case="upper">.</tspan></text>
    <text x="{W/2}" y="{by+bh-14}" text-anchor="middle" font-family="{MONO}" font-size="6.5" letter-spacing="1.3" fill="{CREAM}" opacity="0.45">TICKETSTUB · COMMEMORATIVE KEEPSAKE · NOT VALID FOR ENTRY</text>
  </g>
  <path data-layer="dieline" d="{die()}" fill="none" stroke="#ec008c" stroke-width="0.5"/>
</svg>
'''
    return s


# ------------------------------------------------------------------ back: kraft info card
def back():
    L, R = 40, 404
    lab = f'font-family="{MONO}" font-size="7.5" font-weight="700" letter-spacing="1.8" fill="{INK}" opacity="0.72"'
    big = f'font-family="{DISP}" font-weight="800" fill="{INK}" style="font-variant-numeric: lining-nums"'
    rule = f'stroke="{GOLD}" stroke-width="1.4" fill="none"'
    hair = f'stroke="{GOLD}" stroke-width="0.9" fill="none"'
    dash = f'stroke="{INK}" stroke-width="0.7" stroke-dasharray="2 2.6" fill="none" opacity="0.6"'
    perf = "".join(f'<circle cx="{f(x)}" cy="{PERF}" r="1.6"/>' for x in range(22, W - 20, 8))
    hx, hy, hw, hh = HEAD
    bx, by, bw, bh = BODY
    rnd = random.Random(21)
    fibres = []
    for _ in range(160):  # kraft flecks: short dark and light hairs
        x, y = rnd.uniform(0, W), rnd.uniform(0, H)
        a = rnd.uniform(0, math.pi)
        l = rnd.uniform(1.5, 5)
        c = rnd.choice(["#3b2410", "#3b2410", "#f1d9a8"])
        fibres.append(f'<path d="M{f(x)} {f(y)} l{f(math.cos(a)*l)} {f(math.sin(a)*l)}" stroke="{c}" stroke-width="0.5" opacity="{rnd.uniform(.2,.5):.2f}"/>')

    # seat grid: four cells with write-in rules
    cells = [("SECTION", "section"), ("ROW", "row"), ("SEAT", "seat"), ("GATE", "gate")]
    cw = (R - L) / 4
    grid = []
    for i, (name, slot) in enumerate(cells):
        x0 = L + i * cw + (0 if i == 0 else 10)
        grid.append(f'<text x="{f(x0)}" y="358" {lab}>{name}</text>')
        grid.append(f'<text data-slot="{slot}" data-default="—" x="{f(x0)}" y="392" {big} font-size="28" data-fit="{f(cw-18)}" data-min="12">.</text>')
        grid.append(f'<path d="M{f(x0)} 400 H{f(L + (i+1) * cw - 8)}" {dash}/>')
    grid_div = "".join(f'<path d="M{f(L + i*cw)} 340 V408" {hair}/>' for i in (1, 2, 3))

    stars = "".join(star5(L + 83 + i * 26, 535, 9, fill="none", stroke=INK, sw=1.1) for i in range(5))

    # venue map: a little street diagram in ink lines
    mx, my, mw, mh = L, 640, R - L, 150
    mp = f'stroke="{INK}" stroke-width="1" fill="none"'
    vb = (mx + 214, my + 66, 116, 62)  # venue block
    door = vb[0] + vb[2] / 2
    map_svg = f'''
      <path d="M{mx} {my+40} H{mx+mw} M{mx} {my+52} H{mx+mw}" {mp}/>
      <path d="M{mx+92} {my} V{my+40} M{mx+104} {my} V{my+40} M{mx+92} {my+52} V{mh+my} M{mx+104} {my+52} V{my+mh}" {mp}/>
      <path d="M{mx+176} {my+52} V{my+mh} M{mx+188} {my+52} V{my+mh}" {mp}/>
      <path d="M{mx+104} {my+98} H{mx+176} M{mx+104} {my+108} H{mx+176}" {mp}/>
      <path d="M{mx+250} {my} L{mx+290} {my+40} M{mx+266} {my} L{mx+306} {my+40}" {mp}/>
      <rect x="{vb[0]}" y="{vb[1]}" width="{vb[2]}" height="{vb[3]}" fill="{INK}" opacity="0.12"/>
      <rect x="{vb[0]}" y="{vb[1]}" width="{vb[2]}" height="{vb[3]}" fill="none" stroke="{INK}" stroke-width="1.3"/>
      <rect x="{vb[0]+4}" y="{vb[1]+4}" width="{vb[2]-8}" height="{vb[3]-8}" fill="none" stroke="{INK}" stroke-width="0.5"/>
      <path d="M{door-10} {vb[1]+vb[3]} v-9 h20 v9Z" fill="{INK}"/>
      <text x="{door}" y="{vb[1]+27}" text-anchor="middle" font-family="{DISP}" font-weight="800" font-size="16" letter-spacing="2" fill="{INK}">STAGE</text>
      <text data-slot="gate" x="{door}" y="{vb[1]+42}" text-anchor="middle" font-family="{MONO}" font-size="7" font-weight="700" letter-spacing="1.2" fill="{INK}" data-prefix="ENTRY · GATE " data-case="upper" data-fit="100">.</text>
      <path d="M{mx+20} {my+122} C{mx+80} {my+124} {mx+150} {my+142} {door} {vb[1]+vb[3]+4}" stroke="{INK}" stroke-width="1.1" stroke-dasharray="1 3.2" stroke-linecap="round" fill="none"/>
      <circle cx="{mx+20}" cy="{my+122}" r="3.5" fill="{INK}"/><circle cx="{mx+20}" cy="{my+122}" r="7.5" fill="none" stroke="{INK}" stroke-width="0.7"/>
      <text x="{mx}" y="{my+144}" font-family="{MONO}" font-size="6.5" letter-spacing="0.8" fill="{INK}">YOU ARE HERE</text>
      <g transform="translate({mx+mw-14} {my+16})"><path d="M0 -12 L5 4 L0 0 L-5 4Z" fill="{INK}"/><text y="16" text-anchor="middle" font-family="{MONO}" font-size="7" font-weight="700" fill="{INK}">N</text></g>
    '''

    s = head()
    s += f'''  <defs>
    <clipPath id="headclip"><path d="{notch_rect(hx+5, hy+5, hw-10, hh-10, 9)}"/></clipPath>
  </defs>
  <g data-layer="paper">
    <rect width="{W}" height="{H}" fill="{KRAFT}"/>
    <rect width="{W}" height="{H}" fill="#3b2410" filter="url(#ts-fibre)" opacity="0.14"/>
    <rect width="{W}" height="{H}" fill="#fff" filter="url(#ts-grain-light)" opacity="0.10"/>
    <rect width="{W}" height="{H}" fill="#000" filter="url(#ts-grain)" opacity="0.14"/>
    <g>{''.join(fibres)}</g>
  </g>
  <g data-layer="foil" fill="{GOLD}">
    <path d="{notch_rect(hx+5, hy+5, hw-10, hh-10, 9)}" fill="none" stroke="{GOLD}" stroke-width="0.9"/>
    <path d="{notch_rect(bx+5, by+5, bw-10, bh-10, 11)}" fill="none" stroke="{GOLD}" stroke-width="0.9"/>
    {sparkle(hx+hw-150, hy+56, 5)}{sparkle(hx+hw-130, hy+76, 3)}
    <path d="M{L} 254 H{R} M{L} 330 H{R} M{L} 416 H{R} M{L} 500 H{R} M{L} 600 H{R} M{L} 806 H{R}" {rule}/>
    <path d="M418 186 V914" {hair}/>
    {grid_div}
  </g>
  <g data-layer="ink" fill="{INK}">
    <g opacity="0.55">{perf}</g>
    <text x="{L}" y="48" {lab}>TICKETSTUB ORIGINAL · SERIAL</text>
    <g transform="rotate(-1.6 {L+107} 86)">
      <rect x="{L}" y="60" width="214" height="52" fill="#5a3a18" opacity="0.12"/>
      <rect x="{L}" y="60" width="214" height="52" fill="none" stroke="{INK}" stroke-width="1.8"/>
      <rect x="{L+4}" y="64" width="206" height="44" fill="none" stroke="{INK}" stroke-width="0.6"/>
      <text data-slot="serial" x="{L+107}" y="95" text-anchor="middle" font-family="{MONO}" font-size="22" font-weight="700" letter-spacing="5" data-fit="190">.</text>
    </g>
    <text data-slot="admit" data-default="Admit one" x="{hx+hw-20}" y="48" text-anchor="end" {lab} data-case="upper" data-fit="120">.</text>
    <text data-slot="title" x="{hx+hw-20}" y="94" text-anchor="end" {big} font-size="24" letter-spacing="0.6" data-case="upper" data-wrap="160" data-lines="2" data-leading="0.95" data-anchor="bottom" data-min="13">.</text>
    <text x="{hx+hw-20}" y="112" text-anchor="end" font-family="{MONO}" font-size="8" letter-spacing="1.6" data-wrap="160" data-lines="1" data-min="6.5"><tspan data-slot="year">.</tspan><tspan data-slot="city" data-prefix=" · " data-case="upper">.</tspan></text>

    <text x="{L}" y="196" {lab}>VENUE</text>
    <text data-slot="venue" x="{L}" y="226" {big} font-size="30" letter-spacing="0.5" data-case="upper" data-fit="{R-L}" data-min="14">.</text>
    <text data-slot="city" x="{L}" y="243" font-family="{MONO}" font-size="9.5" letter-spacing="1.6" data-case="upper" data-fit="{R-L}">.</text>

    <text x="{L}" y="274" {lab}>DATE</text>
    <text x="{L+160}" y="274" {lab}>TIME</text>
    <text x="{L+262}" y="274" {lab}>DOORS</text>
    <text data-slot="dateDots" data-default="—" x="{L}" y="314" {big} font-size="32" letter-spacing="0.5" data-fit="140">.</text>
    <text data-slot="time" data-default="—" x="{L+160}" y="314" {big} font-size="32" data-fit="88">.</text>
    <text data-slot="doors" data-default="—" x="{L+262}" y="314" {big} font-size="32" data-fit="96">.</text>
    <path d="M{L+150} 262 V322 M{L+252} 262 V322" {dash}/>

    {''.join(grid)}

    <text x="{L}" y="436" {lab}>LINE-UP</text>
    <text data-slot="peopleAll" data-default="—" x="{L}" y="456" font-family="{MONO}" font-size="10" letter-spacing="0.3" data-wrap="{R-L-44}" data-lines="3" data-leading="1.45" data-min="7">.</text>

    <text x="{L}" y="539" {lab}>RATING</text>
    <g opacity="0.85">{stars}</g>
    <text x="{L+83+4*26+16}" y="539" font-family="{MONO}" font-size="9.5" letter-spacing="0.5">( /5)</text>
    <text x="{L}" y="562" {lab}>REVIEW</text>
    <path d="M{L+74} 562 H{R} M{L} 586 H{R}" {dash}/>

    <text x="{L}" y="626" {lab}>MAP</text>
    {map_svg}

    <text data-slot="tagline" x="{L}" y="828" font-family="{MONO}" font-size="9.5" font-style="italic" data-wrap="{R-L}" data-lines="2" data-leading="1.4" data-min="7" data-prefix="“" data-suffix="”">.</text>
    <g data-slot="barcode" data-w="196" data-h="30" data-color="{INK}" transform="translate({L} 856)"></g>
    <g data-show-if="edition"><text x="{R}" y="866" text-anchor="end" {lab}>EDITION</text>
    <text data-slot="edition" x="{R}" y="894" text-anchor="end" {big} font-size="28" letter-spacing="0.5" data-fit="150">.</text></g>
    <text x="{L}" y="918" font-family="{MONO}" font-size="6.5" letter-spacing="1.1" opacity="0.85" data-fit="250">COMMEMORATIVE KEEPSAKE · NOT VALID FOR ENTRY</text>
    <text x="{R}" y="918" text-anchor="end" font-family="{DISP}" font-weight="800" font-size="10" letter-spacing="2.6">TICKETSTUB™</text>

    <text transform="translate(440 196) rotate(90)" {big} font-size="20" letter-spacing="3" data-wrap="700" data-lines="1" data-min="13"><tspan data-slot="title" data-case="upper">.</tspan><tspan data-slot="date" data-prefix="  ·  ">.</tspan></text>
  </g>
  <path data-layer="dieline" d="{die()}" fill="none" stroke="#ec008c" stroke-width="0.5"/>
</svg>
'''
    return s


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "front.svg").write_text(front(), encoding="utf8")
    (OUT / "back.svg").write_text(back(), encoding="utf8")
    print("wrote", OUT)
