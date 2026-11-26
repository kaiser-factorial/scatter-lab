"""Aggregate retained evidence without replacing failures or narrowing denominators."""
import collections
import hashlib
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[3]
HERE = pathlib.Path(__file__).resolve().parent
FIXTURES = ROOT / 'src/lib/__tests__/fixtures/efa-congruence'

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def read(path):
    return json.loads(path.read_text())

def quantile(values, p):
    values = sorted(values)
    position = (len(values) - 1) * p
    lo = int(position)
    return values[lo] + (values[min(lo + 1, len(values)-1)] - values[lo]) * (position-lo)

reports = ['third-pass-report.json', 'ordinal-report.json', 'extensions-report.json', 'weighted-se-report.json']
metrics = collections.defaultdict(list)
groups = []
source_drift = []
for name in reports:
    report = read(HERE / name)
    for result in report['results']:
        groups.append({'report': name, **{k:v for k,v in result.items() if k not in ['checks', 'convergence', 'referenceWarnings']}})
        for check in result['checks']:
            metrics[check['metric']].append({'report': name, **{k:v for k,v in result.items() if k in ['dataset','method','missing','rotation','standardize']}, **check})
    receipt = read(HERE / (name + '.inputs.json'))
    for path, digest in receipt['sourceHashes'].items():
        if sha(ROOT / path) != digest: source_drift.append({'report': name, 'path': path})

bounds = {}
for metric, checks in metrics.items():
    errors = [c['error'] for c in checks]
    bounds[metric] = {'comparisons':len(checks), 'failures':sum(not c['passed'] for c in checks), 'limits':sorted(set(c['limit'] for c in checks)), 'p50PerComparisonError':quantile(errors,.5), 'p95PerComparisonError':quantile(errors,.95), 'maximumObservedError':max(errors), 'maximumCase':max(checks,key=lambda c:c['error'])}

parallel = []
for name in ['normal','heavy-tail','skew']:
    f = read(ROOT / f'src/lib/__tests__/fixtures/efa-extensions/parallel-{name}.reference.json')
    psych_reference = [quantile([entry['psychEigenvalues'][j] for entry in f['null']],.95) for j in range(len(f['observed']))]
    def suggested(observed, reference):
        n=0
        for a,b in zip(observed,reference):
            if a<=b: break
            n+=1
        return n
    parallel.append({'dataset':name,'savedRDefaultVsContractMaximumNullEigenvalueDifference':max(abs(a-b) for entry in f['null'] for a,b in zip(entry['eigenvalues'],entry['psychEigenvalues'])),'maximum95thPercentileDifference':max(abs(a-b) for a,b in zip(psych_reference,f['reference'])),'contractSuggested':suggested(f['observed'],f['reference']),'psychDefaultSuggested':suggested(f['observedFit']['psychEigenvalues'],psych_reference),'maximumObjectiveDifference':max(abs(entry['objective']-entry['psychObjective']) for entry in f['null'])})

all_evidence = list(FIXTURES.glob('*.json')) + [p for p in HERE.rglob('*') if p.is_file() and p.name not in ['numerical-summary.json','validation-manifest.json'] and '__pycache__' not in p.parts]
manifest = {'qualification':'Hashes bind retained fixtures, scripts, vendor source, past attempts and reports; native reports additionally bind their actually bundled application source. This is evidence integrity, not a proof of numerical equivalence.','reportDocument':{'path':'../docs/EFA-CONGRUENCE.md','sha256':sha(ROOT.parent/'docs/EFA-CONGRUENCE.md')},'files':{str(p.relative_to(ROOT)):sha(p) for p in sorted(set(all_evidence))}}
(HERE / 'validation-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
summary = {'scope':'Finite numerical agreement, signed factor permutation only. Report quantiles are over per-comparison error maxima, not cellwise sampling distributions or population error guarantees. Repeated rotations of the same fitted model are not independent datasets.','groups':len(groups),'passedGroups':sum(g['status']=='passed' for g in groups),'failedGroups':sum(g['status']!='passed' for g in groups),'scalarChecks':sum(len(v) for v in metrics.values()),'failedScalarChecks':sum(not c['passed'] for v in metrics.values() for c in v),'currentSourceDrift':source_drift,'metricBounds':bounds,'parallelPsychDefaultBoundary':parallel,'irisIterationBoundary':read(HERE/'iris-boundary-report.json'),'completionReplay':read(HERE/'replay/r-report.json'),'reportHashes':{name:sha(HERE/name) for name in reports},'manifestSha256':sha(HERE/'validation-manifest.json')}
iris_native = read(HERE/'iris-boundary/native.json')
iris_r = summary['irisIterationBoundary']['results']
iris_checks = []
for r in iris_r:
    n = next(c for c in iris_native if c['seed']==r['seed'] and c['rate']==r['rate'])
    n = next(c for c in n['results'] if c['maxIter']==r['maxIter'])
    iris_checks.append({'seed':r['seed'],'rate':r['rate'],'maxIter':r['maxIter'],'completionMaxAbs':r['maximumCompletionDifference'],'completionLimit':1e-10,'instrumentationOutputDifference':r['instrumentationOutputDifference'],'iterationsExact':n['iterations']==r['iterations'],'convergenceFlagExact':n['converged']==r['converged'],'passed':r['maximumCompletionDifference']<=1e-10 and r['instrumentationOutputDifference']==0 and n['iterations']==r['iterations'] and n['converged']==r['converged']})
summary['irisIterationBoundary']['matchedChecks'] = iris_checks
summary['largestBenchmark'] = read(HERE/'large-benchmark-receipt.json')
summary['applicationVerification'] = {'path':'app-verification.json','sha256':sha(HERE/'app-verification.json')}
(HERE / 'numerical-summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps({k:v for k,v in summary.items() if k in ['groups','passedGroups','failedGroups','scalarChecks','failedScalarChecks','currentSourceDrift']},indent=2))
if summary['failedGroups'] or summary['failedScalarChecks'] or source_drift or not all(c['passed'] for c in iris_checks) or summary['completionReplay']['status']!='passed': raise SystemExit(1)
