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

function makeSource(t, version = '1.2.3', pin = version) {
  const root = tmp(t);
  write(root, { 'pyproject.toml': `[project]\nname = "x"\nversion = "${version}"\n` });
  write(path.join(root, 'marketplace-plugin'), pluginFiles(version, pin));
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
  const g = (...a) => execFileSync('git', ['-C', source, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { stdio: 'pipe' });
  g('init');
  g('add', '-A');
  g('commit', '-m', 'x');
  g('tag', 'v1.2.3');
  write(path.join(source, 'marketplace-plugin'), { 'README.md': 'changed after the tag' });
  const root = makeMarketplace(t);
  sync({ source, ref: 'v1.2.3', root, log: quiet });
  const marker = fs.readFileSync(path.join(root, 'plugins', 'redactor', 'GENERATED.md'), 'utf8');
  assert.match(marker, /ref v1\.2\.3, commit [0-9a-f]{40}/);
  assert.match(fs.readFileSync(path.join(root, 'plugins', 'redactor', 'README.md'), 'utf8'), /1\.2\.3/);
});

test('refuses a tag holding another version', (t) => {
  const source = makeSource(t);
  const g = (...a) => execFileSync('git', ['-C', source, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { stdio: 'pipe' });
  g('init');
  g('add', '-A');
  g('commit', '-m', 'x');
  g('tag', 'v9.9.9');
  assert.throws(() => sync({ source, ref: 'v9.9.9', root: makeMarketplace(t), log: quiet }), /tag v9\.9\.9 holds version 1\.2\.3/);
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
