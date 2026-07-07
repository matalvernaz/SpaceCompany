"""Summarise a pacing-sim JSON report: milestones, walls, blocking histogram.

Usage: python3 sim/report.py <run.json>
"""
import json
import sys

r = json.load(open(sys.argv[1]))


def fmt(s):
    h, m = divmod(s // 60, 60)
    return f"{h:02d}h{m:02d}m"


print(f"simulated: {fmt(r['t'])}; pageErrors: {r['pageErrors'][:2]}")
print(f"rocketLaunched: {r['rocketLaunched']}, explored: {r['explored']}")
print(f"final science: {r['science']:,}")

print("\n=== KEY MILESTONES ===")
for e in r['log']:
    print(f"{fmt(e['t'])}  {e['type']:9s} {e['name']}")

print("\n=== WALLS (idle >= 20 min) ===")
for w in r['walls']:
    tag = ' (STILL STUCK AT END)' if w.get('open') else ''
    print(f"at {fmt(w['from'])}  stuck {fmt(w['sec'])}  on: {w['blocked']}{tag}")

print("\n=== BLOCKING RESOURCE (idle-round histogram) ===")
total = sum(r['blockHist'].values()) or 1
for res, n in sorted(r['blockHist'].items(), key=lambda kv: -kv[1]):
    print(f"{res:12s} {n:6d}  ({100 * n / total:.0f}%)")

print("\n=== FINAL MACHINES (top 20) ===")
for k, v in sorted(r['state'].items(), key=lambda kv: -kv[1])[:20]:
    print(f"{k:20s} {v}")
