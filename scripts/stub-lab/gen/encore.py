"""Encore: a black stage cut by one diagonal beam of light, the performer in B&W, a silver-foil title,
a white seat stub with blurred chrome forms (editorial / photo direction, landscape).

    python scripts/stub-lab/gen/encore.py   -> public/stubs/encore/{front,back}.svg

Front: stage 0..TEAR, stub TEAR..W.  Back (the same card turned over) mirrors it: stub 0..W-TEAR.
"""
import math, random
from pathlib import Path
from die import _f

W, H = 1100, 440
TEAR = 800                      # perforation on the front (x); on the back it sits at W - TEAR
STUBW = W - TEAR
OUT = Path(__file__).resolve().parents[3] / "public" / "stubs" / "encore"
SERIF = "'Cormorant Garamond', 'Bodoni Moda', Georgia, serif"
SANS = "'Syne', 'Inter Tight', Arial, sans-serif"
INK = "#121212"
PAPER = "#f4f3f0"
SILVER = "#b7bcc4"


def die(tear_x, r=15, R=12):
    """Rounded rectangle with a round bite top and bottom at the tear line."""
    return (f"M{R} 0 L{_f(tear_x - r)} 0 A{r} {r} 0 0 0 {_f(tear_x + r)} 0 L{W - R} 0 Q{W} 0 {W} {R} "
            f"L{W} {H - R} Q{W} {H} {W - R} {H} L{_f(tear_x + r)} {H} A{r} {r} 0 0 0 {_f(tear_x - r)} {H} "
            f"L{R} {H} Q0 {H} 0 {H - R} L0 {R} Q0 0 {R} 0Z")


def perforation(x, color, op, r=1.5, gap=7.5):
    dots = []
    y = 24
    while y < H - 22:
        dots.append(f'<circle cx="{x}" cy="{y:.1f}" r="{r}"/>')
        y += gap
    return f'<g fill="{color}" opacity="{op}">{"".join(dots)}</g>'


def head():
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" data-foil="silver" style="font-variant-numeric: lining-nums">\n'


# ------------------------------------------------------------------ chrome: liquid silver forms
CHROME_DEFS = '''
    <linearGradient id="chA" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#2a2b2e"/><stop offset="0.22" stop-color="#d9dbdf"/>
      <stop offset="0.36" stop-color="#ffffff"/><stop offset="0.5" stop-color="#5d6066"/>
      <stop offset="0.66" stop-color="#1b1c1f"/><stop offset="0.8" stop-color="#b9bcc2"/>
      <stop offset="1" stop-color="#3a3c40"/>
    </linearGradient>
    <linearGradient id="chB" x1="1" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#f7f8f9"/><stop offset="0.2" stop-color="#6c6f75"/>
      <stop offset="0.38" stop-color="#151618"/><stop offset="0.56" stop-color="#c7cad0"/>
      <stop offset="0.7" stop-color="#ffffff"/><stop offset="1" stop-color="#46484d"/>
    </linearGradient>
    <filter id="dof1" filterUnits="userSpaceOnUse" x="-200" y="-200" width="1500" height="840"><feGaussianBlur stdDeviation="1.2"/></filter>
    <filter id="dof2" filterUnits="userSpaceOnUse" x="-200" y="-200" width="1500" height="840"><feGaussianBlur stdDeviation="4"/></filter>
    <filter id="dof3" filterUnits="userSpaceOnUse" x="-200" y="-200" width="1500" height="840"><feGaussianBlur stdDeviation="9"/></filter>'''


def ribbon(d, w, grad, blur, op=1.0, hl=True):
    """A thick chrome ribbon: gradient body, dark core and a thin specular line on top."""
    s = f'<g filter="url(#{blur})" opacity="{op}" fill="none" stroke-linecap="round" stroke-linejoin="round">'
    s += f'<path d="{d}" stroke="url(#{grad})" stroke-width="{w}"/>'
    s += f'<path d="{d}" stroke="#0e0f11" stroke-width="{w*0.28:.1f}" opacity="0.55" transform="translate({w*0.12:.1f} {w*0.14:.1f})"/>'
    if hl:
        s += f'<path d="{d}" stroke="#ffffff" stroke-width="{max(1.2, w*0.09):.1f}" opacity="0.95" transform="translate({-w*0.18:.1f} {-w*0.2:.1f})"/>'
    return s + '</g>'


