"""Die-cut outlines for stub templates, as SVG path data. Units are viewBox units (200 per inch).

    scalloped(W, H, r=8, pitch=34, corner=16, edges="tb")  semicircle bites along edges + concave corners
    notched(W, H, at=[(y, r)], radius=12, side="lr")         rounded rect with round bites (tear line)
    rounded(W, H, r)                                         plain rounded rectangle
"""
from math import floor


def _f(v):
    return f"{v:.2f}".rstrip("0").rstrip(".")


def scalloped(W, H, r=8, pitch=34, corner=16, edges="tb"):
    """Concave quarter-circle corners; semicircle bites along the chosen edges (t, b, l, r)."""
    c = corner
    d = [f"M{_f(c)} 0"]

    def run(length, axis_from, axis_to, horizontal, forward, edge):
        # bites centred evenly between the corners
        span = length - 2 * c
        n = max(0, floor(span / pitch))
        if edge not in edges or n == 0:
            return []
        gap = span / n
        out = []
        for i in range(n):
            mid = c + gap * (i + 0.5)
            p0 = mid - r
            p1 = mid + r
            if not forward:
                p0, p1 = length - p1, length - p0
            out.append((p0, p1))
        return out

    # top: left -> right, bite goes down (+y)
    for a, b in run(W, 0, W, True, True, "t"):
        d.append(f"L{_f(a)} 0 A{_f(r)} {_f(r)} 0 0 0 {_f(b)} 0")
    d.append(f"L{_f(W - c)} 0 A{_f(c)} {_f(c)} 0 0 0 {_f(W)} {_f(c)}")
    # right: top -> bottom, bite goes left
    for a, b in run(H, 0, H, False, True, "r"):
        d.append(f"L{_f(W)} {_f(a)} A{_f(r)} {_f(r)} 0 0 0 {_f(W)} {_f(b)}")
    d.append(f"L{_f(W)} {_f(H - c)} A{_f(c)} {_f(c)} 0 0 0 {_f(W - c)} {_f(H)}")
    # bottom: right -> left, bite goes up
    for a, b in run(W, 0, W, True, False, "b"):
        d.append(f"L{_f(b)} {_f(H)} A{_f(r)} {_f(r)} 0 0 0 {_f(a)} {_f(H)}")
    d.append(f"L{_f(c)} {_f(H)} A{_f(c)} {_f(c)} 0 0 0 0 {_f(H - c)}")
    # left: bottom -> top, bite goes right
    for a, b in run(H, 0, H, False, False, "l"):
        d.append(f"L0 {_f(b)} A{_f(r)} {_f(r)} 0 0 0 0 {_f(a)}")
    d.append(f"L0 {_f(c)} A{_f(c)} {_f(c)} 0 0 0 {_f(c)} 0Z")
    return " ".join(d)


def notched(W, H, at, radius=6, side="lr"):
    """Rounded rectangle (corner radius) with semicircle bites on the left/right (side "lr") at y values,
    or on top/bottom (side "tb") at x values. `at` is a list of (pos, r)."""
    R = radius
    d = [f"M{_f(R)} 0"]
    if side == "tb":
        for x, r in sorted(at):
            d.append(f"L{_f(x - r)} 0 A{_f(r)} {_f(r)} 0 0 0 {_f(x + r)} 0")
    d.append(f"L{_f(W - R)} 0 Q{_f(W)} 0 {_f(W)} {_f(R)}")
    if side == "lr":
        for y, r in sorted(at):
            d.append(f"L{_f(W)} {_f(y - r)} A{_f(r)} {_f(r)} 0 0 0 {_f(W)} {_f(y + r)}")
    d.append(f"L{_f(W)} {_f(H - R)} Q{_f(W)} {_f(H)} {_f(W - R)} {_f(H)}")
    if side == "tb":
        for x, r in sorted(at, reverse=True):
            d.append(f"L{_f(x + r)} {_f(H)} A{_f(r)} {_f(r)} 0 0 0 {_f(x - r)} {_f(H)}")
    d.append(f"L{_f(R)} {_f(H)} Q0 {_f(H)} 0 {_f(H - R)}")
    if side == "lr":
        for y, r in sorted(at, reverse=True):
            d.append(f"L0 {_f(y + r)} A{_f(r)} {_f(r)} 0 0 0 0 {_f(y - r)}")
    d.append(f"L0 {_f(R)} Q0 0 {_f(R)} 0Z")
    return " ".join(d)


def rounded(W, H, r):
    return notched(W, H, [], radius=r)
