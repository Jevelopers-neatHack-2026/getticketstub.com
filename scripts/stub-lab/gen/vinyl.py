"""Vinyl: one colour of riso black on cotton stock (editorial direction).

Front: the performer as a real screen halftone (45-degree dot screen + riso grain, thresholded in an
SVG filter) inside a rounded panel, a Didone masthead, a micro body paragraph, sparkle stars, barcode
and a notched tear-off stub. Back: a drawn vinyl record with a printed label, ruled info lines, QR,
price and a graph-paper ADMIT ONE stub.

    python scripts/stub-lab/gen/vinyl.py   -> public/stubs/vinyl/{front,back}.svg
"""
import math, random
from pathlib import Path
from die import notched

W, H = 480, 960
TEAR = 700
OUT = Path(__file__).resolve().parents[3] / "public" / "stubs" / "vinyl"
HOLE = "M234 22 a6 6 0 1 0 12 0 a6 6 0 1 0 -12 0Z"
DIE = notched(W, H, [(TEAR, 15)], radius=16, side="lr") + " " + HOLE
INK = "#1a1917"
PAPER = "#ebe7de"
SERIF = "'Bodoni Moda', 'Didot', 'Bodoni 72', serif"
MONO = "'JetBrains Mono', ui-monospace, monospace"
LN = 'style="font-variant-numeric: lining-nums"'
OP = 'style="font-variant-numeric: lining-nums; font-variation-settings: &quot;opsz&quot; 14"'


def head():
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" data-foil="ink">\n')


def common_defs():
    """Paper relief, riso ink texture, light-tracking sheen."""
    return f'''
    <filter id="vy-cotton" x="0" y="0" width="1" height="1" filterUnits="objectBoundingBox" color-interpolation-filters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency="0.32 0.36" numOctaves="3" seed="21" result="n"/>
      <feDiffuseLighting in="n" surfaceScale="1.1" diffuseConstant="1" lighting-color="#fff" result="lit">
        <feDistantLight azimuth="235" elevation="58"/>
      </feDiffuseLighting>
      <feColorMatrix in="lit" type="matrix" values="0 0 0 0 0.10  0 0 0 0 0.09  0 0 0 0 0.07  -1.1 0 0 0 0.98"/>
      <feComposite in2="SourceGraphic" operator="in"/>
    </filter>
    <filter id="vy-riso" x="-3%" y="-3%" width="106%" height="106%" color-interpolation-filters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency="0.7" numOctaves="2" seed="9" result="rough"/>
      <feDisplacementMap in="SourceGraphic" in2="rough" scale="0.45" xChannelSelector="R" yChannelSelector="G" result="d"/>
      <feTurbulence type="fractalNoise" baseFrequency="1.3" numOctaves="1" seed="4" result="n"/>
      <feColorMatrix in="n" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  7 0 0 0 -4.95" result="specks"/>
      <feComposite in="d" in2="specks" operator="out" result="speckled"/>
      <!-- uneven coverage: big solids breathe a little, like a drum running low on ink -->
      <feTurbulence type="fractalNoise" baseFrequency="0.035 0.05" numOctaves="3" seed="17" result="m"/>
      <feColorMatrix in="m" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0.16 0 0 0 0.91" result="mottle"/>
      <feComposite in="speckled" in2="mottle" operator="in"/>
    </filter>
    <radialGradient id="vy-sheenG" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#fffdf6" stop-opacity="0.26"/>
      <stop offset="0.5" stop-color="#fffdf6" stop-opacity="0.07"/>
      <stop offset="1" stop-color="#fffdf6" stop-opacity="0"/>
    </radialGradient>
    <style>
      svg[data-mode="print"] .vy-light {{ display: none; }}
      .vy-sheen {{ transform: translate(calc((var(--lx, 38%) - 50%) * 1.4), calc((var(--ly, 30%) - 50%) * 1.0)); mix-blend-mode: screen; opacity: calc(0.1 + var(--glow, 0.1) * 0.9); }}
      .vy-hi {{ transform: translate(calc((var(--lx, 38%) - 50%) * -0.006), calc((var(--ly, 30%) - 50%) * -0.004)); opacity: calc(0.45 + var(--glow, 0.1) * 0.55); }}
      .vy-lo {{ transform: translate(calc((var(--lx, 38%) - 50%) * 0.006), calc((var(--ly, 30%) - 50%) * 0.004)); opacity: calc(0.35 + var(--glow, 0.1) * 0.5); }}
    </style>'''


