import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyNumericalReport, lintSignature, addedLintSignatures } from './contracts.mjs';
import { currentPackageBuild } from './package-build.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const report = () => ({ results: [{ status: 'passed', checks: [{ error: 1e-8, limit: 1e-5, passed: true }] }] });
test('a complete finite numerical result passes its exact denominator', () => assert.doesNotThrow(() => verifyNumericalReport(report(), 1, 1)));
test('an empty filtered matrix cannot pass vacuously', () => assert.throws(() => verifyNumericalReport({ results: [] }, 1, 1), /Coverage/));
test('a missing scalar check cannot hide behind a passing group', () => assert.throws(() => verifyNumericalReport({ results: [{ status: 'passed', checks: [] }] }, 1, 1), /Coverage/));
test('a stale passed flag does not override out-of-bound or nonfinite numbers', () => {
  for (const value of [1, Infinity, NaN, null]) {
    const candidate = report(); candidate.results[0].checks[0].error = value;
    assert.throws(() => verifyNumericalReport(candidate, 1, 1), /failed|nonfinite/);
  }
});
test('an error result cannot pass with otherwise acceptable values', () => { const candidate = report(); candidate.results[0].status = 'native-error'; assert.throws(() => verifyNumericalReport(candidate, 1, 1), /failed/); });
test('lint signatures ignore checkout paths and diagnostic source-frame line moves', () => {
  const message = path => ({ ruleId: 'react-hooks/set-state-in-effect', severity: 2, message: `A useful diagnostic\n\n${path}:100:4\n  100 | some source` });
  assert.equal(lintSignature('/tmp/base', '/tmp/base/src/a.ts', message('/tmp/base/src/a.ts')), lintSignature('/workspace', '/workspace/src/a.ts', { ...message('/workspace/src/a.ts'), message: 'A useful diagnostic\n\n/workspace/src/a.ts:201:8\n  201 | shifted source' }));
});
test('fixing an unrelated finding cannot pay for a new lint finding', () => {
  const old = JSON.stringify(['src/old.ts','rule',2,'old']), fresh = JSON.stringify(['src/new.ts','rule',2,'new']);
  assert.equal(addedLintSignatures(new Map([[old, 3]]), new Map([[fresh, 1]])).length, 1);
});
test('adding a second occurrence of an existing diagnostic is a regression', () => {
  const signature = JSON.stringify(['src/a.ts','rule',2,'diagnostic']);
  assert.equal(addedLintSignatures(new Map([[signature, 1]]), new Map([[signature, 2]]))[0].baselineCount, 1);
  assert.deepEqual(addedLintSignatures(new Map([[signature, 2]]), new Map([[signature, 1]])), []);
});
test('the numerical runner rejects a stale library build before executing retained JS', () => {
  const root = mkdtempSync(join(tmpdir(), 'stats-stale-build-'));
  try {
    mkdirSync(join(root, 'src')); mkdirSync(join(root, 'dist'));
    const source = 'export const version = 1;';
    writeFileSync(join(root, 'src/index.ts'), source);
    writeFileSync(join(root, 'dist/build-manifest.json'), JSON.stringify({ format: 'scatterlab-stats-build/1', sourceHashes: { 'src/index.ts': createHash('sha256').update(source).digest('hex') } }));
    assert.equal(Object.keys(currentPackageBuild(root)).length, 2);
    writeFileSync(join(root, 'src/index.ts'), 'export const version = 2;');
    assert.throws(() => currentPackageBuild(root), /build is stale/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
