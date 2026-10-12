"""Soul: edge-to-edge deep holographic film, white keyline that follows the scalloped die, a perforated
stub with vertical type, white barcode and marks, huge white Unbounded title (holo direction, ref 09).

    python scripts/stub-lab/gen/soul.py   -> public/stubs/soul/{front,back}.svg
"""
import math
from pathlib import Path

W, H = 480, 960
P = 196  # perforation (stub / body)
OUT = Path(__file__).resolve().parents[3] / "public" / "stubs" / "soul"
DISPLAY = "'Unbounded', 'Archivo Black', sans-serif"
TEXT = "'Space Grotesk', 'Inter Tight', sans-serif"
WHITE = "#ffffff"
NAVY = "#0a0f3c"
LINING = 'style="font-variant-numeric: lining-nums tabular-nums"'

C = 24       # concave corner radius
BR = 11      # scallop bite radius (top + bottom)
BN = 5       # bites per end
BP = 44      # bite pitch
NR = 11      # side notch radius at the perforation


def f(v):
    return f"{v:.2f}".rstrip("0").rstrip(".")


def outline(d=0.0):
    """The die (d=0) or a parallel line inset by d: concave corners, scalloped ends, perforation notches."""
    s = math.sqrt((C + d) ** 2 - d ** 2)          # where the corner arc meets the inset edge
    t = math.sqrt((BR + d) ** 2 - d ** 2)         # half-width of a bite on the inset edge
    n = math.sqrt((NR + d) ** 2 - d ** 2)         # half-height of a side notch on the inset edge
    mids = [W / 2 + (i - (BN - 1) / 2) * BP for i in range(BN)]
    p = [f"M{f(d)} {f(s)}", f"A{f(C + d)} {f(C + d)} 0 0 0 {f(s)} {f(d)}"]
    for m in mids:
        p.append(f"L{f(m - t)} {f(d)} A{f(BR + d)} {f(BR + d)} 0 0 0 {f(m + t)} {f(d)}")
    p.append(f"L{f(W - s)} {f(d)} A{f(C + d)} {f(C + d)} 0 0 0 {f(W - d)} {f(s)}")
    p.append(f"L{f(W - d)} {f(P - n)} A{f(NR + d)} {f(NR + d)} 0 0 0 {f(W - d)} {f(P + n)}")
    p.append(f"L{f(W - d)} {f(H - s)} A{f(C + d)} {f(C + d)} 0 0 0 {f(W - s)} {f(H - d)}")
    for m in reversed(mids):
        p.append(f"L{f(m + t)} {f(H - d)} A{f(BR + d)} {f(BR + d)} 0 0 0 {f(m - t)} {f(H - d)}")
    p.append(f"L{f(s)} {f(H - d)} A{f(C + d)} {f(C + d)} 0 0 0 {f(d)} {f(H - s)}")
    p.append(f"L{f(d)} {f(P + n)} A{f(NR + d)} {f(NR + d)} 0 0 0 {f(d)} {f(P - n)}Z")
    return " ".join(p)


DIE = outline(0)
K = 15  # keyline inset
KEY = outline(K)
KN = math.sqrt((NR + K) ** 2 - K ** 2)  # keyline notch half-height


def head():
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" data-foil="ink" data-holo="deep" data-holo-print="#1d2150">\n'