def knot_path(cx, cy, sc, n=180):
    """A trefoil knot flattened to 2D: one closed liquid-chrome loop."""
    pts = []
    for i in range(n + 1):
        t = 2 * math.pi * i / n
        x = math.sin(t) + 2 * math.sin(2 * t)
        y = math.cos(t) - 2 * math.cos(2 * t)
        pts.append(f"{cx + x * sc:.1f} {cy + y * sc:.1f}")
    return "M" + " L".join(pts) + "Z"


def knot(cx, cy, sc, w=1.4):
    """A flat foil trefoil mark (line only)."""
    return f'<path d="{knot_path(cx, cy, sc)}" fill="none" stroke="{SILVER}" stroke-width="{w}" stroke-linejoin="round"/>'


def knot_rim(cx, cy, sc, w=1.4):
    """Dark ink edge under the foil mark so it holds on white stock."""
    return f'<path d="{knot_path(cx, cy, sc)}" fill="none" stroke="#3a3c40" stroke-width="{w + 1.0}" stroke-linejoin="round"/>'


def sparkle(cx, cy, R, r):
    """The four-point sparkle from the reference sheet, with a hairline cross and a ring."""
    def star(R, r):
        return (f"M{cx} {cy-R:.1f} Q{cx} {cy} {cx+r:.1f} {cy} Q{cx} {cy} {cx} {cy+R:.1f} "
                f"Q{cx} {cy} {cx-r:.1f} {cy} Q{cx} {cy} {cx} {cy-R:.1f}Z")
    return (f'<path d="{star(R, r)}"/>'
            f'<path d="{star(R*0.36, r*0.36)}" transform="rotate(45 {cx} {cy})"/>'
            f'<circle cx="{cx}" cy="{cy}" r="{R*0.5:.1f}" fill="none" stroke="{SILVER}" stroke-width="0.8"/>'
            )


def floor_lines(vx, fy):
    """Stage boards receding to a vanishing point above the pool, lit only where the beam lands."""
    out = []
    for i in range(-14, 15):
        x2 = vx + i * 70
        out.append(f"M{vx + i * 9:.1f} {fy - 18} L{x2:.1f} {H + 4}")
    for y in (fy + 20, H - 8):
        out.append(f"M0 {y} H{TEAR}")
    d = " ".join(out)
    tape = f"M{vx-16} {fy+4} L{vx+16} {fy+12} M{vx+16} {fy+4} L{vx-16} {fy+12}"
    return (f'<g mask="url(#poolM)"><path d="{d}" stroke="#fff" stroke-width="0.5" fill="none" opacity="0.1"/></g>')


