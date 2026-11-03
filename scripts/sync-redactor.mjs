#!/usr/bin/env node
// Copy the redactor plugin from its source repo (Apra-Labs/apra-redactor-mcp, private) into
// plugins/redactor/ and set its version in .claude-plugin/marketplace.json (CLAUDE.md rule 1).
//
//   node scripts/sync-redactor.mjs [SOURCE] [--ref REF] [--check]
//
// SOURCE  a local checkout of apra-redactor-mcp (default: ../apra-redactor-mcp next to this repo)
// --ref   copy the plugin as of this git ref (e.g. v0.1.0) instead of SOURCE's working tree
// --check change nothing; exit 1 if plugins/redactor/ differs from what a sync would write
//
// The plugin folder is marketplace-plugin/ in the source repo. The sync refuses unless its
// plugin.json version, the uvx pin in its .mcp.json and the package version in pyproject.toml
// agree, because the plugin launches exactly that PyPI release. plugins/redactor/tests/ belongs
// to this repo and is kept; everything else in plugins/redactor/ is replaced.
// Zero dependencies; needs Node 18+ and git on PATH. Works from PowerShell and Git Bash.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PLUGIN = 'redactor';
const SRC_DIR = 'marketplace-plugin';
const PACKAGE = 'apra-redactor-mcp';
const KEEP = new Set(['tests']); // owned by this repo, never synced
export const MARKER = 'GENERATED.md';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fail(msg) {
  console.error(`sync-redactor: ${msg}`);
  process.exit(1);
}

function git(cwd, args, opts = {}) {
  return execFileSync('git', ['-C', cwd, ...args], { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

// Text files are written with LF (this repo's .gitattributes), whatever the source checkout used.
function normalize(buf) {
  return buf.includes(0) ? buf : Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
}

function readTree(dir, prefix = '') {
  const out = new Map();
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) for (const [k, v] of readTree(path.join(dir, e.name), rel)) out.set(k, v);
    else if (e.isFile() && !['.DS_Store', 'Thumbs.db'].includes(e.name)) out.set(rel, normalize(fs.readFileSync(path.join(dir, e.name))));
  }
  return out;
}

/** Plugin files (relative path -> Buffer) and the package version, from a working tree or a ref. */
export function readSource(source, ref) {
  const files = new Map();
  let pyproject;
  if (ref) {
    let names;
    try {
      names = git(source, ['ls-tree', '-r', '-z', '--name-only', ref, '--', `${SRC_DIR}/`]).toString('utf8').split('\0').filter(Boolean);
    } catch (e) {
      fail(`cannot read ${ref} in ${source}: ${String(e.stderr || e.message).trim()}`);
    }
    for (const name of names) files.set(name.slice(SRC_DIR.length + 1), normalize(git(source, ['show', `${ref}:${name}`])));
    pyproject = git(source, ['show', `${ref}:pyproject.toml`]).toString('utf8');
  } else {
    const dir = path.join(source, SRC_DIR);
    if (!fs.existsSync(dir)) fail(`${dir} not found: is ${source} a checkout of ${PACKAGE}?`);
    for (const [k, v] of readTree(dir)) files.set(k, v);
    pyproject = fs.readFileSync(path.join(source, 'pyproject.toml'), 'utf8');
  }
  if (!files.size) fail(`no ${SRC_DIR}/ in ${source}${ref ? ` at ${ref}` : ''}`);
  const m = /^\[project\][\s\S]*?^version\s*=\s*"([^"]+)"/m.exec(pyproject);
  if (!m) fail('cannot find [project] version in pyproject.toml');
  return { files, packageVersion: m[1] };
}

/** Throws unless the plugin is the redactor plugin and every version agrees. Returns the version. */
export function checkVersions(files, packageVersion) {
  const json = (name) => {
    if (!files.has(name)) throw new Error(`${SRC_DIR}/${name} is missing`);
    return JSON.parse(files.get(name).toString('utf8'));
  };
  const manifest = json('.claude-plugin/plugin.json');
  if (manifest.name !== PLUGIN) throw new Error(`plugin.json name is "${manifest.name}", expected "${PLUGIN}"`);
  const v = manifest.version;
  if (v !== packageVersion) throw new Error(`plugin.json version ${v} != ${PACKAGE} version ${packageVersion} in pyproject.toml`);
  const pins = JSON.stringify(json('.mcp.json')).match(new RegExp(`${PACKAGE}==([^"\\s]+)`, 'g')) || [];
  if (!pins.length) throw new Error(`.mcp.json does not pin ${PACKAGE}==<version>`);
  for (const pin of pins) if (pin !== `${PACKAGE}==${v}`) throw new Error(`.mcp.json pins ${pin}, but the plugin version is ${v}`);
  return v;
}

