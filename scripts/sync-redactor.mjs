#!/usr/bin/env node
// Create or update the redactor plugin from its source repo (Apra-Labs/apra-redactor-mcp, private):
// copies marketplace-plugin/ into plugins/redactor/, and adds or updates its entry in
// .claude-plugin/marketplace.json and its row in README.md (CLAUDE.md rule 1). Works the first
// time, when none of those exist yet. apra-redactor-mcp's release pipeline runs this.
//
//   node scripts/sync-redactor.mjs [SOURCE] [--ref REF] [--check]
//
// SOURCE  a local checkout of apra-redactor-mcp (default: ../apra-redactor-mcp next to this repo)
// --ref   copy the plugin as of this git ref (e.g. v0.1.0) instead of SOURCE's working tree
// --check change nothing; exit 1 if the marketplace differs from what a sync would write
//
// The sync refuses unless the plugin.json version and the package version in pyproject.toml agree,
// .mcp.json connects to the local service, and README.md's docker commands pin exactly that image
// tag, because that is the release the plugin was written for. plugins/redactor/ is replaced whole,
// including tests/ (the plugin's tests are synced with it).
// Zero dependencies; needs Node 18+ and git on PATH. Works from PowerShell and Git Bash.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PLUGIN = 'redactor';
const SRC_DIR = 'marketplace-plugin';
const PACKAGE = 'apra-redactor-mcp';
const IMAGE = `ghcr.io/apra-labs/${PACKAGE}`;
const SERVER_KEY = 'apra-redactor';
const SERVICE_URL = 'http://127.0.0.1:8765/mcp';
export const MARKER = 'GENERATED.md';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

class SyncError extends Error {}

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
      throw new SyncError(`cannot read ${ref} in ${source}: ${String(e.stderr || e.message).trim()}`);
    }
    for (const name of names) files.set(name.slice(SRC_DIR.length + 1), normalize(git(source, ['show', `${ref}:${name}`])));
    pyproject = git(source, ['show', `${ref}:pyproject.toml`]).toString('utf8');
  } else {
    const dir = path.join(source, SRC_DIR);
    if (!fs.existsSync(dir)) throw new SyncError(`${dir} not found: is ${source} a checkout of ${PACKAGE}?`);
    for (const [k, v] of readTree(dir)) files.set(k, v);
    pyproject = fs.readFileSync(path.join(source, 'pyproject.toml'), 'utf8');
  }
  if (!files.size) throw new SyncError(`no ${SRC_DIR}/ in ${source}${ref ? ` at ${ref}` : ''}`);
  const m = /^\[project\][\s\S]*?^version\s*=\s*"([^"]+)"/m.exec(pyproject);
  if (!m) throw new SyncError('cannot find [project] version in pyproject.toml');
  return { files, packageVersion: m[1] };
}

/** Throws unless the plugin is the redactor plugin and every version agrees. Returns the version. */
export function checkVersions(files, packageVersion) {
  const text = (name) => {
    if (!files.has(name)) throw new Error(`${SRC_DIR}/${name} is missing`);
    return files.get(name).toString('utf8');
  };
  const manifest = JSON.parse(text('.claude-plugin/plugin.json'));
  if (manifest.name !== PLUGIN) throw new Error(`plugin.json name is "${manifest.name}", expected "${PLUGIN}"`);
  const v = manifest.version;
  if (v !== packageVersion) throw new Error(`plugin.json version ${v} != ${PACKAGE} version ${packageVersion} in pyproject.toml`);
  const server = JSON.parse(text('.mcp.json')).mcpServers?.[SERVER_KEY];
  if (server?.type !== 'http' || server?.url !== SERVICE_URL) throw new Error(`.mcp.json must connect ${SERVER_KEY} to ${SERVICE_URL} over http`);
  const escaped = IMAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tags = [...text('README.md').matchAll(new RegExp(`${escaped}:([0-9][\\w.-]*)`, 'g'))].map((m) => m[1]);
  if (!tags.includes(v)) throw new Error(`README.md does not pin ${IMAGE}:${v}`);
  for (const tag of tags) if (tag.replace(/-ner$/, '') !== v) throw new Error(`README.md names image tag ${tag}, but the plugin version is ${v}`);
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

Everything in this folder is copied from \`${SRC_DIR}/\` in the ${PACKAGE} source
repository by \`scripts/sync-redactor.mjs\`. Edits made here are overwritten by the next
sync: change the source repository and re-run the sync.

- version: ${version}
- source: ${ref ? `ref ${ref}, ` : 'working tree, '}commit ${commit}
- server: Docker image \`${IMAGE}:${version}\`, as one always-on local service
`;
}

/** What plugins/redactor/ should contain, as relative path -> Buffer. */
export function plannedFiles(files, version, ref, commit) {
  const out = new Map(files);
  out.set(MARKER, Buffer.from(marker(version, ref, commit), 'utf8'));
  return out;
}

/** The marketplace.json entry, built from the plugin's manifest. */
export function marketplaceEntry(files) {
  const m = JSON.parse(files.get('.claude-plugin/plugin.json').toString('utf8'));
  return {
    name: PLUGIN,
    source: `./plugins/${PLUGIN}`,
    description: `${m.description.trim().replace(/\.$/, '')}; no apra-fleet needed.`,
    version: m.version,
    category: 'security',
    keywords: m.keywords,
  };
}

