import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
// Keep this Node-only contract outside Vitest's *.test.* discovery.
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const configuration = JSON.parse(readFileSync(fileURLToPath(new URL('../../vercel.json', import.meta.url)), 'utf8'));
const rootManifest = JSON.parse(readFileSync(fileURLToPath(new URL('../../../package.json', import.meta.url)), 'utf8'));
const workspaceConfiguration = readFileSync(fileURLToPath(new URL('../../../pnpm-workspace.yaml', import.meta.url)), 'utf8');
const manager = rootManifest.packageManager;

// Verify the deployment bootstrap pin, then exercise its actual pnpm arguments
// offline. The fixture uses the already installed pnpm executable; downloading
// pnpm through npx is deliberately left to the clean deployment build check.
test('Vercel installs and builds the complete workspace using one frozen pnpm lockfile', { timeout: 45000 }, () => {
  assert.match(manager, /^pnpm@\d+\.\d+\.\d+$/);
  assert.equal(configuration.installCommand, `npx --yes ${manager} -C .. install --frozen-lockfile --prod=false`);
  assert.equal(configuration.buildCommand, `npx --yes ${manager} run build`);
  assert.equal(configuration.framework, 'nextjs');
  assert.match(workspaceConfiguration, /^enablePrePostScripts: true$/m, 'The frontend prebuild must run under pnpm.');

  const root = mkdtempSync(join(tmpdir(), 'scatter-vercel-install-'));
  const frontend = join(root, 'frontend');
  const executingManager = process.env.npm_execpath;
  const pnpmPath = executingManager && /^pnpm(?:\.(?:c?js|mjs|exe))?$/.test(basename(executingManager))
    ? executingManager : 'pnpm';
  const pnpmCommand = /\.(?:c?js|mjs)$/.test(pnpmPath) ? process.execPath : pnpmPath;
  const pnpmPrefix = pnpmCommand === process.execPath ? [pnpmPath] : [];
  const env = { ...process.env, NODE_ENV: 'production', CI: 'true',
    npm_config_offline: 'true', npm_config_store_dir: join(root, '.pnpm-store'),
    npm_config_manage_package_manager_versions: 'false', npm_config_pm_on_fail: 'ignore' };
  if (pnpmPath !== 'pnpm') env.PATH = `${dirname(pnpmPath)}${delimiter}${env.PATH ?? ''}`;
  delete env.NODE_PATH;
  const put = (path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof content === 'string' ? content : JSON.stringify(content));
  };
  const run = (args, cwd = root) => spawnSync(pnpmCommand, [...pnpmPrefix, ...args], {
    cwd, env, encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024,
  });
  const passed = result => assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
  const runConfigured = command => run(command.slice(`npx --yes ${manager} `.length).split(' '), frontend);
  try {
    put('package.json', { name: 'deployment-fixture', private: true, packageManager: manager });
    // The production workspace paths/configuration are retained. Avoid registry
    // resolution of pnpm itself: its running version is checked explicitly.
    put('pnpm-workspace.yaml', `${workspaceConfiguration}\npmOnFail: ignore\n`);
    const version = run(['--version']);
    passed(version);
    assert.equal(version.stdout.trim(), manager.slice('pnpm@'.length), 'Run contracts with the pinned pnpm version.');

    put('packages/statistics/package.json', { name: '@scatterlab/stats', version: '0.0.0', private: true,
      type: 'module', exports: './dist/index.js', scripts: { build: 'node scripts/build.mjs' },
      devDependencies: { typescript: 'file:../../fixtures/typescript' } });
    put('fixtures/typescript/package.json', { name: 'typescript', version: '0.0.0-test', type: 'module', exports: './index.js' });
    put('fixtures/typescript/index.js', 'export default { fixtureCompiler: true };\n');
    put('packages/statistics/scripts/build.mjs', `import ts from 'typescript';
import { mkdirSync, writeFileSync } from 'node:fs';
if (!ts.fixtureCompiler) throw new Error('Unexpected compiler fixture.');
mkdirSync(new URL('../dist/', import.meta.url), { recursive: true });
writeFileSync(new URL('../dist/index.js', import.meta.url), 'export const built = true;\\n');
`);
    for (const name of ['react-plotly-factory']) {
      put(`frontend/vendor/${name}/package.json`, { name: `@scatterlab/${name}`, version: '0.0.0', private: true,
        type: 'module', exports: './index.js' });
      put(`frontend/vendor/${name}/index.js`, `export default '${name}';\n`);
    }
    const frontendManifest = { name: 'frontend', private: true, type: 'module',
      dependencies: { '@scatterlab/stats': 'workspace:*',
        '@scatterlab/react-plotly-factory': 'workspace:*' },
      devDependencies: { typescript: 'file:../fixtures/typescript' },
      scripts: { prebuild: 'pnpm --filter @scatterlab/stats run build', build: 'node build.mjs' } };
    put('frontend/package.json', frontendManifest);
    put('frontend/build.mjs', `import ts from 'typescript';
import { built } from '@scatterlab/stats';
import plotly from '@scatterlab/react-plotly-factory';
import { writeFileSync } from 'node:fs';
if (!ts.fixtureCompiler || !built || plotly !== 'react-plotly-factory') {
  throw new Error('A workspace build dependency is missing.');
}
writeFileSync('build.json', JSON.stringify({ built, manager: process.env.npm_config_user_agent }));
`);
    // Local file/workspace dependencies need no registry or populated store.
    passed(run(['install', '--lockfile-only', '--ignore-scripts', '--no-frozen-lockfile', '--prod=false']));
    const lockfile = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8');
    passed(runConfigured(configuration.installCommand));
    passed(runConfigured(configuration.buildCommand));
    const built = JSON.parse(readFileSync(join(frontend, 'build.json'), 'utf8'));
    assert.equal(built.built, true);
    assert.match(built.manager, new RegExp(`^pnpm/${manager.slice('pnpm@'.length).replaceAll('.', '\\.')}\\b`));
    assert.equal(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'), lockfile, 'Frozen deployment must not rewrite the lockfile.');
    assert.equal(realpathSync(join(frontend, 'node_modules/@scatterlab/stats')), realpathSync(join(root, 'packages/statistics')));
    assert.equal(realpathSync(join(frontend, 'node_modules/typescript')), realpathSync(join(root, 'packages/statistics/node_modules/typescript')));
    for (const path of ['package-lock.json', 'frontend/package-lock.json', 'frontend/pnpm-lock.yaml', 'packages/statistics/pnpm-lock.yaml']) {
      assert.equal(existsSync(join(root, path)), false, `Unexpected second dependency graph: ${path}`);
    }

    frontendManifest.dependencies['@scatterlab/stats'] = 'workspace:^';
    put('frontend/package.json', frontendManifest);
    const stale = runConfigured(configuration.installCommand);
    assert.notEqual(stale.status, 0, 'Deployment must reject an out-of-date workspace lockfile.');
    assert.match(`${stale.stdout}\n${stale.stderr}`, /OUTDATED_LOCKFILE|frozen.lockfile/i);
    assert.equal(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'), lockfile);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
