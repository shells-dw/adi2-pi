"""ADI-2-Pi logo: a volume knob drawn as a pie with a slice taken out. Writes SVGs; PNGs are rendered separately."""
import math
CY, OR, BG = '#3fc1d9', '#f0a23b', '#16191d'
def pt(cx,cy,r,a): t=math.radians(a); return (cx+r*math.cos(t), cy+r*math.sin(t))
def mark(id, ox=0, oy=0, gap=(-66,-14), pointer=-128):
    cx,cy,r=62,66,50
    a0,a1=gap
    x0,y0=pt(cx,cy,r,a1); x1,y1=pt(cx,cy,r,a0)
    body=f"M{cx} {cy} L{x0:.2f} {y0:.2f} A{r} {r} 0 1 1 {x1:.2f} {y1:.2f} Z"
    w0,w1=pt(cx,cy,r,a0),pt(cx,cy,r,a1)
    piece=f"M{cx} {cy} L{w0[0]:.2f} {w0[1]:.2f} A{r} {r} 0 0 1 {w1[0]:.2f} {w1[1]:.2f} Z"
    mid=math.radians((a0+a1)/2); dx,dy=8*math.cos(mid),8*math.sin(mid)
    ticks=''
    for a in range(135,136+270,27):
        aa=((a+180)%360)-180
        if a0-6<=aa<=a1+6: continue
        p,q=pt(cx,cy,39,a),pt(cx,cy,45.5,a)
        ticks+=f'<line x1="{p[0]:.1f}" y1="{p[1]:.1f}" x2="{q[0]:.1f}" y2="{q[1]:.1f}" stroke="#000" stroke-width="3.4" stroke-linecap="round"/>'
    p1,p2=pt(cx,cy,9,pointer),pt(cx,cy,23,pointer)
    return f'''<g transform="translate({ox} {oy})">
  <mask id="{id}" maskUnits="userSpaceOnUse" x="0" y="0" width="128" height="128"><rect width="128" height="128" fill="#fff"/>
    <circle cx="{cx}" cy="{cy}" r="30" fill="none" stroke="#000" stroke-width="5.5"/>
    <line x1="{p1[0]:.1f}" y1="{p1[1]:.1f}" x2="{p2[0]:.1f}" y2="{p2[1]:.1f}" stroke="#000" stroke-width="7" stroke-linecap="round"/>{ticks}
  </mask>
  <path d="{body}" fill="{CY}" mask="url(#{id})"/>
  <path d="{piece}" fill="{OR}" transform="translate({dx:.2f} {dy:.2f})"/>
</g>'''
def svg(w,h,body,vb=None): return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb or f"0 0 {w} {h}"}" width="{w}" height="{h}">\n{body}\n</svg>\n'
def lockup(id, text_c, sub_c):
    return svg(600,140, f'''<g transform="translate(6 6)">{mark(id,1,-2)}</g>
<text x="150" y="92" font-family="Inter, 'Segoe UI', system-ui, sans-serif" font-size="64" font-weight="700" letter-spacing="-1" fill="{text_c}">ADI-2-<tspan fill="{CY}">Pi</tspan></text>
<text x="153" y="122" font-family="Inter, 'Segoe UI', system-ui, sans-serif" font-size="17" font-weight="500" letter-spacing=".5" fill="{sub_c}">Raspberry Pi bridge for RME ADI-2</text>''')
if __name__=='__main__':
    open('adi2-pi-mark.svg','w').write(svg(128,128,mark('m',1,-2)))
    open('adi2-pi-icon.svg','w').write(svg(128,128,f'<rect width="128" height="128" rx="28" fill="{BG}"/>'+mark('i',1,-2)))
    open('adi2-pi-maskable.svg','w').write(svg(128,128,f'<rect width="128" height="128" fill="{BG}"/><g transform="translate(16 16) scale(.75)">'+mark('k',1,-2)+'</g>'))
    open('adi2-pi-wordmark-dark.svg','w').write(lockup('wd','#e7ebef','#8d98a4'))
    open('adi2-pi-wordmark-light.svg','w').write(lockup('wl','#1b2127','#5f6b77'))
