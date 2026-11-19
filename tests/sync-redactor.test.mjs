// scripts/sync-redactor.mjs, against a throwaway marketplace and a fixture of the plugin's source.
// These need no plugins/redactor/ here: the sync creates it, on the first release.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkVersions, sync, withReadmeRow, marketplaceEntry } from '../scripts/sync-redactor.mjs';

const IMAGE = 'ghcr.io/apra-labs/apra-redactor-mcp';
const quiet = () => {};

function pluginFiles(version = '1.2.3', pin = version, name = 'redactor') {
  return {
    '.claude-plugin/plugin.json': JSON.stringify({
      name, version, description: 'Routes your MCP servers through a proxy. Requires Docker.', keywords: ['pii'],
    }),
    '.mcp.json': JSON.stringify({ mcpServers: { 'apra-redactor': { type: 'http', url: 'http://127.0.0.1:8765/mcp' } } }),
    'README.md': `docker run ${IMAGE}:${pin}\nor ${IMAGE}:${pin}-ner\n`,
    LICENSE: 'Apache License\n',
    'skills/redacted-tools/SKILL.md': 'skill\n',
    'tests/redactor.test.mjs': '// the plugin ships its own tests\n',
  };
}

function asMap(files) {
  return new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)]));
}

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-redactor-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(root, files) {
  for (const [rel, text] of Object.entries(files)) {
    const target = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
}

// git in a throwaway repo, without a shell; identity passed per command (CI runners have none configured)
const gitIn = (dir) => (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { stdio: 'pipe' });

// A committed git checkout of the source: the sync reads only git-tracked content.
function makeSource(t, version = '1.2.3', pin = version) {
  const root = tmp(t);
  write(root, { 'pyproject.toml': `[project]\nname = "x"\nversion = "${version}"\n` });
  write(path.join(root, 'marketplace-plugin'), pluginFiles(version, pin));
  const g = gitIn(root);
  g('init', '-q');
  g('add', '-A');
  g('commit', '-q', '-m', 'x');
  return root;
}

function makeMarketplace(t) {
  const root = tmp(t);
  write(root, {
    '.claude-plugin/marketplace.json': JSON.stringify({ name: 'apra', plugins: [{ name: 'rport', version: '0.2.0' }] }),
    'README.md': '# M\n\n## Plugins\n\n| Plugin | What | Needs |\n|---|---|---|\n| [bitbucket](x) | b | c |\n| [rport](y) | r | s |\n\n## Other\n',
  });
  return root;
}

const readMarket = (root) => JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'marketplace.json'), 'utf8'));

test('first sync creates the folder, the marketplace entry and the README row', (t) => {
  const root = makeMarketplace(t);
  sync({ source: makeSource(t), root, log: quiet });
  for (const f of ['.claude-plugin/plugin.json', '.mcp.json', 'README.md', 'LICENSE', 'GENERATED.md',
    'skills/redacted-tools/SKILL.md', 'tests/redactor.test.mjs']) {
    assert.ok(fs.existsSync(path.join(root, 'plugins', 'redactor', ...f.split('/'))), f);
  }
  const entry = readMarket(root).plugins.find((p) => p.name === 'redactor');
  assert.equal(entry.version, '1.2.3');
  assert.equal(entry.source, './plugins/redactor');
  assert.match(entry.description, /Docker/);
  assert.match(entry.description, /no apra-fleet needed/);
  assert.ok(readMarket(root).plugins.some((p) => p.name === 'rport'), 'other plugins stay');
  const lines = fs.readFileSync(path.join(root, 'README.md'), 'utf8').split('\n');
  const names = lines.filter((l) => l.startsWith('| [')).map((l) => l.slice(3, l.indexOf(']')));
  assert.deepEqual(names, ['bitbucket', 'redactor', 'rport']);
});

test('syncing twice changes nothing, and --check agrees', (t) => {
  const root = makeMarketplace(t);
  const source = makeSource(t);
  sync({ source, root, log: quiet });
  const snapshot = () => [readMarket(root), fs.readFileSync(path.join(root, 'README.md'), 'utf8')];
  const before = snapshot();
  sync({ source, root, log: quiet });
  assert.deepEqual(snapshot(), before);
  assert.equal(sync({ source, root, check: true, log: quiet }).ok, true);
});

test('--check reports a missing plugin without changing anything', (t) => {
  const root = makeMarketplace(t);
  assert.equal(sync({ source: makeSource(t), root, check: true, log: quiet }).ok, false);
  assert.ok(!fs.existsSync(path.join(root, 'plugins')));
});

test('a later release updates in place and removes what the source removed', (t) => {
  const root = makeMarketplace(t);
  sync({ source: makeSource(t, '1.2.3'), root, log: quiet });
  fs.writeFileSync(path.join(root, 'plugins', 'redactor', 'stale.txt'), 'old');
  sync({ source: makeSource(t, '1.3.0'), root, log: quiet });
  assert.equal(readMarket(root).plugins.find((p) => p.name === 'redactor').version, '1.3.0');
  assert.equal(readMarket(root).plugins.filter((p) => p.name === 'redactor').length, 1);
  assert.ok(!fs.existsSync(path.join(root, 'plugins', 'redactor', 'stale.txt')));
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.equal(readme.match(/\[redactor\]/g).length, 1);
});

