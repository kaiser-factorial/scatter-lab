"""Standalone v7 evidence plots; matplotlib==3.10.7. No private data."""
from pathlib import Path
import json, csv, hashlib, gzip
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D
from matplotlib.ticker import PercentFormatter

root = Path(__file__).resolve().parents[3]
base = root / 'frontend/scripts/efa-reference/compute'
out = root / 'docs/figures'
out.mkdir(exist_ok=True)
plt.rcParams.update({'font.family': 'DejaVu Sans', 'font.size': 11, 'svg.fonttype': 'none'})

def save(fig, name, source, meta):
    for ext in ['png', 'svg', 'pdf']:
        fig.savefig(out / f'{name}.{ext}', dpi=180, facecolor='white')
    meta.update(matplotlib=matplotlib.__version__, sources={str(source.relative_to(root)): hashlib.sha256(source.read_bytes()).hexdigest()})
    (out / f'{name}.json').write_text(json.dumps(meta, indent=2) + '\n')
    plt.close(fig)

p = base / 'trace-error-shapes-v7.json'
d = json.loads(p.read_text())
assert d['status'] == 'passed'
rs = [d['results'][i] for i in [0, 1, 2, 3, 5, 4]]
labels = ['Dense · rank 1 · 256 rows', 'Dense · rank 4 · 256 rows', 'Dense · rank 16 · 256 rows', 'Diagonal · rank 1 · 256 rows', 'Dense · rank 1 · 4,096 rows', 'Dense · rank 1 · 256 rows\ntrace multiplied by 10¹²']
fig, ax = plt.subplots(figsize=(11.5, 6.5))
fig.subplots_adjust(left=.29, right=.96, top=.78, bottom=.26)
for i, r in enumerate(rs):
    ax.plot([0, r['maxAbsRelativeError']], [i, i], color='#e1e3e5', lw=1, zorder=1)
    ax.scatter(r['observedRmsRelativeError'], i, s=68, color='#226B8E', zorder=3)
    ax.scatter(r['theoreticalRelativeSE'], i-.12, s=45, color='#333', marker='x', zorder=4)
    ax.scatter(r['maxAbsRelativeError'], i, s=65, facecolors='white', edgecolors='#B76613', marker='D', zorder=3)
    ax.text(r['maxAbsRelativeError']+.011, i, f"{100*r['maxAbsRelativeError']:.1f}%", va='center', fontsize=9, color='#8e4d0f')
ax.set_yticks(range(len(rs)), labels)
ax.invert_yaxis()
ax.set_xlim(-.012, .49)
ax.set_xticks([0, .1, .2, .3, .4])
ax.xaxis.set_major_formatter(PercentFormatter(1))
ax.set_xlabel('Relative error in the estimate of tr(H²)')
ax.grid(axis='x', color='#eceeef')
ax.spines[['top', 'right', 'left']].set_visible(False)
ax.tick_params(axis='y', length=0)
fig.suptitle('Large matrices can still have large probe error', x=.035, y=.96, ha='left', fontsize=22, fontweight='bold')
fig.text(.035, .875, '128 probes · 256 seeds per operator · synthetic matrix constructions, not fitted survey datasets', fontsize=12, color='#444')
handles = [Line2D([], [], color='#226B8E', marker='o', ls='None', label='Observed RMS error'), Line2D([], [], color='#333', marker='x', ls='None', label='Theoretical relative SE'), Line2D([], [], color='#B76613', marker='D', markerfacecolor='white', ls='None', label='Largest absolute error among tested seeds')]
fig.legend(handles=handles, loc='lower left', bbox_to_anchor=(.025, .105), frameon=False, ncol=2, fontsize=10)
fig.text(.035, .035, 'RMS is a measure across random draws, not a per-run limit. The observed maximum is not a population bound.\nIncreasing dimension or trace magnitude does not repair a dominant dense direction; rank and orientation matter.', fontsize=10, color='#444', linespacing=1.4)
save(fig, 'efa-mv-error-shapes-v7', p, {'purpose': 'Explain error dependence on structure, dimension and scale', 'grain': 'one constructed operator aggregated over 256 seeds at 128 probes', 'transformations': ['RMS signed relative errors over all seeds', 'maximum absolute error over the same seeds', 'closed-form theoretical standard deviation'], 'encoding': 'common linear percentage axis; distinct marks for RMS, theory and finite-sample maximum', 'limits': ['Not typical-survey error estimates', 'Maximum depends on tested seeds', 'RMS and theoretical SE are not confidence limits'], 'validation': ['all six cases included', 'zero-error diagonal retained', 'scale-control relative errors match'], 'summaries': [{k: v for k, v in r.items() if k != 'draws'} for r in rs]})