def paper_base():
    return f'''  <g data-layer="paper">
    <rect width="{W}" height="{H}" fill="{PAPER}"/>
    <rect width="{W}" height="{H}" fill="#000" filter="url(#ts-fibre)" opacity="0.05"/>
  </g>'''


def paper_top():
    """Cotton relief multiplied over everything (ink sits in the paper), plus a sheen that follows the light."""
    return f'''  <g data-layer="paper" pointer-events="none">
    <rect width="{W}" height="{H}" fill="#000" filter="url(#vy-cotton)" opacity="0.16"/>
    <rect width="{W}" height="{H}" fill="#000" filter="url(#ts-grain)" opacity="0.06"/>
    <g class="vy-light" data-screen-only=""><rect class="vy-sheen" x="{-W*0.4}" y="{-H*0.3}" width="{W*0.8}" height="{H*0.6}" fill="url(#vy-sheenG)"/></g>
  </g>'''


def sparkle(cx, cy, r, waist=0.16):
    """Four-point concave star."""
    k = r * waist
    return (f'M{cx} {cy-r} Q{cx+k} {cy-k} {cx+r} {cy} Q{cx+k} {cy+k} {cx} {cy+r} '
            f'Q{cx-k} {cy+k} {cx-r} {cy} Q{cx-k} {cy-k} {cx} {cy-r}Z')


def regmark(cx, cy, r=5, sw=0.6):
    """Printer's registration target."""
    return (f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="none" stroke="{INK}" stroke-width="{sw}"/>'
            f'<circle cx="{cx}" cy="{cy}" r="{r*0.45:.2f}" fill="{INK}"/>'
            f'<path d="M{cx-r*1.6:.2f} {cy} H{cx+r*1.6:.2f} M{cx} {cy-r*1.6:.2f} V{cy+r*1.6:.2f}" stroke="{INK}" stroke-width="{sw}"/>')