def film_defs():
    """Texture filters shared by both faces: darker swirls for the film mask, crinkle relief, multiply depth."""
    return f'''    <filter id="swirl" x="0" y="0" width="1" height="1" filterUnits="objectBoundingBox" color-interpolation-filters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency="0.0019 0.0027" numOctaves="2" seed="31" result="n"/>
      <feColorMatrix in="n" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  1 0 0 0 0" result="a"/>
      <feComponentTransfer in="a">
        <feFuncA type="table" tableValues="0.9 0.9 0.75 0.2 0 0.35 0.85 0.95 0.5 0.05 0 0.4 0.9 0.9"/>
      </feComponentTransfer>
      <feComposite in2="SourceGraphic" operator="in"/>
    </filter>
    <linearGradient id="oilG" gradientUnits="userSpaceOnUse" x1="40" y1="60" x2="520" y2="700" spreadMethod="reflect">
      <stop offset="0" stop-color="#2233b8"/><stop offset="0.16" stop-color="#2f8bff"/><stop offset="0.3" stop-color="#16d1c0"/>
      <stop offset="0.44" stop-color="#8dff5a"/><stop offset="0.56" stop-color="#ffd23f"/><stop offset="0.7" stop-color="#ff6a1a"/>
      <stop offset="0.84" stop-color="#e2205b"/><stop offset="1" stop-color="#6a1fc4"/>
    </linearGradient>
    <filter id="oilF" x="0" y="0" width="1" height="1" filterUnits="objectBoundingBox" color-interpolation-filters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency="0.0021 0.0029" numOctaves="2" seed="23" result="t"/>
      <feDisplacementMap in="SourceGraphic" in2="t" scale="420" xChannelSelector="R" yChannelSelector="G"/>
    </filter>
    <filter id="crinkle" x="0" y="0" width="1" height="1" filterUnits="objectBoundingBox" color-interpolation-filters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency="0.042" numOctaves="4" seed="8" result="n"/>
      <feDiffuseLighting in="n" surfaceScale="3.2" diffuseConstant="0.86" lighting-color="#ffffff" result="l">
        <feDistantLight azimuth="235" elevation="52"/>
      </feDiffuseLighting>
      <feComposite in="l" in2="SourceGraphic" operator="in"/>
    </filter>
    <filter id="tooth" x="0" y="0" width="1" height="1" filterUnits="objectBoundingBox" color-interpolation-filters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency="0.55" numOctaves="2" seed="4" result="n"/>
      <feDiffuseLighting in="n" surfaceScale="1.4" diffuseConstant="0.8" lighting-color="#ffffff" result="l">
        <feDistantLight azimuth="225" elevation="60"/>
      </feDiffuseLighting>
      <feComposite in="l" in2="SourceGraphic" operator="in"/>
    </filter>
    <filter id="lift" x="-5%" y="-5%" width="110%" height="110%" color-interpolation-filters="sRGB">
      <feDropShadow dx="0" dy="0.8" stdDeviation="1.4" flood-color="#060a2e" flood-opacity="0.45"/>
    </filter>
    <linearGradient id="bandG" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="480" y2="190">
      <stop offset="0.2" stop-color="#fff" stop-opacity="0"/>
      <stop offset="0.33" stop-color="#fff" stop-opacity="0.9"/>
      <stop offset="0.5" stop-color="#fff" stop-opacity="1"/>
      <stop offset="0.6" stop-color="#fff" stop-opacity="0.25"/>
      <stop offset="0.67" stop-color="#fff" stop-opacity="0"/>
      <stop offset="0.76" stop-color="#fff" stop-opacity="0"/>
      <stop offset="0.81" stop-color="#fff" stop-opacity="0.9"/>
      <stop offset="0.87" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <filter id="zones" x="0" y="0" width="1" height="1" filterUnits="objectBoundingBox" color-interpolation-filters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency="0.0046 0.0034" numOctaves="3" seed="41" result="n"/>
      <feColorMatrix in="n" type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  1 0 0 0 0" result="a"/>
      <feComponentTransfer in="a">
        <feFuncA type="table" tableValues="0 0 0 0.55 1 1"/>
      </feComponentTransfer>
      <feComposite in2="SourceGraphic" operator="in"/>
    </filter>
    <filter id="bandWarp" x="0" y="0" width="1" height="1" filterUnits="objectBoundingBox" color-interpolation-filters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency="0.0032 0.0022" numOctaves="2" seed="12" result="t"/>
      <feDisplacementMap in="SourceGraphic" in2="t" scale="190" xChannelSelector="R" yChannelSelector="G"/>
    </filter>
    <filter id="sil" x="-5%" y="-5%" width="110%" height="110%" color-interpolation-filters="sRGB">
      <feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 2.2 0" result="a"/>
      <feMorphology in="a" operator="dilate" radius="5" result="d"/>
      <feGaussianBlur in="d" stdDeviation="3"/>
    </filter>
    <filter id="glint" color-interpolation-filters="sRGB">
      <feColorMatrix type="matrix" values="0.3 0.59 0.11 0 0  0.3 0.59 0.11 0 0  0.3 0.59 0.11 0 0  0 0 0 1 0"/>
      <feComponentTransfer>
        <feFuncR type="table" tableValues="0 0 0.15 0.9 1"/>
        <feFuncG type="table" tableValues="0 0 0.15 0.9 1"/>
        <feFuncB type="table" tableValues="0 0 0.18 0.95 1"/>
      </feComponentTransfer>
    </filter>
    <filter id="mono" color-interpolation-filters="sRGB">
      <feColorMatrix type="matrix" values="0.3 0.59 0.11 0 0  0.3 0.59 0.11 0 0  0.3 0.59 0.11 0 0  0 0 0 1 0"/>
      <feComponentTransfer>
        <feFuncR type="table" tableValues="0.0 0.28 0.78 1"/>
        <feFuncG type="table" tableValues="0.0 0.28 0.78 1"/>
        <feFuncB type="table" tableValues="0.04 0.34 0.82 1"/>
      </feComponentTransfer>
    </filter>'''