function commitOf(source, ref) {
  try {
    const sha = git(source, ['rev-parse', '--verify', `${ref || 'HEAD'}^{commit}`]).toString().trim();
    if (ref) return sha;
    const dirty = git(source, ['status', '--porcelain', '--', SRC_DIR, 'pyproject.toml']).toString().trim();
    return dirty ? `${sha} + uncommitted changes` : sha;
  } catch {
    return 'unknown (not a git checkout)';
  }
}

function marker(version, ref, commit) {
  return `# Generated: do not edit

Everything in this folder except \`tests/\` is copied from \`${SRC_DIR}/\` in the
${PACKAGE} source repository by \`scripts/sync-redactor.mjs\`. Edits made here are
overwritten by the next sync: change the source repository and re-run the sync.

- version: ${version}
- source: ${ref ? `ref ${ref}, ` : 'working tree, '}commit ${commit}
- server: \`uvx --from ${PACKAGE}==${version} ${PACKAGE} serve\` (PyPI)
`;
}

/** What plugins/redactor/ should contain (excluding KEEP), as relative path -> Buffer. */
export function plannedFiles(files, version, ref, commit) {
  const out = new Map(files);
  out.set(MARKER, Buffer.from(marker(version, ref, commit), 'utf8'));
  return out;
}

function currentFiles(dest) {
  if (!fs.existsSync(dest)) return new Map();
  const all = readTree(dest);
  for (const k of [...all.keys()]) if (KEEP.has(k.split('/')[0])) all.delete(k);
  return all;
}

function sameContent(a, b, ignore = []) {
  const keys = new Set([...a.keys(), ...b.keys()]);
  for (const k of keys) {
    if (ignore.includes(k)) continue;
    if (!a.has(k) || !b.has(k) || !a.get(k).equals(b.get(k))) return false;
  }
  return true;
}

function main(argv) {
  let source;
  let ref;
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ref') ref = argv[++i] || fail('--ref needs a value');
    else if (a.startsWith('--ref=')) ref = a.slice(6);
    else if (a === '--check') check = true;
    else if (a === '-h' || a === '--help') {
      console.log('usage: node scripts/sync-redactor.mjs [SOURCE] [--ref REF] [--check]');
      return;
    } else if (a.startsWith('-')) fail(`unknown option ${a}`);
    else if (source) fail(`unexpected argument ${a}`);
    else source = a;
  }
  source = path.resolve(source || path.join(repoRoot, '..', PACKAGE));
  if (!fs.existsSync(source)) fail(`source ${source} not found (pass the path to an ${PACKAGE} checkout)`);

  const { files, packageVersion } = readSource(source, ref);
  let version;
  try {
    version = checkVersions(files, packageVersion);
  } catch (e) {
    fail(`refusing to sync: ${e.message}`);
  }
  if (ref && /^v\d/.test(ref) && ref !== `v${version}`) fail(`refusing to sync: tag ${ref} holds version ${version}`);

  const dest = path.join(repoRoot, 'plugins', PLUGIN);
  const planned = plannedFiles(files, version, ref, commitOf(source, ref));
  const mpPath = path.join(repoRoot, '.claude-plugin', 'marketplace.json');
  const mp = JSON.parse(fs.readFileSync(mpPath, 'utf8'));
  const entry = (mp.plugins || []).find((p) => p.name === PLUGIN);
  if (!entry) fail(`no "${PLUGIN}" entry in .claude-plugin/marketplace.json; add it (source ./plugins/${PLUGIN}) first`);

  if (check) {
    // The marker records the source commit, which legitimately differs between checkouts.
    const ok = sameContent(currentFiles(dest), planned, [MARKER]) && entry.version === version;
    console.log(ok ? `plugins/${PLUGIN} matches ${source} (${version})` : `plugins/${PLUGIN} is out of date with ${source} (${version})`);
    process.exit(ok ? 0 : 1);
  }

  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(dest)) if (!KEEP.has(e)) fs.rmSync(path.join(dest, e), { recursive: true, force: true });
  for (const [rel, buf] of planned) {
    const target = path.join(dest, ...rel.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, buf);
  }
  if (entry.version !== version) {
    entry.version = version;
    fs.writeFileSync(mpPath, `${JSON.stringify(mp, null, 2)}\n`);
  }
  console.log(`Synced ${PLUGIN} ${version} from ${source}${ref ? ` @ ${ref}` : ''} -> plugins/${PLUGIN} (${planned.size} files)`);
  console.log('Next: CHANGELOG line, npm test, claude plugin validate . and plugins/redactor.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
