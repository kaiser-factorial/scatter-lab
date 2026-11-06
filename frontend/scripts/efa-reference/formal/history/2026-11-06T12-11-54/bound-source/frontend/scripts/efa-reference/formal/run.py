#!/usr/bin/env python3
"""Execute narrow native SAW contracts with source/model receipts; fail closed."""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
FRONTEND = HERE.parents[2]
ROOT = FRONTEND.parent
DEFAULT_SAW = ROOT.parent / 'crypto/hash-visualizer/validation/tools/saw-1.6-macos-15-ARM64-with-solvers/bin/saw'
SAW = Path(os.environ.get('SCATTER_SAW', DEFAULT_SAW)).resolve()
OUT = HERE / 'evidence'
ENV = dict(os.environ, PATH=str(SAW.parent) + os.pathsep + os.environ.get('PATH', ''))


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def valid_summary(summary, expected):
    return (isinstance(summary, list) and len(summary) == expected
            and len({p.get('id') for p in summary}) == expected
            and all(p.get('status') == 'verified' and p.get('reason') == 'prove_print'
                    and p.get('type') == 'property' and p.get('provers')
                    and p.get('dependencies') == [] for p in summary))


def snapshot(paths):
    return {str(p.relative_to(ROOT)): sha(p) for p in paths}


def current(hashes):
    return all((ROOT / rel).is_file() and sha(ROOT / rel) == digest for rel, digest in hashes.items())


def invoke(script, name, cwd=HERE):
    log, summary = OUT / f'{name}.log', OUT / f'{name}.summary.json'
    summary.unlink(missing_ok=True)
    command = [str(SAW), '--no-color', '--summary', str(summary), '--summary-format=json', str(script)]
    started = time.monotonic()
    timed_out = False
    with log.open('w') as output:
        try:
            result = subprocess.run(command, cwd=cwd, env=ENV, stdout=output, stderr=subprocess.STDOUT, timeout=60)
            code = result.returncode
        except subprocess.TimeoutExpired:
            timed_out, code = True, None
    entries = json.loads(summary.read_text()) if summary.exists() else []
    return {'command': command, 'returncode': code, 'timedOut': timed_out,
            'seconds': round(time.monotonic() - started, 3), 'summary': entries,
            'log': str(log.relative_to(ROOT)), 'logSha256': sha(log),
            'summaryFile': str(summary.relative_to(ROOT)) if summary.exists() else None,
            'summarySha256': sha(summary) if summary.exists() else None}


def counterexample(run):
    text = (ROOT / run['log']).read_text()
    return (not run['timedOut'] and run['returncode'] not in (None, 0)
            and re.search(r'Invalid:\s*\[', text) is not None
            and 'unsolved subgoal' in text)