def oil(clip=""):
    """Our own marbled spectrum, blended as colour over the runtime film: swirls like an oil slick,
    and it slides faster than the film when the light moves (tilt)."""
    c = f' clip-path="url(#{clip})"' if clip else ""
    return (f'<g{c}><rect x="-300" y="-300" width="{W + 600}" height="{H + 600}" fill="url(#oilG)" filter="url(#oilF)" opacity="0.85" '
            f'style="mix-blend-mode: color; transform: translate(calc((var(--lx, 38%) - 38%) * -1.2), calc((var(--ly, 30%) - 30%) * -0.8))"/></g>')


FLOW_T = "transform: translate(calc((var(--lx, 38%) - 38%) * 1.1), calc((var(--ly, 30%) - 30%) * 0.6))"
# poured-oil zones + one steep band and a thin echo, all sliding together with the light
BAND = (f'<g style="{FLOW_T}">'
        '<rect x="-480" y="-480" width="1440" height="1920" fill="#fff" filter="url(#zones)"/>'
        '<rect x="-480" y="-480" width="1440" height="1920" fill="url(#bandG)" filter="url(#bandWarp)"/></g>')


def band_colour(y0=0, y1=H, x0=0, x1=W):
    """Spectral colour only inside the band (colour blend on the masked group itself): the band runs
    orange to green to blue along its length, while the rest of the film stays deep indigo."""
    return (f'<mask id="bandMask{y0}" maskUnits="userSpaceOnUse" x="{x0}" y="{y0}" width="{x1 - x0}" height="{y1 - y0}">'
            f'<rect x="{x0}" y="{y0}" width="{x1 - x0}" height="{y1 - y0}" fill="#000"/>{BAND}</mask>'
            f'<g mask="url(#bandMask{y0})" style="mix-blend-mode: color" opacity="0.78" data-screen-only="">'
            f'<rect x="-300" y="-300" width="{W + 600}" height="{H + 600}" fill="url(#oilG)" filter="url(#oilF)" '
            f'style="transform: translate(calc((var(--lx, 38%) - 38%) * -0.8), calc((var(--ly, 30%) - 30%) * -0.8))"/></g>')


def film_mask(y0=0, y1=H):
    """Holo layer content: a quiet film base (indigo shows through), then poured-oil zones and the bands
    at full strength, then fine dark veins."""
    return (f'<rect x="0" y="{y0}" width="{W}" height="{y1 - y0}" fill="#262626"/>\n'
            f'    {BAND}\n'
            f'    <rect x="0" y="{y0}" width="{W}" height="{y1 - y0}" fill="#fff" filter="url(#swirl)" opacity="0.22"/>')


def textures(y0=0, y1=H, crinkle=0.5, clip=""):
    """Relief + tooth over the film (overlay keeps the film's hue, adds the pressed-foil texture).
    A clip sits on the blended element itself, so the blend still sees the film below."""
    h = y1 - y0
    c = f' clip-path="url(#{clip})"' if clip else ""
    return (f'<rect x="0" y="{y0}" width="{W}" height="{h}" fill="#fff" filter="url(#crinkle)" style="mix-blend-mode: overlay" opacity="{crinkle}"{c} data-screen-only=""/>\n'
            f'    <rect x="0" y="{y0}" width="{W}" height="{h}" fill="#fff" filter="url(#tooth)" style="mix-blend-mode: overlay" opacity="0.28"{c} data-screen-only=""/>')


