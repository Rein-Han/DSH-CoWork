#!/usr/bin/env node
/**
 * Test runner that works inside a confined parent process.
 *
 * `node --test` with default isolation spawns one child per test file and
 * captures its stdio through pipes; `tsx` additionally spawns esbuild's service.
 * A restricted token allows neither, so this runner:
 *   1. compiles `src/**` and `test/**` to `dist-test/` (one `rootDir` for both);
 *   2. mirrors the repository's static surface (manifests, docs, skills) into the
 *      build directory, because the tests read those through paths relative to
 *      their own file;
 *   3. runs the emitted JavaScript in one process with `--test-isolation=none`.
 *
 * Usage: node scripts/run-tests.mjs [--keep] [--filter <substring>]
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const keep = process.argv.includes('--keep');
const filterAt = process.argv.indexOf('--filter');
const filter = filterAt === -1 ? undefined : process.argv[filterAt + 1];

const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
rmSync(join(root, 'dist-test'), { recursive: true, force: true });
const build = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.test.json'], { cwd: root, stdio: 'inherit' });
// The upstream test files carry pre-existing type looseness that `tsx` never
// type-checked; emission continues past those diagnostics. Only a build that
// produced no output is fatal, and `npm run build` (which is strict) must still
// cover `src/**` on its own.
if (!existsSync(join(root, 'dist-test', 'test'))) {
  console.error('test build produced no output');
  process.exit(build.status ?? 1);
}

const out = join(root, 'dist-test');
for (const asset of [
  'package.json',
  'README.md',
  'README.zh-CN.md',
  'CHANGELOG.md',
  '.gitignore',
  '.gitattributes',
  'CONTRIBUTING.md',
  'KNOWN_ISSUES.md',
  'SECURITY.md',
  'SUPPORT.md',
  'docs',
  'skill',
  'packages',
  'LICENSE',
  'NOTICE',
]) {
  const source = join(root, asset);
  if (existsSync(source)) cpSync(source, join(out, asset), { recursive: true });
}

const testFiles = readdirSync(join(out, 'test'))
  .filter((entry) => entry.endsWith('.test.js'))
  .filter((entry) => filter === undefined || entry.includes(filter))
  .map((entry) => join('dist-test', 'test', entry));

const run = spawnSync(process.execPath, ['--test', '--test-isolation=none', ...testFiles], {
  cwd: root,
  stdio: 'inherit',
});

if (!keep) rmSync(out, { recursive: true, force: true });
process.exit(run.status ?? 1);