test('--ref reads the plugin from git and records the commit', (t) => {
  const source = makeSource(t);
  gitIn(source)('tag', 'v1.2.3');
  write(path.join(source, 'marketplace-plugin'), { 'README.md': 'changed after the tag' });
  const root = makeMarketplace(t);
  sync({ source, ref: 'v1.2.3', root, log: quiet });
  const marker = fs.readFileSync(path.join(root, 'plugins', 'redactor', 'GENERATED.md'), 'utf8');
  assert.match(marker, /ref v1\.2\.3, commit [0-9a-f]{40}/);
  assert.match(fs.readFileSync(path.join(root, 'plugins', 'redactor', 'README.md'), 'utf8'), /1\.2\.3/);
});

test('refuses a tag holding another version', (t) => {
  const source = makeSource(t);
  gitIn(source)('tag', 'v9.9.9');
  assert.throws(() => sync({ source, ref: 'v9.9.9', root: makeMarketplace(t), log: quiet }), /tag v9\.9\.9 holds version 1\.2\.3/);
});

test('without --ref only HEAD is read: untracked, ignored and uncommitted files never reach the marketplace', (t) => {
  const source = makeSource(t);
  const plugin = path.join(source, 'marketplace-plugin');
  write(source, { '.gitignore': 'secrets.txt\n' });
  gitIn(source)('add', '.gitignore');
  gitIn(source)('commit', '-q', '-m', 'ignore');
  write(plugin, {
    '.env': 'API_KEY=fake-not-a-real-key-0000\n', // untracked
    'secrets.txt': 'fake-ignored-secret\n', // ignored
    'notes/draft.md': 'untracked draft\n',
    LICENSE: 'edited but not committed\n', // tracked, modified
  });
  const root = makeMarketplace(t);
  const logs = [];
  sync({ source, root, log: (m) => logs.push(m) });
  const dest = path.join(root, 'plugins', 'redactor');
  for (const f of ['.env', 'secrets.txt', 'notes']) assert.ok(!fs.existsSync(path.join(dest, f)), `${f} must not be copied`);
  assert.equal(fs.readFileSync(path.join(dest, 'LICENSE'), 'utf8'), 'Apache License\n', 'committed content, not the working tree');
  const all = JSON.stringify([...fs.readdirSync(dest, { recursive: true })].map(String));
  assert.ok(!all.includes('.env'), all);
  assert.match(fs.readFileSync(path.join(dest, 'GENERATED.md'), 'utf8'), /ref HEAD, commit [0-9a-f]{40}/);
  assert.ok(logs.some((m) => /4 uncommitted, untracked or ignored path\(s\)/.test(m)), logs.join('\n'));
  assert.ok(!logs.join('\n').includes('fake-not-a-real-key'), 'file contents are never logged');
  // --check agrees with what HEAD holds, whatever the working tree has
  assert.equal(sync({ source, root, check: true, log: quiet }).ok, true);
});

test('a source that is not a git checkout is refused, nothing is copied', (t) => {
  const source = tmp(t);
  write(source, { 'pyproject.toml': '[project]\nname = "x"\nversion = "1.2.3"\n' });
  write(path.join(source, 'marketplace-plugin'), pluginFiles());
  const root = makeMarketplace(t);
  assert.throws(() => sync({ source, root, log: quiet }), /cannot read HEAD .* git checkout/);
  assert.ok(!fs.existsSync(path.join(root, 'plugins')));
});

test('version rules', () => {
  assert.equal(checkVersions(asMap(pluginFiles()), '1.2.3'), '1.2.3');
  assert.throws(() => checkVersions(asMap(pluginFiles()), '1.2.4'), /pyproject/);
  assert.throws(() => checkVersions(asMap(pluginFiles('1.2.3', '1.2.2')), '1.2.3'), /does not pin/);
  assert.throws(() => checkVersions(asMap(pluginFiles('1.2.3', '1.2.3', 'other')), '1.2.3'), /name/);
  const both = asMap(pluginFiles());
  both.set('README.md', Buffer.from(`${IMAGE}:1.2.3 and ${IMAGE}:1.2.2`));
  assert.throws(() => checkVersions(both, '1.2.3'), /image tag 1\.2\.2/);
  const uvx = asMap(pluginFiles());
  uvx.set('.mcp.json', Buffer.from(JSON.stringify({ mcpServers: { 'apra-redactor': { command: 'uvx' } } })));
  assert.throws(() => checkVersions(uvx, '1.2.3'), /must connect/);
});

test('helpers', () => {
  assert.throws(() => withReadmeRow('no table'), /plugins table/);
  const entry = marketplaceEntry(asMap(pluginFiles()));
  assert.equal(entry.description, 'Routes your MCP servers through a proxy. Requires Docker; no apra-fleet needed.');
});