# ------------------------------------------------------------------ front: the stage
def front():
    # the beam: a light source above the top-right of the stage, falling to the floor at (460, 398)
    sx, sy = 905, -70
    ex, ey = 455, 398
    L = math.hypot(ex - sx, ey - sy)
    ux, uy = (ex - sx) / L, (ey - sy) / L
    nx, ny = -uy, ux

    def beam(w0, w1, ext=1.25):
        fx, fy = sx + (ex - sx) * ext, sy + (ey - sy) * ext
        pts = [(sx + nx * w0, sy + ny * w0), (fx + nx * w1 * ext, fy + ny * w1 * ext),
               (fx - nx * w1 * ext, fy - ny * w1 * ext), (sx - nx * w0, sy - ny * w0)]
        return " ".join(f"{x:.1f},{y:.1f}" for x, y in pts)

    rnd = random.Random(12)
    dust = []
    for _ in range(140):  # motes caught in the beam
        t = rnd.uniform(0.08, 1.05)
        off = rnd.gauss(0, 0.45) * (40 + 120 * t)
        x = sx + (ex - sx) * t + nx * off
        y = sy + (ey - sy) * t + ny * off
        if x > TEAR - 8 or y < 0 or y > H:
            continue
        r = rnd.choice([0.5, 0.6, 0.7, 0.9, 1.1])
        o = rnd.uniform(0.15, 0.7) * max(0.0, 1 - abs(off) / (60 + 130 * t))
        dust.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r}" fill="#fff" opacity="{o:.2f}"/>')

    FEET = 398
    # long shadow cast forward-left over the lit floor: (x, y) -> (x + k (FEET - y), FEET + s (FEET - y))
    k, sq = 0.95, 0.11
    shadow_m = f"matrix(1 0 {-k} {-sq} {k*FEET:.1f} {FEET + sq*FEET:.1f})"
    refl_m = f"matrix(1 0 0 -0.32 0 {FEET*1.32:.1f})"

    tear = perforation(TEAR, "#9a9a9a", 0.9)
    KS = knot(W - 72, 352, 6.5)
    TITLE = (f'data-slot="title" x="46" y="190" font-family="{SERIF}" font-weight="500" font-size="88" letter-spacing="0.035em" '
             f'data-case="upper" data-wrap="322" data-lines="4" data-leading="0.9" data-anchor="middle" data-min="22"')
    ADMIT = (f'x="{TEAR + 30 + (STUBW-76)/2}" y="300" text-anchor="middle" font-family="{SERIF}" font-size="25" font-weight="700" letter-spacing="8"')
    s = head()
    s += f'''  <defs>
    <radialGradient id="stageG" cx="0.56" cy="0.95" r="0.75">
      <stop offset="0" stop-color="#1d1d1d"/><stop offset="0.55" stop-color="#0a0a0a"/><stop offset="1" stop-color="#030303"/>
    </radialGradient>
    <linearGradient id="beamG" gradientUnits="userSpaceOnUse" x1="{sx}" y1="{sy}" x2="{ex}" y2="{ey}">
      <stop offset="0" stop-color="#fff" stop-opacity="0.95"/><stop offset="0.55" stop-color="#fff" stop-opacity="0.55"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0.32"/>
    </linearGradient>
    <radialGradient id="poolG" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#fff" stop-opacity="0.85"/><stop offset="0.4" stop-color="#e8e8e8" stop-opacity="0.38"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="flareG" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#fff" stop-opacity="0.9"/><stop offset="0.25" stop-color="#fff" stop-opacity="0.35"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="hazeG" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.6" stop-color="#fff" stop-opacity="0.10"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0.02"/>
    </linearGradient>
    <filter id="soft1" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="34"/></filter>
    <filter id="soft2" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="14"/></filter>
    <filter id="soft3" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="4"/></filter>
    <filter id="mono" color-interpolation-filters="sRGB">
      <feColorMatrix type="matrix" values="0.30 0.59 0.11 0 0  0.30 0.59 0.11 0 0  0.30 0.59 0.11 0 0  0 0 0 1 0"/>
      <feComponentTransfer>
        <feFuncR type="table" tableValues="0 0.05 0.3 0.72 1"/>
        <feFuncG type="table" tableValues="0 0.05 0.3 0.72 1"/>
        <feFuncB type="table" tableValues="0 0.05 0.3 0.72 1"/>
      </feComponentTransfer>
    </filter>
    <filter id="castF" x="-60%" y="-60%" width="220%" height="220%" color-interpolation-filters="sRGB">
      <feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.85 0"/>
      <feGaussianBlur stdDeviation="3.5"/>
    </filter>
    <filter id="reflF" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB">
      <feColorMatrix type="matrix" values="0.30 0.59 0.11 0 0  0.30 0.59 0.11 0 0  0.30 0.59 0.11 0 0  0 0 0 1 0"/>
      <feGaussianBlur stdDeviation="2.2"/>
    </filter>
    <linearGradient id="feetG" gradientUnits="userSpaceOnUse" x1="0" y1="{FEET-120}" x2="0" y2="{FEET-2}">
      <stop offset="0" stop-color="#fff"/><stop offset="0.6" stop-color="#fff" stop-opacity="0.45"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <mask id="feetM" maskUnits="userSpaceOnUse" x="0" y="0" width="{W}" height="{H}">
      <rect width="{W}" height="{FEET-120}" fill="#fff"/><rect y="{FEET-120}" width="{W}" height="122" fill="url(#feetG)"/>
    </mask>
    <linearGradient id="reflG" gradientUnits="userSpaceOnUse" x1="0" y1="{FEET}" x2="0" y2="{H}">
      <stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.25" stop-color="#fff" stop-opacity="0.16"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <mask id="reflM" maskUnits="userSpaceOnUse" x="0" y="0" width="{W}" height="{H}">
      <rect y="{FEET}" width="{W}" height="{H-FEET}" fill="url(#reflG)"/>
    </mask>
    <linearGradient id="castG" gradientUnits="userSpaceOnUse" x1="{ex}" y1="0" x2="{ex-360}" y2="0">
      <stop offset="0" stop-color="#fff" stop-opacity="0.95"/><stop offset="1" stop-color="#fff" stop-opacity="0.05"/>
    </linearGradient>
    <mask id="castM" maskUnits="userSpaceOnUse" x="0" y="0" width="{W}" height="{H}">
      <rect y="{FEET-6}" width="{W}" height="{H}" fill="url(#castG)"/>
    </mask>
    <linearGradient id="artHG" gradientUnits="userSpaceOnUse" x1="365" y1="0" x2="695" y2="0">
      <stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.16" stop-color="#fff"/>
      <stop offset="0.84" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="artVG" gradientUnits="userSpaceOnUse" x1="0" y1="30" x2="0" y2="394">
      <stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.05" stop-color="#fff"/>
      <stop offset="0.6" stop-color="#fff"/><stop offset="0.82" stop-color="#fff" stop-opacity="0.35"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <mask id="artHM" maskUnits="userSpaceOnUse" x="0" y="0" width="{W}" height="{H}"><rect x="365" y="30" width="330" height="364" fill="url(#artHG)"/></mask>
    <mask id="artVM" maskUnits="userSpaceOnUse" x="0" y="0" width="{W}" height="{H}"><rect x="365" y="30" width="330" height="364" fill="url(#artVG)"/></mask>
    <mask id="poolM" maskUnits="userSpaceOnUse" x="0" y="0" width="{W}" height="{H}">
      <ellipse cx="{ex - 10}" cy="{FEET + 14}" rx="300" ry="50" fill="url(#poolG)"/>
    </mask>
    <clipPath id="stageC"><rect width="{TEAR}" height="{H}"/></clipPath>
    <linearGradient id="rimG" gradientUnits="userSpaceOnUse" x1="{sx}" y1="{sy}" x2="{ex}" y2="{ey}">
      <stop offset="0.35" stop-color="#fff" stop-opacity="0"/><stop offset="0.85" stop-color="#fff" stop-opacity="0.5"/>
    </linearGradient>
    {CHROME_DEFS}
  </defs>
  <g data-layer="paper">
    <rect width="{W}" height="{H}" fill="#050505"/>
    <g clip-path="url(#stageC)">
      <rect width="{TEAR}" height="{H}" fill="url(#stageG)"/>
      <!-- floor plane: a faint horizon and a grazing sheen -->
      <rect y="{FEET-26}" width="{TEAR}" height="{H-FEET+26}" fill="url(#hazeG)"/>
      {floor_lines(ex, FEET)}
      <!-- the beam, built from soft volumes -->
      <polygon points="{beam(70, 240)}" fill="url(#beamG)" opacity="0.32" filter="url(#soft1)"/>
      <polygon points="{beam(34, 135)}" fill="url(#beamG)" opacity="0.5" filter="url(#soft2)"/>
      <polygon points="{beam(10, 58)}" fill="url(#beamG)" opacity="0.55" filter="url(#soft3)"/>
      <polygon points="{beam(2, 16)}" fill="#fff" opacity="0.18" filter="url(#soft3)"/>
      <ellipse cx="{ex - 10}" cy="{FEET + 6}" rx="250" ry="34" fill="url(#poolG)" filter="url(#soft3)"/>
      <ellipse cx="{ex - 30}" cy="{FEET + 8}" rx="120" ry="12" fill="#fff" opacity="0.35" filter="url(#soft2)"/>
      <circle cx="{TEAR - 40}" cy="18" r="90" fill="url(#flareG)" opacity="0.55"/>
      <g>{"".join(dust)}</g>
      <g data-hide-if="art">
        <ellipse cx="{ex + 40}" cy="{FEET - 150}" rx="150" ry="230" transform="rotate(43 {ex + 40} {FEET - 150})" fill="url(#poolG)" opacity="0.22" filter="url(#soft2)"/>
        <ellipse cx="{ex - 10}" cy="{FEET + 4}" rx="190" ry="22" fill="#fff" opacity="0.18" filter="url(#soft2)"/>
      </g>
    </g>
  </g>
  <g data-layer="art" clip-path="url(#stageC)">
    <g mask="url(#artVM)"><g mask="url(#artHM)">
      <image id="artImg" data-slot="art" x="365" y="30" width="330" height="364" preserveAspectRatio="xMidYMin slice" filter="url(#mono)"/>
    </g></g>
  </g>
  <g data-layer="paper" clip-path="url(#stageC)">
    <!-- light wrapping the figure from the beam side, and haze drifting through -->
    <polygon points="{beam(40, 150)}" fill="url(#rimG)" opacity="0.22" filter="url(#soft2)" style="mix-blend-mode:screen"/>
    <rect y="{FEET-40}" width="{TEAR}" height="70" fill="#fff" opacity="0.05" filter="url(#soft2)"/>
    <rect width="{TEAR}" height="{H}" fill="#fff" filter="url(#ts-grain-light)" opacity="0.10"/>
  </g>
  <g data-layer="paper">
    <!-- the stub: white stock with chrome forms out of focus -->
    <rect x="{TEAR}" width="{STUBW}" height="{H}" fill="{PAPER}"/>
    <rect x="{TEAR}" width="{STUBW}" height="{H}" fill="#000" filter="url(#ts-fibre)" opacity="0.10"/>
    {tear}
  </g>
  <g data-layer="ink">
    <!-- crisp edges under the foil: a light rim for the title on black, a dark rim for ADMIT ONE on paper -->
    <text {TITLE} fill="#f4f4f4" stroke="#f4f4f4" stroke-width="0.55" stroke-linejoin="round">.</text>
    <text {ADMIT} fill="#2a2b2e" stroke="#2a2b2e" stroke-width="0.9" stroke-linejoin="round">ADMIT ONE</text>
    {knot_rim(W - 72, 352, 6.5)}
  </g>
  <g data-layer="foil">
    <text {TITLE} fill="{SILVER}">.</text>
    <path d="M47 40 H87" stroke="{SILVER}" stroke-width="1" fill="none"/>
    <text {ADMIT} fill="{SILVER}">ADMIT ONE</text>
    {KS}
  </g>
  <g data-layer="ink" fill="#e9e9e9">
    <text data-slot="kicker" x="99" y="43.5" font-family="{SANS}" font-size="9" font-weight="600" letter-spacing="3.4" data-case="upper" data-fit="230" data-min="7" opacity="0.75">.</text>
    <text data-slot="categoryLabel" data-hide-if="kicker" x="99" y="43.5" font-family="{SANS}" font-size="9" font-weight="600" letter-spacing="3.4" opacity="0.75">.</text>
    <text data-slot="subtitle" x="47" y="284" font-family="{SERIF}" font-style="italic" font-size="18" font-weight="400" data-wrap="280" data-lines="2" data-leading="1.15" data-min="12" opacity="0.9">.</text>
    <text x="47" y="346" font-family="{SERIF}" font-size="15" font-weight="400" letter-spacing="0.6"><tspan data-slot="dateDots">.</tspan><tspan data-slot="time" data-prefix="   ·   ">.</tspan></text>
    <text data-slot="venue" x="47" y="365" font-family="{SERIF}" font-size="15" font-weight="400" data-wrap="300" data-lines="2" data-leading="1.12" data-min="10">.</text>
    <text data-slot="city" x="772" y="414" text-anchor="end" font-family="{SANS}" font-size="8.5" font-weight="600" letter-spacing="2.6" data-case="upper" data-fit="235" data-min="7" opacity="0.72">.</text>
    <text x="47" y="414" font-family="{SANS}" font-size="8.5" font-weight="600" letter-spacing="2.4" opacity="0.66"><tspan>TICKETSTUB</tspan><tspan data-slot="edition" data-case="upper" data-prefix="   ·   ">.</tspan></text>
  </g>
  <g data-layer="ink" fill="{INK}">
    <text x="{TEAR+30}" y="40" font-family="{SANS}" font-size="8.5" font-weight="700" letter-spacing="2.4">TICKETSTUB</text>
    <text data-slot="edition" x="{W-46}" y="40" text-anchor="end" font-family="{SERIF}" font-size="12" font-weight="500" letter-spacing="1" data-fit="110">.</text>
    <path d="M{TEAR+30} 50 H{W-46}" stroke="{INK}" stroke-width="0.6" fill="none"/>
    {seat_grid(TEAR + 30, W - 46)}
    <text data-slot="categoryLabel" x="{TEAR+30}" y="246" font-family="{SANS}" font-size="8.5" font-weight="700" letter-spacing="2.2" opacity="0.7">.</text>
    <text data-slot="dateShort" x="{W-46}" y="246" text-anchor="end" font-family="{SANS}" font-size="8.5" font-weight="700" letter-spacing="2" opacity="0.7">.</text>
    <path d="M{TEAR+30} 266 H{W-46} M{TEAR+30} 314 H{W-46}" stroke="{INK}" stroke-width="0.6" fill="none"/>
    <g data-slot="barcode" data-w="128" data-h="38" transform="translate({TEAR+30} 332)"></g>
    <text data-slot="serial" x="{TEAR+30}" y="386" font-family="{SANS}" font-size="8.5" font-weight="600" letter-spacing="3">.</text>
    <text x="{TEAR+30}" y="406" font-family="{SANS}" font-size="7.5" font-weight="600" letter-spacing="1" opacity="0.65">KEEPSAKE · NOT VALID FOR ENTRY</text>
  </g>
  <path data-layer="dieline" d="{die(TEAR)}" fill="none" stroke="#ec008c" stroke-width="0.5"/>
</svg>
'''
    return s


