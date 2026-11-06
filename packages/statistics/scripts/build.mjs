import ts from 'typescript';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = resolve(root, 'tsconfig.json');
const config = ts.readConfigFile(configPath, ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
const program = ts.createProgram(parsed.fileNames, parsed.options);
const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
if (diagnostics.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => root, getCanonicalFileName: path => path, getNewLine: () => '\n',
  }));
  process.exit(1);
}
rmSync(resolve(root, 'dist'), { recursive: true, force: true });
const emitted = program.emit();
if (emitted.emitSkipped) throw new Error('Statistics package emit was skipped.');
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? files(resolve(directory, entry.name)) : [resolve(directory, entry.name)]);
}
// TypeScript's bundler resolution accepts extensionless source imports. Native
// ESM consumers and NodeNext declarations require the emitted .js extension.
for (const path of files(resolve(root, 'dist'))) {
  if (!path.endsWith('.js') && !path.endsWith('.d.ts')) continue;
  const text = readFileSync(path, 'utf8');
  writeFileSync(path, text.replace(/((?:from\s*|import\s*\(|import\s*)["'])(\.{1,2}\/[^"']+)(["'])/g,
    (match, before, target, after) => /\.(?:js|mjs|cjs|json)$/.test(target) ? match : `${before}${target}.js${after}`));
}
const sourceHashes = Object.fromEntries(parsed.fileNames.sort().map(path => [relative(root, path).replaceAll('\\', '/'), createHash('sha256').update(readFileSync(path)).digest('hex')]));
writeFileSync(resolve(root, 'dist/build-manifest.json'), JSON.stringify({ format: 'scatterlab-stats-build/1', version: '0.1.0', typescript: ts.version, sourceHashes }, null, 2) + '\n');
console.log(`Built @scatterlab/stats: ${parsed.fileNames.length} TypeScript sources, native ESM and declarations.`);
