"""Headliner: a white festival ticket, a black-and-white performer panel and a holographic tear-off tab.

    python scripts/stub-lab/gen/headliner.py   -> public/stubs/headliner/{front,back}.svg

Front (poster face): rotating-text badge, huge Archivo Black title, light Space Grotesk subtitle, a framed
monochrome panel (threshold-dithered performer with a sticker keyline over a vinyl record, checker and
chevron blocks), and a holo-film stub on the right behind a notched perforation.
Back (info face, flipped so the stub sits on the left): wristband strip, a poster-bill line-up, the night's
fields, rating + review lines, barcode/QR and small print.
"""
import math
from pathlib import Path
from die import _f

W, H = 1100, 440
CUT = 820  # perforation x on the front (stub to the right)
NOTCH = 13
OUT = Path(__file__).resolve().parents[3] / "public" / "stubs" / "headliner"
INK = "#111111"
PAPER = "#f7f6f2"
GROT = "'Space Grotesk', 'Inter Tight', sans-serif"
BLACK = "'Archivo Black', 'Space Grotesk', sans-serif"


def die(cut, r=18):
    """Rounded rectangle with a semicircle bite top and bottom at x=cut (the tear line)."""
    n = NOTCH
    return (f"M{r} 0 L{cut - n} 0 A{n} {n} 0 0 0 {cut + n} 0 L{W - r} 0 Q{W} 0 {W} {r} "
            f"L{W} {H - r} Q{W} {H} {W - r} {H} L{cut + n} {H} A{n} {n} 0 0 0 {cut - n} {H} "
            f"L{r} {H} Q0 {H} 0 {H - r} L0 {r} Q0 0 {r} 0Z")


def head(extra=""):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" data-foil="ink" data-holo="pastel" {extra}>\n'


def perforation(x, color=INK, op=0.55):
    dots = []
    y = NOTCH + 9
    while y < H - NOTCH - 6:
        dots.append(f'<circle cx="{x}" cy="{y:.1f}" r="1.7"/>')
        y += 8.5
    return f'<g fill="{color}" opacity="{op}">{"".join(dots)}</g>'


def checker(x, y, cols, rows, s, color=INK, phase=0):
    out = []
    for j in range(rows):
        for i in range(cols):
            if (i + j + phase) % 2 == 0:
                out.append(f"M{_f(x + i * s)} {_f(y + j * s)}h{_f(s)}v{_f(s)}h{_f(-s)}z")
    return f'<path d="{"".join(out)}" fill="{color}"/>'


def chevrons(x, y, n, w, h, gap, color=INK, stroke=None):
    """A row of solid chevrons pointing right, each w wide, h tall."""
    d = []
    t = w * 0.55
    for i in range(n):
        x0 = x + i * (w + gap - t)
        d.append(f"M{_f(x0)} {_f(y)}h{_f(t)}l{_f(w - t)} {_f(h / 2)}l{_f(t - w)} {_f(h / 2)}h{_f(-t)}l{_f(w - t)} {_f(-h / 2)}z")
    return f'<path d="{"".join(d)}" fill="{color}"/>'


def badge(cx, cy, r):
    """Black sticker badge: ring text in paper colour around a starburst; rotates slowly on screen."""
    tr = r - 11
    circ = 2 * math.pi * tr
    pts = []
    for i in range(24):
        a = math.pi * 2 * i / 24 - math.pi / 2
        rr = 12 if i % 2 == 0 else 5.6
        pts.append(f"{_f(cx + rr * math.cos(a))} {_f(cy + rr * math.sin(a))}")
    star = "M" + " L".join(pts) + "Z"
    return f'''<g>
      <circle cx="{cx}" cy="{cy}" r="{r}" fill="{INK}"/>
      <circle cx="{cx}" cy="{cy}" r="{r - 3}" fill="none" stroke="{PAPER}" stroke-width="0.6"/>
      <circle cx="{cx}" cy="{cy}" r="{tr - 4}" fill="none" stroke="{PAPER}" stroke-width="0.6"/>
      <path id="badgering" d="M{cx} {cy + tr} A{tr} {tr} 0 1 1 {cx} {cy - tr} A{tr} {tr} 0 1 1 {cx} {cy + tr}" fill="none"/>
      <g>
        <text font-family="{GROT}" font-size="7.4" font-weight="700" letter-spacing="0" fill="{PAPER}"><textPath href="#badgering" textLength="{circ - 3:.1f}" lengthAdjust="spacing">TICKETSTUB ✦ KEEP THE NIGHT ✦ HEADLINER ✦</textPath></text>
        <animateTransform attributeName="transform" type="rotate" from="0 {cx} {cy}" to="360 {cx} {cy}" dur="40s" repeatCount="indefinite"/>
      </g>
      <path d="{star}" fill="{PAPER}"/>
      <circle cx="{cx}" cy="{cy}" r="2.4" fill="{INK}"/>
    </g>'''