def speed_badge(cx, cy, r):
    """A 33 1/3 rpm centre-label badge: our own mark for the stub's right column."""
    p = [f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="{INK}"/>']
    for k in (0.93, 0.86, 0.79, 0.72):
        p.append(f'<circle cx="{cx}" cy="{cy}" r="{r*k:.2f}" fill="none" stroke="{PAPER}" stroke-width="0.45" stroke-opacity="0.55"/>')
    p.append(f'<circle cx="{cx}" cy="{cy}" r="{r*0.6:.2f}" fill="{PAPER}"/>')
    p.append(f'<circle cx="{cx}" cy="{cy}" r="{r*0.6-2:.2f}" fill="none" stroke="{INK}" stroke-width="0.5"/>')
    p.append(f'<text x="{cx}" y="{cy+2}" text-anchor="middle" font-family="{SERIF}" font-style="italic" font-weight="600" font-size="{r*0.46:.1f}" {LN}>33⅓</text>')
    p.append(f'<text x="{cx}" y="{cy+r*0.36:.1f}" text-anchor="middle" font-family="{MONO}" font-size="6.5" font-weight="700" letter-spacing="0.6">RPM</text>')
    return "".join(p)


def globe(cx, cy, rx, ry, sw=1.1):
    p = [f'<ellipse cx="{cx}" cy="{cy}" rx="{rx}" ry="{ry}" fill="none" stroke="{INK}" stroke-width="{sw}"/>']
    for f in (0.62, 0.25):
        p.append(f'<ellipse cx="{cx}" cy="{cy}" rx="{rx*f:.2f}" ry="{ry}" fill="none" stroke="{INK}" stroke-width="{sw*0.8:.2f}"/>')
    p.append(f'<path d="M{cx} {cy-ry} V{cy+ry}" stroke="{INK}" stroke-width="{sw*0.8:.2f}"/>')
    for t in (-0.55, 0, 0.55):
        y = cy + t * ry
        half = rx * math.sqrt(1 - t * t)
        p.append(f'<path d="M{cx-half:.2f} {y:.2f} H{cx+half:.2f}" stroke="{INK}" stroke-width="{sw*0.8:.2f}"/>')
    return "".join(p)


def perforation(y, x0=18, x1=W - 18, step=7, r=1.5):
    return "".join(f'<circle cx="{x:.1f}" cy="{y}" r="{r}"/>' for x in frange(x0, x1, step))


def frange(a, b, s):
    v = a
    while v <= b + 1e-6:
        yield v
        v += s


# ------------------------------------------------------------------ front
def front():
    PX0, PX1, PY0, PY1 = 26, 454, 40, 672  # picture panel
    pw, ph = PX1 - PX0, PY1 - PY0
    rnd = random.Random(7)
    specks = "".join(
        f'<path d="{sparkle(round(rnd.uniform(PX0+20, PX1-20),1), round(rnd.uniform(PY0+20, 250),1), round(rnd.choice([2.5,3,4,5.5]),1), 0.2)}"/>'
        for _ in range(9))
    dust = "".join(
        f'<circle cx="{rnd.uniform(PX0, PX1):.1f}" cy="{rnd.uniform(PY0, 330):.1f}" r="{rnd.choice([0.7,0.9,1.2])}"/>'
        for _ in range(70))
    grooves = "".join(
        f'<circle cx="240" cy="270" r="{r}" fill="none" stroke="#000" stroke-opacity="{0.22 + 0.1*(i%3):.2f}" stroke-width="{0.9 if i%4 else 2.2}"/>'
        for i, r in enumerate(range(62, 176, 4)))
    s = head()
    s += f'''  <defs>{common_defs()}
    <clipPath id="vy-panel"><rect x="{PX0}" y="{PY0}" width="{pw}" height="{ph}" rx="22"/></clipPath>
    <linearGradient id="vy-bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1c1c1c"/>
      <stop offset="0.45" stop-color="#3a3a3a"/>
      <stop offset="0.8" stop-color="#262626"/>
      <stop offset="1" stop-color="#050505"/>
    </linearGradient>
    <linearGradient id="vy-beam" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity="0.85"/>
      <stop offset="0.7" stop-color="#fff" stop-opacity="0.25"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <radialGradient id="vy-disc" cx="0.42" cy="0.38" r="0.65">
      <stop offset="0" stop-color="#cfcfcf"/>
      <stop offset="0.6" stop-color="#a6a6a6"/>
      <stop offset="1" stop-color="#6e6e6e"/>
    </radialGradient>
    <radialGradient id="vy-pool" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#fff" stop-opacity="0.7"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="vy-floorG" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000" stop-opacity="0.92"/>
    </linearGradient>
    <filter id="vy-smoke" x="0" y="0" width="1" height="1" filterUnits="objectBoundingBox" color-interpolation-filters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency="0.011 0.018" numOctaves="5" seed="12" result="n"/>
      <feColorMatrix in="n" type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  2.6 0 0 0 -1.15"/>
      <feComposite in2="SourceGraphic" operator="in"/>
    </filter>
    <filter id="vy-tone" color-interpolation-filters="sRGB">
      <feColorMatrix type="matrix" values="0.30 0.59 0.11 0 0  0.30 0.59 0.11 0 0  0.30 0.59 0.11 0 0  0 0 0 1 0"/>
      <feComponentTransfer>
        <feFuncR type="table" tableValues="0.04 0.24 0.52 0.78 0.93 1"/>
        <feFuncG type="table" tableValues="0.04 0.24 0.52 0.78 0.93 1"/>
        <feFuncB type="table" tableValues="0.04 0.24 0.52 0.78 0.93 1"/>
      </feComponentTransfer>
    </filter>
    <radialGradient id="vy-dot" cx="0.5" cy="0.5" r="0.7072">
      <stop offset="0" stop-color="#000"/>
      <stop offset="1" stop-color="#fff"/>
    </radialGradient>
    <pattern id="vy-screen" width="4.4" height="4.4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="4.4" height="4.4" fill="url(#vy-dot)"/>
    </pattern>
    <linearGradient id="vy-artfadeG" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0.86" stop-color="#fff"/>
      <stop offset="1" stop-color="#000"/>
    </linearGradient>
    <mask id="vy-artfade" maskUnits="userSpaceOnUse" x="0" y="0" width="{W}" height="{H}">
      <rect x="0" y="{PY0}" width="{W}" height="{ph}" fill="url(#vy-artfadeG)"/>
    </mask>
    <!-- the screen: tone + dot screen (50/50) + grain, thresholded to one ink -->
    <filter id="vy-halftone" x="{PX0}" y="{PY0}" width="{pw}" height="{ph}" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency="1.1" numOctaves="2" seed="3" result="n"/>
      <feColorMatrix in="n" type="matrix" values="1 0 0 0 0  1 0 0 0 0  1 0 0 0 0  0 0 0 0 1" result="ng"/>
      <feComposite in="SourceGraphic" in2="ng" operator="arithmetic" k2="0.86" k3="0.14" k4="-0.07" result="mix"/>
      <feColorMatrix in="mix" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  -1 0 0 0 1" result="dark"/>
      <feComponentTransfer in="dark" result="bits"><feFuncA type="discrete" tableValues="0 1"/></feComponentTransfer>
      <feFlood flood-color="{INK}" result="ink"/>
      <feComposite in="ink" in2="bits" operator="in" result="plate"/>
      <feTurbulence type="fractalNoise" baseFrequency="0.03 0.045" numOctaves="3" seed="29" result="m"/>
      <feColorMatrix in="m" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0.14 0 0 0 0.92" result="mottle"/>
      <feComposite in="plate" in2="mottle" operator="in"/>
    </filter>
    <filter id="vy-choke" x="-10%" y="-10%" width="120%" height="120%" color-interpolation-filters="sRGB">
      <feMorphology in="SourceAlpha" operator="dilate" radius="3.2" result="fat"/>
      <feGaussianBlur in="fat" stdDeviation="2.2" result="soft"/>
      <feFlood flood-color="#000" flood-opacity="0.9"/>
      <feComposite in2="soft" operator="in"/>
    </filter>
  </defs>
{paper_base()}
  <g data-layer="art" clip-path="url(#vy-panel)">
    <g filter="url(#vy-halftone)" transform="translate(0.7 0.5)">
      <rect x="{PX0}" y="{PY0}" width="{pw}" height="{ph}" fill="url(#vy-bg)"/>
      <rect x="{PX0}" y="{PY0}" width="{pw}" height="{ph}" fill="#fff" filter="url(#vy-smoke)" opacity="0.55"/>
      <path d="M200 {PY0} L280 {PY0} L430 {PY1} L50 {PY1}Z" fill="url(#vy-beam)" opacity="0.55"/>
      <circle cx="240" cy="270" r="176" fill="url(#vy-disc)"/>
      <g>{grooves}</g>
      <circle cx="240" cy="270" r="54" fill="#9a9a9a"/><circle cx="240" cy="270" r="48" fill="none" stroke="#fff" stroke-width="1.2"/><circle cx="240" cy="270" r="5" fill="#111"/>
      <circle cx="240" cy="270" r="176" fill="none" stroke="#000" stroke-width="3"/>
      <g fill="#fff">{dust}{specks}</g>
      <ellipse cx="240" cy="{PY1-34}" rx="210" ry="40" fill="url(#vy-pool)"/>
      <rect x="{PX0}" y="{PY1-120}" width="{pw}" height="120" fill="url(#vy-floorG)"/>
      <g mask="url(#vy-artfade)">
        <image data-slot="art" x="{PX0+6}" y="{PY0+40}" width="{pw-12}" height="{ph-40}" preserveAspectRatio="xMidYMax meet" filter="url(#vy-choke)"/>
        <image data-slot="art" x="{PX0+6}" y="{PY0+40}" width="{pw-12}" height="{ph-40}" preserveAspectRatio="xMidYMax meet" filter="url(#vy-tone)"/>
      </g>
      <rect x="{PX0}" y="{PY0}" width="{pw}" height="{ph}" fill="url(#vy-screen)" opacity="0.5"/>
    </g>
  </g>
  <g data-layer="ink" fill="{INK}" filter="url(#vy-riso)">
    <rect x="{PX0}" y="{PY0}" width="{pw}" height="{ph}" rx="22" fill="none" stroke="{INK}" stroke-width="1.6"/>
    <text data-slot="categoryLabel" x="{PX0+20}" y="{PY1-14}" font-family="{MONO}" font-size="8.5" font-weight="600" letter-spacing="2.6" fill="{PAPER}">.</text>
    <text data-slot="dateDots" x="240" y="{PY1-14}" text-anchor="middle" font-family="{MONO}" font-size="8.5" font-weight="600" letter-spacing="2.6" fill="{PAPER}">.</text>
    <text data-slot="city" x="{PX1-20}" y="{PY1-14}" text-anchor="end" font-family="{MONO}" font-size="8.5" font-weight="600" letter-spacing="2.6" fill="{PAPER}" data-case="upper" data-fit="120" data-min="6.5">.</text>
    <g fill="{INK}">{perforation(TEAR)}</g>
    <path d="M146 {TEAR+12} H30 V{H-18} H450 V{TEAR+12} H334" fill="none" stroke="{INK}" stroke-width="1.1"/>
    <path d="M146 {TEAR+16} H34 V{H-22} H446 V{TEAR+16} H334" fill="none" stroke="{INK}" stroke-width="0.5"/>
    <path d="M146 {TEAR+10} V{TEAR+18} M334 {TEAR+10} V{TEAR+18}" stroke="{INK}" stroke-width="0.8"/>
    <text data-slot="kicker" x="240" y="{TEAR+16+2.6}" text-anchor="middle" font-family="{MONO}" font-size="7.5" font-weight="700" letter-spacing="2.4" data-case="upper" data-fit="168" data-min="6.5" data-default="One night only">.</text>
    <text data-slot="title" x="240" y="802" text-anchor="middle" font-family="{SERIF}" font-weight="600" font-size="37" letter-spacing="1" data-case="upper" data-wrap="384" data-lines="3" data-leading="0.94" data-anchor="bottom" data-min="13" {OP}>.</text>
    <path d="M48 814 H432" stroke="{INK}" stroke-width="0.6"/>
    <text x="48" y="830" font-family="{SERIF}" font-size="8.6" font-weight="500" data-wrap="270" data-lines="3" data-leading="1.36" data-min="6.6" data-justify="" {LN}><tspan data-slot="tagline" data-suffix=" " data-default="One night, kept."></tspan><tspan data-slot="subtitle" data-suffix=". "></tspan><tspan data-slot="place" data-prefix="At " data-suffix="."></tspan></text>
    <text x="48" y="875" font-family="{MONO}" font-size="7" font-weight="500" letter-spacing="0.6" data-wrap="270" data-lines="2" data-leading="1.45" data-anchor="bottom" data-min="6.5" ><tspan data-slot="peopleAll" data-case="upper" data-prefix="WITH "></tspan></text>
    <g data-slot="barcode" data-w="150" data-h="20" transform="translate(48 888)"></g>
    <text x="48" y="921" font-family="{MONO}" font-size="7" font-weight="500" letter-spacing="1.2" {LN}><tspan data-slot="year" data-prefix="© ">.</tspan> TICKETSTUB · <tspan data-slot="serial">.</tspan></text>
    {speed_badge(388, 858, 30)}
    <text x="388" y="908" text-anchor="middle" font-family="{MONO}" font-size="6.5" font-weight="600" letter-spacing="1.6" data-fit="110"><tspan data-slot="edition" data-default="KEEPSAKE">.</tspan></text>
    {regmark(426, 924, 3.6, 0.5)}
  </g>
{paper_top()}
  <path data-layer="dieline" d="{DIE}" clip-rule="evenodd" fill-rule="evenodd" fill="none" stroke="#ec008c" stroke-width="0.5"/>
</svg>
'''
    return s


# ------------------------------------------------------------------ back
def record(cx, cy, R):
    """A record drawn in one ink: disc, grooves, two light reflections as sawtooth wedges, paper label."""
    p = [f'<circle cx="{cx}" cy="{cy}" r="{R}" fill="{INK}"/>']
    # grooves: thin paper-colour rings
    rnd = random.Random(33)
    r = R - 5
    while r > R * 0.36:
        p.append(f'<circle cx="{cx}" cy="{cy}" r="{r:.1f}" fill="none" stroke="{PAPER}" stroke-opacity="{rnd.uniform(0.10, 0.28):.2f}" stroke-width="{rnd.choice([0.35, 0.45, 0.6])}"/>')
        r -= rnd.uniform(2.0, 3.6)
    # track gaps
    for rr in (R * 0.82, R * 0.66, R * 0.52):
        p.append(f'<circle cx="{cx}" cy="{cy}" r="{rr:.1f}" fill="none" stroke="{INK}" stroke-width="1.6"/>')
    # reflections: light catching the grooves, a soft tapered wedge filled with thin radial streaks
    rnd2 = random.Random(5)
    r0, r1 = R * 0.38, R * 0.97
    for base in (-50, 130):
        for half, op in ((19, 0.10), (12, 0.14), (6, 0.22)):
            a0, a1 = math.radians(base - half), math.radians(base + half)
            b0, b1 = math.radians(base - half * 0.25), math.radians(base + half * 0.25)
            d = (f"M{cx + r0*math.cos(b0):.1f} {cy + r0*math.sin(b0):.1f} "
                 f"L{cx + r1*math.cos(a0):.1f} {cy + r1*math.sin(a0):.1f} "
                 f"A{r1} {r1} 0 0 1 {cx + r1*math.cos(a1):.1f} {cy + r1*math.sin(a1):.1f} "
                 f"L{cx + r0*math.cos(b1):.1f} {cy + r0*math.sin(b1):.1f}Z")
            p.append(f'<path d="{d}" fill="{PAPER}" opacity="{op}"/>')
        for _ in range(46):
            t = rnd2.gauss(0, 0.42)
            spread = 19
            a = math.radians(base + max(-1, min(1, t)) * spread)
            ra = r0 + (r1 - r0) * rnd2.uniform(0.0, 0.45)
            rb = ra + (r1 - ra) * rnd2.uniform(0.35, 1.0)
            w = rnd2.choice([0.35, 0.5, 0.7, 0.9])
            o = max(0.25, 0.95 - abs(t) * 0.9)
            p.append(f'<path d="M{cx + ra*math.cos(a):.1f} {cy + ra*math.sin(a):.1f} L{cx + rb*math.cos(a):.1f} {cy + rb*math.sin(a):.1f}" stroke="{PAPER}" stroke-width="{w}" stroke-linecap="round" opacity="{o:.2f}"/>')
    # label
    L = R * 0.36
    p.append(f'<circle cx="{cx}" cy="{cy}" r="{L:.1f}" fill="{PAPER}"/>')
    p.append(f'<circle cx="{cx}" cy="{cy}" r="{L-3:.1f}" fill="none" stroke="{INK}" stroke-width="0.6"/>')
    p.append(f'<circle cx="{cx}" cy="{cy}" r="3.2" fill="{INK}"/>')
    return "".join(p), L


def back():
    cx, cy, R = 240, 262, 118
    rec, L = record(cx, cy, R)
    lab = f'font-family="{MONO}" font-size="7.5" font-weight="700" letter-spacing="1.6"'
    val = f'font-family="{MONO}" font-size="11" font-weight="500" {LN}'
    # graph-paper grid inside the stub box
    GX0, GX1, GY0, GY1 = 34, 446, TEAR + 22, 900
    grid = []
    for x in frange(GX0, GX1, (GX1-GX0)/30):
        grid.append(f'M{x:.1f} {GY0} V{GY1}')
    for y in frange(GY0, GY1, (GY1-GY0)/13):
        grid.append(f'M{GX0} {y:.1f} H{GX1}')
    stars = "".join(f'<path d="{sparkle(170 + i*22, 523, 7.5, 0.2)}" fill="none" stroke="{INK}" stroke-width="0.9"/>' for i in range(5))
    ecy = (GY0 + GY1) / 2
    s = head()
    s += f'''  <defs>{common_defs()}</defs>
{paper_base()}
  <g data-layer="ink" fill="{INK}" filter="url(#vy-riso)">
    <text data-slot="title" x="240" y="76" text-anchor="middle" font-family="{SERIF}" font-weight="700" font-size="46" letter-spacing="0.5" data-case="upper" data-wrap="412" data-lines="2" data-leading="0.98" data-anchor="bottom" data-min="11" {OP}>.</text>
    <text x="240" y="100" text-anchor="middle" font-family="{MONO}" font-size="10" font-weight="700" letter-spacing="2.4" data-fit="404" data-min="6.5"><tspan data-slot="venue" data-case="upper" data-suffix=" PRESENTS">.</tspan></text>
    <path d="M26 114 H454" stroke="{INK}" stroke-width="1.1"/>
    <path d="M26 118 H454" stroke="{INK}" stroke-width="0.5"/>
    {rec}
    <text data-slot="title" x="{cx}" y="{cy-11}" text-anchor="middle" font-family="{SERIF}" font-weight="700" font-size="10.5" data-wrap="{0.72*2*L:.0f}" data-lines="2" data-leading="1.05" data-anchor="bottom" data-min="6.5" {OP}>.</text>
    <text x="{cx}" y="{cy+17}" text-anchor="middle" font-family="{MONO}" font-size="6.5" font-weight="600" letter-spacing="1">SIDE A · 33⅓</text>
    <text data-slot="year" x="{cx}" y="{cy+26}" text-anchor="middle" font-family="{MONO}" font-size="6.5" letter-spacing="1" data-prefix="℗ ">.</text>
    <path d="M26 400 H454" stroke="{INK}" stroke-width="0.5"/>
    <text x="40" y="424" {lab}>DATE &amp; TIME</text>
    <text x="150" y="424" {val} data-fit="290" data-min="7"><tspan data-slot="dateLong">.</tspan><tspan data-slot="time" data-prefix="  |  ">.</tspan></text>
    <path d="M26 438 H454" stroke="{INK}" stroke-width="0.5" stroke-dasharray="1 2.5"/>
    <text x="40" y="458" {lab}>VENUE</text>
    <text x="150" y="458" {val} data-fit="290" data-min="7"><tspan data-slot="place">.</tspan></text>
    <path d="M26 472 H454" stroke="{INK}" stroke-width="0.5" stroke-dasharray="1 2.5"/>
    <text x="40" y="492" {lab}>SEAT</text>
    <text data-slot="seatLine" x="150" y="492" {val} data-fit="290" data-min="7" data-default="Unreserved · general admission">.</text>
    <path d="M26 506 H454" stroke="{INK}" stroke-width="0.5" stroke-dasharray="1 2.5"/>
    <text x="40" y="526" {lab}>RATING</text>
    {stars}
    <text x="440" y="526" text-anchor="end" font-family="{MONO}" font-size="8" {LN}>( &#160;&#160;/ 5 )</text>
    <path d="M26 540 H454" stroke="{INK}" stroke-width="0.5" stroke-dasharray="1 2.5"/>
    <text x="40" y="560" {lab}>REVIEW</text>
    <text data-slot="note" x="150" y="560" font-family="{SERIF}" font-style="italic" font-size="11" data-wrap="290" data-lines="1" data-min="8">.</text>
    <path d="M150 564 H440 M150 584 H440" stroke="{INK}" stroke-width="0.5" stroke-dasharray="1 2.5"/>
    <path d="M26 600 H454" stroke="{INK}" stroke-width="0.5"/>
    <text x="44" y="628" {lab}>PRICE</text>
    <text data-slot="price" x="44" y="662" font-family="{SERIF}" font-weight="700" font-size="24" data-fit="120" data-min="10" data-default="—" {OP}>.</text>
    {regmark(56, 680, 3.6, 0.5)}
    <text data-slot="edition" x="250" y="640" text-anchor="middle" font-family="{SERIF}" font-style="italic" font-weight="500" font-size="22" data-fit="170" data-min="10" {LN} data-default="Keepsake">.</text>
    <text x="250" y="658" text-anchor="middle" font-family="{MONO}" font-size="7" letter-spacing="2.2" {LN}>SERIAL <tspan data-slot="serial">.</tspan></text>
    <text x="250" y="674" text-anchor="middle" font-family="{MONO}" font-size="6.5" letter-spacing="1.2">ONE COLOUR · COTTON STOCK</text>
    <g data-slot="qr" data-size="76" transform="translate(364 608)"></g>
    <g fill="{INK}">{perforation(TEAR)}</g>
    <path d="{' '.join(grid)}" stroke="{INK}" stroke-width="0.35" stroke-opacity="0.8" fill="none"/>
    <rect x="{GX0}" y="{GY0}" width="{GX1-GX0}" height="{GY1-GY0}" fill="none" stroke="{INK}" stroke-width="1.4"/>
    <ellipse cx="240" cy="{ecy}" rx="176" ry="50" fill="{PAPER}" stroke="{INK}" stroke-width="2.6"/>
    <ellipse cx="240" cy="{ecy}" rx="169" ry="44" fill="none" stroke="{INK}" stroke-width="0.6"/>
    <text data-slot="admit" x="240" y="{ecy+15}" text-anchor="middle" font-family="{SERIF}" font-weight="600" font-size="42" letter-spacing="1" data-case="upper" data-fit="300" data-min="14" data-default="Welcome" {OP}>.</text>
    <rect x="{GX0+6}" y="{GY0+6}" width="64" height="15" fill="{PAPER}"/>
    <text data-slot="dateShort" x="{GX0+12}" y="{GY0+16.6}" font-family="{MONO}" font-size="8" font-weight="700" letter-spacing="1.4">.</text>
    <rect x="{GX1-70}" y="{GY1-21}" width="64" height="15" fill="{PAPER}"/>
    <text data-slot="time" x="{GX1-12}" y="{GY1-10.4}" text-anchor="end" font-family="{MONO}" font-size="8" font-weight="700" letter-spacing="1.4" data-default="—" {LN}>.</text>
    <text x="240" y="920" text-anchor="middle" font-family="{MONO}" font-size="6.5" letter-spacing="1.4" data-fit="400">COMMEMORATIVE KEEPSAKE · NOT VALID FOR ENTRY · <tspan data-slot="serial">.</tspan></text>
    <text x="240" y="936" text-anchor="middle" font-family="{SERIF}" font-style="italic" font-size="8">Printed by TicketStub</text>
  </g>
{paper_top()}
  <path data-layer="dieline" d="{DIE}" clip-rule="evenodd" fill-rule="evenodd" fill="none" stroke="#ec008c" stroke-width="0.5"/>
</svg>
'''
    return s


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "front.svg").write_text(front(), encoding="utf8")
    (OUT / "back.svg").write_text(back(), encoding="utf8")
    print("wrote", OUT)
