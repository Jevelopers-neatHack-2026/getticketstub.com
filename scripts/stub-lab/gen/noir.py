"""Noir: one colour of red foil on black. A severe poster face (duotone performer in front of a red sun,
monumental condensed title) and a ruled collector card on the back with the same sun ghosted behind it.

    python scripts/stub-lab/gen/noir.py   -> public/stubs/noir/{front,back}.svg
"""
import math
from pathlib import Path

W, H = 480, 960
OUT = Path(__file__).resolve().parents[3] / "public" / "stubs" / "noir"
RED = "#b3161b"
INK = "#b01a1e"  # flat red ink (labels, small print); the foil carries the big type and rules
TINT = "#d23a33"  # brighter flat red for values set in ink
STOCK = "#0d0b0b"
EDGE = "#5c1013"  # painted die edge, so the castellated silhouette reads on a dark page
MONO = "'Chakra Petch', 'Barlow Condensed', sans-serif"
DISPLAY = "'Big Shoulders Display', 'Oswald', 'Barlow Condensed', sans-serif"
LINING = 'style="font-variant-numeric: lining-nums"'
PERF_Y = 838  # perforation between poster/card and the tear stub


def f(v):
    return f"{v:.2f}".rstrip("0").rstrip(".")


def castellated(W, H, bite=16, depth=12, pitch=40, corner=16, ri=4, side_notch=None):
    """Concave corners, rounded-square bites along top and bottom (like a cinema 'original ticket'),
    optional semicircle side notches at y=side_notch (the tear line)."""
    c = corner
    span = W - 2 * c
    n = int(span // pitch)
    gap = span / n
    mids = [c + gap * (i + 0.5) for i in range(n)]
    d = [f"M{f(c)} 0"]
    for m in mids:  # top, bite goes down
        a, b = m - bite / 2, m + bite / 2
        d.append(f"L{f(a)} 0 L{f(a)} {f(depth - ri)} Q{f(a)} {f(depth)} {f(a + ri)} {f(depth)} "
                 f"L{f(b - ri)} {f(depth)} Q{f(b)} {f(depth)} {f(b)} {f(depth - ri)} L{f(b)} 0")
    d.append(f"L{f(W - c)} 0 A{f(c)} {f(c)} 0 0 0 {f(W)} {f(c)}")
    if side_notch:
        y, r = side_notch
        d.append(f"L{f(W)} {f(y - r)} A{f(r)} {f(r)} 0 0 0 {f(W)} {f(y + r)}")
    d.append(f"L{f(W)} {f(H - c)} A{f(c)} {f(c)} 0 0 0 {f(W - c)} {f(H)}")
    for m in reversed(mids):  # bottom, bite goes up
        a, b = m - bite / 2, m + bite / 2
        d.append(f"L{f(b)} {f(H)} L{f(b)} {f(H - depth + ri)} Q{f(b)} {f(H - depth)} {f(b - ri)} {f(H - depth)} "
                 f"L{f(a + ri)} {f(H - depth)} Q{f(a)} {f(H - depth)} {f(a)} {f(H - depth + ri)} L{f(a)} {f(H)}")
    d.append(f"L{f(c)} {f(H)} A{f(c)} {f(c)} 0 0 0 0 {f(H - c)}")
    if side_notch:
        y, r = side_notch
        d.append(f"L0 {f(y + r)} A{f(r)} {f(r)} 0 0 0 0 {f(y - r)}")
    d.append(f"L0 {f(c)} A{f(c)} {f(c)} 0 0 0 {f(c)} 0Z")
    return " ".join(d)


DIE = castellated(W, H, side_notch=(PERF_Y, 9))


def head():
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" data-foil="red">\n'


def edge():
    """Edge paint: a dark red band just inside the cut (half of a 5u stroke survives the clip)."""
    return f'<path d="{DIE}" fill="none" stroke="{EDGE}" stroke-width="5"/>'


WEAVE_DEFS = f"""
    <pattern id="weave" patternUnits="userSpaceOnUse" width="5" height="5" patternTransform="rotate(-38)">
      <rect width="5" height="5" fill="{STOCK}"/>
      <rect y="0" width="5" height="1.9" fill="#181515"/>
      <rect y="2.6" width="5" height="0.5" fill="#050404"/>
    </pattern>
    <pattern id="twill" patternUnits="userSpaceOnUse" width="20" height="5" patternTransform="rotate(-38)">
      <rect x="0" y="0" width="9" height="1.9" fill="#231f1f" opacity="0.5"/>
      <rect x="11" y="2.5" width="7" height="1" fill="#000" opacity="0.45"/>
    </pattern>"""


def rays(cx, hy, R, n=36, color="#000", op=0.22):
    """Sunburst wedges fanning up from the horizon point (cx, hy), inside the sun."""
    out = []
    for i in range(0, n, 2):
        a0 = math.pi + math.pi * i / n
        a1 = math.pi + math.pi * (i + 1) / n
        L = R * 2.2
        out.append(f'M{cx} {hy} L{f(cx + L * math.cos(a0))} {f(hy + L * math.sin(a0))} L{f(cx + L * math.cos(a1))} {f(hy + L * math.sin(a1))}Z')
    return f'<path d="{" ".join(out)}" fill="{color}" opacity="{op}"/>'


def bars(cx, cy, R, start, color):
    """Horizon cuts across the lower part of the sun: stock-coloured bars that thicken downwards."""
    out, y, h = [], cy + start, 1.4
    while y < cy + R + 4:
        out.append(f'<rect x="{cx - R - 4}" y="{f(y)}" width="{2 * R + 8}" height="{f(h)}" fill="{color}"/>')
        y += 12
        h += 1.45
    return "".join(out)


def ring_arc(cx, cy, r, hy):
    """The foil ring, only above the horizon line (so it never runs behind the title)."""
    dx = math.sqrt(r * r - (hy - cy) ** 2)
    return (f'<path d="M{f(cx - dx)} {hy} A{r} {r} 0 1 1 {f(cx + dx)} {hy}" fill="none" stroke="{RED}" stroke-width="0.9"/>'
            f'<path d="M30 {hy} H{f(cx - dx - 6)} M{f(cx + dx + 6)} {hy} H450" stroke="{RED}" stroke-width="0.9" fill="none"/>')


# ------------------------------------------------------------------ front
def front():
    cx, cy, R = 240, 310, 192
    hy = cy + 50  # horizon
    cy2, R2 = 330, 196  # no art: a bigger sun fills the poster
    hy2 = cy2 + 60
    side = f'font-family="{MONO}" font-size="8.5" font-weight="600" letter-spacing="3.4" fill="{INK}"'
    lab = f'font-family="{MONO}" font-size="8.5" font-weight="600" letter-spacing="2.2" fill="{INK}"'
    title = (f'data-slot="title" x="{W/2}" y="700" text-anchor="middle" font-family="{DISPLAY}" font-weight="900" '
             f'font-size="136" letter-spacing="1" data-case="upper" data-wrap="424" data-lines="4" data-leading="0.86" '
             f'data-anchor="bottom" data-min="30" {LINING}')
    val = f'font-family="{MONO}" font-size="13.5" font-weight="600" letter-spacing="0.8" fill="{TINT}"'
    return head() + f"""  <defs>{WEAVE_DEFS}
    <radialGradient id="sunG" cx="0.5" cy="0.38" r="0.62">
      <stop offset="0" stop-color="#5a0a0d"/>
      <stop offset="0.75" stop-color="#3c0608"/>
      <stop offset="1" stop-color="#290405"/>
    </radialGradient>
    <clipPath id="sunClip"><circle cx="{cx}" cy="{cy}" r="{R}"/></clipPath>
    <clipPath id="sunClip2"><circle cx="{cx}" cy="{cy2}" r="{R2}"/></clipPath>
    <filter id="duo" color-interpolation-filters="sRGB">
      <feColorMatrix type="matrix" values="0.33 0.55 0.12 0 0  0.33 0.55 0.12 0 0  0.33 0.55 0.12 0 0  0 0 0 1 0"/>
      <feComponentTransfer>
        <feFuncR type="table" tableValues="0.01 0.02 0.10 0.50 0.86 1"/>
        <feFuncG type="table" tableValues="0.01 0.01 0.01 0.04 0.20 0.52"/>
        <feFuncB type="table" tableValues="0.01 0.01 0.02 0.05 0.19 0.46"/>
      </feComponentTransfer>
    </filter>
    <linearGradient id="fadeG" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="{H}">
      <stop offset="0.058" stop-color="#000"/>
      <stop offset="0.092" stop-color="#fff"/>
      <stop offset="0.42" stop-color="#fff"/>
      <stop offset="0.56" stop-color="#000"/>
    </linearGradient>
    <linearGradient id="hfadeG" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="{W}" y2="0">
      <stop offset="0.035" stop-color="#000"/>
      <stop offset="0.11" stop-color="#fff"/>
      <stop offset="0.89" stop-color="#fff"/>
      <stop offset="0.965" stop-color="#000"/>
    </linearGradient>
    <mask id="hfade" maskUnits="userSpaceOnUse" x="0" y="0" width="{W}" height="{H}">
      <rect width="{W}" height="{H}" fill="url(#hfadeG)"/>
    </mask>
    <mask id="fade" maskUnits="userSpaceOnUse" x="0" y="0" width="{W}" height="{H}">
      <g mask="url(#hfade)"><rect width="{W}" height="{H}" fill="url(#fadeG)"/></g>
    </mask>
  </defs>
  <g data-layer="paper">
    <rect width="{W}" height="{H}" fill="url(#weave)"/>
    <rect width="{W}" height="{H}" fill="url(#twill)"/>
    <g data-show-if="art">
      <circle cx="{cx}" cy="{cy}" r="{R}" fill="url(#sunG)"/>
      <g clip-path="url(#sunClip)">{rays(cx, hy, R)}{bars(cx, cy, R, 50, STOCK)}</g>
    </g>
    <g data-hide-if="art">
      <circle cx="{cx}" cy="{cy2}" r="{R2}" fill="url(#sunG)"/>
      <g clip-path="url(#sunClip2)">{rays(cx, hy2, R2)}{bars(cx, cy2, R2, 60, STOCK)}</g>
    </g>
  </g>
  <g data-layer="art" mask="url(#fade)">
    <image data-slot="art" x="16" y="60" width="448" height="520" preserveAspectRatio="xMidYMax meet" filter="url(#duo)"/>
  </g>
  <g data-layer="paper">
    <rect width="{W}" height="{H}" fill="#fff" filter="url(#ts-grain-light)" opacity="0.06"/>
    {edge()}
  </g>
  <g data-layer="ink" fill="{INK}">
    <text x="30" y="40" font-family="{MONO}" font-size="10" font-weight="700" letter-spacing="1.8">TICKETSTUB ORIGINAL TICKET</text>
    <text data-slot="edition" x="450" y="40" text-anchor="end" font-family="{MONO}" font-size="10" font-weight="700" letter-spacing="1.2" {LINING}>.</text>
    <text transform="translate(22 {cy}) rotate(-90)" text-anchor="middle" {side} data-slot="kicker" data-case="upper" data-fit="300" data-default="ORIGINAL TICKET">.</text>
    <text transform="translate(458 {cy}) rotate(90)" text-anchor="middle" {side} data-slot="categoryLabel" data-suffix="  ·  ADMIT ONE">.</text>
    <text data-slot="subtitle" x="{W/2}" y="742" text-anchor="middle" font-family="{MONO}" font-size="12.5" font-weight="600" letter-spacing="3.6" fill="{TINT}" data-case="upper" data-wrap="416" data-lines="1" data-min="8.5" data-default="ONE NIGHT · ONE STUB">.</text>
    <text x="40" y="806" {val} {LINING}><tspan data-slot="dateDots">.</tspan><tspan data-slot="time" data-prefix="  ">.</tspan></text>
    <text data-slot="place" x="200" y="806" {val} data-case="upper" data-wrap="240" data-lines="2" data-leading="1.18" data-anchor="bottom" data-min="10.5">.</text>
    <text x="40" y="774" {lab}>DATE · TIME</text>
    <text x="200" y="774" {lab}>VENUE</text>
  </g>
  <g data-layer="foil" fill="{RED}">
    <path d="M30 50 H450" stroke="{RED}" stroke-width="0.9" fill="none"/>
    <g data-show-if="art">{ring_arc(cx, cy, R + 12, hy)}</g>
    <g data-hide-if="art">{ring_arc(cx, cy2, R2 + 10, hy2)}</g>
    <text {title} data-ink="" fill="{RED}">.</text>
    <text {title} opacity="0.3">.</text>
    <path d="M30 718 H450" stroke="{RED}" stroke-width="0.9" fill="none"/>
    <path d="M30 758 H450 M30 820 H450 M190 758 V820" stroke="{RED}" stroke-width="0.7" fill="none"/>
    <path data-ink="" d="M24 {PERF_Y} H456" stroke="{RED}" stroke-width="1.1" stroke-dasharray="1.2 4.8" stroke-linecap="round" fill="none"/>
    <text data-ink="" fill="{RED}" x="30" y="888" font-family="{DISPLAY}" font-weight="800" font-size="36" letter-spacing="2">ADMIT ONE</text>
    <text opacity="0.3" x="30" y="888" font-family="{DISPLAY}" font-weight="800" font-size="36" letter-spacing="2">ADMIT ONE</text>
    <g data-slot="barcode" data-w="150" data-h="38" transform="translate(300 858)"></g>
  </g>
  <g data-layer="ink" fill="{INK}" font-family="{MONO}">
    <text data-slot="seatLine" x="31" y="910" font-size="10.5" font-weight="600" letter-spacing="1.6" fill="{TINT}" data-fit="240" data-min="7" data-default="GENERAL ADMISSION">.</text>
    <text data-slot="serial" x="375" y="910" text-anchor="middle" font-size="8.5" letter-spacing="3.4" fill="{TINT}">.</text>
    <text x="{W/2}" y="934" text-anchor="middle" font-size="7.2" letter-spacing="1.2" fill="#d23a33">© TICKETSTUB · COMMEMORATIVE KEEPSAKE · NOT VALID FOR ENTRY</text>
  </g>
  <path data-layer="dieline" d="{DIE}" fill="none" stroke="#ec008c" stroke-width="0.5"/>
</svg>
"""


# ------------------------------------------------------------------ back
def star(cx, cy, r=10.5, ri=4.4):
    pts = []
    for k in range(10):
        a = -math.pi / 2 + k * math.pi / 5
        rr = r if k % 2 == 0 else ri
        pts.append(f"{f(cx + rr * math.cos(a))} {f(cy + rr * math.sin(a))}")
    return f'<path d="M{" L".join(pts)}Z" fill="none" stroke="{RED}" stroke-width="1.1" stroke-linejoin="round"/>'


def reel(cx, cy):
    p = [f'<circle cx="{cx}" cy="{f(cy)}" r="10" fill="none" stroke="{RED}" stroke-width="1.1"/>',
         f'<circle cx="{cx}" cy="{f(cy)}" r="1.8" fill="{RED}"/>']
    for k in range(5):
        a = -math.pi / 2 + k * 2 * math.pi / 5
        p.append(f'<circle cx="{f(cx + 5.6 * math.cos(a))}" cy="{f(cy + 5.6 * math.sin(a))}" r="2.1" fill="none" stroke="{RED}" stroke-width="0.8"/>')
    return "".join(p)


def empty_dash(x, y, slot, w=18):
    """A thin em-dash rule shown only when the slot is empty (one style for every empty field)."""
    return f'<path data-hide-if="{slot}" d="M{f(x - w / 2)} {f(y)} H{f(x + w / 2)}" stroke="{RED}" stroke-width="1.6" fill="none"/>'


def back():
    L, R = 30, 450
    T, B = 54, 818
    lab = f'font-family="{MONO}" font-size="11" font-weight="500" fill="{INK}"'
    val = f'font-family="{MONO}" font-size="11.5" font-weight="500" fill="{TINT}"'
    rule = f'stroke="{RED}" stroke-width="1" fill="none"'
    dash = f'stroke="{RED}" stroke-width="0.8" stroke-dasharray="2.5 3" fill="none"'
    big = f'font-family="{DISPLAY}" font-weight="800" {LINING}'
    VX = 116
    # y of the rule under each block
    r_title, r_info, r_rate, r_dt, r_rev, r_seat = 232, 336, 392, 472, 592, 708
    rc = (r_info + r_rate) / 2
    rating = []
    for i in range(5):
        cx = 134 + i * 46
        rating.append(star(cx, rc))
        if i < 4:
            rating.append(f'<path d="M{cx + 14} {f(rc)} H{cx + 32}" {dash}/>')
    brand = []
    letters = "TICKETSTUB"
    bx = R - len(letters) * 11
    for i, ch in enumerate(letters):
        x = bx + i * 11
        brand.append(f'<rect x="{x}" y="884" width="10" height="14" fill="none" stroke="{RED}" stroke-width="0.8"/>'
                     f'<text x="{x + 5}" y="895" text-anchor="middle" font-family="{MONO}" font-size="9.5" font-weight="700">{ch}</text>')
    ry = f(rc + 4)
    dt_y = r_dt - 15          # date/time numerals baseline
    seat_y = r_seat - 26      # section/row/seat numerals baseline (centred under the label)
    ev_y = B - 28             # event/gate/price baseline
    return head() + f"""  <defs>
    <filter id="ghost" color-interpolation-filters="sRGB">
      <feColorMatrix type="matrix" values="0 0 0 0 0.16  0 0 0 0 0.02  0 0 0 0 0.025  0 0 0 1 0"/>
    </filter>
    <radialGradient id="sunB" cx="0.5" cy="0.4" r="0.6">
      <stop offset="0" stop-color="#1f0405"/>
      <stop offset="1" stop-color="#140203"/>
    </radialGradient>
    <clipPath id="sunClipB"><circle cx="300" cy="440" r="236"/></clipPath>
    <linearGradient id="gfadeG" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="{H}">
      <stop offset="0.62" stop-color="#fff"/>
      <stop offset="0.84" stop-color="#000"/>
    </linearGradient>
    <mask id="gfade" maskUnits="userSpaceOnUse" x="0" y="0" width="{W}" height="{H}">
      <rect width="{W}" height="{H}" fill="url(#gfadeG)"/>
    </mask>
  </defs>
  <g data-layer="paper">
    <rect width="{W}" height="{H}" fill="{STOCK}"/>
    <circle cx="300" cy="440" r="236" fill="url(#sunB)"/>
    <g clip-path="url(#sunClipB)">{rays(300, 510, 236, op=0.3)}{bars(300, 440, 236, 70, STOCK)}</g>
  </g>
  <g data-layer="art" mask="url(#gfade)" opacity="0.5">
    <image data-slot="art" x="-10" y="170" width="540" height="680" preserveAspectRatio="xMidYMax meet" filter="url(#ghost)"/>
  </g>
  <g data-layer="paper">
    <rect width="{W}" height="{H}" fill="#fff" filter="url(#ts-grain-light)" opacity="0.06"/>
    {edge()}
  </g>
  <g data-layer="ink" fill="{INK}">
    <text x="{L}" y="40" font-family="{MONO}" font-size="10" font-weight="700" letter-spacing="1.8">TICKETSTUB ORIGINAL TICKET</text>
    <text data-slot="edition" x="{R}" y="40" text-anchor="end" font-family="{MONO}" font-size="10" font-weight="700" letter-spacing="1.2" {LINING}>.</text>
    <text x="{L + 14}" y="{T + 24}" {lab}>Title</text>
    <text data-slot="year" x="{R - 14}" y="{T + 24}" text-anchor="end" {lab} data-prefix="(" data-suffix=")" {LINING}>.</text>
    <text x="{L + 14}" y="{r_title + 26}" {lab}>Venue</text>
    <text x="{L + 14}" y="{r_title + 50}" {lab}>City</text>
    <text x="{L + 14}" y="{r_title + 74}" {lab}>With</text>
    <text data-slot="venue" x="{VX}" y="{r_title + 26}" {val} data-fit="320" data-min="8.5">.</text>
    <text data-slot="city" x="{VX}" y="{r_title + 50}" {val} data-fit="320" data-min="8.5">.</text>
    <text data-slot="peopleAll" x="{VX}" y="{r_title + 74}" {val} data-wrap="320" data-lines="2" data-leading="1.4" data-min="8.5">.</text>
    <text x="{L + 14}" y="{ry}" {lab}>Rating</text>
    <text x="{R - 14}" y="{ry}" text-anchor="end" {lab}>(   / 5)</text>
    <text x="{L + 14}" y="{r_rate + 22}" {lab}>Date</text><text x="256" y="{r_rate + 22}" {lab}>Time</text>
    <text x="{L + 14}" y="{r_dt + 22}" {lab}>Review</text>
    <text data-slot="tagline" x="{L + 14}" y="{r_dt + 56}" font-family="{MONO}" font-size="12.5" font-weight="500" fill="{TINT}" data-wrap="384" data-lines="2" data-leading="2.08" data-min="9" data-prefix="“" data-suffix="”">.</text>
    <g data-show-if="seat">
      <text x="100" y="{r_rev + 22}" text-anchor="middle" {lab}>Section</text>
      <text x="240" y="{r_rev + 22}" text-anchor="middle" {lab}>Row</text>
      <text x="380" y="{r_rev + 22}" text-anchor="middle" {lab}>Seat</text>
    </g>
    <text data-hide-if="seat" x="240" y="{r_rev + 22}" text-anchor="middle" {lab}>Admission</text>
    <g data-show-if="gate">
      <text x="100" y="{r_seat + 22}" text-anchor="middle" {lab}>Event</text>
      <text x="240" y="{r_seat + 22}" text-anchor="middle" {lab}>Gate</text>
      <text x="380" y="{r_seat + 22}" text-anchor="middle" {lab}>Price</text>
    </g>
    <text data-hide-if="gate" x="240" y="{r_seat + 22}" text-anchor="middle" {lab}>Event</text>
    <text data-slot="serial" x="{L}" y="914" font-family="{MONO}" font-size="8.5" letter-spacing="3.6" fill="{TINT}">.</text>
    <text x="{W/2}" y="936" text-anchor="middle" font-family="{MONO}" font-size="7.2" letter-spacing="1.2" fill="#d23a33">© TICKETSTUB · COMMEMORATIVE KEEPSAKE · NOT VALID FOR ENTRY</text>
  </g>
  <g data-layer="foil" fill="{RED}">
    <path d="M{L} 50 H{R}" stroke="{RED}" stroke-width="0.9" fill="none"/>
    <rect x="{L}" y="{T + 4}" width="{R - L}" height="{B - T - 4}" fill="none" stroke="{RED}" stroke-width="1.2"/>
    <text data-slot="title" x="{W/2}" y="178" text-anchor="middle" font-family="{DISPLAY}" font-size="46" font-weight="800" letter-spacing="2.2" data-case="upper" data-wrap="340" data-lines="3" data-leading="0.92" data-anchor="bottom" data-min="16" {LINING}>.</text>
    <text data-slot="subtitle" data-ink="" fill="{TINT}" x="{W/2}" y="202" text-anchor="middle" font-family="{MONO}" font-size="10.5" font-weight="600" letter-spacing="2.4" data-case="upper" data-wrap="384" data-lines="2" data-leading="1.35" data-min="7">.</text>
    <path d="M{L} {r_title} H{R}" {rule}/>
    {empty_dash(VX + 9, r_title + 70, "peopleAll")}{empty_dash(VX + 9, r_title + 22, "venue")}{empty_dash(VX + 9, r_title + 46, "city")}
    <path d="M{L} {r_info} H{R}" {rule}/>
    {''.join(rating)}
    <path d="M{L} {r_rate} H{R}" {rule}/>
    <path d="M240 {r_rate} V{r_dt}" {dash}/>
    <text data-slot="dateDots" x="{L + 14}" y="{dt_y}" {big} font-size="34" letter-spacing="1.5">.</text>
    <text data-slot="time" x="256" y="{dt_y}" {big} font-size="34" letter-spacing="1.5">.</text>
    {empty_dash(265, dt_y - 12, "time")}
    <path d="M{L} {r_dt} H{R}" {rule}/>
    <path d="M{L + 14} {r_dt + 62} H{R - 14} M{L + 14} {r_dt + 88} H{R - 14}" {dash}/>
    <path d="M{L} {r_rev} H{R}" {rule}/>
    <path data-show-if="seat" d="M170 {r_rev} V{r_seat} M310 {r_rev} V{r_seat}" {dash}/>
    <path data-show-if="gate" d="M170 {r_seat} V{B} M310 {r_seat} V{B}" {dash}/>
    <g data-show-if="seat">
    <text data-slot="section" x="100" y="{seat_y}" text-anchor="middle" {big} font-size="44" data-fit="124">.</text>
    <text data-slot="row" x="240" y="{seat_y}" text-anchor="middle" {big} font-size="44" data-fit="124">.</text>
    <text data-slot="seat" x="380" y="{seat_y}" text-anchor="middle" {big} font-size="44" data-fit="124">.</text>
    {empty_dash(100, seat_y - 15, "section")}{empty_dash(240, seat_y - 15, "row")}
    </g>
    <text data-hide-if="seat" x="{W/2}" y="{seat_y - 4}" text-anchor="middle" {big} font-size="34" letter-spacing="4">GENERAL ADMISSION</text>
    <path d="M{L} {r_seat} H{R}" {rule}/>
    <text data-hide-if="gate" data-slot="categoryLabel" x="{W/2}" y="{ev_y}" text-anchor="middle" {big} font-size="26" letter-spacing="4">.</text>
    <g data-show-if="gate">
    <text data-slot="categoryLabel" x="100" y="{ev_y}" text-anchor="middle" {big} font-size="24" letter-spacing="1.5" data-fit="124" data-min="12">.</text>
    <text data-slot="gate" x="240" y="{ev_y}" text-anchor="middle" {big} font-size="24" letter-spacing="1" data-case="upper" data-fit="124" data-min="12">.</text>
    <text data-slot="price" x="380" y="{ev_y}" text-anchor="middle" {big} font-size="24" letter-spacing="1" data-fit="124" data-min="12">.</text>
    {empty_dash(380, ev_y - 8, "price")}
    </g>
    <path data-ink="" d="M24 {PERF_Y} H456" stroke="{RED}" stroke-width="1.1" stroke-dasharray="1.2 4.8" stroke-linecap="round" fill="none"/>
    <g data-slot="barcode" data-w="190" data-h="38" transform="translate({L} 858)"></g>
    <text x="{R}" y="872" text-anchor="end" font-family="{MONO}" font-size="11" font-weight="700" letter-spacing="1">KEEP THE NIGHT™</text>
    {''.join(brand)}
  </g>
  <path data-layer="dieline" d="{DIE}" fill="none" stroke="#ec008c" stroke-width="0.5"/>
</svg>
"""


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "front.svg").write_text(front(), encoding="utf8")
    (OUT / "back.svg").write_text(back(), encoding="utf8")
    print("wrote", OUT)