# ------------------------------------------------------------------ front
def holo_texture():
    """Screen-only rainbow hairline banding + sparkles over the holo tab (simulates diffraction foil)."""
    import random
    hues = ["#ff4fa3", "#ff9a3c", "#ffe14a", "#5ee08a", "#3cc8ff", "#6b7bff", "#c45cff"]
    lines = []
    i = 0
    off = -H * 0.6
    while CUT + off + i * 2.2 < W + H * 0.6:
        x = CUT + off + i * 2.2
        c = hues[(i // 5) % len(hues)]
        lines.append(f'<path d="M{_f(x)} 0 l{_f(H * 0.58)} {H}" stroke="{c}"/>')
        i += 1
    rnd = random.Random(21)
    sp = []
    for _ in range(46):
        x, y = rnd.uniform(CUT + 6, W - 6), rnd.uniform(40, H - 6)
        r = rnd.choice([1.2, 1.6, 2.2, 3.2])
        sp.append(f'<path d="M{_f(x)} {_f(y - r)} Q{_f(x)} {_f(y)} {_f(x + r)} {_f(y)} Q{_f(x)} {_f(y)} {_f(x)} {_f(y + r)} Q{_f(x)} {_f(y)} {_f(x - r)} {_f(y)} Q{_f(x)} {_f(y)} {_f(x)} {_f(y - r)}Z" opacity="{rnd.uniform(0.5, 0.95):.2f}"/>')
    return (f'<g data-screen-only="" clip-path="url(#tabclip)" pointer-events="none">'
            f'<g fill="none" stroke-width="0.55" opacity="0.2" style="mix-blend-mode: multiply">{"".join(lines)}</g>'
            f'<g fill="#ffffff" style="mix-blend-mode: screen">{"".join(sp)}</g></g>')


def diffraction():
    """Fine concentric grating lines (dark in the holo mask), like spun diffraction foil."""
    cx, cy = W + 140, -120
    d = []
    r = 180.0
    while r < 760:
        d.append(f"M{_f(cx - r)} {_f(cy)}a{_f(r)} {_f(r)} 0 1 0 {_f(2 * r)} 0a{_f(r)} {_f(r)} 0 1 0 {_f(-2 * r)} 0")
        r += 2.6
    return f'<path d="{"".join(d)}" fill="none" stroke="#000" stroke-opacity="0.16" stroke-width="0.7"/>'


PX, PY, PW, PH = 468, 26, 326, 388  # art panel frame
BAND = 50  # caption band at the bottom of the panel


def record(cx, cy, r):
    g = [f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="{INK}"/>']
    rr = r - 6
    while rr > r * 0.36:
        g.append(f'<circle cx="{cx}" cy="{cy}" r="{rr:.1f}" fill="none" stroke="#fff" stroke-opacity="{0.10 if int(rr) % 3 else 0.2}" stroke-width="0.6"/>')
        rr -= 3.2
    # light sheen wedge on the vinyl
    g.append(f'<path d="M{cx} {cy} L{_f(cx + r * math.cos(-0.95))} {_f(cy + r * math.sin(-0.95))} A{r} {r} 0 0 1 {_f(cx + r * math.cos(-0.55))} {_f(cy + r * math.sin(-0.55))}Z" fill="#fff" opacity="0.10"/>')
    g.append(f'<path d="M{cx} {cy} L{_f(cx + r * math.cos(2.19))} {_f(cy + r * math.sin(2.19))} A{r} {r} 0 0 1 {_f(cx + r * math.cos(2.59))} {_f(cy + r * math.sin(2.59))}Z" fill="#fff" opacity="0.07"/>')
    lr = r * 0.32
    g.append(f'<circle cx="{cx}" cy="{cy}" r="{lr:.1f}" fill="{PAPER}"/>')
    g.append(f'<circle cx="{cx}" cy="{cy}" r="{lr - 5:.1f}" fill="none" stroke="{INK}" stroke-width="0.7"/>')
    g.append(f'<circle cx="{cx}" cy="{cy}" r="3.2" fill="{INK}"/>')
    return "\n      ".join(g)


def halftone_field(x0, y0, w, h, step, rmax, fade="up"):
    """Dot screen whose dots grow toward the bottom (or top)."""
    d = []
    j = 0
    y = y0 + step / 2
    while y < y0 + h:
        t = (y - y0) / h
        t = t if fade == "up" else 1 - t
        rr = rmax * (t ** 1.6)
        off = step / 2 if j % 2 else 0
        x = x0 + step / 2 + off
        if rr > 0.35:
            while x < x0 + w:
                d.append(f"M{_f(x - rr)} {_f(y)}a{_f(rr)} {_f(rr)} 0 1 0 {_f(2 * rr)} 0a{_f(rr)} {_f(rr)} 0 1 0 {_f(-2 * rr)} 0")
                x += step
        y += step
        j += 1
    return f'<path d="{"".join(d)}" fill="{INK}"/>'


def front():
    ax, ay, aw, ah = PX + 34, PY + 3, PW - 42, PH - BAND - 3  # art box inside the frame
    rcx, rcy, rr = PX + PW / 2 + 18, PY + 150, 128
    s = head()
    s += f'''  <defs>
    <filter id="bw" x="-4%" y="-4%" width="108%" height="108%" color-interpolation-filters="sRGB">
      <feColorMatrix in="SourceGraphic" type="matrix" values="0.30 0.59 0.11 0 0  0.30 0.59 0.11 0 0  0.30 0.59 0.11 0 0  0 0 0 0 1" result="lum"/>
      <feComponentTransfer in="lum" result="con">
        <feFuncR type="linear" slope="1.7" intercept="0.0"/>
        <feFuncG type="linear" slope="1.7" intercept="0.0"/>
        <feFuncB type="linear" slope="1.7" intercept="0.0"/>
      </feComponentTransfer>
      <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="1" seed="4" result="noise"/>
      <feColorMatrix in="noise" type="matrix" values="1 0 0 0 0  1 0 0 0 0  1 0 0 0 0  0 0 0 0 1" result="ng"/>
      <feComposite in="con" in2="ng" operator="arithmetic" k1="0" k2="1" k3="0.55" k4="-0.3" result="mix"/>
      <feComponentTransfer in="mix" result="thr">
        <feFuncR type="discrete" tableValues="0.067 1"/>
        <feFuncG type="discrete" tableValues="0.067 1"/>
        <feFuncB type="discrete" tableValues="0.067 0.99"/>
        <feFuncA type="discrete" tableValues="1 1"/>
      </feComponentTransfer>
      <feColorMatrix in="noise" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  1 0 0 0 0" result="na"/>
      <feComposite in="SourceAlpha" in2="na" operator="arithmetic" k1="0" k2="1.1" k3="0.6" k4="-0.35" result="ad"/>
      <feComponentTransfer in="ad" result="am"><feFuncA type="discrete" tableValues="0 1"/></feComponentTransfer>
      <feComposite in="thr" in2="am" operator="in" result="dot"/>
      <feComponentTransfer in="SourceAlpha" result="sa"><feFuncA type="discrete" tableValues="0 0 1"/></feComponentTransfer>
      <feMorphology in="sa" operator="dilate" radius="4.5" result="d1"/>
      <feFlood flood-color="#ffffff" result="w"/>
      <feComposite in="w" in2="d1" operator="in" result="keyline"/>
      <feMorphology in="sa" operator="dilate" radius="6" result="d2"/>
      <feFlood flood-color="{INK}" result="k"/>
      <feComposite in="k" in2="d2" operator="in" result="outer"/>
      <feMerge><feMergeNode in="outer"/><feMergeNode in="keyline"/><feMergeNode in="dot"/></feMerge>
    </filter>
    <linearGradient id="underlay" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#d9f3ff"/><stop offset="0.35" stop-color="#fff3c4"/><stop offset="0.7" stop-color="#ffd7e6"/><stop offset="1" stop-color="#e4dcff"/>
    </linearGradient>
    <clipPath id="tabclip"><rect x="{CUT}" y="34" width="{W - CUT}" height="{H - 34}"/></clipPath>
    <clipPath id="artclip"><rect x="{PX}" y="{PY}" width="{PW}" height="{PH - BAND}"/></clipPath>
  </defs>
  <g data-layer="paper">
    <rect width="{W}" height="{H}" fill="{PAPER}"/>
    <rect width="{W}" height="{H}" fill="#000" filter="url(#ts-fibre)" opacity="0.05"/>
    <rect width="{W}" height="{H}" fill="#000" filter="url(#ts-grain)" opacity="0.05"/>
  </g>
  <g data-layer="art" clip-path="url(#artclip)">
    <rect x="{PX}" y="{PY}" width="{PW}" height="{PH - BAND}" fill="#fff"/>
    {halftone_field(PX + 26, PY + 180, PW - 26, PH - BAND - 180, 7, 2.9)}
    {record(rcx, rcy, rr)}
    <image data-slot="art" x="{ax}" y="{ay}" width="{aw}" height="{ah}" preserveAspectRatio="xMidYMax meet" filter="url(#bw)"/>
  </g>
  <g data-layer="paper">
    <rect x="{CUT}" y="0" width="{W - CUT}" height="{H}" fill="url(#underlay)"/>
  </g>
  <g data-layer="holo">
    <rect x="{CUT}" y="0" width="{W - CUT}" height="{H}" fill="#fff"/>
    {diffraction()}
  </g>
  <g data-layer="ink" fill="{INK}">
    <!-- art panel frame + pattern blocks -->
    <rect x="{PX}" y="{PY}" width="{PW}" height="{PH}" fill="none" stroke="{INK}" stroke-width="2"/>
    <path d="M{PX + 26} {PY} V{PY + PH - BAND} M{PX} {PY + PH - BAND} H{PX + PW}" stroke="{INK}" stroke-width="2" fill="none"/>
    {checker(PX, PY, 2, 26, 13)}
    <text data-show-if="doors" x="{PX + 14}" y="{PY + PH - 29}" font-family="{GROT}" font-size="7.5" font-weight="700" letter-spacing="1.8">DOORS</text>
    <text data-slot="doors" x="{PX + 14}" y="{PY + PH - 14}" font-family="{GROT}" font-size="13" font-weight="600" letter-spacing="0.4">.</text>
    {chevrons(PX + PW / 2 - 24, PY + PH - 34, 3, 16, 18, 4)}
    <text data-show-if="people2" x="{PX + PW - 14}" y="{PY + PH - 29}" text-anchor="end" font-family="{GROT}" font-size="7.5" font-weight="700" letter-spacing="1.8">ALSO ON THE BILL</text>
    <text data-slot="people2" x="{PX + PW - 14}" y="{PY + PH - 14}" text-anchor="end" font-family="{GROT}" font-size="12" font-weight="500" data-fit="124" data-min="6.8">.</text>

    <!-- left column -->
    {badge(72, 66, 42)}
    <text data-slot="kicker" data-default="Original stub" x="134" y="46" font-family="{GROT}" font-size="11" font-weight="700" letter-spacing="2.6" data-case="upper" data-fit="210" data-min="7.5">.</text>
    <text data-slot="edition" x="440" y="46" text-anchor="end" font-family="{GROT}" font-size="11" font-weight="500" letter-spacing="0.6">.</text>
    <path d="M134 58 H440" stroke="{INK}" stroke-width="0.8"/>
    <text x="134" y="78" font-family="{GROT}" font-size="11" font-weight="500" letter-spacing="0.4" data-fit="306" data-min="7.5"><tspan data-slot="weekday">.</tspan><tspan data-show-if="weekday">  ·  </tspan><tspan data-slot="date">.</tspan></text>

    <text data-slot="title" x="33" y="298" style="font-variant-numeric: lining-nums" font-family="{BLACK}" font-size="108" letter-spacing="-2" data-wrap="396" data-lines="3" data-leading="0.92" data-anchor="bottom" data-min="22">.</text>
    <text data-slot="subtitle" data-default="One night only." x="36" y="330" font-family="{GROT}" font-size="22" font-weight="300" letter-spacing="-0.3" data-wrap="404" data-lines="2" data-leading="1.04" data-min="13">.</text>

    <path d="M36 370 H440" stroke="{INK}" stroke-width="0.8"/>
    <text data-slot="serial" x="36" y="388" font-family="{GROT}" font-size="11" font-weight="500" letter-spacing="2.2">.</text>
    <g data-slot="barcode" data-w="132" data-h="20" transform="translate(36 394)"></g>
    <text x="440" y="385" text-anchor="end" font-family="{GROT}" font-size="7" font-weight="700" letter-spacing="1.6" opacity="0.7">VENUE</text>
    <text data-slot="place" x="440" y="401" text-anchor="end" font-family="{GROT}" font-size="11" font-weight="700" letter-spacing="1.1" data-case="upper" data-wrap="250" data-lines="1" data-min="6.8">.</text>
    <text x="440" y="413" text-anchor="end" font-family="{GROT}" font-size="6.5" font-weight="500" letter-spacing="0.8" opacity="0.6">COMMEMORATIVE KEEPSAKE · NOT VALID FOR ENTRY</text>

    {holo_texture()}
    <!-- tear line -->
    {perforation(CUT)}

    <!-- holo stub -->
    <rect x="{CUT}" y="0" width="{W - CUT}" height="34" fill="{INK}"/>
    {checker(CUT + 18, 9, 4, 2, 8, PAPER)}
    <text x="{CUT + 60}" y="22" font-family="{GROT}" font-size="8" font-weight="700" letter-spacing="2.4" fill="{PAPER}">TICKETSTUB · STUB</text>
    <text data-slot="edition" x="1074" y="22" text-anchor="end" font-family="{GROT}" font-size="8" font-weight="700" letter-spacing="1" fill="{PAPER}">.</text>
    <g data-slot="barcode" data-w="228" data-h="28" transform="translate(846 58)"></g>
    <text data-slot="serial" x="846" y="102" font-family="{GROT}" font-size="9.5" font-weight="600" letter-spacing="2.6">.</text>
    {chevrons(1032, 92, 3, 10, 12, 3)}
    <path d="M846 114 H1074" stroke="{INK}" stroke-width="1"/>
    <text data-slot="title" x="846" y="170" style="font-variant-numeric: lining-nums" font-family="{BLACK}" font-size="30" letter-spacing="-0.6" data-wrap="224" data-lines="3" data-leading="1.02" data-anchor="bottom" data-min="11">.</text>
    <text data-slot="subtitle" x="846" y="190" font-family="{GROT}" font-size="10.5" font-weight="500" data-wrap="228" data-lines="1" data-min="7.5">.</text>
    <path d="M846 206 H1074" stroke="{INK}" stroke-width="1"/>
    <text data-slot="month" x="846" y="268" font-family="{BLACK}" font-size="50" letter-spacing="-0.5">.</text>
    <text data-slot="day" x="1071" y="268" text-anchor="end" font-family="{BLACK}" font-size="50" letter-spacing="-1">.</text>
    <text x="846" y="290" font-family="{GROT}" font-size="10" font-weight="600" letter-spacing="2"><tspan data-slot="weekday">.</tspan><tspan data-show-if="time">  ·  </tspan><tspan data-slot="time">.</tspan></text>
    <text data-slot="year" x="1074" y="290" text-anchor="end" font-family="{GROT}" font-size="10" font-weight="600" letter-spacing="2">.</text>
    <path d="M846 304 H1074" stroke="{INK}" stroke-width="1"/>
    <g font-family="{GROT}">
      <text x="846" y="322" font-size="7.5" font-weight="700" letter-spacing="1.6">GATE</text>
      <text x="903" y="322" font-size="7.5" font-weight="700" letter-spacing="1.6">SEC</text>
      <text x="960" y="322" font-size="7.5" font-weight="700" letter-spacing="1.6">ROW</text>
      <text x="1017" y="322" font-size="7.5" font-weight="700" letter-spacing="1.6">SEAT</text>
      <path d="M897 312 V346 M954 312 V346 M1011 312 V346" stroke="{INK}" stroke-width="0.7"/>
      <text data-slot="gate" x="846" y="342" data-default="—" font-size="15" font-weight="700" data-fit="46" data-min="8">—</text>
      <text data-slot="section" x="903" y="342" data-default="—" font-size="15" font-weight="700" data-fit="46" data-min="8">—</text>
      <text data-slot="row" x="960" y="342" data-default="—" font-size="15" font-weight="700" data-fit="46" data-min="8">—</text>
      <text data-slot="seat" x="1017" y="342" data-default="—" font-size="15" font-weight="700" data-fit="57" data-min="8">—</text>
    </g>
    <rect x="846" y="362" width="228" height="40" rx="6" fill="{INK}"/>
    <text x="860" y="387" font-family="{BLACK}" font-size="14" letter-spacing="0.6" fill="{PAPER}">ADMIT ONE</text>
    {chevrons(1010, 374, 3, 12, 16, 2, PAPER)}
  </g>
  <path data-layer="dieline" d="{die(CUT)}" fill="none" stroke="#ec008c" stroke-width="0.5"/>
</svg>
'''
    return s


# ------------------------------------------------------------------ back
BCUT = W - CUT  # flipped: the stub is on the left


def back():
    L = BCUT + 26  # main area left
    R = W - 30
    mid = (L + 790) / 2
    lab = f'font-family="{GROT}" font-size="7.5" font-weight="700" letter-spacing="1.6"'
    valf = f'font-family="{GROT}" font-size="14" font-weight="600"'
    # wristband strip
    band_y, band_h = 22, 40
    rating = []
    for i in range(5):
        cx = 846 + i * 26
        rating.append(f'<circle cx="{cx}" cy="128" r="9.5" fill="none" stroke="{INK}" stroke-width="1"/>')
    s = head()
    s += f'''  <g data-layer="paper">
    <rect width="{W}" height="{H}" fill="{PAPER}"/>
    <rect width="{W}" height="{H}" fill="#000" filter="url(#ts-fibre)" opacity="0.05"/>
    <rect width="{W}" height="{H}" fill="#000" filter="url(#ts-grain)" opacity="0.05"/>
    <rect x="0" y="0" width="{BCUT}" height="{H}" fill="{INK}"/>
  </g>
  <g data-layer="ink" fill="{INK}">
    <!-- wristband strip -->
    <rect x="{BCUT}" y="{band_y}" width="{W - BCUT}" height="{band_h}" fill="{INK}"/>
    {checker(BCUT + 18, band_y + 4, 8, 4, 8, PAPER)}
    {chevrons(BCUT + 96, band_y + 11, 3, 12, 18, 3, PAPER)}
    <text data-slot="title" x="{BCUT + 150}" y="{band_y + 26}" font-family="{BLACK}" font-size="15" letter-spacing="0.2" fill="{PAPER}" data-wrap="370" data-lines="1" data-min="8">.</text>
    <text x="{W - 116}" y="{band_y + 25}" text-anchor="end" font-family="{GROT}" font-size="10" font-weight="700" letter-spacing="2" fill="{PAPER}" data-fit="200" data-min="7"><tspan data-slot="date">.</tspan></text>
    {checker(W - 102, band_y + 4, 8, 4, 8, PAPER, 1)}

    <!-- line-up bill -->
    <text x="{L}" y="92" {lab}>LINE-UP</text>
    <text data-slot="categoryLabel" x="790" y="92" text-anchor="end" {lab}>.</text>
    <path d="M{L} 100 H790" stroke="{INK}" stroke-width="0.8"/>
    <text data-slot="people1" x="{mid}" y="164" text-anchor="middle" font-family="{BLACK}" font-size="46" letter-spacing="-1" data-fit="{790 - L}" data-min="16">.</text>
    <text x="{mid}" y="196" text-anchor="middle" font-family="{GROT}" font-size="18" font-weight="600" letter-spacing="0.8" data-case="upper" data-fit="{790 - L}" data-min="8"><tspan data-slot="people2" data-case="upper">.</tspan><tspan data-show-if="people3" font-weight="400" opacity="0.5">  ✦  </tspan><tspan data-slot="people3" data-case="upper">.</tspan><tspan data-show-if="people4" font-weight="400" opacity="0.5">  ✦  </tspan><tspan data-slot="people4" data-case="upper">.</tspan><tspan data-show-if="people5" font-weight="400" opacity="0.5">  ✦  </tspan><tspan data-slot="people5" data-case="upper">.</tspan></text>
    <text data-slot="tagline" x="{mid}" y="228" text-anchor="middle" font-family="{GROT}" font-size="12" font-weight="300" data-wrap="{790 - L - 40}" data-lines="1" data-min="8" data-prefix="“" data-suffix="”">.</text>

    <!-- your night -->
    <path d="M812 78 V258" stroke="{INK}" stroke-width="0.8"/>
    <text x="836" y="92" {lab}>YOUR NIGHT</text>
    <path d="M836 100 H{R}" stroke="{INK}" stroke-width="0.8"/>
    <text x="836" y="114" font-family="{GROT}" font-size="7" font-weight="500" letter-spacing="1" opacity="0.7">RATING</text>
    {"".join(rating)}
    <text x="964" y="132" font-family="{GROT}" font-size="10" font-weight="500">/ 5</text>
    <text x="836" y="162" font-family="{GROT}" font-size="7" font-weight="500" letter-spacing="1" opacity="0.7">REVIEW</text>
    <path d="M836 188 H{R} M836 214 H{R} M836 240 H{R}" stroke="{INK}" stroke-width="0.7" stroke-dasharray="2 3"/>

    <!-- fields -->
    <path d="M{L} 260 H{R} M{L} 330 H{R}" stroke="{INK}" stroke-width="1.4"/>
    <path d="M440 266 V324 M540 266 V324 M640 266 V324 M920 266 V324 M1000 266 V324" stroke="{INK}" stroke-width="0.7"/>
    <text x="{L}" y="279" {lab}>DATE</text><text data-slot="dateDots" x="{L}" y="314" data-default="—" {valf} data-fit="128">—</text>
    <text x="452" y="279" {lab}>DOORS</text><text data-slot="doors" x="452" y="314" data-default="—" {valf} data-fit="80">—</text>
    <text x="552" y="279" {lab}>SHOW</text><text data-slot="time" x="552" y="314" data-default="—" {valf} data-fit="80">—</text>
    <text x="652" y="279" {lab}>VENUE</text><text data-slot="place" x="652" y="314" data-default="—" font-family="{GROT}" font-size="13" font-weight="600" data-wrap="258" data-lines="2" data-leading="1.12" data-anchor="bottom" data-min="9.5">—</text>
    <text x="932" y="279" {lab}>GATE</text><text data-slot="gate" x="932" y="314" data-default="—" {valf} data-fit="60" data-min="8">—</text>
    <text x="1012" y="279" {lab}>PRICE</text><text data-slot="price" x="1012" y="314" data-default="—" {valf} data-fit="58" data-min="8">—</text>

    <!-- foot -->
    <g data-slot="barcode" data-w="220" data-h="38" transform="translate({L} 344)"></g>
    <text data-slot="serial" x="{L}" y="400" font-family="{GROT}" font-size="10" font-weight="600" letter-spacing="3.2">.</text>
    <text x="{L + 250}" y="358" font-family="{BLACK}" font-size="13" letter-spacing="0.4">KEEP THE NIGHT™</text>
    <text x="{L + 250}" y="376" font-family="{GROT}" font-size="7.5" font-weight="500" letter-spacing="0.4" opacity="0.75">Commemorative keepsake · not valid for entry. Printed by TicketStub</text>
    <text x="{L + 250}" y="388" font-family="{GROT}" font-size="7.5" font-weight="500" letter-spacing="0.4" opacity="0.75">from the fan's own ticket. Keep dry, keep flat, keep forever.</text>
    <text x="{R}" y="400" text-anchor="end" font-family="{GROT}" font-size="10" font-weight="700" letter-spacing="1.4" data-fit="150"><tspan data-slot="edition">.</tspan></text>
    {chevrons(R - 46, 344, 3, 12, 16, 2)}

    <!-- flipped stub: black wristband face -->
    {perforation(BCUT, INK, 0.5)}
    <g fill="{PAPER}">
      <text x="28" y="44" font-family="{GROT}" font-size="8" font-weight="700" letter-spacing="2.4">ADMIT · STUB</text>
      <text data-slot="year" x="252" y="44" text-anchor="end" font-family="{GROT}" font-size="8" font-weight="700" letter-spacing="1.4" data-prefix="✦ ">.</text>
      <rect x="28" y="60" width="104" height="104" rx="4" fill="{PAPER}"/>
      <g data-slot="qr" data-size="88" data-color="{INK}" transform="translate(36 68)"></g>
      <text x="148" y="76" font-family="{GROT}" font-size="7.5" font-weight="700" letter-spacing="1.6" opacity="0.7">SCAN</text>
      <text x="148" y="92" font-family="{GROT}" font-size="10" font-weight="500">the memory,</text>
      <text x="148" y="106" font-family="{GROT}" font-size="10" font-weight="500">not the gate.</text>
      {checker(28, 178, 28, 2, 8, PAPER)}
      <text data-slot="title" x="28" y="248" font-family="{BLACK}" font-size="24" letter-spacing="-0.3" data-wrap="224" data-lines="3" data-leading="1.1" data-anchor="bottom" data-min="10">.</text>
      <path d="M28 262 H252" stroke="{PAPER}" stroke-width="0.8" opacity="0.6"/>
      <text x="28" y="282" font-family="{GROT}" font-size="7.5" font-weight="700" letter-spacing="1.6" opacity="0.7">ADMIT</text>
      <text data-slot="admit" data-default="One" x="28" y="302" font-family="{GROT}" font-size="15" font-weight="600" data-fit="224" data-min="8">One</text>
      <text x="28" y="330" font-family="{GROT}" font-size="7.5" font-weight="700" letter-spacing="1.6" opacity="0.7">SEAT</text>
      <text data-slot="seatLine" data-default="General admission" x="28" y="350" font-family="{GROT}" font-size="13" font-weight="600" data-fit="224" data-min="7.5">General admission</text>
      <path d="M28 372 H252" stroke="{PAPER}" stroke-width="0.8" opacity="0.6"/>
      <text data-slot="serial" x="28" y="400" font-family="{GROT}" font-size="10" font-weight="600" letter-spacing="3">.</text>
      {chevrons(212, 390, 3, 10, 12, 2, PAPER)}
    </g>
  </g>
  <path data-layer="dieline" d="{die(BCUT)}" fill="none" stroke="#ec008c" stroke-width="0.5"/>
</svg>
'''
    return s


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "front.svg").write_text(front(), encoding="utf8")
    (OUT / "back.svg").write_text(back(), encoding="utf8")
    print("wrote", OUT)
