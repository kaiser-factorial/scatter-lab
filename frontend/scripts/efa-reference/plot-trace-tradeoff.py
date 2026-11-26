"""Reproduce with Python + matplotlib==3.10.7; synthetic benchmark evidence only."""
from pathlib import Path
import json, csv, statistics, hashlib, math
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D
from matplotlib.ticker import FixedLocator, FuncFormatter

root = Path(__file__).resolve().parents[3]
base = root / 'frontend/scripts/efa-reference/compute'
out = root / 'docs/figures'; out.mkdir(exist_ok=True)
fresh_path = base/'trace-tradeoff-v6.json'; large_path = base/'trace-estimation-large-v5.json'
fresh = json.loads(fresh_path.read_text()); large = json.loads(large_path.read_text())
assert fresh['status'] == large['status'] == 'completed-experiment'
records = fresh['results'] + large['results']
rows=[]; summaries=[]
for i,r in enumerate(records):
    d=r['dimensions']; historical=i==len(records)-1
    exact_ms = large['exactReference']['phaseTimings']['Exact robust trace blocks'] if historical else r['timings']['exactTrace']+r['timings']['exactStartup']
    for e in r['estimates']:
        elapsed=e['elapsedMs']+r['timings']['operatorStartup']
        relative=(e['traceSquared']-r['exact']['traceSquared'])/r['exact']['traceSquared']
        assert abs(relative-e['relativeTraceSquaredError'])<1e-12
        rows.append(dict(case=i,rows=d['rows'],items=d['items'],factors=d['factors'],seed=e['seed'],probes=e['probes'],exact_ms=exact_ms,estimated_ms=elapsed,speedup=exact_ms/elapsed,relative_error_percent=relative*100,absolute_relative_error_percent=abs(relative)*100,monte_carlo_se=e['monteCarloSE'],delta_p=e['delta']['pValue'],historical_exact=historical))
    subset=[v for v in rows if v['case']==i and v['probes']==128]
    cpu=r.get('cpuExact')
    summaries.append(dict(dimensions=d,exact_gpu_ms=exact_ms,estimated_gpu_median_ms=statistics.median(v['estimated_ms'] for v in subset),error_range_percent=[min(v['absolute_relative_error_percent'] for v in subset),max(v['absolute_relative_error_percent'] for v in subset)],median_abs_error_percent=statistics.median(v['absolute_relative_error_percent'] for v in subset),seeds=len(subset),cpu_exact_inference_median_ms=statistics.median(cpu['elapsedMs']) if cpu else None,cpu_repeats=cpu['elapsedMs'] if cpu else None))
assert len(rows)==126 and all(.8 <= r['speedup'] <= 200 and .001 <= r['absolute_relative_error_percent'] <= 30 for r in rows)
with (out/'efa-mv-tradeoff-v6.csv').open('w') as f:
    writer=csv.DictWriter(f,fieldnames=list(rows[0]));writer.writeheader();writer.writerows(rows)
plt.rcParams.update({'font.family':'DejaVu Sans','font.size':10,'axes.titlesize':12,'axes.labelsize':10,'svg.fonttype':'none'})
fig,axes=plt.subplots(2,3,figsize=(14.5,8.4));fig.subplots_adjust(left=.075,right=.975,bottom=.20,top=.84,wspace=.27,hspace=.47)
colors={32:'#B76613',64:'#226B8E',128:'#8053A5'};markers={32:'^',64:'s',128:'o'}
for i,ax in enumerate(axes.flat):
    if i==5: ax.axis('off');continue
    summary=summaries[i]; d=summary['dimensions']; subset=[r for r in rows if r['case']==i]
    ax.set_xscale('log');ax.set_yscale('log');ax.set_xlim(.8,200);ax.set_ylim(.001,30)
    for probes in [32,64,128]:
        points=[r for r in subset if r['probes']==probes]
        ax.scatter([r['speedup'] for r in points],[r['absolute_relative_error_percent'] for r in points],s=35,marker=markers[probes],color=colors[probes],edgecolors='white',linewidths=.45,alpha=.9,zorder=3)
    ax.axvline(1,color='#555',lw=1,ls='--');ax.grid(which='major',color='#e3e5e6',lw=.7)
    ax.xaxis.set_major_locator(FixedLocator([1,3,10,30,100]));ax.xaxis.set_major_formatter(FuncFormatter(lambda v,p:f'{v:g}×'))
    ax.yaxis.set_major_locator(FixedLocator([.001,.01,.1,1,10]));ax.yaxis.set_major_formatter(FuncFormatter(lambda v,p:f'{v:g}%'))
    ax.minorticks_off();ax.spines[['top','right']].set_visible(False)
    ax.set_title(f"{d['rows']:,} respondents × {d['items']} items · {d['factors']} factors",loc='left',fontweight='bold',pad=26)
    exact=summary['exact_gpu_ms']/1000
    value=f'{exact:.3f} s' if exact<10 else f'{exact:.2f} s' if exact<60 else f'{exact/60:.2f} min'
    ax.text(0,1.035,f"Exact GPU: {value}  |  {summary['seeds']} seeds"+('  |  historical*' if i==4 else ''),transform=ax.transAxes,fontsize=9,color='#4a4a4a')
    if i%3==0:ax.set_ylabel('Absolute error in tr(H²), relative to exact')
    ax.set_xlabel('Trace-stage speedup over exact GPU →')
    ax.text(.02,.025,f"128 probes: median error {summary['median_abs_error_percent']:.3g}%",transform=ax.transAxes,fontsize=9,bbox={'facecolor':'white','edgecolor':'none','alpha':.9})