const README_ROW = `| [${PLUGIN}](plugins/${PLUGIN}) | A local MCP proxy that removes secrets and personal data (API keys, passwords, cards, IBANs, ...) from your MCP servers' tool results before Claude sees them. Runs as one always-on local container; configure your servers in \`~/.apra-redactor-mcp/config.yaml\`. | [Docker](https://docs.docker.com/get-docker/) |`;

/** README.md with our row in the plugins table, in alphabetical place. */
export function withReadmeRow(readme) {
  const lines = readme.split('\n');
  const start = lines.findIndex((l) => /^\|\s*Plugin\s*\|/.test(l));
  if (start < 0) throw new SyncError('README.md has no plugins table');
  let end = start + 2;
  while (end < lines.length && lines[end].startsWith('|')) end++;
  const rows = lines.slice(start + 2, end).filter((l) => !l.startsWith(`| [${PLUGIN}]`));
  const name = (row) => /^\|\s*\[([^\]]+)\]/.exec(row)?.[1] ?? row;
  rows.push(README_ROW);
  rows.sort((a, b) => name(a).localeCompare(name(b)));
  return [...lines.slice(0, start + 2), ...rows, ...lines.slice(end)].join('\n');
}

function currentFiles(dest) {
  return fs.existsSync(dest) ? readTree(dest) : new Map();
}

function sameContent(a, b, ignore = []) {
  const keys = new Set([...a.keys(), ...b.keys()]);
  for (const k of keys) {
    if (ignore.includes(k)) continue;
    if (!a.has(k) || !b.has(k) || !a.get(k).equals(b.get(k))) return false;
  }
  return true;
}

/** Sync the plugin from `source` (at `ref`, if given) into the marketplace at `root`. */
export function sync({ source, ref, root = repoRoot, check = false, log = console.log }) {
  const { files, packageVersion } = readSource(source, ref);
  let version;
  try {
    version = checkVersions(files, packageVersion);
  } catch (e) {
    throw new SyncError(`refusing to sync: ${e.message}`);
  }
  if (ref && /^v\d/.test(ref) && ref !== `v${version}`) throw new SyncError(`refusing to sync: tag ${ref} holds version ${version}`);

  const dest = path.join(root, 'plugins', PLUGIN);
  const planned = plannedFiles(files, version, ref, commitOf(source, ref));
  const mpPath = path.join(root, '.claude-plugin', 'marketplace.json');
  const mp = JSON.parse(fs.readFileSync(mpPath, 'utf8'));
  const entry = marketplaceEntry(files);
  const at = (mp.plugins || []).findIndex((p) => p.name === PLUGIN);
  const entrySame = at >= 0 && JSON.stringify(mp.plugins[at]) === JSON.stringify(entry);
  const readmePath = path.join(root, 'README.md');
  const readme = fs.readFileSync(readmePath, 'utf8').replace(/\r\n/g, '\n');
  const newReadme = withReadmeRow(readme);

  if (check) {
    // The marker records the source commit, which legitimately differs between checkouts.
    const ok = sameContent(currentFiles(dest), planned, [MARKER]) && entrySame && readme === newReadme;
    log(ok ? `plugins/${PLUGIN} matches ${source} (${version})` : `plugins/${PLUGIN} is out of date with ${source} (${version})`);
    return { ok, version };
  }

  fs.rmSync(dest, { recursive: true, force: true });
  for (const [rel, buf] of planned) {
    const target = path.join(dest, ...rel.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, buf);
  }
  if (!entrySame) {
    mp.plugins = mp.plugins || [];
    if (at >= 0) mp.plugins[at] = entry;
    else mp.plugins.push(entry);
    fs.writeFileSync(mpPath, `${JSON.stringify(mp, null, 2)}\n`);
  }
  if (readme !== newReadme) fs.writeFileSync(readmePath, newReadme);
  log(`Synced ${PLUGIN} ${version} from ${source}${ref ? ` @ ${ref}` : ''} -> plugins/${PLUGIN} (${planned.size} files)`);
  log('Next: CHANGELOG line, npm test, claude plugin validate . and plugins/redactor.');
  return { ok: true, version };
}

function main(argv) {
  let source;
  let ref;
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ref') {
      ref = argv[++i];
      if (!ref) throw new SyncError('--ref needs a value');
    } else if (a.startsWith('--ref=')) ref = a.slice(6);
    else if (a === '--check') check = true;
    else if (a === '-h' || a === '--help') {
      console.log('usage: node scripts/sync-redactor.mjs [SOURCE] [--ref REF] [--check]');
      return 0;
    } else if (a.startsWith('-')) throw new SyncError(`unknown option ${a}`);
    else if (source) throw new SyncError(`unexpected argument ${a}`);
    else source = a;
  }
  source = path.resolve(source || path.join(repoRoot, '..', PACKAGE));
  if (!fs.existsSync(source)) throw new SyncError(`source ${source} not found (pass the path to an ${PACKAGE} checkout)`);
  return sync({ source, ref, check }).ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    if (!(e instanceof SyncError)) throw e;
    console.error(`sync-redactor: ${e.message}`);
    process.exit(1);
  }
}
