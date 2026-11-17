import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';
import { discoverRepos } from '../src/services/discovery';
import { findLogo, scanLanguages } from '../src/services/languageScanner';

const root = mkdtempSync(path.join(os.tmpdir(), 'repoboard-'));
after(() => rmSync(root, { recursive: true, force: true }));

const dir = (...p: string[]) => {
  const d = path.join(root, ...p);
  mkdirSync(d, { recursive: true });
  return d;
};

test('discovers repos, stops at .git, skips ignored/hidden dirs and symlinks, respects depth', async () => {
  dir('code', 'alpha', '.git');
  dir('code', 'alpha', 'packages', 'nested', '.git'); // inside a repo: not reported separately
  dir('code', 'group', 'beta', '.git');
  writeFileSync(path.join(dir('code', 'worktree'), '.git'), 'gitdir: ../alpha/.git/worktrees/w'); // .git file
  dir('code', 'node_modules', 'dep', '.git');
  dir('code', '.hidden', 'secret', '.git');
  dir('code', 'a', 'b', 'c', 'too-deep', '.git');
  let linked = false;
  try {
    symlinkSync(dir('code', 'group'), path.join(root, 'code', 'link-to-group'), 'junction');
    linked = true;
  } catch {
    // Symlinks may need privileges; the rest of the test still runs.
  }

  const found = (await discoverRepos([path.join(root, 'code')], { maxDepth: 3, ignoreDirs: ['node_modules'] })).map((p) => path.relative(root, p).replace(/\\/g, '/'));
  assert.deepEqual(found.sort(), ['code/alpha', 'code/group/beta', 'code/worktree']);
  if (linked) assert.ok(!found.some((f) => f.includes('link-to-group')));

  const deeper = await discoverRepos([path.join(root, 'code')], { maxDepth: 5, ignoreDirs: [] });
  assert.ok(deeper.some((p) => p.endsWith('too-deep')));
  assert.ok(deeper.some((p) => p.includes('node_modules')));

  assert.deepEqual(await discoverRepos([path.join(root, 'does-not-exist')], { maxDepth: 3, ignoreDirs: [] }), []);
});

test('the scan root itself can be a repo', async () => {
  const solo = dir('solo');
  dir('solo', '.git');
  assert.deepEqual(await discoverRepos([solo], { maxDepth: 2, ignoreDirs: [] }), [solo]);
});

test('language scan weighs by bytes and honours the ignore list', async () => {
  const p = dir('langs');
  writeFileSync(path.join(p, 'a.ts'), 'x'.repeat(3000));
  writeFileSync(path.join(p, 'b.css'), 'x'.repeat(1000));
  writeFileSync(path.join(p, 'data.json'), 'x'.repeat(50000));
  writeFileSync(path.join(dir('langs', 'node_modules'), 'huge.js'), 'x'.repeat(90000));
  const shares = await scanLanguages(p, { ignoreDirs: ['node_modules'], maxFiles: 100 });
  assert.deepEqual(shares.map((s) => [s.name, s.percent]), [['TypeScript', 75], ['CSS', 25]]);
});

test('logo lookup returns a data URI and ignores oversized files', async () => {
  const p = dir('logo');
  assert.equal(await findLogo(p), undefined);
  writeFileSync(path.join(p, 'logo.svg'), 'x'.repeat(200 * 1024));
  assert.equal(await findLogo(p), undefined);
  writeFileSync(path.join(p, 'icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  assert.match((await findLogo(p))!, /^data:image\/png;base64,/);
});
