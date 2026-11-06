import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { extractCellContract, sourcePath } from './source-contract.mjs';
const source = fs.readFileSync(sourcePath, 'utf8');
const guard = 'if (!source.observed[j * n + i]) numeric[j * n + i] = replacement;';

test('derives a mask branch from the actual production write', () => {
  const result = extractCellContract(source);
  assert.equal(result.source.writeOnMissing, true);
  assert.match(result.generated, /if mask == 0 then replacement else original/);
});
test('reversed production guard changes the generated branch, for native counterexample control', () => {
  const result = extractCellContract(source.replace(guard, guard.replace('!source.observed', 'source.observed')));
  assert.equal(result.source.writeOnMissing, false);
  assert.match(result.generated, /if mask != 0 then replacement else original/);
});
test('rejects aliasing instead of a copied output', () => {
  assert.throws(() => extractCellContract(source.replace('numeric = values.slice()', 'numeric = values')), /copied/);
});
test('rejects a write to a different cell from the mask', () => {
  assert.throws(() => extractCellContract(source.replace(guard, guard.replace('numeric[j * n + i]', 'numeric[j * n + i + 1]'))), /same cell/);
});
test('rejects removal of the observation guard', () => {
  assert.throws(() => extractCellContract(source.replace(guard, 'numeric[j * n + i] = replacement;')), /mask guard/);
});
test('rejects output aliases that could hide writes', () => {
  assert.throws(() => extractCellContract(source.replace('let completedMean = 0', 'const leak = numeric; let completedMean = 0')), /alias/);
});
test('rejects syntax errors and records source changes even if model is unchanged', () => {
  assert.throws(() => extractCellContract(source + '\nfunction broken('), /parse/);
  const normal = extractCellContract(source), comment = extractCellContract(source + '\n// Different source receipt.\n');
  assert.equal(normal.generated, comment.generated);
  assert.notEqual(normal.source.sha256, comment.source.sha256);
});

import { extractFimlContract, fimlSourcePath } from './source-fiml.mjs';
const fimlSource = fs.readFileSync(fimlSourcePath, 'utf8');
test('FIML source lowering preserves observed zero with nullish coalescing', () => {
  const result = extractFimlContract(fimlSource);
  assert.equal(result.source.operator, '??');
  assert.match(result.generated, /if present then original else calculated/);
});
test('FIML truthiness mutation is lowered differently for a native counterexample', () => {
  const result = extractFimlContract(fimlSource.replace('value ?? model.means[j]', 'value || model.means[j]'));
  assert.equal(result.source.operator, '||');
  assert.match(result.generated, /original != 0/);
});
test('FIML source lowering rejects an altered observed branch', () => {
  assert.throws(() => extractFimlContract(fimlSource.replace('value ?? model.means[j]', '(value + 1) ?? model.means[j]')), /original callback value/);
});
