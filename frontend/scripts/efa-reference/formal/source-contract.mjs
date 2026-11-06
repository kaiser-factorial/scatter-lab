import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const sourcePath = path.resolve(here, '../../../../packages/statistics/src/internal/efa/numeric-imputation.ts');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const assert = (ok, message) => { if (!ok) throw new Error(message); };

/** Narrow source recognizer: copy + the only numeric element write. */
export function extractCellContract(source, filename = sourcePath) {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  assert(!file.parseDiagnostics.length, 'Source must parse without diagnostics.');
  const fn = file.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'completeNumericSample');
  assert(fn?.body, 'Missing completeNumericSample function.');
  const compact = n => n.getText(file).replace(/\s+/g, '');
  let copy = false;
  const writes = [];
  function walk(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'numeric') {
      assert(compact(node.initializer) === 'values.slice()', 'Completion must initialize a copied numeric array.');
      copy = true;
    }
    if (ts.isIdentifier(node) && node.text === 'numeric') {
      const p = node.parent;
      assert((ts.isVariableDeclaration(p) && p.name === node) ||
        (ts.isElementAccessExpression(p) && p.expression === node) ||
        ts.isShorthandPropertyAssignment(p), 'Unsupported numeric alias/call/reference.');
    }
    if (ts.isBinaryExpression(node) && ts.isElementAccessExpression(node.left) && compact(node.left.expression) === 'numeric') {
      assert(node.operatorToken.kind === ts.SyntaxKind.EqualsToken, 'Only direct cell assignments are supported.');
      assert(compact(node.right) === 'replacement', 'Cell replacement must be the computed replacement identifier.');
      assert(ts.isExpressionStatement(node.parent) && ts.isIfStatement(node.parent.parent), 'Every numeric write must have an immediate mask guard.');
      const guard = node.parent.parent.expression;
      const negated = ts.isPrefixUnaryExpression(guard) && guard.operator === ts.SyntaxKind.ExclamationToken;
      const observed = negated ? guard.operand : guard;
      assert(ts.isElementAccessExpression(observed) && compact(observed.expression) === 'source.observed', 'Guard must read the original observed mask.');
      assert(compact(observed.argumentExpression) === compact(node.left.argumentExpression), 'Mask and numeric write must use the same cell index.');
      writes.push({ writeOnMissing: negated, index: compact(node.left.argumentExpression),
        sourceLine: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1 });
    }
    ts.forEachChild(node, walk);
  }
  walk(fn);
  assert(copy && writes.length === 1, 'Expected exactly one copied-array numeric write.');
  const condition = writes[0].writeOnMissing ? 'mask == 0' : 'mask != 0';
  const generated = `module NumericCellContract where\n\n// Source-derived conditional cell update; Number payloads are uninterpreted bits.\ncellWrite : [8] -> [64] -> [64] -> [64]\ncellWrite mask original replacement = if ${condition} then replacement else original\n\nproperty preservesObserved mask original replacement = (mask != 0) ==> (cellWrite mask original replacement == original)\nproperty fillsMissing mask original replacement = (mask == 0) ==> (cellWrite mask original replacement == replacement)\n`;
  return { generated, source: { file: filename, sha256: sha(source), function: 'completeNumericSample', ...writes[0] },
    trusted: ['TypeScript AST recognizer and lowering', 'Uint8Array truthiness equals nonzero', 'Float64 payload copy preserves values', 'Standard unmodified slice and ordinary arrays'],
    scope: 'The single guarded numeric-cell write preserves an observed payload and replaces a missing payload. No theorem about replacement calculation, array-loop execution, optimizer, compiler, or R equivalence.' };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const source = fs.readFileSync(process.argv[2] ?? sourcePath, 'utf8');
  const contract = extractCellContract(source, process.argv[2] ?? sourcePath);
  const out = path.resolve(process.argv[3] ?? here);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'NumericCellContract.cry'), contract.generated);
  fs.writeFileSync(path.join(out, 'source-contract.json'), JSON.stringify(contract, null, 2) + '\n');
}
