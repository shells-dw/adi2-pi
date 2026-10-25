"""ADI-2-Pi logo: a volume ring drawn as a pie with one slice taken out. Writes the SVGs; PNGs are
rendered from them (render.js)."""
import math

CY, OR, BG, FACE, DIM = '#3fc1d9', '#f0a23b', '#16191d', '#262c33', '#2b6672'
S = 128                      # canvas
CX = CY_ = 64
R_OUT, R_IN = 54, 33         # the ring
GAP = (-78, -22)             # the missing slice, degrees (0 = right, clockwise positive)
PUSH = 7                     # how far the slice sits away from the ring
SCALE_START = 135            # where the knob's scale begins (bottom left)
POINTER = -60                # knob pointer angle: the value arc runs from SCALE_START to here


def pt(cx, cy, r, a):
    t = math.radians(a)
    return cx + r * math.cos(t), cy + r * math.sin(t)


def annulus(cx, cy, r1, r2, a0, a1):
    """Ring sector from a0 to a1 (clockwise, degrees), as a path."""
    large = 1 if (a1 - a0) % 360 > 180 else 0
    o0, o1 = pt(cx, cy, r1, a0), pt(cx, cy, r1, a1)
    i0, i1 = pt(cx, cy, r2, a0), pt(cx, cy, r2, a1)
    return (f"M{o0[0]:.2f} {o0[1]:.2f} A{r1} {r1} 0 {large} 1 {o1[0]:.2f} {o1[1]:.2f} "
            f"L{i1[0]:.2f} {i1[1]:.2f} A{r2} {r2} 0 {large} 0 {i0[0]:.2f} {i0[1]:.2f} Z")


def mark(ox=0, oy=0, face=FACE):
    a0, a1 = GAP
    ring = annulus(CX, CY_, R_OUT, R_IN, a1, a0 + 360)          # the track (the pie without its slice)
    value = annulus(CX, CY_, R_OUT, R_IN, SCALE_START, POINTER + 360)   # how far the knob is turned
    piece = annulus(CX, CY_, R_OUT, R_IN, a0, a1)
    mid = math.radians((a0 + a1) / 2)
    dx, dy = PUSH * math.cos(mid), PUSH * math.sin(mid)
    p1, p2 = pt(CX, CY_, R_IN - 23, POINTER), pt(CX, CY_, R_IN - 8, POINTER)
    return f'''<g transform="translate({ox} {oy})">
  <path d="{ring}" fill="{DIM}"/>
  <path d="{value}" fill="{CY}"/>
  <path d="{piece}" fill="{OR}" transform="translate({dx:.2f} {dy:.2f})"/>
  <circle cx="{CX}" cy="{CY_}" r="{R_IN - 3}" fill="{face}"/>
  <line x1="{p1[0]:.2f}" y1="{p1[1]:.2f}" x2="{p2[0]:.2f}" y2="{p2[1]:.2f}" stroke="{CY}" stroke-width="7" stroke-linecap="round"/>
</g>'''


def svg(w, h, body, vb=None):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb or f"0 0 {w} {h}"}" width="{w}" height="{h}">\n{body}\n</svg>\n'


def lockup(text_c, sub_c, face):
    return svg(600, 140, f'''<g transform="translate(6 6)">{mark(0, 0, face)}</g>
<text x="150" y="90" font-family="Inter, 'Segoe UI', system-ui, sans-serif" font-size="62" font-weight="700" letter-spacing="-1.5" fill="{text_c}">ADI-2-<tspan fill="{CY}">Pi</tspan></text>
<text x="153" y="120" font-family="Inter, 'Segoe UI', system-ui, sans-serif" font-size="17" font-weight="500" letter-spacing=".4" fill="{sub_c}">Remote and audio bridge for RME ADI-2</text>''')


if __name__ == '__main__':
    open('adi2-pi-mark.svg', 'w').write(svg(S, S, mark()))
    open('adi2-pi-icon.svg', 'w').write(svg(S, S, f'<rect width="{S}" height="{S}" rx="28" fill="{BG}"/>' + mark()))
    open('adi2-pi-maskable.svg', 'w').write(svg(S, S, f'<rect width="{S}" height="{S}" fill="{BG}"/><g transform="translate(16 16) scale(.75)">' + mark() + '</g>'))
    open('adi2-pi-wordmark-dark.svg', 'w').write(lockup('#e7ebef', '#8d98a4', FACE))
    open('adi2-pi-wordmark-light.svg', 'w').write(lockup('#1b2127', '#5f6b77', '#dde3e8'))