p = base / 'paired-full-large-v7.json'
if p.with_suffix('.json.gz').exists():
    p = p.with_suffix('.json.gz')
    d = json.loads(gzip.decompress(p.read_bytes()))
else:
    d = json.loads(p.read_text())
if d['status'] != 'passed':
    print('Error-shape figure written; full-fit figure awaits completed paired evidence.')
    raise SystemExit(0)
rows = []
for arm in d['arms']:
    r = arm['result']
    first = r['results'][0]
    trace = sum(s['durationMs'] for s in first['report']['stages'] if s['stage'] in ['Exact robust trace blocks', 'Estimated MV probes', 'MV matrix products'])
    assert 0 < trace < first['elapsedMs'] < r['totalMs']
    rows.append({'mode': arm['correction'], 'first_fit_ms': first['elapsedMs'], 'trace_stage_wall_ms': trace, 'other_first_fit_ms': first['elapsedMs']-trace, 'scores_and_rotation_comparisons_ms': r['totalMs']-first['elapsedMs'], 'total_ms': r['totalMs']})
fig, ax = plt.subplots(figsize=(11.5, 6.4))
fig.subplots_adjust(left=.17, right=.92, bottom=.42, top=.75)
colors = ['#d5dadf', '#226B8E', '#9274AD']
keys = ['other_first_fit_ms', 'trace_stage_wall_ms', 'scores_and_rotation_comparisons_ms']
names = ['Other initial-fit work', 'MV trace stage', 'Scores + rotation comparisons']
for i, row in enumerate(rows):
    left = 0
    for key, color in zip(keys, colors):
        value = row[key]/60000
        ax.barh(i, value, left=left, height=.48, color=color, edgecolor='white', linewidth=.7)
        left += value
    ax.text(left+.35, i, f'{left:.2f} min', va='center', fontweight='bold')
ax.set_yticks([0, 1], ['Exact WebGPU', 'Estimated WebGPU\n128 probes'])
ax.invert_yaxis()
ax.set_xlim(0, max(r['total_ms'] for r in rows)/60000*1.18)
ax.set_xlabel('Elapsed analysis time (minutes)')
ax.spines[['top', 'right', 'left']].set_visible(False)
ax.grid(axis='x', color='#eceeef')
ax.set_axisbelow(True)
ax.tick_params(axis='y', length=0)
fig.suptitle('Fresh full-fit pair: 20,000 respondents × 500 items', x=.035, y=.96, ha='left', fontsize=21, fontweight='bold')
fig.text(.035, .885, f"Five factors · identical synthetic input · {d['comparison']['totalSpeedup']:.2f}× total speedup in this pair", fontsize=12, color='#444')
fig.legend([plt.Rectangle((0, 0), 1, 1, color=c) for c in colors], names, loc='lower left', bbox_to_anchor=(.025, .275), ncol=3, frameon=False, fontsize=10)
x, y = [a['result']['results'][0]['weighted']['robust']['test'] for a in d['arms']]
fig.text(.035, .215, f"Second-trace relative error: {100*d['comparison']['traceSquaredRelativeError']:+.4f}%   |   corrected χ² change: {y['statistic']-x['statistic']:+.3f}", fontsize=12)
fig.text(.035, .16, 'Matched correlations, loadings, factor correlations, communalities, standard errors and scores passed parity.', fontsize=10)
fig.text(.035, .035, 'One sequential pair, exact then estimated; fresh browser + service for each, including numerical self-checks.\nTotals include a cold oblimin fit, scoring and cached promax/varimax comparisons. Browser launch and input generation excluded.\nApple M1 · 8 GiB · ordinary Chrome; interactive applications remained available. These are not repeated idle-machine estimates.', fontsize=9.5, color='#444', linespacing=1.45)
save(fig, 'efa-mv-paired-full-v7', p, {'purpose': 'Compare full analysis time for a fresh exact/estimated pair', 'grain': 'one complete production-service analysis per method', 'transformation': 'disjoint elapsed time components; no summation of parallel worker CPU times', 'encoding': 'stacked horizontal bars on common zero-based minute scale with total labels', 'limits': ['One sequential pair on one machine', 'Other applications may remain active', 'No repeated or order-balanced estimate'], 'validation': ['parts add to measured total', 'trace wall stage is a subset of initial fit', 'same input hash and unchanged-output parity'], 'timings': rows, 'comparison': d['comparison']})
with (out/'efa-mv-paired-full-v7.csv').open('w') as f:
    writer = csv.DictWriter(f, fieldnames=list(rows[0]), lineterminator='\n')
    writer.writeheader()
    writer.writerows(rows)
print(json.dumps(rows, indent=2))