def seat_grid(x0, x1):
    """SECTION / ROW over SEAT / GATE in thin serif caps; empty fields stay as write-in rules."""
    cw = (x1 - x0) / 2
    out = []
    rows = [(("SECTION", "section"), ("ROW", "row")), (("SEAT", "seat"), ("GATE", "gate"))]
    for r, pair in enumerate(rows):
        ly = 86 + r * 84
        for c, (lab, key) in enumerate(pair):
            cx = x0 + c * cw
            out.append(f'<text x="{cx:.1f}" y="{ly}" font-family="{SERIF}" font-size="15" font-weight="500" letter-spacing="2.4">{lab}</text>')
            out.append(f'<text data-slot="{key}" x="{cx:.1f}" y="{ly + 38}" font-family="{SERIF}" font-size="34" font-weight="400" data-fit="{cw - 16:.0f}" data-min="14" data-default="—">.</text>')
            out.append(f'<path d="M{cx:.1f} {ly + 50} H{cx + cw - 18:.1f}" stroke="{INK}" stroke-width="0.5" stroke-dasharray="1.5 2.5" fill="none" opacity="0.7"/>')
    return "\n    ".join(out)


# ------------------------------------------------------------------ back: the editorial face
def back():
    T = W - TEAR  # the tear line from behind
    tear = perforation(T, "#8a8a8a", 0.8)
    cx0, cx1 = T + 112, 812        # centre column
    rx0, rx1 = 846, W - 34         # right column
    lab = f'font-family="{SANS}" font-size="7.5" font-weight="700" letter-spacing="2.4"'
    stars = []
    for i in range(5):
        x = cx0 + 74 + i * 26
        stars.append(f'<circle cx="{x}" cy="327" r="8.5" fill="none" stroke="#6f737a" stroke-width="0.9"/>')
    fields = []
    for i, (labt, key, size) in enumerate([("DATE", "dateDots", 17), ("TIME", "time", 17), ("DOORS", "doors", 17), ("PRICE", "price", 17)]):
        fx = rx0 + (i % 2) * ((rx1 - rx0) / 2)
        fy = 196 + (i // 2) * 58
        fields.append(f'<text x="{fx:.1f}" y="{fy}" {lab} opacity="0.55">{labt}</text>')
        fields.append(f'<text data-slot="{key}" x="{fx:.1f}" y="{fy + 24}" font-family="{SERIF}" font-size="{size}" font-weight="500" data-fit="{(rx1 - rx0) / 2 - 12:.0f}" data-min="10" data-default="—">—</text>')
    KS = knot(W - 66, 108, 7)
    rx0_, rx1_ = 846, W - 34
    CHIP = (f'data-slot="categoryLabel" x="{(rx0_+rx1_)/2}" y="314" text-anchor="middle" font-family="{SERIF}" font-size="15" '
            f'font-weight="700" letter-spacing="3.5" data-suffix="  ·  KEEPSAKE" data-fit="{rx1_-rx0_-10}" data-min="9"')
    s = head()
    s += f'''  <defs>
    {CHROME_DEFS}
    <linearGradient id="stubG" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#0b0b0b"/><stop offset="1" stop-color="#151515"/>
    </linearGradient>
  </defs>
  <g data-layer="paper">
    <rect width="{W}" height="{H}" fill="{PAPER}"/>
    <rect width="{W}" height="{H}" fill="#000" filter="url(#ts-fibre)" opacity="0.10"/>
    <rect width="{T}" height="{H}" fill="url(#stubG)"/>
    <rect width="{T}" height="{H}" fill="#fff" filter="url(#ts-grain-light)" opacity="0.06"/>
    <!-- chrome forms drifting out of focus behind the right column -->
    {tear}
  </g>
  <g data-layer="ink">
    <text {CHIP} fill="#2a2b2e" stroke="#2a2b2e" stroke-width="0.9" stroke-linejoin="round">.</text>
    {knot_rim(W - 66, 108, 7)}
  </g>
  <g data-layer="foil">
    <text transform="translate({T/2 + 18} {H/2}) rotate(-90)" text-anchor="middle" font-family="{SERIF}" font-size="58" font-weight="500" letter-spacing="9" fill="{SILVER}">ADMIT ONE</text>
    {KS}
    <text {CHIP} fill="{SILVER}">.</text>
  </g>
  <g data-layer="ink" fill="#d8d8d8">
    <text data-slot="edition" transform="translate({T/2 - 52} {H/2}) rotate(-90)" text-anchor="middle" font-family="{SANS}" font-size="9.5" font-weight="700" letter-spacing="3" data-case="upper" data-fit="300" opacity="0.85">.</text>
    <text data-slot="seatLine" transform="translate({T/2 + 68} {H/2}) rotate(-90)" text-anchor="middle" font-family="{SANS}" font-size="9.5" font-weight="600" letter-spacing="2.4" data-fit="340" data-min="7" opacity="0.85">.</text>
  </g>
  <g data-layer="ink" fill="{INK}">
    <!-- vertical type band -->
    <text data-slot="dateLong" transform="translate({T+40} {H/2}) rotate(-90)" text-anchor="middle" font-family="{SERIF}" font-size="15" font-weight="500" letter-spacing="0.4" data-fit="320" data-min="9">.</text>
    <text data-slot="venue" transform="translate({T+64} {H/2}) rotate(-90)" text-anchor="middle" font-family="{SANS}" font-size="7.5" font-weight="600" letter-spacing="2.2" data-case="upper" data-fit="320" data-min="6.5" opacity="0.7">.</text>
    <path d="M{T+86} 30 V{H-30}" stroke="{INK}" stroke-width="0.6" fill="none"/>
    <!-- centre column -->
    <text data-slot="kicker" x="{cx0}" y="52" {lab} data-case="upper" data-fit="{cx1-cx0}" opacity="0.6">.</text>
    <text data-slot="title" x="{cx0 - 2}" y="128" font-family="{SERIF}" font-size="44" font-weight="500" letter-spacing="1.5" data-case="upper" data-wrap="{cx1-cx0}" data-lines="3" data-leading="0.95" data-anchor="bottom" data-min="16">.</text>
    <text data-slot="subtitle" x="{cx0}" y="152" font-family="{SERIF}" font-style="italic" font-size="16" data-wrap="{cx1-cx0}" data-lines="1" data-min="10">.</text>
    <text x="{cx0}" y="196" {lab} opacity="0.55">FEATURING</text>
    <text data-slot="peopleAll" x="{cx0 + 86}" y="196" font-family="{SERIF}" font-size="15" font-weight="500" data-wrap="{cx1-cx0-86}" data-lines="2" data-leading="1.3" data-min="10">.</text>
    <text data-slot="tagline" x="{cx0}" y="260" font-family="{SERIF}" font-style="italic" font-size="18" data-wrap="{cx1-cx0}" data-lines="2" data-leading="1.2" data-min="11" data-prefix="“" data-suffix="”">.</text>
    <path d="M{cx0} 302 H{cx1}" stroke="{INK}" stroke-width="0.6" fill="none"/>
    <text x="{cx0}" y="330" {lab} opacity="0.55">RATING</text>
    {''.join(stars)}
    <text x="{cx1}" y="330" text-anchor="end" font-family="{SERIF}" font-size="13">/ 5</text>
    <text x="{cx0}" y="366" {lab} opacity="0.55">REVIEW</text>
    <path d="M{cx0 + 74} 366 H{cx1} M{cx0} 394 H{cx1}" stroke="{INK}" stroke-width="0.5" stroke-dasharray="1.5 2.5" fill="none" opacity="0.8"/>
    <text x="{cx0}" y="420" font-family="{SANS}" font-size="6.5" font-weight="600" letter-spacing="1.6" opacity="0.55">COMMEMORATIVE KEEPSAKE · NOT VALID FOR ENTRY · © TICKETSTUB</text>
    <!-- right column -->
    <path d="M{rx0 - 16} 30 V{H-30}" stroke="{INK}" stroke-width="0.6" fill="none"/>
    <text x="{rx0}" y="52" {lab}>TICKETSTUB</text>
    <text data-slot="edition" x="{rx0}" y="68" font-family="{SERIF}" font-style="italic" font-size="13" opacity="0.75">.</text>
    {''.join(fields)}
    <path d="M{rx0} 290 H{rx1} M{rx0} 326 H{rx1}" stroke="{INK}" stroke-width="0.6" fill="none"/>
    <g data-slot="barcode" data-w="{rx1-rx0}" data-h="36" transform="translate({rx0} 350)"></g>
    <text data-slot="serial" x="{rx0}" y="404" font-family="{SANS}" font-size="7.5" font-weight="600" letter-spacing="3.2">.</text>
    <text data-slot="dateShort" x="{rx1}" y="404" text-anchor="end" font-family="{SANS}" font-size="7.5" font-weight="600" letter-spacing="2">.</text>
  </g>
  <path data-layer="dieline" d="{die(T)}" fill="none" stroke="#ec008c" stroke-width="0.5"/>
</svg>
'''
    return s


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "front.svg").write_text(front(), encoding="utf8")
    (OUT / "back.svg").write_text(back(), encoding="utf8")
    print("wrote", OUT)
