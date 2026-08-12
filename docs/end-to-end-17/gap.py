"""For every ask flagged 'ahead', how long the older rows had been on the wire.

An ask is only evidence of #494 if the client had *time to file* the older rows
before it asked. The tap sees bytes; the client sees them some milliseconds
later, and under load that gap is wide. A row that arrived 20 ms before the ask
proves nothing about the order of anybody's list.
"""
import re, sys
STAMP=re.compile(r"time=([\d-]+T[\d:.]+Z)"); MSGID=re.compile(r"msgid=([^;\s]+)")
BEFORE=re.compile(r"CHATHISTORY BEFORE (\S+) msgid=(\S+) (\d+)")
sess=0; said={}; oldest={}; oldest_at={}; rows=[]
for line in open(sys.argv[1]):
    if "session opened" in line: sess+=1; continue
    if len(line)<12: continue
    at=float(line[:8]); a=line[9]; b=line[11:].rstrip()
    if a=="<":
        s,m=STAMP.search(b),MSGID.search(b)
        if s and m:
            said[m.group(1)]=s.group(1)
            if sess not in oldest or s.group(1)<oldest[sess]:
                oldest[sess]=s.group(1); oldest_at[sess]=at
        continue
    h=BEFORE.search(b)
    if h:
        w=said.get(h.group(2))
        if w and sess in oldest and w>oldest[sess]:
            rows.append((sess, at, at-oldest_at[sess], w, oldest[sess]))
print(f"{'walk':>4} {'ask at':>8} {'older seen':>10}  ask names / oldest on wire")
for s,at,gap,w,o in rows:
    print(f"{s:>4} {at:>8.3f} {gap:>9.3f}s  {w}  {o}")
if rows:
    gaps=sorted(r[2] for r in rows)
    print(f"\nflagged {len(rows)}   gap min {gaps[0]:.3f}s  median {gaps[len(gaps)//2]:.3f}s  max {gaps[-1]:.3f}s")
    print(f"gaps under 1s: {sum(g<1 for g in gaps)} of {len(gaps)}")
