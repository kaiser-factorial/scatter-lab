import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
export const fimlSourcePath = path.resolve(here, '../../../src/lib/efa/maximum-likelihood.ts');
const assert = (ok, message) => { if (!ok) throw new Error(message); };
export function extractFimlContract(source, filename = fimlSourcePath) {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  assert(!file.parseDiagnostics.length, 'Source must parse.');
  const fn = file.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'createConditionalProjector');
  assert(fn?.body, 'Missing createConditionalProjector.');
  const closure = fn.body.statements.filter(ts.isReturnStatement).at(-1)?.expression;
  assert(closure && ts.isArrowFunction(closure) && ts.isBlock(closure.body), 'Expected conditional projection closure.');
  const output = closure.body.statements.filter(ts.isReturnStatement).at(-1)?.expression;
  assert(output && ts.isObjectLiteralExpression(output), 'Expected projection result object.');
  const property = output.properties.find(node => ts.isPropertyAssignment(node) && node.name.getText(file) === 'means');
  const returned = property?.initializer;
  assert(returned && ts.isCallExpression(returned) && returned.expression.getText(file) === 'values.map', 'Expected returned completion map.');
  const callback = returned.arguments[0];
  assert(ts.isArrowFunction(callback) && ts.isBinaryExpression(callback.body), 'Expected one expression in the completion callback.');
  const body = callback.body;
  assert(body.left.getText(file) === 'value' && callback.parameters[0].name.getText(file) === 'value', 'Observed branch must return the original callback value.');
  const nullish = body.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken;
  const truthy = body.operatorToken.kind === ts.SyntaxKind.BarBarToken;
  assert(nullish || truthy, 'Unsupported completion branch operator.');
  const condition = nullish ? 'present' : '(present && (original != 0) && (original != 0x8000000000000000))';
  const generated = `module FimlCellContract where\n\n// Source-derived branch. The calculated fallback is an opaque payload.\ncellWrite : Bit -> [64] -> [64] -> [64]\ncellWrite present original calculated = if ${condition} then original else calculated\nproperty preservesObserved present original calculated = present ==> (cellWrite present original calculated == original)\nproperty fillsMissing present original calculated = (~present) ==> (cellWrite present original calculated == calculated)\n`;
  return { generated, source: { file: filename, sha256: crypto.createHash('sha256').update(source).digest('hex'),
    function: 'createConditionalProjector', sourceLine: file.getLineAndCharacterOfPosition(body.getStart(file)).line + 1,
    operator: nullish ? '??' : '||' },
    scope: 'The final mapped cell branch preserves any present observed payload, including zero. The calculated fallback is unconstrained; no Gaussian calculation or full function equivalence is proved.',
    trusted: ['TypeScript AST recognizer and lowering', 'Inputs are finite Numbers or null', 'Nullish coalescing returns its left operand when nonnull', 'Ordinary standard Array.map and no asynchronous mutation'] };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const filename = process.argv[2] ?? fimlSourcePath;
  const contract = extractFimlContract(fs.readFileSync(filename, 'utf8'), filename);
  const out = path.resolve(process.argv[3] ?? here);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'FimlCellContract.cry'), contract.generated);
  fs.writeFileSync(path.join(out, 'fiml-source-contract.json'), JSON.stringify(contract, null, 2) + '\n');
}
