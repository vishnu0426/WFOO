"""Synthetic but realistic 24x7 voice centre: ~20,000 calls/day, AHT 180 s. Known truth so forecast error can be scored."""
import math, random
from datetime import date, timedelta
DOW=[1.07,1.05,1.03,1.02,0.99,0.90,0.94]     # Mon..Sun, mean ~1.0
raw=[0.2,0.15,0.12,0.1,0.1,0.15,0.3,0.6,1.1,1.6,1.9,2.0,1.9,1.8,1.9,1.9,1.7,1.5,1.3,1.1,0.9,0.7,0.5,0.3]  # hourly shape
SH=[v/sum(raw) for v in raw]
def day_total(d, base=20000, growth=0.0004):
    n=(d-date(2026,8,3)).days
    return base*DOW[d.weekday()]*(1+growth*n)
def slot_share(slot):                          # 15-minute share inside the hour, smooth interpolation
    h=slot//4; nxt=SH[(h+1)%24]; prv=SH[h]
    w=(slot%4+0.5)/4
    return (prv*(1-w)+nxt*w)/4
def history(end=date(2026,10,31), days=120, seed=11):
    r=random.Random(seed); rows=[]; slots=[]
    for i in range(days):
        d=end-timedelta(days=days-1-i)
        tot=day_total(d)*(1+r.gauss(0,0.035))
        rows.append((d,tot))
        if i>=days-28:
            for s in range(96):
                v=tot*slot_share(s)*(1+r.gauss(0,0.06)); aht=180*(1+r.gauss(0,0.04))
                slots.append((d,s,max(0,v),aht))
    return rows,slots
def actual(d, seed=99):
    r=random.Random(seed+d.toordinal()); tot=day_total(d)*(1+r.gauss(0,0.035))
    return tot,[tot*slot_share(s)*(1+r.gauss(0,0.06)) for s in range(96)]