notes=axes.flat[5]
handles=[Line2D([],[],color=colors[n],marker=markers[n],linestyle='None',markersize=7,label=f'{n} probes') for n in [32,64,128]]
notes.legend(handles=handles,loc='upper left',frameon=False,ncol=1,borderaxespad=0)
notes.text(0,.60,'Each mark is one seed at one probe budget.\nFarther right = faster; lower = more precise.\nBoth axes are logarithmic. Exact has zero\nMonte Carlo error, so it is not a point here.',va='top',linespacing=1.45,fontsize=10)
notes.text(0,.22,f"Small CPU exact inference is already fast:\n8 items: {summaries[0]['cpu_exact_inference_median_ms']:.1f} ms  ·  20 items: {summaries[1]['cpu_exact_inference_median_ms']:.1f} ms\nMedian of 7 runs; includes canonical covariance\nas well as exact traces, excluding earlier fitting.",va='top',linespacing=1.45,fontsize=10,fontweight='normal')
fig.suptitle('MV correction: measured speed–precision tradeoff',x=.075,ha='left',y=.965,fontsize=21,fontweight='bold')
fig.text(.075,.91,'Both modes apply the correction. Random probes estimate its second trace moment; the DWLS fit and standard errors are unchanged.',fontsize=11,color='#444')
fig.text(.075,.04,'GPU times include observed kernel startup + trace computation; shared projections/covariance, numerical self-checks and rotations are excluded.\n*500-item case reuses the completed exact benchmark and two probe seeds; other cases have fresh exact timings and ten seeds.\nApple M1 · 8 GiB · Chrome 156 · synthetic data. Nested probe checkpoints share random streams. These cases do not establish a universal size threshold.',fontsize=9,color='#444',linespacing=1.45)
for ext in ['png','svg','pdf']:fig.savefig(out/f'efa-mv-tradeoff-v6.{ext}',dpi=180,facecolor='white')
meta={'purpose':'Compare measured trace-stage speed against observed relative Monte Carlo error, by dataset and probe budget','grain':'one synthetic case, seed and cumulative fixed probe budget','statistic':'absolute relative error to exact tr(H²); exact time / estimated time','encoding':'faceted log-log scatter; common scales; probe count encoded by color and marker; no aggregation or trend line','alternative':'A single pooled scatter would obscure dataset structure and encourage a size-only claim; facets retain the case identity','timing_scope':'GPU kernel startup plus trace stage, excluding common projections/covariance, self-checks and rotations. CPU inset is whole inference and explicitly separate.','limits':['Data dimensions and factor counts vary together; not a controlled effect of N alone','Ten seeds for current cases; two for the historical 500-item case','Observed errors are not error guarantees; probe checkpoints are nested','Single-hardware measurements; no universal backend threshold'], 'matplotlib':matplotlib.__version__,'sources':{str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in [fresh_path,large_path]},'summaries':summaries}
(out/'efa-mv-tradeoff-v6.json').write_text(json.dumps(meta,indent=2)+'\n')
print(json.dumps(summaries,indent=2))