def main():
    OUT.mkdir(exist_ok=True)
    report_path = HERE / 'report.json'
    report = {'status': 'running', 'startedAtUtc': datetime.now(timezone.utc).isoformat(),
              'claim': 'Five exact-rational bounded Gaussian algebra identities and four source-derived numeric/FIML cell update identities.',
              'notClaimed': ['Global optimizer convergence', 'Full TypeScript/R or lavaan equivalence',
                             'IEEE-754 likelihood arithmetic equality', 'Verified ECMAScript compiler or source translator',
                             'General-dimensional matrix theorem', 'Imputation uncertainty or statistical validity'],
              'timeoutSecondsPerProof': 60}
    report_path.write_text(json.dumps(report, indent=2) + '\n')
    try:
        subprocess.run(['node', 'source-contract.mjs'], cwd=HERE, check=True, capture_output=True)
        subprocess.run(['node', 'source-fiml.mjs'], cwd=HERE, check=True, capture_output=True)
        source_contract = json.loads((HERE / 'source-contract.json').read_text())
        fiml_contract = json.loads((HERE / 'fiml-source-contract.json').read_text())
        report['fimlSourceContract'] = fiml_contract
        report['sourceContract'] = source_contract
        bound_files = [HERE / name for name in ['GaussianContracts.cry', 'NumericCellContract.cry', 'gaussian.saw',
                       'cell.saw', 'negative-gaussian.saw', 'source-contract.mjs', 'source-fiml.mjs', 'FimlCellContract.cry', 'fiml-cell.saw', 'run.py', 'verify.py']]
        bound_files += [Path(source_contract['source']['file']), Path(fiml_contract['source']['file'])]
        context_files = [FRONTEND / f'src/lib/efa/{name}' for name in ['maximum-likelihood.ts', 'optimize.ts', 'fit.ts', 'types.ts']]
        report['boundHashes'] = snapshot(bound_files)
        report['implementationContextHashes'] = snapshot([p for p in context_files if p.exists()])
        report['contextHashMeaning'] = 'Binds the surrounding implementation inspected with this receipt; these files are not proved by the handwritten Gaussian identities.'
        report['tools'] = {'sawPath': str(SAW), 'sawSha256': sha(SAW),
                           'sawVersion': subprocess.check_output([str(SAW), '--version'], text=True, stderr=subprocess.STDOUT).strip()}
        z3 = Path(shutil.which('z3', path=ENV['PATH'])).resolve()
        report['tools'].update({'z3Path': str(z3), 'z3Sha256': sha(z3), 'z3Version': subprocess.check_output([str(z3), '--version'], text=True, stderr=subprocess.STDOUT).strip()})
        positive = invoke(HERE / 'gaussian.saw', 'gaussian')
        positive['expectedTheorems'] = 5
        positive['accepted'] = positive['returncode'] == 0 and not positive['timedOut'] and valid_summary(positive['summary'], 5)
        report['gaussian'] = positive
        cell = invoke(HERE / 'cell.saw', 'cell')
        cell['expectedTheorems'] = 2
        cell['accepted'] = cell['returncode'] == 0 and not cell['timedOut'] and valid_summary(cell['summary'], 2)
        report['cell'] = cell
        fiml = invoke(HERE / 'fiml-cell.saw', 'fiml-cell')
        fiml['expectedTheorems'] = 2
        fiml['accepted'] = fiml['returncode'] == 0 and not fiml['timedOut'] and valid_summary(fiml['summary'], 2)
        report['fimlCell'] = fiml
        negative = invoke(HERE / 'negative-gaussian.saw', 'negative-gaussian')
        negative['counterexampleObserved'] = counterexample(negative)
        report['negativeGaussian'] = negative
        # Lower a temporary mutated production copy, then require native refutation.
        negative_dir = OUT / 'negative-cell'
        negative_dir.mkdir(exist_ok=True)
        source = Path(source_contract['source']['file']).read_text()
        target = 'if (!source.observed[j * n + i]) numeric[j * n + i] = replacement;'
        if source.count(target) != 1:
            raise RuntimeError('Actual source mutation target changed; review the control.')
        mutated = source.replace(target, target.replace('!source.observed', 'source.observed'))
        (negative_dir / 'numeric-imputation.ts.txt').write_text(mutated)
        subprocess.run(['node', 'source-contract.mjs', str(negative_dir / 'numeric-imputation.ts.txt'), str(negative_dir)], cwd=HERE, check=True, capture_output=True)
        shutil.copyfile(HERE / 'cell.saw', negative_dir / 'cell.saw')
        bad_cell = invoke(negative_dir / 'cell.saw', 'negative-cell', negative_dir)
        bad_cell['counterexampleObserved'] = counterexample(bad_cell)
        report['negativeCell'] = bad_cell
        negative_fiml_dir = OUT / 'negative-fiml-cell'
        negative_fiml_dir.mkdir(exist_ok=True)
        fiml_source = Path(fiml_contract['source']['file']).read_text()
        target_fiml = 'value ?? model.means[j]'
        if fiml_source.count(target_fiml) != 1:
            raise RuntimeError('FIML nullish mutation target changed; review the control.')
        (negative_fiml_dir / 'maximum-likelihood.ts.txt').write_text(fiml_source.replace(target_fiml, 'value || model.means[j]'))
        subprocess.run(['node', 'source-fiml.mjs', str(negative_fiml_dir / 'maximum-likelihood.ts.txt'), str(negative_fiml_dir)], cwd=HERE, check=True, capture_output=True)
        shutil.copyfile(HERE / 'fiml-cell.saw', negative_fiml_dir / 'fiml-cell.saw')
        bad_fiml = invoke(negative_fiml_dir / 'fiml-cell.saw', 'negative-fiml-cell', negative_fiml_dir)
        bad_fiml['counterexampleObserved'] = counterexample(bad_fiml)
        report['negativeFimlCell'] = bad_fiml
        report['negativeArtifactHashes'] = snapshot([p for folder in [negative_dir, negative_fiml_dir] for p in sorted(folder.iterdir()) if p.is_file()])
        # Capability probe retained separately; failure is never called a proof.
        float_library = SAW.parent.parent / 'lib/Float.cry'
        if not float_library.exists():
            float_library = DEFAULT_SAW.parent.parent.parent / 'saw-1.6-macos-15-ARM64/lib/Float.cry'
        probe = OUT / 'float-probe.saw'
        probe.write_text('enable_experimental;\nimport ' + json.dumps(str(float_library)) + ';\nlet main : TopLevel () = do {\n  p <- prove_print z3 {{ \\(x : Float64) -> x =.= x }};\n  return ();\n};\n')
        float_run = invoke(probe, 'float-probe')
        float_run['librarySha256'] = sha(float_library)
        float_run['libraryPath'] = str(float_library)
        float_run['scriptSha256'] = sha(probe)
        float_run['scriptPath'] = str(probe.relative_to(ROOT))
        float_run['classification'] = 'unsupported-native-symbolic-Float-probe' if 'Unimplemented: =.=' in (ROOT / float_run['log']).read_text() else 'inspect-log'
        report['floatCapabilityProbe'] = float_run
        report['sourceAndModelsUnchanged'] = current(report['boundHashes'])
        report['contextUnchanged'] = current(report['implementationContextHashes'])
        report['status'] = 'passed' if (positive['accepted'] and cell['accepted'] and fiml['accepted'] and negative['counterexampleObserved']
            and bad_cell['counterexampleObserved'] and bad_fiml['counterexampleObserved'] and report['sourceAndModelsUnchanged'] and report['contextUnchanged']) else 'failed'
    except Exception as error:
        report['status'] = 'failed'
        report['error'] = f'{type(error).__name__}: {error}'
    report['completedAtUtc'] = datetime.now(timezone.utc).isoformat()
    report_path.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'status': report['status'], 'report': str(report_path), 'error': report.get('error')}))
    return 0 if report['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