def sparkle(cx, cy, r, w=1.6):
    """Four-point star mark in white line, with a small ring at its heart."""
    k = r * 0.16
    d = (f"M{f(cx)} {f(cy - r)} Q{f(cx + k)} {f(cy - k)} {f(cx + r)} {f(cy)} Q{f(cx + k)} {f(cy + k)} {f(cx)} {f(cy + r)} "
         f"Q{f(cx - k)} {f(cy + k)} {f(cx - r)} {f(cy)} Q{f(cx - k)} {f(cy - k)} {f(cx)} {f(cy - r)}Z")
    return f'<path d="{d}" fill="none" stroke="{WHITE}" stroke-width="{w}" stroke-linejoin="round"/>'


def disc_mark(cx, cy, r):
    """A small record / sound-hole mark: rings with a filled spindle."""
    out = [f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="none" stroke="{WHITE}" stroke-width="1.6"/>']
    for rr in (r * 0.72, r * 0.52):
        out.append(f'<circle cx="{cx}" cy="{cy}" r="{f(rr)}" fill="none" stroke="{WHITE}" stroke-width="0.8" opacity="0.8"/>')
    out.append(f'<circle cx="{cx}" cy="{cy}" r="{f(r * 0.2)}" fill="{WHITE}"/>')
    return "".join(out)


def guilloche(cx, cy, r0, amp, k=9, n=14, w=0.5, op=0.5):
    """Security-print rosette: n phase-shifted sine rings."""
    out = []
    for j in range(n):
        pts = []
        for i in range(361):
            t = i * math.tau / 360
            r = r0 + amp * math.sin(k * t + j * math.tau / n)
            pts.append(f"{f(cx + r * math.cos(t))} {f(cy + r * math.sin(t))}")
        out.append(f'<path d="M{" L".join(pts)}Z" fill="none" stroke="{WHITE}" stroke-width="{w}" opacity="{op}"/>')
    return "".join(out)


def halo(cx, cy, rmax, gap_from=None):
    """Concentric rings + tick crown behind the art (and the composition's fallback when there is none)."""
    o = []
    for r, w, op, dash in [(rmax * 0.36, 0.9, 0.55, None), (rmax * 0.6, 0.8, 0.5, "1.5 4.5"), (rmax * 0.82, 1.0, 0.55, None)]:
        da = f' stroke-dasharray="{dash}"' if dash else ""
        o.append(f'<circle cx="{cx}" cy="{cy}" r="{f(r)}" fill="none" stroke="{WHITE}" stroke-width="{w}" opacity="{op}"{da}/>')
    for i in range(96):
        a = i * math.tau / 96
        r0 = rmax * (0.9 if i % 4 else 0.86)
        x0, y0 = cx + r0 * math.cos(a), cy + r0 * math.sin(a)
        x1, y1 = cx + rmax * math.cos(a), cy + rmax * math.sin(a)
        o.append(f'<path d="M{f(x0)} {f(y0)} L{f(x1)} {f(y1)}" stroke="{WHITE}" stroke-width="{1.1 if i % 4 == 0 else 0.6}" opacity="0.55"/>')
    return "\n      ".join(o)


def perforation(y=P):
    x0, x1 = K + KN * 0 + NR + K - 2, W - (NR + K) + 2
    return (f'<path d="M{f(NR + K + 6)} {y} H{f(W - NR - K - 6)}" stroke="{WHITE}" stroke-width="2" stroke-dasharray="9 7" '
            f'stroke-linecap="round" fill="none"/>')




# ------------------------------------------------------------------ front: the poster face
ART = (40, 290, 400, 520)  # x, y, w, h of the front art slot
MED = (240, 484, 184)       # medallion centre + radius


def art_image(x, y, w, h, extra):
    return (f'<image data-slot="art" x="{x}" y="{y}" width="{w}" height="{h}" preserveAspectRatio="xMidYMax meet" {extra}/>')


def front():
    lab = f'font-family="{TEXT}" font-weight="500" fill="{WHITE}"'
    ax, ay, aw, ah = ART
    s = head()
    s += f'''  <defs>
{film_defs()}
    <linearGradient id="base" x1="0" y1="0" x2="0.35" y2="1">
      <stop offset="0" stop-color="#0b1052"/>
      <stop offset="0.45" stop-color="#1a2492"/>
      <stop offset="1" stop-color="#0a0d3e"/>
    </linearGradient>
    <linearGradient id="depth" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="{NAVY}" stop-opacity="0.45"/>
      <stop offset="0.22" stop-color="{NAVY}" stop-opacity="0.08"/>
      <stop offset="0.7" stop-color="{NAVY}" stop-opacity="0.04"/>
      <stop offset="1" stop-color="{NAVY}" stop-opacity="0.32"/>
    </linearGradient>
    <linearGradient id="artFadeG" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#000"/>
      <stop offset="0.06" stop-color="#fff"/>
      <stop offset="0.6" stop-color="#fff"/>
      <stop offset="0.8" stop-color="#000"/>
    </linearGradient>
    <mask id="artFade" maskUnits="userSpaceOnUse" x="0" y="0" width="{W}" height="{H}">
      <rect x="0" y="{ay}" width="{W}" height="{ah}" fill="url(#artFadeG)"/>
    </mask>
    <mask id="notArt" maskUnits="userSpaceOnUse" x="0" y="0" width="{W}" height="{H}">
      <rect width="{W}" height="{H}" fill="#fff"/>
      {art_image(ax, ay, aw, ah, 'filter="url(#sil)"')}
    </mask>
  </defs>
  <g data-layer="paper">
    <rect width="{W}" height="{H}" fill="url(#base)"/>
  </g>
  <g data-layer="holo">
    {film_mask()}
  </g>
  <g data-layer="paper">
    <rect width="{W}" height="{H}" fill="#7a7a7a" style="mix-blend-mode: saturation" opacity="0.12" data-screen-only=""/>
    {band_colour()}
    {textures()}
    <rect width="{W}" height="{H}" fill="url(#depth)" style="mix-blend-mode: multiply"/>
  </g>
  <g data-layer="art">
    <g mask="url(#notArt)">
      {halo(*MED)}
      {guilloche(MED[0], MED[1], 98, 9, k=14, n=9, w=0.5, op=0.42)}
      <g data-hide-if="art">{sparkle(MED[0], MED[1], 30, 1.3)}</g>
    </g>
    {art_image(ax, ay, aw, ah, 'filter="url(#mono)" mask="url(#artFade)" style="mix-blend-mode: multiply" opacity="0.45"')}
    {art_image(ax, ay, aw, ah, 'filter="url(#mono)" mask="url(#artFade)" style="mix-blend-mode: soft-light" opacity="0.95"')}
    {art_image(ax, ay, aw, ah, 'filter="url(#glint)" mask="url(#artFade)" style="mix-blend-mode: screen" opacity="0.5"')}
  </g>
  <g data-layer="ink" fill="{WHITE}" filter="url(#lift)">
    <path d="{KEY}" fill="none" stroke="{WHITE}" stroke-width="2.2"/>
    {perforation()}
    <!-- stub: vertical type (reads bottom to top), star mark, edition -->
    <g transform="translate(54 180) rotate(-90)">
      <text data-slot="kicker" x="0" y="0" {lab} font-size="8.5" letter-spacing="2.2" data-case="upper" data-default="ADMIT ONE" data-wrap="142" data-lines="1" data-min="7">.</text>
      <text data-slot="dateShort" x="0" y="34" font-family="{DISPLAY}" font-weight="800" font-size="30" letter-spacing="-0.5" data-fit="142" {LINING}>.</text>
      <text x="0" y="52" {lab} font-size="8.5" letter-spacing="2.2" data-fit="142" {LINING}><tspan data-slot="weekday">.</tspan><tspan data-slot="time" data-prefix=" · SHOW ">.</tspan></text>
    </g>
    {sparkle(388, 86, 34, 1.8)}
    <text data-slot="edition" x="388" y="160" text-anchor="middle" font-family="{DISPLAY}" font-weight="600" font-size="11" letter-spacing="1.4" data-default="ADMIT ONE" data-fit="104" {LINING}>.</text>
    <text x="442" y="40" {lab} font-size="7.5" letter-spacing="2" transform="rotate(90 442 40)" opacity="0.9">KEEP THIS STUB</text>
    <!-- body -->
    <g data-slot="barcode" data-w="250" data-h="40" data-color="{WHITE}" transform="translate(115 224)"></g>
    <text data-slot="seatLine" x="{W/2}" y="284" text-anchor="middle" {lab} font-size="9" letter-spacing="2.4" data-default="GENERAL ADMISSION" data-fit="300" {LINING}>.</text>
    <text x="445" y="318" {lab} font-size="8" letter-spacing="2.4" transform="rotate(90 445 318)" data-fit="410" data-min="7" {LINING}><tspan data-slot="date">.</tspan><tspan>   ·   </tspan><tspan data-slot="place" data-case="upper">.</tspan></text>
    <text x="35" y="760" {lab} font-size="7.5" letter-spacing="1.8" transform="rotate(-90 35 760)" opacity="0.9" data-fit="440">TICKETSTUB ORIGINAL   ·   COMMEMORATIVE KEEPSAKE   ·   NOT VALID FOR ENTRY</text>
    <!-- poster type -->
    <text data-slot="title" x="{W/2}" y="834" text-anchor="middle" font-family="{DISPLAY}" font-weight="800" font-size="74" letter-spacing="-1" data-case="upper" data-wrap="404" data-lines="4" data-leading="0.96" data-anchor="bottom" data-min="18" {LINING}>.</text>
    <text data-slot="subtitle" x="{W/2}" y="868" text-anchor="middle" {lab} font-size="11" letter-spacing="1.8" data-case="upper" data-wrap="404" data-lines="2" data-leading="1.4" data-min="8">.</text>
  </g>
  <path data-layer="dieline" d="{DIE}" fill="none" stroke="#ec008c" stroke-width="0.5"/>
</svg>
'''
    return s


# ------------------------------------------------------------------ back: the collector card
PAN = (296, 384, 148, 206)


def cutrect(x, y, w, h, c):
    """A rectangle with concave (punched) corners, the die's own corner language."""
    return (f"M{f(x + c)} {f(y)} H{f(x + w - c)} A{c} {c} 0 0 0 {f(x + w)} {f(y + c)} V{f(y + h - c)} "
            f"A{c} {c} 0 0 0 {f(x + w - c)} {f(y + h)} H{f(x + c)} A{c} {c} 0 0 0 {f(x)} {f(y + h - c)} "
            f"V{f(y + c)} A{c} {c} 0 0 0 {f(x + c)} {f(y)}Z")


def back():
    L, R = 36, 444
    px, py, pw, ph = PAN
    PD = cutrect(px, py, pw, ph, 13)
    lab = f'font-family="{TEXT}" font-size="7.5" font-weight="500" letter-spacing="1.8" fill="{WHITE}" opacity="0.66"'
    val = f'font-family="{TEXT}" font-weight="500" fill="{WHITE}"'
    big = f'font-family="{DISPLAY}" font-weight="700" fill="{WHITE}" {LINING}'
    rule = f'stroke="{WHITE}" stroke-width="0.8" opacity="0.35" fill="none"'
    dash = f'stroke="{WHITE}" stroke-width="0.8" stroke-dasharray="2 3" opacity="0.5" fill="none"'
    stars = "".join(sparkle(312 + i * 30, 716, 9.5, 1.1) for i in range(5))
    slab = f'font-family="{TEXT}" font-size="7.5" font-weight="500" letter-spacing="2" fill="{WHITE}" text-anchor="middle"'
    seat = []
    for name, slot, x in [("SECTION", "section", 214), ("ROW", "row", 300), ("SEAT", "seat", 386)]:
        seat.append(f'<text x="{x}" y="62" {slab}>{name}</text>'
                    f'<text data-slot="{slot}" x="{x}" y="100" text-anchor="middle" {big} font-size="24" data-fit="64" data-min="9" data-default="—" data-case="upper">.</text>'
                    f'<path d="M{x-33} 110 H{x+33}" stroke="{WHITE}" stroke-width="1"/>')
    big2 = f'font-family="{DISPLAY}" fill="{WHITE}" {LINING}'
    for name, slot, x in [("GATE", "gate", 214), ("PRICE", "price", 300), ("DOORS", "doors", 386)]:
        seat.append(f'<g data-show-if="{slot}"><text x="{x}" y="138" {slab} opacity="0.85">{name}</text>'
                    f'<text data-slot="{slot}" x="{x}" y="160" text-anchor="middle" {big2} font-weight="600" font-size="13" data-fit="66" data-min="8" data-case="upper">.</text></g>')
    cells = [f'<g data-show-if="seat">{"".join(seat)}</g>',
             f'<g data-hide-if="seat">'
             f'<text x="300" y="80" {slab}>ENTRY</text>'
             f'<text x="300" y="108" text-anchor="middle" {big2} font-weight="800" font-size="24" letter-spacing="-0.3" data-fit="240">GENERAL</text>'
             f'<text x="300" y="134" text-anchor="middle" {big2} font-weight="800" font-size="24" letter-spacing="-0.3" data-fit="240">ADMISSION</text>'
             f'<path d="M190 148 H410" stroke="{WHITE}" stroke-width="1"/>'
             f'<text x="300" y="166" {slab} data-fit="220"><tspan data-slot="admit" data-default="ADMIT ONE" data-case="upper">.</tspan><tspan> · KEEP THIS STUB</tspan></text></g>']
    s = head()
    s += f'''  <defs>
{film_defs()}
    <linearGradient id="ink" x1="0" y1="0" x2="0.3" y2="1">
      <stop offset="0" stop-color="#0d1030"/>
      <stop offset="1" stop-color="#06070f"/>
    </linearGradient>
    <linearGradient id="base" x1="0" y1="0" x2="0.35" y2="1">
      <stop offset="0" stop-color="#0b1052"/>
      <stop offset="1" stop-color="#1a2492"/>
    </linearGradient>
    <linearGradient id="stubDepth" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="{NAVY}" stop-opacity="0.45"/>
      <stop offset="1" stop-color="{NAVY}" stop-opacity="0.1"/>
    </linearGradient>
    <radialGradient id="panelDepth" cx="0.5" cy="0.4" r="0.8">
      <stop offset="0" stop-color="{NAVY}" stop-opacity="0"/>
      <stop offset="1" stop-color="{NAVY}" stop-opacity="0.5"/>
    </radialGradient>
    <linearGradient id="artFadeB" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff"/>
      <stop offset="0.8" stop-color="#fff"/>
      <stop offset="1" stop-color="#000"/>
    </linearGradient>
    <mask id="artMaskB" maskUnits="userSpaceOnUse" x="0" y="0" width="{W}" height="{H}">
      <path d="{PD}" fill="url(#artFadeB)"/>
    </mask>
    <mask id="notArtB" maskUnits="userSpaceOnUse" x="0" y="0" width="{W}" height="{H}">
      <path d="{PD}" fill="#fff"/>
      {art_image(px + 4, py + 8, pw - 8, ph - 8, 'filter="url(#sil)"')}
    </mask>
    <clipPath id="stubClip"><rect width="{W}" height="{P}"/></clipPath>
    <clipPath id="panelClip"><path d="{PD}"/></clipPath>
  </defs>
  <g data-layer="paper">
    <rect width="{W}" height="{H}" fill="url(#ink)"/>
    <rect width="{W}" height="{P}" fill="url(#base)"/>
    <path d="{PD}" fill="url(#base)"/>
    <rect width="{W}" height="{H}" fill="#fff" filter="url(#ts-grain-light)" opacity="0.06"/>
  </g>
  <g data-layer="holo">
    <rect x="0" y="{P}" width="{W}" height="{H - P}" fill="#121212"/>
    <g clip-path="url(#stubClip)">{film_mask(0, P)}</g>
    <g clip-path="url(#panelClip)">{film_mask(py, py + ph)}</g>
  </g>
  <g data-layer="paper">
    <rect width="{W}" height="{P}" fill="#7a7a7a" style="mix-blend-mode: saturation" opacity="0.12" data-screen-only=""/>
    {band_colour(0, P)}
    {band_colour(py, py + ph, px, px + pw)}
    {textures(0, P, 0.5)}
    {textures(py, py + ph, 0.45, "panelClip")}
    <rect width="{W}" height="{P}" fill="url(#stubDepth)" style="mix-blend-mode: multiply"/>
    <path d="{PD}" fill="url(#panelDepth)" style="mix-blend-mode: multiply"/>
  </g>
  <g data-layer="art">
    <g mask="url(#notArtB)">
      {guilloche(px + pw / 2, py + ph / 2 - 6, 56, 11, k=12, n=10, w=0.45, op=0.5)}
      {guilloche(px + pw / 2, py + ph / 2 - 6, 26, 6, k=7, n=6, w=0.45, op=0.5)}
    </g>
    {art_image(px + 4, py + 8, pw - 8, ph - 8, 'filter="url(#mono)" mask="url(#artMaskB)" style="mix-blend-mode: multiply" opacity="0.6"')}
    {art_image(px + 4, py + 8, pw - 8, ph - 8, 'filter="url(#mono)" mask="url(#artMaskB)" style="mix-blend-mode: soft-light" opacity="0.95"')}
    {art_image(px + 4, py + 8, pw - 8, ph - 8, 'filter="url(#glint)" mask="url(#artMaskB)" style="mix-blend-mode: screen" opacity="0.45"')}
  </g>
  <g data-layer="ink">
    <path d="{KEY}" fill="none" stroke="{WHITE}" stroke-width="2.2"/>
    {perforation()}
    <path d="{cutrect(px + 6, py + 6, pw - 12, ph - 12, 8)}" fill="none" stroke="{WHITE}" stroke-width="0.8" opacity="0.75"/>
    <!-- stub on film: QR + a 3-column field grid -->
    <g data-slot="qr" data-size="104" data-color="{WHITE}" transform="translate(44 50)"></g>
    {''.join(cells)}
    <!-- body -->
    <text x="{L}" y="228" {lab}>TICKETSTUB · ORIGINAL KEEPSAKE</text>
    <text data-slot="categoryLabel" x="{R}" y="228" text-anchor="end" {lab}>.</text>
    <text data-slot="title" x="{L}" y="314" font-family="{DISPLAY}" font-weight="800" font-size="30" letter-spacing="-0.4" fill="{WHITE}" data-case="upper" data-wrap="372" data-lines="3" data-leading="1.14" data-anchor="bottom" data-min="13" {LINING}>.</text>
    <text data-slot="subtitle" x="{L}" y="338" {val} font-size="12" opacity="0.85" data-wrap="{R-L}" data-lines="2" data-leading="1.3" data-min="9">.</text>
    <path d="M{L} 370 H{R}" {rule}/>
    <text x="{L}" y="400" {lab}>DATE</text>
    <text data-slot="dateLong" x="{L}" y="418" {val} font-size="13" data-wrap="244" data-lines="1" data-min="10" {LINING}>.</text>
    <text x="{L}" y="448" {lab}>SHOW</text>
    <text data-slot="time" x="{L}" y="472" {big} font-size="20" data-default="—">.</text>

    <text x="{L}" y="502" {lab}>CITY</text>
    <text data-slot="city" x="{L}" y="520" {val} font-size="13" data-wrap="244" data-lines="1" data-min="10" data-default="—">.</text>
    <text x="{L}" y="550" {lab}>VENUE</text>
    <text data-slot="venue" x="{L}" y="568" {val} font-size="13" data-wrap="244" data-lines="2" data-leading="1.2" data-min="10" data-default="—">.</text>
    <path d="M{L} 606 H{R}" {rule}/>
    <text x="{L}" y="632" {lab}>LINE-UP</text>
    <text data-slot="peopleAll" x="{L}" y="652" {val} font-size="12" data-wrap="{R-L}" data-lines="2" data-leading="1.35" data-min="9" data-default="—">.</text>
    <path d="M{L} 688 H{R}" {rule}/>
    <text x="{L}" y="720" {lab}>YOUR RATING</text>
    {stars}
    <text x="{L}" y="752" {lab}>REVIEW</text>
    <text data-slot="tagline" x="{L}" y="774" {val} font-size="12.5" opacity="0.92" data-wrap="{R-L}" data-lines="2" data-leading="1.35" data-min="9.5" data-prefix="“" data-suffix="”">.</text>
    <path d="M{L} 818 H{R}" {rule}/>
    <g data-slot="barcode" data-w="230" data-h="32" data-color="{WHITE}" transform="translate({L} 836)"></g>
    <text data-slot="serial" x="{L}" y="884" font-family="{TEXT}" font-size="8" font-weight="500" letter-spacing="3.2" fill="{WHITE}" opacity="0.8" {LINING}>.</text>
    <text data-slot="edition" x="{R}" y="860" text-anchor="end" {big} font-size="17" data-default="No. 0001" data-fit="160">.</text>
    <text x="{R}" y="884" text-anchor="end" {lab}>COLLECTOR EDITION</text>
    <text x="{W/2}" y="914" text-anchor="middle" font-family="{TEXT}" font-size="7" font-weight="500" letter-spacing="1.3" fill="{WHITE}" opacity="0.55" data-fit="340">COMMEMORATIVE KEEPSAKE · NOT VALID FOR ENTRY · © TICKETSTUB</text>
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
