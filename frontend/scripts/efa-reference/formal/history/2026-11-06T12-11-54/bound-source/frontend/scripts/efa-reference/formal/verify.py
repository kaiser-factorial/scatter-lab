#!/usr/bin/env python3
"""Revalidate retained proof evidence against current source; starts no solver."""
import json
from pathlib import Path
import subprocess
from run import HERE, ROOT, sha, current, valid_summary, counterexample


def require(ok, message):
    if not ok:
        raise ValueError(message)


def verify(report):
    require(report.get('status') == 'passed', 'Receipt is not passed.')
    require(report.get('boundHashes') and report.get('implementationContextHashes'), 'Missing source/model hash maps.')
    require(current(report['boundHashes']), 'Source/model/runner receipt is stale.')
    require(current(report['implementationContextHashes']), 'Inspected implementation context is stale.')
    require(report.get('negativeArtifactHashes') and current(report['negativeArtifactHashes']), 'Negative-control source/models changed.')
    require(sha(report['tools']['sawPath']) == report['tools']['sawSha256'], 'SAW executable changed.')
    require(sha(report['tools']['z3Path']) == report['tools']['z3Sha256'], 'Z3 executable changed.')
    probe = report['floatCapabilityProbe']
    require(sha(ROOT / probe['log']) == probe['logSha256'] and sha(ROOT / probe['scriptPath']) == probe['scriptSha256'] and sha(probe['libraryPath']) == probe['librarySha256'], 'Floating capability evidence changed.')
    require(set(report['boundHashes']) == {
        str((HERE / name).relative_to(ROOT)) for name in ['GaussianContracts.cry', 'NumericCellContract.cry',
        'gaussian.saw', 'cell.saw', 'negative-gaussian.saw', 'source-contract.mjs', 'source-fiml.mjs', 'FimlCellContract.cry', 'fiml-cell.saw', 'run.py', 'verify.py']
    } | {'frontend/src/lib/efa/numeric-imputation.ts', 'frontend/src/lib/efa/maximum-likelihood.ts'}, 'Bound source/model set differs from the declared scope.')
    for key, count in [('gaussian', 5), ('cell', 2), ('fimlCell', 2)]:
        item = report[key]
        require(item.get('returncode') == 0 and not item.get('timedOut'), f'{key} native execution did not pass.')
        require(valid_summary(item.get('summary'), count), f'{key} has incorrect theorem results.')
        require(sha(ROOT / item['log']) == item['logSha256'], f'{key} log hash differs.')
        require(sha(ROOT / item['summaryFile']) == item['summarySha256'], f'{key} summary hash differs.')
        require(json.loads((ROOT / item['summaryFile']).read_text()) == item['summary'], f'{key} summary contents differ.')
    for key in ['negativeGaussian', 'negativeCell', 'negativeFimlCell']:
        item = report[key]
        require(sha(ROOT / item['log']) == item['logSha256'], f'{key} log hash differs.')
        require(counterexample(item), f'{key} is not an actual native counterexample.')
    # Regenerate from the live AST without rewriting the retained generated file.
    js = "import fs from 'node:fs'; import {extractCellContract,sourcePath} from './source-contract.mjs'; process.stdout.write(JSON.stringify(extractCellContract(fs.readFileSync(sourcePath,'utf8'))));"
    regenerated = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', js], cwd=HERE, text=True))
    require(regenerated == report['sourceContract'], 'Fresh source lowering differs from retained source contract.')
    require(regenerated['generated'] == (HERE / 'NumericCellContract.cry').read_text(), 'Generated source contract was substituted.')
    fiml_js = "import fs from 'node:fs'; import {extractFimlContract,fimlSourcePath} from './source-fiml.mjs'; process.stdout.write(JSON.stringify(extractFimlContract(fs.readFileSync(fimlSourcePath,'utf8'))));"
    fiml_regenerated = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', fiml_js], cwd=HERE, text=True))
    require(fiml_regenerated == report['fimlSourceContract'], 'Fresh FIML branch lowering differs.')
    require(fiml_regenerated['generated'] == (HERE / 'FimlCellContract.cry').read_text(), 'Generated FIML branch was substituted.')
    return {'status': 'passed', 'nativeTheorems': 9, 'freshSolverRun': False,
            'claim': 'Retained bounded proof evidence matches current bound source, models, native logs and regenerated cell contract.'}


if __name__ == '__main__':
    try:
        print(json.dumps(verify(json.loads((HERE / 'report.json').read_text()))))
    except Exception as error:
        print(json.dumps({'status': 'failed', 'error': f'{type(error).__name__}: {error}'}))
        raise SystemExit(1)
