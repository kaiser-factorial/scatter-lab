import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintSignature, addedLintSignatures } from './contracts.mjs';

const frontend = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const repository = resolve(frontend, '..');
const output = resolve(process.env.CI_ARTIFACT_DIR ?? join(frontend, '.ci-artifacts'), 'lint');
mkdirSync(output, { recursive: true });
const requested = process.env.CI_BASE_SHA || process.argv[2] || 'HEAD';
if (/^0+$/.test(requested)) throw new Error('A real base commit is required; the all-zero initial-push SHA is not a baseline.');
const base = execFileSync('git', ['rev-parse', '--verify', `${requested}^{commit}`], { cwd: repository, encoding: 'utf8' }).trim();
const temporary = mkdtempSync(join(tmpdir(), 'scatter-lint-base-'));
const ignores = [
  '.ci-artifacts/**',
  'scripts/efa-reference/congruence/attempts/**',
  'scripts/efa-reference/formal/evidence/**',
];
function lint(directory) {
  const command = [join(frontend, 'node_modules/eslint/bin/eslint.js'), '.', '--format', 'json', ...ignores.flatMap(pattern => ['--ignore-pattern', pattern])];
  const result = spawnSync(process.execPath, command, { cwd: directory, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120000 });
  if (result.error || ![0, 1].includes(result.status)) throw new Error(`eslint could not complete: ${result.error ?? result.stderr}`);
  const files = JSON.parse(result.stdout);
  if (!Array.isArray(files)) throw new Error('eslint JSON output must be an array');
  const signatures = new Map();
  for (const file of files) for (const message of file.messages) {
    const key = lintSignature(realpathSync(directory), file.filePath, message);
    signatures.set(key, (signatures.get(key) ?? 0) + 1);
  }
  return { files, signatures };
}
try {
  const archive = join(temporary, 'base.tar');
  const paths = execFileSync('git', ['ls-tree', '-r', '--name-only', `${base}:frontend`], { cwd: repository, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim().split('\n').filter(path => /\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/.test(path) || path.endsWith('package.json'));
  // Archive lintable sources, not large benchmark matrices/images. Stream the
  // archive directly to disk so source count cannot overflow a stdout buffer.
  execFileSync('git', ['archive', `--output=${archive}`, `${base}:frontend`, '--', ...paths], { cwd: repository });
  const checkout = join(temporary, 'frontend'); mkdirSync(checkout);
  execFileSync('tar', ['-xf', archive, '-C', checkout]);
  symlinkSync(join(frontend, 'node_modules'), join(checkout, 'node_modules'), 'dir');
  // Use each revision's committed configuration with the same currently pinned
  // eslint toolchain. Line moves do not hide newly introduced diagnostic counts.
  const before = lint(checkout), after = lint(frontend);
  const added = addedLintSignatures(before.signatures, after.signatures);
  const summary = { base, status: added.length ? 'failed' : 'passed', qualification: 'No increases in normalized file/rule/severity/message multiplicities versus explicit Git base. Existing findings remain visible; no global count allowance.', ignores, baselineDiagnostics: before.files.reduce((sum, f) => sum + f.messages.length, 0), currentDiagnostics: after.files.reduce((sum, f) => sum + f.messages.length, 0), added };
  writeFileSync(join(output, 'base.json'), JSON.stringify(before.files, null, 2) + '\n');
  writeFileSync(join(output, 'current.json'), JSON.stringify(after.files, null, 2) + '\n');
  writeFileSync(join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
  if (added.length) process.exitCode = 1;
} finally { rmSync(temporary, { recursive: true, force: true }); }
