#!/usr/bin/env node
// github.mjs - CLI behind the `github` agent skill. A SUPPLEMENT to `gh`: it only covers what agents
// get wrong - safe identity selection, Discussions (GraphQL-only) and a FAQ workflow, PR review
// mechanics (inline comments on valid diff lines, threads), sub-issues / issue types / duplicates,
// and Actions failure triage / rerun / dispatch. Use `gh` for everything else.
// Node >= 18 (global fetch, node:crypto), no npm dependencies, same on Windows, macOS and Linux.
//
// Secret handling: tokens come from the environment (GH_TOKEN / GITHUB_TOKEN), from `gh auth token`
// (opt-in identity) or are minted in memory from a GitHub App private key. A token is never printed,
// never stored, never put in a URL, an argv or a file. Every line this script writes goes through
// redact(). Bodies are only read from files (shell quoting corrupts inline markdown).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const EXIT = Object.freeze({ OK: 0, USAGE: 1, GUARDRAIL: 2, API: 3, CONFIG: 4, AUTH: 5 });
export const SOURCES = Object.freeze(['env', 'gh-cli', 'app-key']);
const DEFAULT_API = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 1000;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(SCRIPT_DIR, '..', '..', '..');

export class CliError extends Error {
  constructor(exitCode, message, extra) {
    super(message);
    this.exitCode = exitCode;
    if (extra) Object.assign(this, extra);
  }
}
const guard = (m) => new CliError(EXIT.GUARDRAIL, `REFUSED (guardrail): ${m}`);
const cfgErr = (m) => new CliError(EXIT.CONFIG, `CONFIG: ${m}`);
const usage = (m) => new CliError(EXIT.USAGE, `USAGE: ${m} (see help)`);
const authErr = (m, extra) => new CliError(EXIT.AUTH, `AUTH: ${m}`, extra);
const apiErr = (m, extra) => new CliError(EXIT.API, m, extra);

// ---------------------------------------------------------------------------
// Redaction and output
// ---------------------------------------------------------------------------
const SECRETS = new Set();
export function addSecret(s) {
  if (typeof s !== 'string' || s.length < 4) return;
  SECRETS.add(s);
  const enc = encodeURIComponent(s);
  if (enc !== s) SECRETS.add(enc);
}
export function redact(text) {
  let s = String(text);
  for (const sec of [...SECRETS].sort((a, b) => b.length - a.length)) s = s.split(sec).join('[REDACTED]');
  s = s.replace(/(Authorization:\s*(?:Basic|Bearer|token))\s+(?!\[REDACTED\])[A-Za-z0-9+/=._~-]+/gi, '$1 [REDACTED]');
  // any GitHub token shape that slipped through
  s = s.replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[REDACTED]');
  return s;
}
let COMPACT = false;
function out(line = '') {
  process.stdout.write(redact(line) + '\n');
}
function outJson(obj) {
  out(COMPACT ? JSON.stringify(obj) : JSON.stringify(obj, null, 2));
}
function errOut(line) {
  process.stderr.write(redact(line) + '\n');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Config: <stateDir>/config.json - identities (never tokens), default identity, repo mapping.
// ---------------------------------------------------------------------------
export function stateDir() {
  return process.env.GITHUB_SKILL_HOME || path.join(os.homedir(), '.config', 'github-skill');
}
const configPath = () => path.join(stateDir(), 'config.json');

// Actions logs go to a per-user cache outside any repo checkout (never the CWD), owner-only where the OS
// supports modes. Content is redacted before it is written.
export function defaultLogDir() {
  return path.join(os.homedir(), '.cache', 'apra-github', 'logs');
}
export function writeLogFile(dir, name, text, ownerOnlyDir = true) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (ownerOnlyDir) { try { fs.chmodSync(dir, 0o700); } catch { /* not supported on this OS */ } }
  const p = path.join(dir, name);
  fs.writeFileSync(p, redact(text), { mode: 0o600 });
  try { fs.chmodSync(p, 0o600); } catch { /* not supported on this OS */ }
  return p;
}
const IDENTITY_FIELDS = {
  env: ['source', 'host', 'env_var'],
  'gh-cli': ['source', 'host', 'user'],
  'app-key': ['source', 'host', 'app_id', 'client_id', 'installation_id', 'private_key_path', 'repositories', 'permissions'],
};
const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function checkNoSecrets(obj, where) {
  const walk = (v, k) => {
    if (typeof k === 'string' && /token|password|secret|^pat$|private_key$/i.test(k) && k !== 'private_key_path' && k !== 'env_var') {
      throw cfgErr(`${where} has a "${k}" field: config never holds tokens or keys. Remove it; tokens come from GH_TOKEN, \`gh auth token\` or an App private key file.`);
    }
    if (typeof v === 'string' && /^(gh[pousr]_|github_pat_)[A-Za-z0-9_]{10,}/.test(v)) throw cfgErr(`${where} contains a GitHub token value (field "${k}"). Remove it.`);
    if (typeof v === 'string' && /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(v)) throw cfgErr(`${where} contains a private key. Store only private_key_path.`);
    if (v && typeof v === 'object') for (const [kk, vv] of Object.entries(v)) walk(vv, kk);
  };
  walk(obj, '');
}

export function loadConfig() {
  const p = configPath();
  if (!fs.existsSync(p)) return { exists: false, identities: {}, repo_identity: {} };
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    throw cfgErr(`${p} is not valid JSON (${e.message}).`);
  }
  checkNoSecrets(cfg, p);
  return {
    exists: true,
    identities: cfg.identities && typeof cfg.identities === 'object' ? cfg.identities : {},
    default_identity: typeof cfg.default_identity === 'string' ? cfg.default_identity : undefined,
    repo_identity: cfg.repo_identity && typeof cfg.repo_identity === 'object' ? cfg.repo_identity : {},
    default_repo: typeof cfg.default_repo === 'string' ? cfg.default_repo : undefined,
  };
}

function saveConfig(cfg) {
  const clean = { identities: cfg.identities || {} };
  if (cfg.default_identity) clean.default_identity = cfg.default_identity;
  clean.repo_identity = cfg.repo_identity || {};
  if (cfg.default_repo) clean.default_repo = cfg.default_repo;
  checkNoSecrets(clean, 'config');
  const d = stateDir();
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  const p = configPath();
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, p);
  try { fs.chmodSync(p, 0o600); } catch { /* not supported on this OS */ }
  return clean;
}

// GITHUB_API_URL overrides the API host only for an `env` identity (the token and the URL come from the
// same environment, as in GitHub Actions) or when its host is the identity's own host (api.<host> counts).
// For any other identity it is ignored with a warning, so a stray value cannot send a gh-cli or App token
// to another host. With no identity (ident omitted) nothing is authenticated, and it is honoured.
const warnedApiUrl = new Set();
export function apiUrlAllowed(rawUrl, ident) {
  if (!ident || !ident.def) return true;
  if (ident.def.source === 'env') return true;
  let u;
  try { u = new URL(rawUrl); } catch { return true; } // invalid: apiBase reports it
  const host = String(ident.def.host || 'github.com').toLowerCase();
  const h = u.host.toLowerCase();
  return h === host || h === `api.${host}`;
}
export function apiBase(host, ident) {
  let raw = process.env.GITHUB_API_URL;
  if (raw && !apiUrlAllowed(raw, ident)) {
    if (!warnedApiUrl.has(ident.name)) {
      warnedApiUrl.add(ident.name);
      process.stderr.write(`warning: GITHUB_API_URL (host ${new URL(raw).host}) ignored for identity "${ident.name}" (source ${ident.def.source}, host ${ident.def.host || 'github.com'}); it applies only to env identities or the identity's own host.\n`);
    }
    raw = '';
  }
  if (!raw) raw = host && host !== 'github.com' ? `https://${host}/api/v3` : DEFAULT_API;
  let u;
  try { u = new URL(raw); } catch { throw cfgErr(`GITHUB_API_URL "${raw}" is not a valid URL.`); }
  if (u.username || u.password) throw cfgErr('GITHUB_API_URL must not contain credentials.');
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw cfgErr(`GITHUB_API_URL must use https:// (got ${u.protocol}//).`);
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

// ---------------------------------------------------------------------------
// Identity selection (pure; exported for tests). Never falls back to another identity.
// ---------------------------------------------------------------------------
export function resolveIdentity(cfg, { flag, repo, env = process.env } = {}) {
  const ids = cfg.identities || {};
  const envToken = !!(env.GH_TOKEN || env.GITHUB_TOKEN);
  const pick = (name, via) => {
    const def = ids[name];
    if (!def) {
      if (name === 'env' && !cfg.exists) return { name: 'env', def: { source: 'env', host: 'github.com' }, via: `${via} (implicit env identity)` };
      throw cfgErr(`identity "${name}" (${via}) is not defined. Defined: ${Object.keys(ids).join(', ') || '(none)'}. Add it with: config identity add ${name} --source env|gh-cli|app-key ...`);
    }
    if (!SOURCES.includes(def.source)) throw cfgErr(`identity "${name}" has unknown source "${def.source}" (expected ${SOURCES.join(', ')}).`);
    return { name, def: { host: 'github.com', ...def }, via };
  };
  if (flag) return pick(flag, '--identity');
  if (repo) {
    const map = cfg.repo_identity || {};
    const exact = Object.keys(map).find((k) => k.toLowerCase() === repo.toLowerCase());
    if (exact) return pick(map[exact], `repo_identity ${exact}`);
    const owner = repo.split('/')[0].toLowerCase();
    const wild = Object.keys(map).find((k) => k.toLowerCase() === `${owner}/*`);
    if (wild) return pick(map[wild], `repo_identity ${wild}`);
  }
  if (cfg.default_identity) return pick(cfg.default_identity, 'default_identity');
  if (!cfg.exists && envToken) return { name: 'env', def: { source: 'env', host: 'github.com' }, via: 'implicit (no config, GH_TOKEN/GITHUB_TOKEN set)' };
  throw cfgErr(`no identity selected${repo ? ` for ${repo}` : ''}. Options:
  - pass --identity NAME (a configured identity)
  - map the repo: config map ${repo || 'owner/repo'} NAME   (or owner/*)
  - set a default: config default NAME
  - define one: config identity add NAME --source env [--env-var GH_TOKEN]
                config identity add NAME --source gh-cli [--host github.com] [--user LOGIN]
                config identity add NAME --source app-key --app-id N|--client-id C --installation-id N --private-key-path /abs/key.pem
  - with no config file at all, GH_TOKEN/GITHUB_TOKEN in the environment is used as the implicit "env" identity.`);
}

export function tokenKind(token) {
  const t = String(token || '');
  if (t.startsWith('ghp_')) return 'classic-pat';
  if (t.startsWith('github_pat_')) return 'fine-grained-pat';
  if (t.startsWith('gho_')) return 'oauth';
  if (t.startsWith('ghu_')) return 'app-user';
  if (t.startsWith('ghs_')) return 'installation';
  return 'unknown';
}

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

// GitHub App JWT (RS256). iat backdated 60s for clock drift, exp 9 minutes ahead (max 10).
export function mintAppJwt({ appId, clientId, privateKeyPem, now = Math.floor(Date.now() / 1000) }) {
  const iss = clientId ? String(clientId) : /^\d+$/.test(String(appId)) ? Number(appId) : String(appId);
  if (iss === undefined || iss === '' || (typeof iss === 'number' && !iss)) throw cfgErr('app-key identity needs app_id or client_id.');
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss }));
  let sig;
  try {
    sig = crypto.createSign('RSA-SHA256').update(`${header}.${payload}`).sign(privateKeyPem);
  } catch (e) {
    throw authErr(`could not sign the App JWT with the private key (${e.message}).`);
  }
  const jwt = `${header}.${payload}.${b64url(sig)}`;
  addSecret(jwt);
  return jwt;
}

function insidePath(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
export function checkKeyPath(p) {
  if (!p || !path.isAbsolute(p)) throw usage('--private-key-path must be an absolute path to the App .pem file');
  const bad = [PLUGIN_ROOT, path.dirname(PLUGIN_ROOT), path.join(os.homedir(), '.claude', 'plugins')];
  for (const b of bad) if (insidePath(p, b)) throw guard(`the private key ${p} is inside a plugin directory (${b}). Keep it outside any plugin/skill dir (e.g. ~/.config/github-skill/keys/), where plugin updates and copies cannot spread it.`);
  return path.resolve(p);
}

function spawnCapture(command, args, env) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return reject(e);
    }
    const so = [];
    const se = [];
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 30000);
    child.stdout.on('data', (c) => so.push(c));
    child.stderr.on('data', (c) => se.push(c));
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code === null ? 1 : code, stdout: Buffer.concat(so).toString('utf8'), stderr: Buffer.concat(se).toString('utf8') });
    });
  });
}

async function ghCliToken(def) {
  const bin = process.env.GITHUB_SKILL_GH_BIN || 'gh';
  const args = ['auth', 'token', '--hostname', def.host || 'github.com'];
  if (def.user) args.push('--user', def.user);
  const isJs = /\.(m?js|cjs)$/i.test(bin);
  const env = { ...process.env };
  // gh auth token prints GH_TOKEN if set; strip it so this identity really is the gh login
  for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) delete env[k];
  let r;
  try {
    r = await spawnCapture(isJs ? process.execPath : bin, isJs ? [bin, ...args] : args, env);
  } catch (e) {
    if (e.code === 'ENOENT') throw authErr('identity source gh-cli: `gh` was not found on PATH. Install GitHub CLI and run `gh auth login`, or select another identity.');
    throw authErr(`identity source gh-cli: could not run gh (${e.message}).`);
  }
  const tok = r.stdout.trim();
  if (r.code !== 0 || !tok) {
    addSecret(tok);
    throw authErr(`identity source gh-cli: \`gh auth token --hostname ${def.host || 'github.com'}${def.user ? ' --user ' + def.user : ''}\` failed (exit ${r.code}): ${redact(r.stderr.trim().split(/\r?\n/).slice(-2).join(' | ')) || 'no token'}. Run \`gh auth login\` (or \`gh auth switch\`).`);
  }
  addSecret(tok);
  return tok;
}

// ---------------------------------------------------------------------------
// Context, token, HTTP
// ---------------------------------------------------------------------------
function makeCtx(flags) {
  return { cfg: loadConfig(), f: flags, dryRun: !!flags['dry-run'], debug: !!flags.debug, ident: null, token: null, lastWriteAt: 0, actor: null };
}

function identityFor(ctx, repo) {
  if (!ctx.ident) {
    ctx.ident = resolveIdentity(ctx.cfg, { flag: ctx.f.identity, repo });
    ctx.base = apiBase(ctx.ident.def.host, ctx.ident);
  }
  return ctx.ident;
}

async function tokenFor(ctx) {
  if (ctx.token) return ctx.token;
  const { name, def } = identityFor(ctx, ctx.repo);
  let tok;
  if (def.source === 'env') {
    const vars = def.env_var ? [def.env_var] : ['GH_TOKEN', 'GITHUB_TOKEN'];
    const v = vars.map((n) => process.env[n]).find(Boolean);
    if (!v) throw authErr(`identity "${name}" (source env) needs ${vars.join(' or ')} in the environment. With apra-fleet: GH_TOKEN={{secret.NAME}} via execute_command, or GH_TOKEN={{vcs_token}} via vcs_credential_exec. Not falling back to another identity.`);
    if (/\{\{\s*(secret\.|secure\.|vcs_token)/.test(v)) throw authErr(`${vars.join('/')} still holds an unsubstituted {{...}} placeholder. Check the secret name and that it is in scope for this member.`);
    tok = v;
  } else if (def.source === 'gh-cli') {
    tok = await ghCliToken(def);
  } else if (def.source === 'app-key') {
    if (!def.installation_id) throw cfgErr(`identity "${name}" (app-key) has no installation_id.`);
    if (!def.private_key_path) throw cfgErr(`identity "${name}" (app-key) has no private_key_path.`);
    let pem;
    try { pem = fs.readFileSync(def.private_key_path, 'utf8'); } catch (e) { throw authErr(`identity "${name}": cannot read private key ${def.private_key_path} (${e.code || e.message}).`); }
    const jwt = mintAppJwt({ appId: def.app_id, clientId: def.client_id, privateKeyPem: pem });
    ctx.appJwt = jwt;
    const body = {};
    if (Array.isArray(def.repositories) && def.repositories.length) body.repositories = def.repositories;
    if (def.permissions && typeof def.permissions === 'object' && Object.keys(def.permissions).length) body.permissions = def.permissions;
    const r = await rawRequest(ctx, 'POST', `/app/installations/${encodeURIComponent(def.installation_id)}/access_tokens`, { body, authHeader: `Bearer ${jwt}` });
    tok = r.data && r.data.token;
    if (!tok) throw authErr(`identity "${name}": the installation token response had no token.`);
    ctx.tokenExpires = r.data.expires_at;
  } else throw cfgErr(`identity "${name}" has unknown source "${def.source}".`);
  addSecret(tok);
  ctx.token = tok;
  ctx.kind = tokenKind(tok);
  return tok;
}

function buildUrl(ctx, p, query) {
  const base = ctx.base || apiBase();
  let url;
  if (/^https?:\/\//i.test(p)) {
    url = new URL(p);
    if (url.origin !== new URL(base).origin) throw apiErr(`API: refusing to follow a link to ${url.origin}; the token is only sent to the API host.`);
  } else url = new URL(base + p);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  return url;
}

function dryRunPlan(method, url, body) {
  const plan = { dry_run: true, method, url: decodeURIComponent(url.toString()), headers: { Authorization: 'Bearer [REDACTED]' } };
  if (body !== undefined) plan.body = body;
  return plan;
}

function parseJson(text) {
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}
const hget = (headers, name) => (headers ? (typeof headers.get === 'function' ? headers.get(name) : headers[name.toLowerCase()]) : null);

// Pure diagnosis of a failed REST call; exported for tests.
export function diagnoseApiError(status, text, headers, where = '') {
  const j = parseJson(text) || {};
  const msg = j.message || String(text || '').slice(0, 300);
  const at = where ? ` on ${where}` : '';
  const sso = hget(headers, 'x-github-sso');
  if (status === 401) return authErr(`HTTP 401${at}: the token is invalid, expired or revoked (${msg}). For gh-cli run \`gh auth login\`; for env check the secret value; App installation tokens expire after 1 hour.`, { status });
  if (status === 403 && (sso || /SAML|SSO/i.test(msg))) {
    const m = /url=(\S+)/.exec(sso || '');
    return authErr(`HTTP 403${at}: the organization enforces SAML SSO and this token is not authorized for it. Authorize the token for the org${m ? `: ${m[1]}` : ' (GitHub settings -> token -> Configure SSO)'}. ${msg}`, { status });
  }
  const accepted = hget(headers, 'x-accepted-github-permissions');
  if (status === 403 && accepted) {
    return authErr(`HTTP 403${at}: ${msg}. This identity lacks a permission. Needed (any one set): ${accepted}.${/not accessible by integration/i.test(msg) ? ' "Resource not accessible by integration" = the GitHub App installation or fine-grained PAT was not granted this permission (or this repository).' : ''}`, { status, needed: accepted });
  }
  if (status === 403 && /not accessible by integration/i.test(msg)) {
    return authErr(`HTTP 403${at}: Resource not accessible by integration: the GitHub App installation or fine-grained PAT lacks the permission or repository access for this call.`, { status });
  }
  if ((status === 403 || status === 429) && (hget(headers, 'x-ratelimit-remaining') === '0' || /rate limit/i.test(msg))) {
    const reset = hget(headers, 'x-ratelimit-reset');
    const ra = hget(headers, 'retry-after');
    return apiErr(`API error ${status}${at}: rate limited (${msg}).${ra ? ` Retry after ${ra}s.` : reset ? ` Resets at ${new Date(Number(reset) * 1000).toISOString()}.` : ''} Do not loop; slow down.`, { status });
  }
  if (status === 403) {
    const scopes = hget(headers, 'x-accepted-oauth-scopes');
    return authErr(`HTTP 403${at}: forbidden (${msg}).${scopes ? ` Accepted OAuth scopes: ${scopes} (have: ${hget(headers, 'x-oauth-scopes') || 'none'}).` : ''}`, { status });
  }
  if (status === 404) return apiErr(`API error 404${at}: not found OR no access with this identity (GitHub answers 404 for private resources it will not show you). Check owner/repo and numbers, and that the identity can see this repo.`, { status });
  if (status === 410) return apiErr(`API error 410${at}: gone (${msg}).`, { status });
  if (status === 422) {
    const errs = Array.isArray(j.errors) ? j.errors.map((e) => (typeof e === 'string' ? e : e.message || `${e.resource || ''} ${e.field || ''} ${e.code || ''}`.trim())).join('; ') : '';
    return apiErr(`API error 422${at}: validation failed: ${msg}${errs ? ` (${errs})` : ''}`, { status });
  }
  return apiErr(`API error ${status}${at}: ${msg || 'no detail'}`, { status });
}

export function diagnoseGraphqlErrors(errors) {
  const types = new Set(errors.map((e) => e.type).filter(Boolean));
  const msgs = errors.map((e) => `${e.type ? `[${e.type}] ` : ''}${e.message}`).join('; ');
  if (types.has('FORBIDDEN')) return authErr(`GraphQL: forbidden: ${msgs}. This identity lacks permission (App/fine-grained PAT: check its permissions, e.g. Discussions/Issues/Pull requests: write).`);
  if (types.has('INSUFFICIENT_SCOPES')) return authErr(`GraphQL: insufficient token scopes: ${msgs}. A classic PAT needs the listed scopes (e.g. repo, read:org, write:discussion).`);
  if (types.has('NOT_FOUND')) return apiErr(`GraphQL: not found OR no access with this identity: ${msgs}`);
  if (/SAML/i.test(msgs)) return authErr(`GraphQL: ${msgs}. Authorize the token for the org's SAML SSO.`);
  return apiErr(`GraphQL error: ${msgs}`);
}

const writeGap = () => {
  const v = process.env.GITHUB_SKILL_WRITE_GAP_MS;
  return v !== undefined && /^\d+$/.test(v) ? Number(v) : 1000;
};

// One HTTP request with an explicit Authorization header (used for the App token mint too).
async function rawRequest(ctx, method, p, { query, body, authHeader, raw = false, allow = [], accept } = {}) {
  if (!ctx.base) ctx.base = apiBase(ctx.ident && ctx.ident.def.host, ctx.ident);
  const url = buildUrl(ctx, p, query);
  const apiOrigin = new URL(ctx.base).origin;
  let retried = false;
  for (;;) {
    let target = url;
    let m = method;
    let res;
    for (let hop = 0; hop < 6; hop++) {
      const headers = { Accept: accept || (raw ? '*/*' : 'application/vnd.github+json'), 'User-Agent': 'github-skill', 'X-GitHub-Api-Version': API_VERSION };
      if (target.origin === apiOrigin) headers.Authorization = authHeader; // never to a redirect host
      if (body !== undefined && m !== 'GET') headers['Content-Type'] = 'application/json';
      if (ctx.debug) errOut(`DEBUG > ${m} ${decodeURIComponent(target.toString())}${headers.Authorization ? '  Authorization: Bearer [REDACTED]' : '  (no Authorization)'}${body !== undefined && m !== 'GET' ? '  body: ' + JSON.stringify(body).slice(0, 2000) : ''}`);
      try {
        res = await fetch(target, { method: m, headers, body: body !== undefined && m !== 'GET' ? JSON.stringify(body) : undefined, redirect: 'manual', signal: AbortSignal.timeout(120000) });
      } catch (e) {
        throw apiErr(`API: ${m} ${target.origin}${target.pathname} failed: ${(e.cause && e.cause.code) || e.message}`);
      }
      if (ctx.debug) errOut(`DEBUG < ${res.status}`);
      const loc = res.headers.get('location');
      if ([301, 302, 303, 307, 308].includes(res.status) && loc) {
        target = new URL(loc, target);
        if (res.status === 303 || res.status === 302) m = 'GET';
        continue;
      }
      break;
    }
    const where = `${method} ${url.pathname}`;
    if (allow.includes(res.status)) return { status: res.status, data: null, text: '', buffer: Buffer.alloc(0), headers: res.headers };
    if (!res.ok) {
      const text = await res.text();
      const ra = res.headers.get('retry-after');
      const secondary = (res.status === 403 || res.status === 429) && (ra || /secondary rate limit/i.test(text));
      if (secondary) {
        const wait = ra && /^\d+$/.test(ra) ? Number(ra) : 60;
        if (wait <= 60 && !retried) {
          retried = true;
          errOut(`WARNING: secondary rate limit on ${where}; waiting ${wait}s once, as GitHub asks (retry-after).`);
          await sleep(wait * 1000);
          continue;
        }
        throw apiErr(`API error ${res.status} on ${where}: secondary rate limit; GitHub asks to wait ${wait}s${retried ? ' (already waited once)' : ''}. Stop and retry later; do not loop.`, { status: res.status });
      }
      throw diagnoseApiError(res.status, text, res.headers, where);
    }
    if (raw) {
      const buffer = Buffer.from(await res.arrayBuffer());
      return { status: res.status, buffer, text: buffer.toString('utf8'), headers: res.headers };
    }
    const text = await res.text();
    return { status: res.status, data: parseJson(text), text, headers: res.headers };
  }
}

export async function api(ctx, method, p, { query, body, write = false, raw = false, allow = [], accept } = {}) {
  identityFor(ctx, ctx.repo);
  if (write && ctx.dryRun) return { status: 0, dryRun: true, plan: dryRunPlan(method, buildUrl(ctx, p, query), body) };
  const tok = await tokenFor(ctx);
  if (write) {
    const wait = ctx.lastWriteAt + writeGap() - Date.now();
    if (wait > 0) await sleep(wait); // content-creation secondary limits: writes >= 1s apart
  }
  const r = await rawRequest(ctx, method, p, { query, body, authHeader: `Bearer ${tok}`, raw, allow, accept });
  if (write) ctx.lastWriteAt = Date.now();
  return r;
}

export async function gql(ctx, query, variables = {}, { write = false, allowPartial = false } = {}) {
  const body = { query, variables };
  const r = await api(ctx, 'POST', '/graphql', { body, write });
  if (r.dryRun) return r;
  const d = r.data || {};
  if (Array.isArray(d.errors) && d.errors.length && !(allowPartial && d.data)) throw diagnoseGraphqlErrors(d.errors);
  return { data: d.data || {}, errors: d.errors || [] };
}

// REST pagination via Link: rel="next".
async function paginate(ctx, p, { query = {}, key, limit = MAX_LIMIT, maxPages = 30 } = {}) {
  const values = [];
  let next = p;
  let q = { per_page: 100, ...query };
  let pages = 0;
  let more = false;
  while (next) {
    if (pages >= maxPages) { more = true; break; }
    const r = await api(ctx, 'GET', next, { query: q });
    pages++;
    const page = key ? (r.data && r.data[key]) || [] : Array.isArray(r.data) ? r.data : [];
    for (const v of page) {
      if (values.length >= limit) { more = true; break; }
      values.push(v);
    }
    const link = r.headers.get('link') || '';
    const m = /<([^>]+)>;\s*rel="next"/.exec(link);
    next = m ? m[1] : null;
    q = undefined;
    if (values.length >= limit) { more = more || !!next; break; }
  }
  return { values, more };
}

// Who is acting: included in every write's output and dry-run.
async function actingAs(ctx) {
  if (ctx.actor) return ctx.actor;
  const { name, def } = identityFor(ctx, ctx.repo);
  const tok = await tokenFor(ctx);
  const a = { identity: name, source: def.source, kind: tokenKind(tok) };
  if (a.kind === 'installation') {
    a.app = 'GitHub App installation';
    if (ctx.appJwt) {
      try {
        const r = await rawRequest(ctx, 'GET', '/app', { authHeader: `Bearer ${ctx.appJwt}` });
        if (r.data && r.data.slug) a.app = `${r.data.slug}[bot]`;
      } catch { /* keep generic */ }
    }
  } else {
    try {
      a.login = (await api(ctx, 'GET', '/user')).data.login;
    } catch (e) {
      if (e instanceof CliError && e.exitCode === EXIT.AUTH) throw e;
      a.login = null;
    }
  }
  ctx.actor = a;
  return a;
}

// ---------------------------------------------------------------------------
// Argument helpers
// ---------------------------------------------------------------------------
const seg = encodeURIComponent;
function parseLimit(v, def = DEFAULT_LIMIT, max = MAX_LIMIT) {
  if (v === undefined) return def;
  if (!/^\d+$/.test(String(v)) || Number(v) < 1 || Number(v) > max) throw usage(`--limit must be 1..${max}`);
  return Number(v);
}
function posInt(v, name) {
  if (!/^\d+$/.test(String(v || '')) || Number(v) < 1) throw usage(`${name} must be a positive whole number (got "${v === undefined ? '' : v}")`);
  return Number(v);
}
function repoOf(ctx, { required = true } = {}) {
  const r = ctx.f.R || ctx.f.repo || ctx.cfg.default_repo;
  if (!r) {
    if (required) throw usage('missing -R owner/repo (or config repo owner/repo)');
    return null;
  }
  if (!REPO_RE.test(r)) throw usage(`"${r}" is not owner/repo`);
  const [owner, name] = r.split('/');
  ctx.repo = r;
  return { owner, name, full: r, rp: `/repos/${seg(owner)}/${seg(name)}` };
}

function readFileArg(file, label) {
  if (!file) throw usage(`${label} is required`);
  let t;
  try { t = fs.readFileSync(path.resolve(file), 'utf8'); } catch (e) { throw usage(`${label} ${file}: ${e.code === 'ENOENT' ? 'file not found' : e.message}`); }
  return t.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

// Body from a file, linted unless --no-lint.
function readBody(ctx, file, label = '--body-file') {
  const t = readFileArg(file, label).replace(/\s+$/, '');
  if (!t.trim()) throw usage(`${label} ${file} is empty`);
  lintOrRefuse(ctx, t, `${label} ${file}`);
  return t;
}
function lintOrRefuse(ctx, text, where) {
  if (ctx.f['no-lint']) return;
  const issues = lintMarkdown(text);
  if (issues.length) throw guard(`markdown lint failed for ${where} (GitHub renders these badly; fix the file, or pass --no-lint if intended):\n${issues.map((i) => `  line ${i.line}: ${i.message}`).join('\n')}`);
}

const excerpt = (s, n = 200) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 3) + '...' : t;
};

// ---------------------------------------------------------------------------
// Markdown linter (pure; exported)
// ---------------------------------------------------------------------------
const LIST_RE = /^\s*([-*+]|\d{1,9}[.)])(\s+\S|\s*$)/;
export function lintMarkdown(text) {
  const lines = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  const kinds = [];
  let fence = null;
  let fenceLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (fence) {
      const c = new RegExp(`^\\s{0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`);
      if (c.test(l)) { kinds[i] = 'fence-close'; fence = null; } else kinds[i] = 'code';
      continue;
    }
    const fm = /^\s*(`{3,}|~{3,})/.exec(l);
    if (fm) { fence = fm[1]; fenceLine = i; kinds[i] = 'fence-open'; continue; }
    const prev = i > 0 ? kinds[i - 1] : 'blank';
    if (/^\s*$/.test(l)) kinds[i] = 'blank';
    else if (/^\s{0,3}#{1,6}(\s|$)/.test(l)) kinds[i] = 'heading';
    else if (/^\s{0,3}>/.test(l)) kinds[i] = 'quote';
    else if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(l)) kinds[i] = 'hr';
    else if (LIST_RE.test(l)) kinds[i] = 'list';
    else if (/^\s*\|/.test(l)) kinds[i] = 'table';
    else if (/^\s{0,3}<\/?[A-Za-z!]/.test(l)) kinds[i] = 'html';
    else if (/^\s+\S/.test(l) && (prev === 'list' || prev === 'list-cont' || (prev === 'blank' && listContext(kinds, i)))) kinds[i] = 'list-cont';
    else if (/^(\s{4,}|\t)/.test(l) && prev === 'blank') kinds[i] = 'code';
    else kinds[i] = 'text';
  }
  const issues = [];
  const add = (i, m) => issues.push({ line: i + 1, message: m });
  const hardBreak = (l) => / {2,}$/.test(l) || /\\$/.test(l) || /<br\s*\/?>\s*$/i.test(l);
  const quoteText = (l) => l.replace(/^\s{0,3}>\s?/, '');
  const plainQuote = (l) => {
    const t = quoteText(l);
    return t.trim() !== '' && !/^\s*(>|#|[-*+]\s|\d+[.)]\s|```|~~~|\|)/.test(t);
  };
  for (let i = 0; i < lines.length; i++) {
    const k = kinds[i];
    const pk = i > 0 ? kinds[i - 1] : 'blank';
    const nk = i + 1 < lines.length ? kinds[i + 1] : 'blank';
    if (k === 'text' && pk === 'text' && !hardBreak(lines[i - 1]) && (i < 2 || kinds[i - 2] !== 'text' || hardBreak(lines[i - 2]))) {
      let e = i;
      while (e + 1 < lines.length && kinds[e + 1] === 'text' && !hardBreak(lines[e])) e++;
      add(i - 1, `paragraph text wrapped across lines ${i}-${e + 1}: unwrap into one line (GitHub keeps single newlines as line breaks)`);
    }
    if (k === 'list-cont' && (pk === 'list' || pk === 'list-cont') && !/^\s*(`{3,}|~{3,})/.test(lines[i]) && !hardBreak(lines[i - 1])) {
      add(i, 'list item text wrapped onto the next line: unwrap into one line');
    }
    if (k === 'text' && (pk === 'list' || pk === 'list-cont')) add(i, 'missing blank line after list');
    if (k === 'list' && ['text', 'quote', 'table', 'html', 'fence-close', 'hr'].includes(pk)) add(i, `missing blank line before list${pk === 'text' ? ' (after the lead-in sentence)' : ''}`);
    if (k === 'heading') {
      if (i > 0 && pk !== 'blank') add(i, 'missing blank line before heading');
      if (i + 1 < lines.length && nk !== 'blank') add(i, 'missing blank line after heading');
    }
    if (k === 'quote') {
      if (i > 0 && pk !== 'blank' && pk !== 'quote') add(i, 'missing blank line before blockquote');
      if (i + 1 < lines.length && nk !== 'blank' && nk !== 'quote') add(i, 'missing blank line after blockquote');
      if (pk === 'quote' && plainQuote(lines[i]) && plainQuote(lines[i - 1]) && !hardBreak(lines[i - 1])) add(i, 'blockquote paragraph wrapped across ">" lines: unwrap into one line');
    }
    if (k === 'fence-open' && i > 0 && pk !== 'blank' && !((pk === 'list' || pk === 'list-cont') && /^\s+/.test(lines[i]))) {
      add(i, `missing blank line before fenced code block${pk === 'text' ? ' (after the lead-in sentence)' : ''}`);
    }
    if (k === 'fence-close' && i + 1 < lines.length && nk !== 'blank' && !(nk === 'list-cont' || nk === 'list')) add(i, 'missing blank line after fenced code block');
    if (k === 'table' && pk === 'text') add(i, 'missing blank line before table');
  }
  if (fence) add(fenceLine, 'fenced code block is never closed');
  return issues.sort((a, b) => a.line - b.line);
}
function listContext(kinds, i) {
  for (let j = i - 1; j >= 0; j--) {
    if (kinds[j] === 'blank') continue;
    return kinds[j] === 'list' || kinds[j] === 'list-cont';
  }
  return false;
}

// ---------------------------------------------------------------------------
// Small pure helpers: titles, diff
// ---------------------------------------------------------------------------
export function normaliseTitle(t) {
  return String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
const titleTokens = (t) => new Set(normaliseTitle(t).split(' ').filter(Boolean).map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w)));
// Dice coefficient over normalised word tokens (simple plural folding).
export function titleSimilarity(a, b) {
  const A = titleTokens(a);
  const B = titleTokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return (2 * inter) / (A.size + B.size);
}

export function unifiedDiff(a, b, { from = 'before', to = 'after', context = 3 } = {}) {
  const A = String(a).split('\n');
  const B = String(b).split('\n');
  const n = A.length;
  const m = B.length;
  const L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { ops.push([' ', A[i], i, j]); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) { ops.push(['-', A[i], i, j]); i++; } else { ops.push(['+', B[j], i, j]); j++; }
  }
  while (i < n) { ops.push(['-', A[i], i, j]); i++; }
  while (j < m) { ops.push(['+', B[j], i, j]); j++; }
  const changed = ops.map((o, k) => (o[0] !== ' ' ? k : -1)).filter((k) => k >= 0);
  if (!changed.length) return '';
  const outL = [`--- ${from}`, `+++ ${to}`];
  let k = 0;
  while (k < changed.length) {
    let s = Math.max(0, changed[k] - context);
    let e = Math.min(ops.length - 1, changed[k] + context);
    while (k + 1 < changed.length && changed[k + 1] - context <= e + 1) { k++; e = Math.min(ops.length - 1, changed[k] + context); }
    const hunk = ops.slice(s, e + 1);
    const oldStart = hunk[0][2] + 1;
    const newStart = hunk[0][3] + 1;
    const oldLen = hunk.filter((o) => o[0] !== '+').length;
    const newLen = hunk.filter((o) => o[0] !== '-').length;
    outL.push(`@@ -${oldStart},${oldLen} +${newStart},${newLen} @@`);
    for (const o of hunk) outL.push(o[0] + o[1]);
    k++;
  }
  return outL.join('\n');
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------
function rawConfigForWrite(ctx) {
  const c = ctx.cfg;
  return { identities: { ...c.identities }, default_identity: c.default_identity, repo_identity: { ...c.repo_identity }, default_repo: c.default_repo };
}
function persist(ctx, next, what) {
  if (ctx.dryRun) return outJson({ dry_run: true, would_save: next, config_path: configPath(), change: what });
  const saved = saveConfig(next);
  return outJson({ saved, config_path: configPath(), change: what });
}

function cmdConfig(ctx, a) {
  const sub = a._[1] || 'show';
  const f = a.f;
  if (sub === 'show') {
    let selected = null;
    try { selected = resolveIdentity(ctx.cfg, { flag: f.identity, repo: f.R || ctx.cfg.default_repo }); } catch (e) { selected = { error: e.message }; }
    return outJson({
      config_path: configPath(), config_exists: ctx.cfg.exists,
      identities: ctx.cfg.identities, default_identity: ctx.cfg.default_identity || null, repo_identity: ctx.cfg.repo_identity, default_repo: ctx.cfg.default_repo || null,
      api_url: apiBase(), env_token_present: !!(process.env.GH_TOKEN || process.env.GITHUB_TOKEN),
      selected_identity: selected && selected.name ? { name: selected.name, source: selected.def.source, via: selected.via } : selected,
    });
  }
  const next = rawConfigForWrite(ctx);
  if (sub === 'identity') {
    const op = a._[2];
    const name = a._[3];
    if (op === 'add') {
      if (!name || !NAME_RE.test(name)) throw usage('config identity add <name> --source env|gh-cli|app-key [fields]  (name: letters, digits, . _ -)');
      const source = f.source;
      if (!SOURCES.includes(source)) throw usage(`--source must be one of ${SOURCES.join(', ')}`);
      const def = { source, host: f.host || 'github.com' };
      if (source === 'env' && f['env-var']) {
        if (!ENV_NAME_RE.test(f['env-var'])) throw usage('--env-var is the NAME of an environment variable, not a token');
        def.env_var = f['env-var'];
      }
      if (source === 'gh-cli' && f.user) def.user = f.user;
      if (source === 'app-key') {
        if (!f['app-id'] && !f['client-id']) throw usage('app-key needs --app-id N or --client-id C');
        if (f['app-id']) def.app_id = /^\d+$/.test(f['app-id']) ? Number(f['app-id']) : (() => { throw usage('--app-id must be numeric'); })();
        if (f['client-id']) def.client_id = f['client-id'];
        def.installation_id = posInt(f['installation-id'], '--installation-id');
        const kp = checkKeyPath(f['private-key-path']);
        if (!fs.existsSync(kp)) throw cfgErr(`private key ${kp} does not exist.`);
        def.private_key_path = kp;
        if (f.repositories) def.repositories = String(f.repositories).split(',').map((s) => s.trim()).filter(Boolean);
        if (f.permissions) {
          def.permissions = {};
          for (const kv of String(f.permissions).split(',')) {
            const m = /^\s*([a-z_]+)\s*=\s*(read|write|admin)\s*$/.exec(kv);
            if (!m) throw usage(`--permissions entries are name=read|write|admin (got "${kv}")`);
            def.permissions[m[1]] = m[2];
          }
        }
      }
      for (const k of ['env-var', 'user', 'app-id', 'client-id', 'installation-id', 'private-key-path', 'repositories', 'permissions']) {
        if (f[k] !== undefined && !IDENTITY_FIELDS[source].includes(k.replace(/-/g, '_'))) throw usage(`--${k} does not apply to source ${source}`);
      }
      next.identities[name] = def;
      return persist(ctx, next, `identity ${name} (${source})`);
    }
    if (op === 'remove') {
      if (!name || !next.identities[name]) throw usage(`config identity remove <name> (defined: ${Object.keys(next.identities).join(', ') || 'none'})`);
      delete next.identities[name];
      const dropped = [];
      if (next.default_identity === name) { delete next.default_identity; dropped.push('default_identity'); }
      for (const [k, v] of Object.entries(next.repo_identity)) if (v === name) { delete next.repo_identity[k]; dropped.push(`repo_identity ${k}`); }
      return persist(ctx, next, `removed identity ${name}${dropped.length ? `; also cleared ${dropped.join(', ')}` : ''}`);
    }
    throw usage('config identity add|remove <name>');
  }
  if (sub === 'default') {
    const name = a._[2];
    if (!name || !next.identities[name]) throw usage(`config default <identity> (defined: ${Object.keys(next.identities).join(', ') || 'none'})`);
    next.default_identity = name;
    return persist(ctx, next, `default_identity = ${name}`);
  }
  if (sub === 'map') {
    const [pat, name] = a._.slice(2);
    if (!pat || !(REPO_RE.test(pat) || /^[A-Za-z0-9_.-]+\/\*$/.test(pat))) throw usage('config map <owner/repo|owner/*> <identity>');
    if (!name || !next.identities[name]) throw usage(`identity "${name || ''}" is not defined`);
    next.repo_identity[pat] = name;
    return persist(ctx, next, `repo_identity ${pat} = ${name}`);
  }
  if (sub === 'repo') {
    const r = a._[2];
    if (!r || !REPO_RE.test(r)) throw usage('config repo <owner/repo>');
    next.default_repo = r;
    return persist(ctx, next, `default_repo = ${r}`);
  }
  throw usage(`unknown config subcommand "${sub}" (show | identity add|remove | default | map | repo)`);
}

// ---------------------------------------------------------------------------
// auth whoami
// ---------------------------------------------------------------------------
async function cmdAuth(ctx, a) {
  if (a._[1] !== 'whoami') throw usage('auth whoami [-R owner/repo]');
  const repo = repoOf(ctx, { required: false });
  const { name, def, via } = identityFor(ctx, repo && repo.full);
  const tok = await tokenFor(ctx);
  const rep = { identity: name, source: def.source, selected_via: via, host: def.host || 'github.com', token_kind: tokenKind(tok) };
  if (ctx.tokenExpires) rep.token_expires_at = ctx.tokenExpires;
  if (rep.token_kind === 'installation') {
    const r = await api(ctx, 'GET', '/installation/repositories', { query: { per_page: 5 } });
    rep.actor = { type: 'GitHub App installation', repositories_count: r.data && r.data.total_count, first_repositories: ((r.data && r.data.repositories) || []).map((x) => x.full_name) };
    const act = await actingAs(ctx);
    if (act.app) rep.actor.app = act.app;
  } else {
    const r = await api(ctx, 'GET', '/user');
    rep.actor = { login: r.data && r.data.login, type: r.data && r.data.type };
    const sc = r.headers.get('x-oauth-scopes');
    if (sc !== null) rep.oauth_scopes = sc;
  }
  try {
    const rl = await api(ctx, 'GET', '/rate_limit');
    const res = (rl.data && rl.data.resources) || {};
    rep.rate_limit = Object.fromEntries(['core', 'graphql', 'search'].filter((k) => res[k]).map((k) => [k, { limit: res[k].limit, remaining: res[k].remaining, reset: new Date(res[k].reset * 1000).toISOString() }]));
  } catch (e) {
    rep.rate_limit = { error: redact(e.message) };
  }
  if (repo) {
    try {
      const r = await api(ctx, 'GET', repo.rp);
      rep.repo = { full_name: r.data.full_name, private: r.data.private, permissions: r.data.permissions || null };
    } catch (e) {
      if (!(e instanceof CliError)) throw e;
      rep.repo = { full_name: repo.full, error: redact(e.message) };
    }
  }
  return outJson(rep);
}

// ---------------------------------------------------------------------------
// lint
// ---------------------------------------------------------------------------
function cmdLint(ctx, a) {
  const file = a._[1];
  if (!file) throw usage('lint <file>');
  const issues = lintMarkdown(readFileArg(file, 'lint'));
  outJson({ file: path.resolve(file), ok: issues.length === 0, issues });
  if (issues.length) throw new CliError(EXIT.GUARDRAIL, `lint: ${issues.length} issue(s); writes with this body are refused until fixed.`);
}

// ---------------------------------------------------------------------------
// Discussions
// ---------------------------------------------------------------------------
const Q = {
  categories: `query RepoCategories($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) { id nameWithOwner discussionCategories(first: 100) { nodes { id name slug isAnswerable emoji description } } }
}`,
  list: `query ListDiscussions($owner: String!, $name: String!, $first: Int!, $categoryId: ID, $answered: Boolean) {
  repository(owner: $owner, name: $name) {
    discussions(first: $first, categoryId: $categoryId, answered: $answered, orderBy: { field: UPDATED_AT, direction: DESC }) {
      totalCount
      nodes { id number title url isAnswered closed locked createdAt updatedAt author { login } category { name } comments { totalCount } }
    }
  }
}`,
  search: `query SearchDiscussions($q: String!, $first: Int!) {
  search(type: DISCUSSION, query: $q, first: $first) {
    discussionCount
    nodes { ... on Discussion { id number title url isAnswered closed category { name } repository { nameWithOwner } } }
  }
}`,
  get: `query GetDiscussion($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    discussion(number: $number) {
      id number title body url closed locked isAnswered createdAt author { login }
      category { id name isAnswerable }
      answer { id url author { login } }
      comments(first: 100) {
        totalCount
        nodes {
          id url body isAnswer createdAt author { login }
          replies(first: 100) { totalCount nodes { id url body isAnswer createdAt author { login } } }
        }
      }
    }
  }
}`,
  body: `query DiscussionBody($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { discussion(number: $number) { id number title body url isAnswered answer { id } category { id name isAnswerable } } }
}`,
  create: `mutation CreateDiscussion($input: CreateDiscussionInput!) { createDiscussion(input: $input) { discussion { id number url title } } }`,
  comment: `mutation AddDiscussionComment($input: AddDiscussionCommentInput!) { addDiscussionComment(input: $input) { comment { id url } } }`,
  mark: `mutation MarkAnswer($input: MarkDiscussionCommentAsAnswerInput!) { markDiscussionCommentAsAnswer(input: $input) { discussion { id number isAnswered } } }`,
  unmark: `mutation UnmarkAnswer($input: UnmarkDiscussionCommentAsAnswerInput!) { unmarkDiscussionCommentAsAnswer(input: $input) { discussion { id number isAnswered } } }`,
  update: `mutation UpdateDiscussion($input: UpdateDiscussionInput!) { updateDiscussion(input: $input) { discussion { id number url title } } }`,
  updateComment: `mutation UpdateDiscussionComment($input: UpdateDiscussionCommentInput!) { updateDiscussionComment(input: $input) { comment { id url } } }`,
  close: `mutation CloseDiscussion($input: CloseDiscussionInput!) { closeDiscussion(input: $input) { discussion { id number closed } } }`,
  reopen: `mutation ReopenDiscussion($input: ReopenDiscussionInput!) { reopenDiscussion(input: $input) { discussion { id number closed } } }`,
  lock: `mutation LockLockable($input: LockLockableInput!) { lockLockable(input: $input) { lockedRecord { locked } } }`,
  unlock: `mutation UnlockLockable($input: UnlockLockableInput!) { unlockLockable(input: $input) { unlockedRecord { locked } } }`,
};

async function categories(ctx, repo) {
  const r = await gql(ctx, Q.categories, { owner: repo.owner, name: repo.name });
  if (!r.data.repository) throw apiErr(`repository ${repo.full} not found OR no access with this identity.`);
  return { repoId: r.data.repository.id, list: r.data.repository.discussionCategories.nodes };
}
function findCategory(cats, name) {
  if (!name) throw usage('--category NAME is required');
  const c = cats.find((x) => x.name === name) || cats.find((x) => x.name.toLowerCase() === String(name).toLowerCase() || x.slug === name);
  if (!c) throw usage(`category "${name}" not found. Available: ${cats.map((x) => x.name).join(', ')}`);
  return c;
}
async function discussionBody(ctx, repo, number) {
  const r = await gql(ctx, Q.body, { owner: repo.owner, name: repo.name, number });
  const d = r.data.repository && r.data.repository.discussion;
  if (!d) throw apiErr(`discussion #${number} not found in ${repo.full} (or no access with this identity).`);
  return d;
}

async function duplicateCandidates(ctx, repo, title) {
  const seen = new Map();
  const q = `repo:${repo.full} in:title ${normaliseTitle(title)}`;
  const s = await gql(ctx, Q.search, { q, first: 20 });
  for (const n of (s.data.search && s.data.search.nodes) || []) if (n && n.number) seen.set(n.number, n);
  const l = await gql(ctx, Q.list, { owner: repo.owner, name: repo.name, first: 100 });
  for (const n of (l.data.repository && l.data.repository.discussions.nodes) || []) if (!seen.has(n.number)) seen.set(n.number, n);
  const nt = normaliseTitle(title);
  const out = [];
  for (const n of seen.values()) {
    const sim = normaliseTitle(n.title) === nt ? 1 : titleSimilarity(title, n.title);
    if (sim >= 0.8) out.push({ number: n.number, title: n.title, url: n.url, similarity: Math.round(sim * 100) / 100 });
  }
  return out.sort((a, b) => b.similarity - a.similarity);
}
async function refuseDuplicates(ctx, repo, title) {
  if (ctx.f['allow-duplicate']) return [];
  const c = await duplicateCandidates(ctx, repo, title);
  if (c.length) throw guard(`a discussion with this or a very similar title already exists (similarity >= 0.8):\n${c.map((x) => `  #${x.number} ${x.title} (${x.similarity}) ${x.url}`).join('\n')}\nAdd to the existing one instead, or pass --allow-duplicate if it really is a different topic.`);
  return c;
}
const titleWarnings = (t) => (String(t).length > 80 ? [`title is ${String(t).length} characters (> 80): GitHub lists truncate it; consider shortening`] : []);

const summarizeComment = (c) => ({ id: c.id, author: c.author && c.author.login, is_answer: !!c.isAnswer, created_at: c.createdAt, url: c.url, body: c.body });

async function cmdDiscussions(ctx, a) {
  const sub = a._[1];
  const pos = a._.slice(2);
  const f = a.f;
  if (sub === 'categories') {
    const repo = repoOf(ctx);
    const c = await categories(ctx, repo);
    return outJson({ repo: repo.full, categories: c.list.map((x) => ({ id: x.id, name: x.name, slug: x.slug, isAnswerable: x.isAnswerable, emoji: x.emoji })) });
  }
  if (sub === 'list') {
    const repo = repoOf(ctx);
    if (f.answered && f.unanswered) throw usage('pass --answered or --unanswered, not both');
    let categoryId;
    if (f.category) categoryId = findCategory((await categories(ctx, repo)).list, f.category).id;
    const r = await gql(ctx, Q.list, { owner: repo.owner, name: repo.name, first: parseLimit(f.limit, 30, 100), categoryId, answered: f.answered ? true : f.unanswered ? false : undefined });
    const d = r.data.repository.discussions;
    return outJson({ repo: repo.full, total: d.totalCount, discussions: d.nodes.map((n) => ({ number: n.number, title: n.title, category: n.category && n.category.name, answered: n.isAnswered, closed: n.closed, comments: n.comments.totalCount, author: n.author && n.author.login, updated_at: n.updatedAt, url: n.url })) });
  }
  if (sub === 'search') {
    const repo = repoOf(ctx);
    const text = pos.join(' ');
    if (!text) throw usage('discussions search -R owner/repo "<text>"');
    const r = await gql(ctx, Q.search, { q: `repo:${repo.full} in:title ${text}`, first: parseLimit(f.limit, 20, 100) });
    return outJson({ repo: repo.full, query: text, total: r.data.search.discussionCount, discussions: r.data.search.nodes.filter((n) => n && n.number).map((n) => ({ number: n.number, title: n.title, category: n.category && n.category.name, answered: n.isAnswered, closed: n.closed, url: n.url })) });
  }
  if (sub === 'get') {
    const repo = repoOf(ctx);
    const number = posInt(pos[0], '<number>');
    const r = await gql(ctx, Q.get, { owner: repo.owner, name: repo.name, number });
    const d = r.data.repository && r.data.repository.discussion;
    if (!d) throw apiErr(`discussion #${number} not found in ${repo.full} (or no access with this identity).`);
    return outJson({
      id: d.id, number: d.number, title: d.title, url: d.url, category: d.category, closed: d.closed, locked: d.locked, author: d.author && d.author.login,
      answered: d.isAnswered, answer: d.answer ? { id: d.answer.id, url: d.answer.url, author: d.answer.author && d.answer.author.login } : null, body: d.body,
      comments_total: d.comments.totalCount,
      comments: d.comments.nodes.map((c) => ({ ...summarizeComment(c), replies: c.replies.nodes.map(summarizeComment), replies_total: c.replies.totalCount })),
    });
  }
  if (sub === 'create') {
    const repo = repoOf(ctx);
    if (!f.title) throw usage('discussions create -R owner/repo --category NAME --title T --body-file F [--allow-duplicate]');
    const body = readBody(ctx, f['body-file']);
    const cats = await categories(ctx, repo);
    const cat = findCategory(cats.list, f.category);
    await refuseDuplicates(ctx, repo, f.title);
    const acting = await actingAs(ctx);
    const r = await gql(ctx, Q.create, { input: { repositoryId: cats.repoId, categoryId: cat.id, title: f.title, body } }, { write: true });
    const warnings = titleWarnings(f.title);
    if (r.dryRun) return outJson({ ...r.plan, acting_as: acting, warnings });
    const d = r.data.createDiscussion.discussion;
    return outJson({ created: { number: d.number, id: d.id, url: d.url, title: d.title, category: cat.name }, acting_as: acting, warnings });
  }
  if (sub === 'comment') {
    const repo = repoOf(ctx);
    const number = posInt(pos[0], '<number>');
    const body = readBody(ctx, f['body-file']);
    const d = await discussionBody(ctx, repo, number);
    const acting = await actingAs(ctx);
    const input = { discussionId: d.id, body };
    if (f['reply-to']) input.replyToId = f['reply-to'];
    const r = await gql(ctx, Q.comment, { input }, { write: true });
    if (r.dryRun) return outJson({ ...r.plan, acting_as: acting });
    return outJson({ commented: r.data.addDiscussionComment.comment, discussion: number, acting_as: acting });
  }
  if (sub === 'answer') {
    const repo = repoOf(ctx);
    const number = posInt(pos[0], '<number>');
    const body = readBody(ctx, f['body-file']);
    const d = await discussionBody(ctx, repo, number);
    if (!d.category.isAnswerable) throw guard(`category "${d.category.name}" of #${number} is not answerable (not a Q&A-style category); answers cannot be marked there. Post a normal comment (discussions comment) instead.`);
    if (d.isAnswered && !f['replace-answer']) throw guard(`#${number} already has a marked answer (${d.answer && d.answer.id}). Pass --replace-answer to post a new answer and mark it instead.`);
    const acting = await actingAs(ctx);
    if (ctx.dryRun) {
      const p1 = (await gql(ctx, Q.comment, { input: { discussionId: d.id, body } }, { write: true })).plan;
      const p2 = (await gql(ctx, Q.mark, { input: { id: '<new comment id>' } }, { write: true })).plan;
      return outJson({ dry_run: true, steps: [p1, p2], acting_as: acting });
    }
    const c = (await gql(ctx, Q.comment, { input: { discussionId: d.id, body } }, { write: true })).data.addDiscussionComment.comment;
    await gql(ctx, Q.mark, { input: { id: c.id } }, { write: true });
    return outJson({ answered: number, comment: c, marked_as_answer: true, replaced_previous: !!d.isAnswered, acting_as: acting });
  }
  if (sub === 'mark-answer' || sub === 'unmark-answer') {
    repoOf(ctx, { required: false });
    const id = pos[0];
    if (!id) throw usage(`discussions ${sub} <comment-node-id>`);
    const acting = await actingAs(ctx);
    const r = await gql(ctx, sub === 'mark-answer' ? Q.mark : Q.unmark, { input: { id } }, { write: true });
    if (r.dryRun) return outJson({ ...r.plan, acting_as: acting });
    return outJson({ [sub === 'mark-answer' ? 'marked' : 'unmarked']: id, discussion: (r.data.markDiscussionCommentAsAnswer || r.data.unmarkDiscussionCommentAsAnswer).discussion, acting_as: acting });
  }
  if (sub === 'edit') {
    const repo = repoOf(ctx);
    const number = posInt(pos[0], '<number>');
    if (!f.title && !f['body-file'] && !f.category) throw usage('discussions edit needs --title, --body-file and/or --category');
    const input = {};
    if (f['body-file']) input.body = readBody(ctx, f['body-file']);
    const d = await discussionBody(ctx, repo, number);
    input.discussionId = d.id;
    if (f.title) input.title = f.title;
    if (f.category) input.categoryId = findCategory((await categories(ctx, repo)).list, f.category).id;
    const acting = await actingAs(ctx);
    const r = await gql(ctx, Q.update, { input }, { write: true });
    const extra = {};
    if (input.body !== undefined) extra.body_diff = unifiedDiff(d.body, input.body, { from: `#${number} body (current)`, to: `#${number} body (new)` });
    if (r.dryRun) return outJson({ ...r.plan, ...extra, acting_as: acting, warnings: f.title ? titleWarnings(f.title) : [] });
    return outJson({ updated: r.data.updateDiscussion.discussion, acting_as: acting });
  }
  if (sub === 'edit-comment') {
    repoOf(ctx, { required: false });
    const id = pos[0];
    if (!id) throw usage('discussions edit-comment <comment-node-id> --body-file F');
    const body = readBody(ctx, f['body-file']);
    const acting = await actingAs(ctx);
    const r = await gql(ctx, Q.updateComment, { input: { commentId: id, body } }, { write: true });
    if (r.dryRun) return outJson({ ...r.plan, acting_as: acting });
    return outJson({ updated: r.data.updateDiscussionComment.comment, acting_as: acting });
  }
  if (['close', 'reopen', 'lock', 'unlock'].includes(sub)) {
    const repo = repoOf(ctx);
    const number = posInt(pos[0], '<number>');
    const d = await discussionBody(ctx, repo, number);
    let q;
    let input;
    if (sub === 'close') {
      const reason = (f.reason || 'RESOLVED').toUpperCase();
      if (!['RESOLVED', 'OUTDATED', 'DUPLICATE'].includes(reason)) throw usage('--reason for close: RESOLVED|OUTDATED|DUPLICATE');
      q = Q.close; input = { discussionId: d.id, reason };
    } else if (sub === 'reopen') { q = Q.reopen; input = { discussionId: d.id }; } else if (sub === 'lock') {
      q = Q.lock; input = { lockableId: d.id };
      if (f.reason) {
        const reason = f.reason.toUpperCase();
        if (!['RESOLVED', 'OFF_TOPIC', 'TOO_HEATED', 'SPAM'].includes(reason)) throw usage('--reason for lock: RESOLVED|OFF_TOPIC|TOO_HEATED|SPAM');
        input.lockReason = reason;
      }
    } else { q = Q.unlock; input = { lockableId: d.id }; }
    const acting = await actingAs(ctx);
    const r = await gql(ctx, q, { input }, { write: true });
    if (r.dryRun) return outJson({ ...r.plan, acting_as: acting });
    return outJson({ [sub === 'close' ? 'closed' : sub === 'reopen' ? 'reopened' : sub === 'lock' ? 'locked' : 'unlocked']: number, acting_as: acting });
  }
  throw usage(`unknown discussions subcommand "${sub}" (categories | list | search | get | create | comment | answer | mark-answer | unmark-answer | edit | edit-comment | close | reopen | lock | unlock)`);
}

// ---------------------------------------------------------------------------
// FAQ index (pure parse/append; exported)
// ---------------------------------------------------------------------------
const SEP_RE = /^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/;
const ENTRY_RE = /^\s*[-*]\s+\[(.+)\]\((\S+?)\)\s*$/;
const GROUP_RE = /^###\s+(.+?)\s*#*\s*$/;
export function parseDiscussionUrl(u) {
  const m = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/discussions\/(\d+)\/?(?:[#?].*)?$/.exec(String(u));
  return m ? { repo: `${m[1]}/${m[2]}`, number: Number(m[3]) } : null;
}
export function parseFaqIndex(body, repoFull) {
  const lines = String(body || '').replace(/\r\n?/g, '\n').split('\n');
  const sep = lines.findIndex((l) => SEP_RE.test(l));
  const res = { has_separator: sep >= 0, intro: sep >= 0 ? lines.slice(0, sep).join('\n').trim() : '', groups: [], problems: [] };
  if (sep < 0) {
    res.problems.push({ line: null, problem: 'no "---" separator between the intro and the grouped entries' });
    return res;
  }
  const seen = new Map();
  let g = null;
  for (let i = sep + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    const gm = GROUP_RE.exec(l);
    if (gm) { g = { name: gm[1], line: i + 1, entries: [] }; res.groups.push(g); continue; }
    if (/^#{1,6}\s/.test(l)) { res.problems.push({ line: i + 1, problem: `heading "${l.trim()}" is not a "### Group" heading` }); continue; }
    const em = ENTRY_RE.exec(l);
    if (em) {
      const e = { title: em[1], url: em[2], line: i + 1 };
      const u = parseDiscussionUrl(e.url);
      if (u) { e.repo = u.repo; e.number = u.number; }
      if (!g) res.problems.push({ line: i + 1, problem: 'entry before any "### Group" heading' });
      if (!u) res.problems.push({ line: i + 1, problem: `link is not a discussion URL: ${e.url}` });
      else if (repoFull && u.repo.toLowerCase() !== repoFull.toLowerCase()) res.problems.push({ line: i + 1, problem: `links to another repository (${u.repo}): ${e.url}` });
      if (u) {
        const key = `${u.repo.toLowerCase()}#${u.number}`;
        if (seen.has(key)) res.problems.push({ line: i + 1, problem: `duplicate link to #${u.number} (also on line ${seen.get(key)})` });
        else seen.set(key, i + 1);
      }
      if (g) g.entries.push(e);
      else (res.orphans = res.orphans || []).push(e);
      continue;
    }
    if (/^\s*[-*]\s/.test(l)) res.problems.push({ line: i + 1, problem: `broken entry (expected "- [Title](url)"): ${l.trim()}` });
    else res.problems.push({ line: i + 1, problem: `unrecognised line in the index section: ${excerpt(l, 80)}` });
  }
  return res;
}
const escTitle = (t) => String(t).replace(/([[\]])/g, '\\$1');
export const faqEntryLine = (title, url) => `- [${escTitle(title)}](${url})`;

// Append an entry at the end of a group (create the group at the end if missing). Never reorders.
export function appendToIndex(body, group, entry) {
  const src = String(body || '').replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  const sep = lines.findIndex((l) => SEP_RE.test(l));
  if (sep < 0) throw guard('the index body has no "---" separator between the intro and the grouped entries; fix the index first (faq index shows problems).');
  const target = parseDiscussionUrl(entry.url);
  for (let i = sep + 1; i < lines.length; i++) {
    const m = ENTRY_RE.exec(lines[i]);
    if (!m) continue;
    const u = parseDiscussionUrl(m[2]);
    if ((u && target && u.repo.toLowerCase() === target.repo.toLowerCase() && u.number === target.number) || m[2] === entry.url) {
      return { body: src, changed: false, reason: `already linked on line ${i + 1}` };
    }
  }
  const line = faqEntryLine(entry.title, entry.url);
  let h = -1;
  for (let i = sep + 1; i < lines.length; i++) {
    const gm = GROUP_RE.exec(lines[i]);
    if (gm && gm[1].trim().toLowerCase() === String(group).trim().toLowerCase()) { h = i; break; }
  }
  if (h >= 0) {
    let end = lines.length;
    for (let i = h + 1; i < lines.length; i++) if (/^#{1,6}\s/.test(lines[i])) { end = i; break; }
    let last = end - 1;
    while (last > h && !lines[last].trim()) last--;
    const ins = last === h ? ['', line] : [line];
    lines.splice(last + 1, 0, ...ins);
    return { body: lines.join('\n'), changed: true, group_created: false, line: last + ins.length + 1 };
  }
  const hadNl = src.endsWith('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  lines.push('', `### ${group}`, '', line);
  return { body: lines.join('\n') + (hadNl ? '\n' : ''), changed: true, group_created: true, line: lines.length };
}

async function discussionTitles(ctx, repo, numbers) {
  const uniq = [...new Set(numbers)];
  if (!uniq.length) return {};
  const fields = uniq.map((n) => `d${n}: discussion(number: ${n}) { number title url }`).join('\n    ');
  const q = `query DiscussionTitles($owner: String!, $name: String!) {\n  repository(owner: $owner, name: $name) {\n    ${fields}\n  }\n}`;
  const r = await gql(ctx, q, { owner: repo.owner, name: repo.name }, { allowPartial: true });
  const repoData = r.data.repository || {};
  const outMap = {};
  for (const n of uniq) outMap[n] = repoData[`d${n}`] || null;
  return outMap;
}

const PIN_NOTE = 'GitHub has no API to pin a discussion: pin the index once in the web UI (discussion page -> "Pin discussion").';

function progressPath(repo, title) {
  const slug = normaliseTitle(title).replace(/ /g, '-').slice(0, 60) || 'untitled';
  return path.join(stateDir(), 'faq-progress', `${repo.owner}-${repo.name}-${slug}.json`.replace(/[^A-Za-z0-9._-]/g, '_'));
}
function saveProgress(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
}

async function indexAdd(ctx, repo, indexNumber, entryNumber, group, { entry: known } = {}) {
  const idx = await discussionBody(ctx, repo, indexNumber);
  let entry = known;
  if (!entry) {
    const t = (await discussionTitles(ctx, repo, [entryNumber]))[entryNumber];
    if (!t) throw apiErr(`discussion #${entryNumber} not found in ${repo.full} (or no access with this identity).`);
    entry = { title: t.title, url: t.url };
  }
  const res = appendToIndex(idx.body, group, entry);
  return { idx, entry, res };
}

async function cmdFaq(ctx, a) {
  const sub = a._[1];
  const pos = a._.slice(2);
  const f = a.f;
  if (sub === 'index') {
    const repo = repoOf(ctx);
    const number = posInt(pos[0], '<index-number>');
    const d = await discussionBody(ctx, repo, number);
    const parsed = parseFaqIndex(d.body, repo.full);
    const nums = parsed.groups.flatMap((g) => g.entries).filter((e) => e.number && e.repo && e.repo.toLowerCase() === repo.full.toLowerCase()).map((e) => e.number);
    const titles = await discussionTitles(ctx, repo, nums);
    for (const g of parsed.groups) {
      for (const e of g.entries) {
        if (!e.number || !e.repo || e.repo.toLowerCase() !== repo.full.toLowerCase()) continue;
        const t = titles[e.number];
        if (!t) { parsed.problems.push({ line: e.line, problem: `#${e.number} is missing (deleted, transferred or no access)` }); e.status = 'missing'; continue; }
        e.current_title = t.title;
        if (t.title.trim() !== e.title.replace(/\\([[\]])/g, '$1').trim()) parsed.problems.push({ line: e.line, problem: `title changed: index says "${e.title}", #${e.number} is now "${t.title}"` });
      }
    }
    parsed.problems.sort((x, y) => (x.line || 0) - (y.line || 0));
    return outJson({ index: { number: d.number, title: d.title, url: d.url }, intro: parsed.intro, groups: parsed.groups.map((g) => ({ name: g.name, count: g.entries.length, entries: g.entries })), problems: parsed.problems, pinning: PIN_NOTE });
  }
  if (sub === 'index-create') {
    const repo = repoOf(ctx);
    if (!f.title) throw usage('faq index-create -R owner/repo --category NAME --title T --intro-file F');
    const intro = readBody(ctx, f['intro-file'], '--intro-file');
    const body = `${intro}\n\n---\n`;
    const cats = await categories(ctx, repo);
    const cat = findCategory(cats.list, f.category);
    await refuseDuplicates(ctx, repo, f.title);
    const acting = await actingAs(ctx);
    const r = await gql(ctx, Q.create, { input: { repositoryId: cats.repoId, categoryId: cat.id, title: f.title, body } }, { write: true });
    if (r.dryRun) return outJson({ ...r.plan, acting_as: acting, pinning: PIN_NOTE });
    const d = r.data.createDiscussion.discussion;
    return outJson({ created_index: { number: d.number, url: d.url, title: d.title }, acting_as: acting, pinning: PIN_NOTE, next: `faq index-add -R ${repo.full} ${d.number} --entry <n> --group "Name"` });
  }
  if (sub === 'index-add') {
    const repo = repoOf(ctx);
    const indexNumber = posInt(pos[0] || f.index, '<index-number>');
    const entryNumber = posInt(f.entry, '--entry');
    if (!f.group) throw usage('--group "Name" is required');
    const { idx, entry, res } = await indexAdd(ctx, repo, indexNumber, entryNumber, f.group);
    if (!res.changed) return outJson({ no_op: true, reason: res.reason, index: indexNumber, entry: entryNumber });
    const acting = await actingAs(ctx);
    const diff = unifiedDiff(idx.body, res.body, { from: `#${indexNumber} body (current)`, to: `#${indexNumber} body (new)` });
    const r = await gql(ctx, Q.update, { input: { discussionId: idx.id, body: res.body } }, { write: true });
    if (r.dryRun) return outJson({ ...r.plan, diff, acting_as: acting });
    return outJson({ indexed: { index: indexNumber, entry: entryNumber, title: entry.title, group: f.group, group_created: res.group_created }, diff, acting_as: acting });
  }
  if (sub === 'add') {
    const repo = repoOf(ctx);
    const indexNumber = posInt(f.index, '--index');
    if (!f.title || !f.group) throw usage('faq add -R owner/repo --index N --category NAME --group "Name" --title T --question-file Q --answer-file A [--allow-duplicate]');
    const question = readBody(ctx, f['question-file'], '--question-file');
    const answer = readBody(ctx, f['answer-file'], '--answer-file');
    const pfile = progressPath(repo, f.title);
    let prog = null;
    if (fs.existsSync(pfile)) {
      prog = parseJson(fs.readFileSync(pfile, 'utf8'));
      if (prog && prog.title !== f.title) prog = null;
    }
    const resumed = !!(prog && prog.created);
    if (prog && prog.completed) return outJson({ already_completed: true, discussion: prog.created, progress_file: pfile, note: 'nothing to do; delete the progress file to start over' });
    prog = prog || { repo: repo.full, title: f.title, index: indexNumber, group: f.group, category: f.category, started_at: new Date().toISOString() };
    const cats = await categories(ctx, repo);
    const cat = findCategory(cats.list, f.category);
    if (!cat.isAnswerable) throw guard(`category "${cat.name}" is not answerable, so the answer cannot be marked. Use a Q&A-style category.`);
    const idx = await discussionBody(ctx, repo, indexNumber);
    if (!parseFaqIndex(idx.body, repo.full).has_separator) throw guard(`#${indexNumber} does not look like a FAQ index (no "---" separator); check --index.`);
    if (!prog.created) await refuseDuplicates(ctx, repo, f.title);
    const acting = await actingAs(ctx);
    const steps = [
      { step: 'dedupe', status: prog.created ? 'done' : f['allow-duplicate'] ? 'skipped (--allow-duplicate)' : 'passed' },
      { step: 'create', status: prog.created ? `done (#${prog.created.number})` : 'pending', detail: `createDiscussion in "${cat.name}": ${f.title}` },
      { step: 'answer', status: prog.answer_comment ? 'done' : 'pending', detail: 'addDiscussionComment with the answer file' },
      { step: 'mark-answer', status: prog.marked ? 'done' : 'pending', detail: 'markDiscussionCommentAsAnswer' },
      { step: 'index-add', status: prog.indexed ? 'done' : 'pending', detail: `append to group "${f.group}" of index #${indexNumber}` },
    ];
    if (ctx.dryRun) {
      const preview = appendToIndex(idx.body, f.group, { title: f.title, url: prog.created ? prog.created.url : `https://github.com/${repo.full}/discussions/NEW` });
      return outJson({ dry_run: true, plan: steps, index_diff: preview.changed ? unifiedDiff(idx.body, preview.body, { from: `#${indexNumber} body (current)`, to: `#${indexNumber} body (new)` }) : `no change: ${preview.reason}`, warnings: titleWarnings(f.title), progress_file: pfile, acting_as: acting });
    }
    const save = () => saveProgress(pfile, prog);
    save();
    if (!prog.created) {
      const d = (await gql(ctx, Q.create, { input: { repositoryId: cats.repoId, categoryId: cat.id, title: f.title, body: question } }, { write: true })).data.createDiscussion.discussion;
      prog.created = { number: d.number, id: d.id, url: d.url };
      save();
    }
    if (!prog.answer_comment) {
      const c = (await gql(ctx, Q.comment, { input: { discussionId: prog.created.id, body: answer } }, { write: true })).data.addDiscussionComment.comment;
      prog.answer_comment = { id: c.id, url: c.url };
      save();
    }
    if (!prog.marked) {
      await gql(ctx, Q.mark, { input: { id: prog.answer_comment.id } }, { write: true });
      prog.marked = true;
      save();
    }
    if (!prog.indexed) {
      const { idx: cur, res } = await indexAdd(ctx, repo, indexNumber, prog.created.number, f.group, { entry: { title: f.title, url: prog.created.url } });
      if (res.changed) await gql(ctx, Q.update, { input: { discussionId: cur.id, body: res.body } }, { write: true });
      prog.indexed = true;
      prog.group_created = !!res.group_created;
      save();
    }
    prog.completed = true;
    prog.completed_at = new Date().toISOString();
    save();
    return outJson({ added: { number: prog.created.number, url: prog.created.url, title: f.title, group: f.group, index: indexNumber }, resumed, answer_comment: prog.answer_comment, warnings: titleWarnings(f.title), progress_file: pfile, acting_as: acting });
  }
  throw usage(`unknown faq subcommand "${sub}" (index | index-create | index-add | add)`);
}

// ---------------------------------------------------------------------------
// PR review mechanics (pure patch parsing / validation; exported)
// ---------------------------------------------------------------------------
export function parsePatch(patch) {
  const hunks = [];
  let h = null;
  let o = 0;
  let n = 0;
  for (const l of String(patch || '').split('\n')) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (m) {
      o = Number(m[1]); n = Number(m[3]);
      h = { oldStart: o, oldLines: m[2] === undefined ? 1 : Number(m[2]), newStart: n, newLines: m[4] === undefined ? 1 : Number(m[4]), left: [], right: [] };
      hunks.push(h);
      continue;
    }
    if (!h || l.startsWith('\\')) continue;
    const c = l[0];
    if (c === '+') { h.right.push(n); n++; } else if (c === '-') { h.left.push(o); o++; } else if (c === ' ' || l === '') {
      if (l === '' && o >= h.oldStart + h.oldLines && n >= h.newStart + h.newLines) continue; // trailing newline of the patch
      h.left.push(o); h.right.push(n); o++; n++;
    }
  }
  const right = hunks.flatMap((x) => x.right);
  const left = hunks.flatMap((x) => x.left);
  return { hunks, right, left };
}
export function compactRanges(nums) {
  const s = [...new Set(nums)].sort((a, b) => a - b);
  const outR = [];
  for (let i = 0; i < s.length; i++) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    outR.push(i === j ? `${s[i]}` : `${s[i]}-${s[j]}`);
    i = j;
  }
  return outR.join(',');
}
const SIDES = ['RIGHT', 'LEFT'];
// files: [{filename, status, patch}] from GET pulls/{n}/files. Returns {errors, comments}.
export function validateReviewComments(comments, files) {
  const byPath = new Map(files.map((x) => [x.filename, x]));
  const errors = [];
  const outC = [];
  (comments || []).forEach((c, idx) => {
    const at = `comments[${idx}]${c && c.path ? ` (${c.path}:${c.line})` : ''}`;
    if (!c || typeof c !== 'object') { errors.push(`${at}: not an object`); return; }
    if (c.position !== undefined) { errors.push(`${at}: "position" is not used; give line (+ side) in file coordinates`); return; }
    const file = byPath.get(c.path);
    if (!file) { errors.push(`${at}: path "${c.path}" is not changed in this PR`); return; }
    if (!file.patch) { errors.push(`${at}: ${c.path} has no diff hunk (binary or too large): line comments are impossible; mention it in the review body`); return; }
    const side = String(c.side || 'RIGHT').toUpperCase();
    if (!SIDES.includes(side)) { errors.push(`${at}: side must be RIGHT or LEFT`); return; }
    if (!Number.isInteger(c.line) || c.line < 1) { errors.push(`${at}: line must be a positive integer`); return; }
    const pp = parsePatch(file.patch);
    const lineSet = (s) => (s === 'RIGHT' ? pp.right : pp.left);
    const hunkOf = (s, ln) => pp.hunks.findIndex((hk) => (s === 'RIGHT' ? hk.right : hk.left).includes(ln));
    if (!lineSet(side).includes(c.line)) { errors.push(`${at}: line ${c.line} is not commentable on ${side} (commentable: ${compactRanges(lineSet(side)) || 'none'})`); return; }
    const o = { path: c.path, line: c.line, side };
    if (c.start_line !== undefined) {
      const ss = String(c.start_side || side).toUpperCase();
      if (!SIDES.includes(ss)) { errors.push(`${at}: start_side must be RIGHT or LEFT`); return; }
      if (!Number.isInteger(c.start_line) || c.start_line < 1) { errors.push(`${at}: start_line must be a positive integer`); return; }
      if (ss === side && c.start_line >= c.line) { errors.push(`${at}: start_line must be before line`); return; }
      if (!lineSet(ss).includes(c.start_line)) { errors.push(`${at}: start_line ${c.start_line} is not commentable on ${ss}`); return; }
      if (hunkOf(ss, c.start_line) !== hunkOf(side, c.line)) { errors.push(`${at}: range ${c.start_line}-${c.line} spans more than one diff hunk; a multi-line comment must stay inside one hunk`); return; }
      o.start_line = c.start_line;
      o.start_side = ss;
    }
    if (c.suggestion !== undefined) {
      if (side !== 'RIGHT' || (o.start_side && o.start_side !== 'RIGHT')) { errors.push(`${at}: a suggestion can only replace lines on the RIGHT (new) side`); return; }
      if (typeof c.suggestion !== 'string') { errors.push(`${at}: suggestion must be a string (the replacement text)`); return; }
    }
    o._src = c;
    outC.push(o);
  });
  return { errors, comments: outC };
}
export const suggestionBody = (body, suggestion) => `${body ? body.replace(/\s+$/, '') + '\n\n' : ''}\`\`\`suggestion\n${suggestion.replace(/\n$/, '')}\n\`\`\``;

const THREADS_Q = `query ReviewThreads($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path line startLine diffSide viewerCanResolve viewerCanUnresolve
          firstComment: comments(first: 1) { totalCount nodes { author { login } body url } }
          lastComment: comments(last: 1) { nodes { author { login } body } }
        }
      }
    }
  }
}`;
const THREAD_NODE_Q = `query ThreadNode($id: ID!) { node(id: $id) { ... on PullRequestReviewThread { id isResolved viewerCanResolve viewerCanUnresolve path } } }`;

async function prFiles(ctx, repo, n) {
  return (await paginate(ctx, `${repo.rp}/pulls/${n}/files`, { limit: 3000 })).values;
}

async function cmdPrs(ctx, a) {
  const sub = a._[1];
  const pos = a._.slice(2);
  const f = a.f;
  if (sub === 'lines') {
    const repo = repoOf(ctx);
    const n = posInt(pos[0], '<pr>');
    let files = await prFiles(ctx, repo, n);
    if (f.path) files = files.filter((x) => x.filename === f.path);
    const res = { pr: n, files: [], file_level_only: [] };
    for (const x of files) {
      if (!x.patch) { res.file_level_only.push({ path: x.filename, status: x.status, reason: 'no patch (binary, too large, or rename without changes)' }); continue; }
      const pp = parsePatch(x.patch);
      res.files.push({ path: x.filename, status: x.status, right: compactRanges(pp.right), left: compactRanges(pp.left), hunks: pp.hunks.map((h) => ({ new: `${h.newStart}-${h.newStart + Math.max(h.newLines, 1) - 1}`, old: `${h.oldStart}-${h.oldStart + Math.max(h.oldLines, 1) - 1}` })) });
    }
    res.note = 'comment on RIGHT lines (new file: added + context) or LEFT lines (old file: removed + context); a range must stay within one hunk';
    return outJson(res);
  }
  if (sub === 'review') {
    const repo = repoOf(ctx);
    const n = posInt(pos[0], '<pr>');
    if (!f.file) throw usage('prs review -R owner/repo <pr> --file review.json [--pending] [--dry-run]');
    const reviewPath = path.resolve(f.file);
    const spec = parseJson(readFileArg(f.file, '--file'));
    if (!spec || typeof spec !== 'object') throw usage(`${f.file} is not a JSON object`);
    const rel = (p) => path.resolve(path.dirname(reviewPath), p);
    const pending = !!f.pending;
    const event = spec.event ? String(spec.event).toUpperCase() : pending ? undefined : 'COMMENT';
    if (!pending && !['COMMENT', 'APPROVE', 'REQUEST_CHANGES'].includes(event)) throw usage('event must be COMMENT, APPROVE or REQUEST_CHANGES');
    let body = '';
    if (spec.body_file && spec.body !== undefined) throw usage('review: pass body_file or body, not both');
    if (spec.body_file) body = readBody(ctx, rel(spec.body_file), 'body_file');
    else if (typeof spec.body === 'string' && spec.body.trim()) { body = spec.body.replace(/\s+$/, ''); lintOrRefuse(ctx, body, 'review body'); }
    if (!pending && (event === 'COMMENT' || event === 'REQUEST_CHANGES') && !body) throw usage(`event ${event} needs a review body (body_file)`);
    const pr = (await api(ctx, 'GET', `${repo.rp}/pulls/${n}`)).data;
    const files = await prFiles(ctx, repo, n);
    const v = validateReviewComments(spec.comments || [], files);
    const comments = [];
    v.comments.forEach((c, i) => {
      const src = c._src;
      let cb = '';
      try {
        if (src.body_file && src.body !== undefined) throw usage('pass body_file or body, not both');
        if (src.body_file) cb = readBody(ctx, rel(src.body_file), `comments[${i}].body_file`);
        else if (typeof src.body === 'string') { cb = src.body.replace(/\s+$/, ''); if (cb) lintOrRefuse(ctx, cb, `comments[${i}].body`); }
      } catch (e) {
        v.errors.push(`${c.path}:${c.line}: ${e.message}`);
        return;
      }
      if (src.suggestion !== undefined) cb = suggestionBody(cb, src.suggestion);
      if (!cb) { v.errors.push(`${c.path}:${c.line}: comment has no body/body_file/suggestion`); return; }
      const o = { path: c.path, line: c.line, side: c.side, body: cb };
      if (c.start_line !== undefined) { o.start_line = c.start_line; o.start_side = c.start_side; }
      comments.push(o);
    });
    if (v.errors.length) throw guard(`review not sent; fix review.json (\`prs lines -R ${repo.full} ${n}\` lists commentable lines):\n${v.errors.map((e) => `  - ${e}`).join('\n')}`);
    const payload = { commit_id: pr.head.sha };
    if (body) payload.body = body;
    if (!pending) payload.event = event;
    payload.comments = comments;
    const acting = await actingAs(ctx);
    const r = await api(ctx, 'POST', `${repo.rp}/pulls/${n}/reviews`, { body: payload, write: true });
    if (r.dryRun) return outJson({ ...r.plan, validated: true, acting_as: acting });
    return outJson({ review: { id: r.data.id, state: r.data.state, url: r.data.html_url }, comments: comments.length, pending, acting_as: acting, ...(pending ? { note: 'pending review: submit it in the web UI or with gh api .../reviews/{id}/events' } : {}) });
  }
  if (sub === 'threads') {
    const repo = repoOf(ctx);
    const n = posInt(pos[0], '<pr>');
    const limit = parseLimit(f.limit, 100);
    const all = [];
    let after = null;
    for (let page = 0; page < 20; page++) {
      const r = await gql(ctx, THREADS_Q, { owner: repo.owner, name: repo.name, number: n, after });
      const pr = r.data.repository && r.data.repository.pullRequest;
      if (!pr) throw apiErr(`PR #${n} not found in ${repo.full} (or no access with this identity).`);
      all.push(...pr.reviewThreads.nodes);
      if (!pr.reviewThreads.pageInfo.hasNextPage) break;
      after = pr.reviewThreads.pageInfo.endCursor;
    }
    const sel = all.filter((t) => !f.unresolved || !t.isResolved).slice(0, limit);
    return outJson({
      pr: n, total: all.length, unresolved: all.filter((t) => !t.isResolved).length,
      threads: sel.map((t) => {
        const fc = t.firstComment.nodes[0] || {};
        const lc = t.lastComment.nodes[0] || {};
        return { id: t.id, resolved: t.isResolved, outdated: t.isOutdated, path: t.path, line: t.line, start_line: t.startLine, side: t.diffSide, viewer_can_resolve: t.viewerCanResolve, comments: t.firstComment.totalCount, first: { author: fc.author && fc.author.login, excerpt: excerpt(fc.body), url: fc.url }, last: { author: lc.author && lc.author.login, excerpt: excerpt(lc.body) } };
      }),
    });
  }
  if (sub === 'reply') {
    repoOf(ctx, { required: false });
    const id = pos[0];
    if (!id) throw usage('prs reply <thread-id> --body-file F');
    const body = readBody(ctx, f['body-file']);
    const acting = await actingAs(ctx);
    const r = await gql(ctx, `mutation AddThreadReply($input: AddPullRequestReviewThreadReplyInput!) { addPullRequestReviewThreadReply(input: $input) { comment { id url } } }`, { input: { pullRequestReviewThreadId: id, body } }, { write: true });
    if (r.dryRun) return outJson({ ...r.plan, acting_as: acting });
    return outJson({ replied: r.data.addPullRequestReviewThreadReply.comment, thread: id, acting_as: acting });
  }
  if (sub === 'resolve' || sub === 'unresolve') {
    repoOf(ctx, { required: false });
    const id = pos[0];
    if (!id) throw usage(`prs ${sub} <thread-id>`);
    const node = (await gql(ctx, THREAD_NODE_Q, { id })).data.node;
    if (!node || !node.id) throw apiErr(`review thread ${id} not found (or no access with this identity).`);
    if (sub === 'resolve' && !node.viewerCanResolve) throw guard(`this identity cannot resolve thread ${id} (viewerCanResolve is false${node.isResolved ? '; it is already resolved' : ''}). Only users with write access or the PR author can resolve.`);
    if (sub === 'unresolve' && !node.viewerCanUnresolve) throw guard(`this identity cannot unresolve thread ${id} (viewerCanUnresolve is false${!node.isResolved ? '; it is not resolved' : ''}).`);
    const acting = await actingAs(ctx);
    const m = sub === 'resolve'
      ? `mutation ResolveThread($input: ResolveReviewThreadInput!) { resolveReviewThread(input: $input) { thread { id isResolved } } }`
      : `mutation UnresolveThread($input: UnresolveReviewThreadInput!) { unresolveReviewThread(input: $input) { thread { id isResolved } } }`;
    const r = await gql(ctx, m, { input: { threadId: id } }, { write: true });
    if (r.dryRun) return outJson({ ...r.plan, acting_as: acting });
    return outJson({ [sub === 'resolve' ? 'resolved' : 'unresolved']: id, acting_as: acting });
  }
  if (sub === 'rerequest') {
    const repo = repoOf(ctx);
    const n = posInt(pos[0], '<pr>');
    const reviewers = (f.reviewers || '').split(',').map((s) => s.trim()).filter(Boolean);
    const teams = (f.teams || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!reviewers.length && !teams.length) throw usage('prs rerequest -R owner/repo <pr> --reviewers a,b [--teams t1]');
    const acting = await actingAs(ctx);
    const r = await api(ctx, 'POST', `${repo.rp}/pulls/${n}/requested_reviewers`, { body: { reviewers, team_reviewers: teams }, write: true });
    if (r.dryRun) return outJson({ ...r.plan, acting_as: acting });
    return outJson({ requested: { reviewers, teams }, pr: n, acting_as: acting });
  }
  throw usage(`unknown prs subcommand "${sub}" (lines | review | threads | reply | resolve | unresolve | rerequest)`);
}

// ---------------------------------------------------------------------------
// Issues (gaps only)
// ---------------------------------------------------------------------------
export function parseIssueRef(s, repo) {
  const m = /^(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+))?#?(\d+)$/.exec(String(s || ''));
  if (!m) throw usage(`"${s}" is not an issue number or owner/repo#number`);
  const full = m[1] || repo.full;
  const [owner, name] = full.split('/');
  return { owner, name, full, number: Number(m[2]), rp: `/repos/${seg(owner)}/${seg(name)}` };
}
async function issueRestId(ctx, ref) {
  const r = await api(ctx, 'GET', `${ref.rp}/issues/${ref.number}`);
  if (r.data.pull_request) throw usage(`${ref.full}#${ref.number} is a pull request, not an issue`);
  return { id: r.data.id, node_id: r.data.node_id, number: r.data.number, title: r.data.title, repo: ref.full };
}
const summarizeIssue = (i) => ({ number: i.number, id: i.id, title: i.title, state: i.state, url: i.html_url, repo: i.repository && i.repository.full_name });

async function cmdIssues(ctx, a) {
  const sub = a._[1];
  const f = a.f;
  if (sub === 'sub') {
    const op = a._[2];
    const pos = a._.slice(3);
    const repo = repoOf(ctx);
    const parent = posInt(pos[0], '<parent>');
    const base = `${repo.rp}/issues/${parent}`;
    if (op === 'list') {
      const r = await paginate(ctx, `${base}/sub_issues`, { limit: 100 });
      return outJson({ parent, count: r.values.length, sub_issues: r.values.map(summarizeIssue) });
    }
    if (op === 'parent') {
      const r = await api(ctx, 'GET', `${base}/parent`, { allow: [404] });
      return outJson({ issue: parent, parent: r.status === 404 ? null : summarizeIssue(r.data) });
    }
    if (op === 'add' || op === 'remove' || op === 'move') {
      if (!pos[1]) throw usage(`issues sub ${op} -R owner/repo <parent> <child-number|owner/repo#n>${op === 'move' ? ' --before <n>|--after <n>' : ''}`);
      const child = await issueRestId(ctx, parseIssueRef(pos[1], repo));
      let method;
      let p;
      const body = { sub_issue_id: child.id };
      if (op === 'add') {
        method = 'POST'; p = `${base}/sub_issues`;
        if (f['replace-parent']) body.replace_parent = true;
      } else if (op === 'remove') { method = 'DELETE'; p = `${base}/sub_issue`; } else {
        if (!!f.before === !!f.after) throw usage('issues sub move needs exactly one of --before <n> or --after <n>');
        const sib = await issueRestId(ctx, parseIssueRef(f.before || f.after, repo));
        body[f.before ? 'before_id' : 'after_id'] = sib.id;
        method = 'PATCH'; p = `${base}/sub_issues/priority`;
      }
      const acting = await actingAs(ctx);
      let r;
      try {
        r = await api(ctx, method, p, { body, write: true });
      } catch (e) {
        if (e instanceof CliError && e.status === 422) e.message += '\n  hint: sub-issue limits are 100 children per parent and 8 levels of nesting; an issue can have only one parent (use --replace-parent to move it).';
        throw e;
      }
      if (r.dryRun) return outJson({ ...r.plan, child, acting_as: acting });
      return outJson({ [op === 'add' ? 'added' : op === 'remove' ? 'removed' : 'moved']: { parent, child: `${child.repo}#${child.number}`, child_id: child.id }, acting_as: acting });
    }
    throw usage('issues sub list|parent|add|remove|move');
  }
  if (sub === 'type') {
    const repo = repoOf(ctx);
    const pos = a._.slice(2);
    const n = posInt(pos[0], '<number>');
    const typeName = pos[1];
    if (!typeName) throw usage('issues type -R owner/repo <number> <TypeName|none>');
    const r = await gql(ctx, `query RepoOwnerIssue($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { owner { __typename login } issue(number: $number) { id number title issueType { id name } } } }`, { owner: repo.owner, name: repo.name, number: n });
    const rd = r.data.repository;
    if (!rd || !rd.issue) throw apiErr(`issue #${n} not found in ${repo.full} (or no access with this identity).`);
    if (rd.owner.__typename !== 'Organization') throw guard(`issue types exist only for organization-owned repositories; ${repo.owner} is a user account.`);
    let typeId = null;
    if (typeName.toLowerCase() !== 'none') {
      const t = await gql(ctx, `query OrgIssueTypes($login: String!) { organization(login: $login) { issueTypes(first: 100) { nodes { id name isEnabled description } } } }`, { login: rd.owner.login });
      const types = ((t.data.organization && t.data.organization.issueTypes && t.data.organization.issueTypes.nodes) || []).filter((x) => x.isEnabled !== false);
      const hit = types.find((x) => x.name === typeName) || types.find((x) => x.name.toLowerCase() === typeName.toLowerCase());
      if (!hit) throw usage(`issue type "${typeName}" is not defined for ${rd.owner.login}. Available: ${types.map((x) => x.name).join(', ') || '(none)'}; or "none" to clear`);
      typeId = hit.id;
    }
    const acting = await actingAs(ctx);
    const m = await gql(ctx, `mutation UpdateIssueType($input: UpdateIssueIssueTypeInput!) { updateIssueIssueType(input: $input) { issue { number issueType { name } } } }`, { input: { issueId: rd.issue.id, issueTypeId: typeId } }, { write: true });
    if (m.dryRun) return outJson({ ...m.plan, previous_type: rd.issue.issueType && rd.issue.issueType.name, acting_as: acting });
    return outJson({ issue: n, type: typeId ? typeName : null, previous_type: rd.issue.issueType ? rd.issue.issueType.name : null, acting_as: acting });
  }
  if (sub === 'duplicate') {
    const repo = repoOf(ctx);
    const pos = a._.slice(2);
    const n = posInt(pos[0], '<number>');
    if (!f.of) throw usage('issues duplicate -R owner/repo <n> --of <m> [--rationale-file F]');
    const of = parseIssueRef(f.of, repo);
    if (of.full === repo.full && of.number === n) throw usage('an issue cannot be a duplicate of itself');
    const rationale = f['rationale-file'] ? readBody(ctx, f['rationale-file'], '--rationale-file') : null;
    const q = `query IssueIds($o1: String!, $n1: String!, $a: Int!, $o2: String!, $n2: String!, $b: Int!) { dup: repository(owner: $o1, name: $n1) { issue(number: $a) { id number state title } } orig: repository(owner: $o2, name: $n2) { issue(number: $b) { id number state title } } }`;
    const r = await gql(ctx, q, { o1: repo.owner, n1: repo.name, a: n, o2: of.owner, n2: of.name, b: of.number });
    const dup = r.data.dup && r.data.dup.issue;
    const orig = r.data.orig && r.data.orig.issue;
    if (!dup) throw apiErr(`issue #${n} not found in ${repo.full}.`);
    if (!orig) throw apiErr(`issue ${of.full}#${of.number} not found.`);
    const acting = await actingAs(ctx);
    const steps = [];
    if (rationale) steps.push(await gql(ctx, `mutation AddComment($input: AddCommentInput!) { addComment(input: $input) { commentEdge { node { id url } } } }`, { input: { subjectId: dup.id, body: rationale } }, { write: true }));
    steps.push(await gql(ctx, `mutation CloseIssueDuplicate($input: CloseIssueInput!) { closeIssue(input: $input) { issue { number state stateReason } } }`, { input: { issueId: dup.id, stateReason: 'DUPLICATE', duplicateIssueId: orig.id } }, { write: true }));
    if (ctx.dryRun) return outJson({ dry_run: true, steps: steps.map((s) => s.plan), acting_as: acting });
    return outJson({ closed_as_duplicate: n, of: `${of.full}#${of.number}`, rationale_posted: !!rationale, acting_as: acting });
  }
  throw usage(`unknown issues subcommand "${sub}" (sub | type | duplicate)`);
}

// ---------------------------------------------------------------------------
// Actions triage
// ---------------------------------------------------------------------------
const FAILED_RUN = new Set(['failure', 'timed_out', 'cancelled', 'startup_failure']);
const FAILED_JOB = new Set(['failure', 'timed_out', 'startup_failure']);
const TS_RE = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(\.\d+)?Z\s?/;
const ERR_RE = /error|fail|exception|panic|##\[error\]/i;
const stripTs = (l) => l.replace(TS_RE, '');
function lineTime(l) {
  const m = TS_RE.exec(l);
  if (!m) return null;
  return Date.parse(`${m[1]}${m[2] ? m[2].slice(0, 4) : ''}Z`);
}
// Pure: section of a job log for one step, its tail and error-ish lines. Exported for tests.
export function extractStepLog(logText, step, { tail = 60, cap = 40 } = {}) {
  const lines = String(logText || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  let section = [];
  let method = 'timestamps';
  const start = Date.parse(step.started_at || '');
  const end = Date.parse(step.completed_at || '');
  if (!Number.isNaN(start) && !Number.isNaN(end)) {
    let last = null;
    for (const l of lines) {
      const t = lineTime(l);
      if (t !== null) last = t;
      if (last !== null && last >= Math.floor(start / 1000) * 1000 && last <= end + 999) section.push(l);
    }
  }
  if (!section.length) {
    method = 'group-markers';
    const name = String(step.name || '').toLowerCase();
    const isStepStart = (l) => /##\[group\]Run /.test(l) || /Post job cleanup/.test(l);
    let s = lines.findIndex((l) => /##\[group\]/.test(l) && stripTs(l).replace('##[group]', '').toLowerCase().includes(name.replace(/^run /, '')));
    if (s >= 0) {
      let e = lines.length;
      for (let i = s + 1; i < lines.length; i++) if (isStepStart(lines[i])) { e = i; break; }
      section = lines.slice(s, e);
    }
  }
  if (!section.length) { method = 'whole-log'; section = lines; }
  const clean = section.map(stripTs).filter((l, i, arr) => !(i === arr.length - 1 && l === ''));
  const seen = new Set();
  const matches = [];
  for (const l of clean) {
    if (!ERR_RE.test(l)) continue;
    const k = l.trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    matches.push(k.length > 400 ? k.slice(0, 397) + '...' : k);
    if (matches.length >= cap) break;
  }
  return { extracted_by: method, lines: clean.length, tail: clean.slice(-tail), matches };
}

async function cmdActions(ctx, a) {
  const sub = a._[1];
  const pos = a._.slice(2);
  const f = a.f;
  const repo = repoOf(ctx);
  if (sub === 'failures') {
    const sel = [f.branch, f.pr, f.sha].filter((x) => x !== undefined);
    if (sel.length !== 1) throw usage('actions failures -R owner/repo (--branch B | --pr N | --sha S) [--workflow FILE] [--out DIR]');
    const head = {};
    const query = { status: 'completed', per_page: 100 };
    if (f.pr) {
      const pr = (await api(ctx, 'GET', `${repo.rp}/pulls/${posInt(f.pr, '--pr')}`)).data;
      head.pr = pr.number; head.sha = pr.head.sha; head.branch = pr.head.ref;
      query.head_sha = pr.head.sha;
    } else if (f.sha) { head.sha = f.sha; query.head_sha = f.sha; } else { head.branch = f.branch; query.branch = f.branch; }
    const runs = (await paginate(ctx, `${repo.rp}/actions/runs`, { query, key: 'workflow_runs', limit: 300, maxPages: 3 })).values;
    const wf = f.workflow ? String(f.workflow).replace(/^\.github\/workflows\//, '') : null;
    const newest = new Map();
    for (const r of runs) {
      if (wf && !(r.path === `.github/workflows/${wf}` || String(r.path || '').endsWith(`/${wf}`) || r.name === f.workflow)) continue;
      const k = r.workflow_id || r.path || r.name;
      const cur = newest.get(k);
      if (!cur || Date.parse(r.created_at) > Date.parse(cur.created_at) || (r.created_at === cur.created_at && r.id > cur.id)) newest.set(k, r);
    }
    const failed = [...newest.values()].filter((r) => FAILED_RUN.has(r.conclusion));
    const outDir = f.out ? path.resolve(f.out) : defaultLogDir();
    const report = { repo: repo.full, head, workflows_seen: newest.size, failed_runs: [], passing_or_other: [...newest.values()].filter((r) => !FAILED_RUN.has(r.conclusion)).map((r) => ({ workflow: r.path || r.name, conclusion: r.conclusion, run_id: r.id })), out_dir: outDir };
    for (const run of failed) {
      const jobs = (await paginate(ctx, `${repo.rp}/actions/runs/${run.id}/jobs`, { query: { filter: 'latest' }, key: 'jobs', limit: 500, maxPages: 5 })).values;
      const rr = { run_id: run.id, workflow: run.path || run.name, name: run.name, conclusion: run.conclusion, attempt: run.run_attempt, url: run.html_url, created_at: run.created_at, failed_jobs: [], cancelled_jobs: jobs.filter((j) => j.conclusion === 'cancelled').map((j) => j.name) };
      for (const job of jobs.filter((j) => FAILED_JOB.has(j.conclusion))) {
        const jr = { job_id: job.id, name: job.name, conclusion: job.conclusion, url: job.html_url, failed_steps: [], annotations: [] };
        const steps = (job.steps || []).filter((s) => FAILED_JOB.has(s.conclusion));
        let logText = null;
        try {
          const lr = await api(ctx, 'GET', `${repo.rp}/actions/jobs/${job.id}/logs`, { raw: true });
          logText = redact(lr.text);
          jr.log_file = writeLogFile(outDir, `${run.id}-${job.id}.log`, logText, !f.out);
        } catch (e) {
          if (!(e instanceof CliError) || e.exitCode === EXIT.AUTH || e.exitCode === EXIT.CONFIG) throw e;
          jr.log_error = e.status === 410 || e.status === 404 ? 'log expired or not available (GitHub keeps logs for a limited retention period)' : redact(e.message);
        }
        for (const s of steps) {
          const sr = { number: s.number, name: s.name, conclusion: s.conclusion, started_at: s.started_at, completed_at: s.completed_at };
          if (logText !== null) Object.assign(sr, extractStepLog(logText, s));
          jr.failed_steps.push(sr);
        }
        if (!steps.length && logText !== null) jr.log_excerpt = extractStepLog(logText, { name: '' });
        try {
          const an = (await paginate(ctx, `${repo.rp}/check-runs/${job.id}/annotations`, { limit: 100, maxPages: 2 })).values;
          jr.annotations = an.filter((x) => x.annotation_level === 'failure' || x.annotation_level === 'warning').map((x) => ({ level: x.annotation_level, path: x.path, line: x.start_line, title: x.title, message: excerpt(x.message, 500) }));
        } catch (e) {
          if (!(e instanceof CliError) || e.exitCode === EXIT.AUTH) throw e;
          jr.annotations_error = redact(e.message);
        }
        rr.failed_jobs.push(jr);
      }
      report.failed_runs.push(rr);
    }
    if (!failed.length) report.note = newest.size ? 'no failed runs: the newest completed run of every workflow did not fail' : 'no completed runs found for this head';
    return outJson(report);
  }
  if (sub === 'rerun' || sub === 'rerun-job') {
    const id = posInt(pos[0], sub === 'rerun' ? '<run-id>' : '<job-id>');
    if (f.all && f['failed-only']) throw usage('pass --failed-only or --all, not both');
    let runId = id;
    let job = null;
    if (sub === 'rerun-job') {
      job = (await api(ctx, 'GET', `${repo.rp}/actions/jobs/${id}`)).data;
      runId = job.run_id;
    }
    const run = (await api(ctx, 'GET', `${repo.rp}/actions/runs/${runId}`)).data;
    const ageDays = (Date.now() - Date.parse(run.created_at)) / 86400000;
    if (ageDays > 30) throw guard(`run ${runId} was created ${Math.floor(ageDays)} days ago; GitHub only allows re-running runs up to 30 days old. Push a new commit or dispatch the workflow instead.`);
    if ((run.run_attempt || 1) >= 50) throw guard(`run ${runId} already has ${run.run_attempt} attempts; GitHub allows at most 50. Trigger a new run instead.`);
    const body = f.debug ? { enable_debug_logging: true } : undefined;
    const p = sub === 'rerun-job' ? `${repo.rp}/actions/jobs/${id}/rerun` : f.all ? `${repo.rp}/actions/runs/${runId}/rerun` : `${repo.rp}/actions/runs/${runId}/rerun-failed-jobs`;
    const acting = await actingAs(ctx);
    const r = await api(ctx, 'POST', p, { body, write: true });
    const info = { run_id: runId, workflow: run.path || run.name, attempt: run.run_attempt, conclusion: run.conclusion, mode: sub === 'rerun-job' ? `job ${id}${job ? ` (${job.name})` : ''}` : f.all ? 'all jobs' : 'failed jobs only' };
    if (r.dryRun) return outJson({ ...r.plan, run: info, acting_as: acting });
    return outJson({ rerun_requested: info, url: run.html_url, acting_as: acting });
  }
  if (sub === 'dispatch') {
    const file = pos[0];
    if (!file) throw usage('actions dispatch -R owner/repo <workflow-file> --ref R [--input k=v ...]');
    if (!f.ref) throw usage('--ref (branch or tag) is required');
    const wpath = file.includes('/') ? file : `.github/workflows/${file}`;
    const c = (await api(ctx, 'GET', `${repo.rp}/contents/${wpath.split('/').map(seg).join('/')}`, { query: { ref: f.ref } })).data;
    const yaml = Buffer.from(String(c.content || ''), c.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8');
    const spec = parseDispatchInputs(yaml);
    if (!spec.dispatchable) throw guard(`${wpath}@${f.ref} has no "on: workflow_dispatch" trigger; it cannot be dispatched.`);
    const given = {};
    for (const kv of [].concat(f.input || [])) {
      const eq = kv.indexOf('=');
      if (eq <= 0) throw usage(`--input must be key=value (got "${kv}")`);
      given[kv.slice(0, eq)] = kv.slice(eq + 1);
    }
    const v = validateDispatchInputs(spec.inputs, given);
    if (v.errors.length) throw guard(`dispatch not sent; inputs of ${wpath}@${f.ref} do not validate:\n${v.errors.map((e) => `  - ${e}`).join('\n')}\nDeclared inputs: ${Object.entries(spec.inputs).map(([k, d]) => `${k} (${d.type || 'string'}${d.required ? ', required' : ''}${d.options ? `: ${d.options.join('|')}` : ''})`).join(', ') || 'none'}`);
    const acting = await actingAs(ctx);
    const body = { ref: f.ref, inputs: v.inputs, return_run_details: true };
    const r = await api(ctx, 'POST', `${repo.rp}/actions/workflows/${seg(path.posix.basename(wpath))}/dispatches`, { body, write: true });
    if (r.dryRun) return outJson({ ...r.plan, acting_as: acting });
    const d = r.data || {};
    return outJson({ dispatched: path.posix.basename(wpath), ref: f.ref, inputs: v.inputs, ...(r.status === 200 && d.workflow_run_id ? { run_id: d.workflow_run_id, run_url: d.html_url || d.run_url } : { note: `HTTP ${r.status}: accepted without run details; find the run with \`gh run list --workflow ${path.posix.basename(wpath)}\`` }), acting_as: acting });
  }
  throw usage(`unknown actions subcommand "${sub}" (failures | rerun | rerun-job | dispatch)`);
}

// ---------------------------------------------------------------------------
// Minimal YAML reader for on.workflow_dispatch.inputs (pure; exported)
// ---------------------------------------------------------------------------
function stripComment(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).replace(/\s+$/, '');
  }
  return s.replace(/\s+$/, '');
}
function scalar(v) {
  const t = String(v).trim();
  if (/^"(.*)"$/.test(t)) return t.slice(1, -1).replace(/\\"/g, '"');
  if (/^'(.*)'$/.test(t)) return t.slice(1, -1).replace(/''/g, "'");
  if (/^(true|yes|on)$/i.test(t)) return true;
  if (/^(false|no|off)$/i.test(t)) return false;
  if (/^(null|~)?$/i.test(t)) return null;
  return t;
}
function flowSeq(t) {
  const inner = t.trim().slice(1, -1).trim();
  return inner ? inner.split(',').map((x) => scalar(x)) : [];
}
function parseYamlBlock(lines, start, end, indent) {
  // returns [value, nextIndex] for a block whose items sit at `indent`
  if (start < end && lines[start].indent === indent && /^- |^-$/.test(lines[start].text)) {
    const arr = [];
    let i = start;
    while (i < end && lines[i].indent === indent && /^- |^-$/.test(lines[i].text)) {
      arr.push(scalar(lines[i].text.replace(/^-\s*/, '')));
      i++;
      while (i < end && lines[i].indent > indent) i++;
    }
    return [arr, i];
  }
  const obj = {};
  let i = start;
  while (i < end && lines[i].indent === indent) {
    const m = /^("[^"]*"|'[^']*'|[^:]+?)\s*:(?:\s+(.*))?$/.exec(lines[i].text);
    if (!m) { i++; continue; }
    const key = String(scalar(m[1]));
    const rest = m[2] === undefined ? '' : m[2];
    i++;
    if (/^[|>][-+]?\d*$/.test(rest)) {
      const parts = [];
      while (i < end && lines[i].indent > indent) { parts.push(lines[i].raw.trim()); i++; }
      obj[key] = parts.join(rest.startsWith('|') ? '\n' : ' ');
    } else if (rest.startsWith('[')) obj[key] = flowSeq(rest);
    else if (rest === '{}') obj[key] = {};
    else if (rest !== '') obj[key] = scalar(rest);
    else if (i < end && (lines[i].indent > indent || (lines[i].indent === indent && /^- |^-$/.test(lines[i].text)))) {
      const [v, ni] = parseYamlBlock(lines, i, end, lines[i].indent);
      obj[key] = v;
      i = ni;
    } else obj[key] = null;
    while (i < end && lines[i].indent > indent) i++;
  }
  return [obj, i];
}
export function parseDispatchInputs(yaml) {
  const raw = String(yaml || '').replace(/\r\n?/g, '\n').split('\n');
  const lines = [];
  let blockIndent = -1;
  for (const r of raw) {
    if (!r.trim()) continue;
    const indent = r.length - r.replace(/^ +/, '').length;
    if (blockIndent >= 0 && indent > blockIndent) { lines.push({ indent, text: r.trim(), raw: r }); continue; }
    blockIndent = -1;
    if (/^\s*#/.test(r)) continue;
    const text = stripComment(r.trim());
    if (!text) continue;
    lines.push({ indent, text, raw: r });
    if (/:\s*[|>][-+]?\d*$/.test(text)) blockIndent = indent;
  }
  const onIdx = lines.findIndex((l) => l.indent === 0 && /^(on|"on"|'on'|true)\s*:/.test(l.text));
  if (onIdx < 0) return { dispatchable: false, inputs: {} };
  const rest = lines[onIdx].text.replace(/^[^:]+:\s*/, '');
  if (rest) {
    const v = rest.startsWith('[') ? flowSeq(rest) : [scalar(rest)];
    return { dispatchable: v.includes('workflow_dispatch'), inputs: {} };
  }
  let end = onIdx + 1;
  while (end < lines.length && lines[end].indent > 0) end++;
  if (end === onIdx + 1) return { dispatchable: false, inputs: {} };
  const [on] = parseYamlBlock(lines, onIdx + 1, end, lines[onIdx + 1].indent);
  if (Array.isArray(on)) return { dispatchable: on.includes('workflow_dispatch'), inputs: {} };
  if (!on || !Object.prototype.hasOwnProperty.call(on, 'workflow_dispatch')) return { dispatchable: false, inputs: {} };
  const wd = on.workflow_dispatch || {};
  const inputs = {};
  for (const [name, d] of Object.entries((wd && wd.inputs) || {})) {
    const def = d && typeof d === 'object' ? d : {};
    inputs[name] = {
      type: def.type ? String(def.type) : 'string',
      required: def.required === true,
      default: def.default === undefined || def.default === null ? undefined : def.default,
      options: Array.isArray(def.options) ? def.options.map(String) : undefined,
      description: def.description || undefined,
    };
  }
  return { dispatchable: true, inputs };
}
export function validateDispatchInputs(defs, given) {
  const errors = [];
  const inputs = {};
  if (Object.keys(defs).length > 25) errors.push(`the workflow declares ${Object.keys(defs).length} inputs; GitHub allows at most 25 for workflow_dispatch`);
  for (const k of Object.keys(given)) if (!defs[k]) errors.push(`unknown input "${k}"`);
  for (const [k, d] of Object.entries(defs)) {
    if (!(k in given)) {
      if (d.required && d.default === undefined) errors.push(`missing required input "${k}" (no default)`);
      continue;
    }
    const v = String(given[k]);
    if (d.type === 'boolean' && !/^(true|false)$/.test(v)) errors.push(`input "${k}" is boolean: use true or false (got "${v}")`);
    if (d.type === 'number' && (v.trim() === '' || !Number.isFinite(Number(v)))) errors.push(`input "${k}" must be a number (got "${v}")`);
    if (d.type === 'choice' && d.options && !d.options.includes(v)) errors.push(`input "${k}" must be one of ${d.options.join(', ')} (got "${v}")`);
    if (d.required && v === '') errors.push(`input "${k}" is required and cannot be empty`);
    inputs[k] = v;
  }
  return { errors, inputs };
}

// ---------------------------------------------------------------------------
// help, args, main
// ---------------------------------------------------------------------------
export const HELP = `github.mjs - supplement to \`gh\` for the github agent skill (Node >= 18, no deps)

Use \`gh\` for what it does well (create/list/view PRs and issues, merge, labels, clone).
This script covers: identity selection, Discussions + FAQ, PR review mechanics, sub-issues /
issue types / duplicates, and Actions failure triage / rerun / dispatch. Output is JSON.

Identity (config never holds tokens; a failing identity is an error, never a fallback):
  config show
  config identity add <name> --source env [--env-var GH_TOKEN] [--host H]
  config identity add <name> --source gh-cli [--host H] [--user LOGIN]       (runs gh auth token)
  config identity add <name> --source app-key (--app-id N | --client-id C) --installation-id N
                      --private-key-path /abs/key.pem [--repositories a,b] [--permissions issues=write,...]
  config identity remove <name> | config default <name> | config map <owner/repo|owner/*> <name>
  config repo <owner/repo>                       default -R
  auth whoami [-R owner/repo]                    identity, token kind, actor, rate limit, repo permissions
  Selection: --identity > repo_identity (exact, then owner/*) > default_identity >
             (no config at all and GH_TOKEN/GITHUB_TOKEN set) implicit "env".
  apra-fleet: GH_TOKEN={{secret.NAME}} node github.mjs ...  (execute_command), or GH_TOKEN={{vcs_token}} (vcs_credential_exec)

Markdown bodies come only from files and are linted (--no-lint to bypass):
  lint <file>

Discussions (pass numbers; node ids are resolved internally):
  discussions categories -R o/r
  discussions list -R o/r [--category NAME] [--answered|--unanswered] [--limit N]
  discussions search -R o/r "<text>" [--limit N]
  discussions get -R o/r <number>
  discussions create -R o/r --category NAME --title T --body-file F [--allow-duplicate]
  discussions comment -R o/r <number> --body-file F [--reply-to <comment-node-id>]
  discussions answer -R o/r <number> --body-file F [--replace-answer]     comment + mark as answer
  discussions mark-answer|unmark-answer <comment-node-id>
  discussions edit -R o/r <number> [--title T] [--body-file F] [--category NAME]
  discussions edit-comment <comment-node-id> --body-file F
  discussions close -R o/r <number> [--reason RESOLVED|OUTDATED|DUPLICATE] | reopen <number>
  discussions lock -R o/r <number> [--reason RESOLVED|OFF_TOPIC|TOO_HEATED|SPAM] | unlock <number>
FAQ (index = discussion: intro, ---, then "### Group" headings with "- [Title](url)" lines):
  faq index -R o/r <index-number>                parsed groups + problems
  faq index-create -R o/r --category NAME --title T --intro-file F
  faq index-add -R o/r <index-number> --entry <number> --group "Name"   appends, never reorders
  faq add -R o/r --index N --category NAME --group "Name" --title T --question-file Q --answer-file A [--allow-duplicate]
      dedupe -> create -> answer + mark -> index-add; resumable after a failure. Pinning has no API: pin in the web UI.

Pull request review mechanics:
  prs lines -R o/r <pr> [--path P]               commentable RIGHT/LEFT line ranges per file
  prs review -R o/r <pr> --file review.json [--pending]
      review.json: {"event":"COMMENT|APPROVE|REQUEST_CHANGES","body_file":"r.md",
        "comments":[{"path":"a.js","line":12,"side":"RIGHT","start_line":10,"body_file":"c1.md","suggestion":"new text"}]}
      validated against the diff before sending (line/side, never position)
  prs threads -R o/r <pr> [--unresolved] [--limit N]
  prs reply <thread-id> --body-file F
  prs resolve|unresolve <thread-id>
  prs rerequest -R o/r <pr> --reviewers a,b [--teams t1]

Issues (gaps only):
  issues sub list|parent -R o/r <n>
  issues sub add -R o/r <parent> <child|owner/repo#n> [--replace-parent]
  issues sub remove -R o/r <parent> <child>
  issues sub move -R o/r <parent> <child> --before <n>|--after <n>
  issues type -R o/r <n> <TypeName|none>
  issues duplicate -R o/r <n> --of <m|owner/repo#m> [--rationale-file F]

Actions:
  actions failures -R o/r (--branch B | --pr N | --sha S) [--workflow FILE] [--out DIR]
      newest run per workflow, failed jobs/steps, step log tail + error lines, annotations;
      full logs (redacted) saved to DIR (default ~/.cache/apra-github/logs/, outside any repo)
  actions rerun -R o/r <run-id> [--failed-only (default) | --all] [--debug]   (--debug = enable_debug_logging)
  actions rerun-job -R o/r <job-id> [--debug]
  actions dispatch -R o/r <workflow-file> --ref R [--input k=v ...]   inputs validated against the workflow

Global: -R owner/repo  --identity NAME  --dry-run (writes print method/url/body, nothing sent)
        --json (compact)  --debug (redacted request trace)  --no-lint
Env: GH_TOKEN / GITHUB_TOKEN (env identity), GITHUB_SKILL_HOME (config dir, default ~/.config/github-skill),
     GITHUB_API_URL (default ${DEFAULT_API}; GraphQL at <base>/graphql; only for env identities or the identity's own host), GITHUB_SKILL_GH_BIN (gh binary)
Exit codes: 0 ok, 1 usage, 2 guardrail refusal, 3 API error, 4 config error, 5 auth problem.`;

const BOOL_FLAGS = new Set(['dry-run', 'debug', 'json', 'help', 'no-lint', 'allow-duplicate', 'replace-answer', 'answered', 'unanswered', 'pending', 'unresolved', 'failed-only', 'all', 'replace-parent']);
const VALUE_FLAGS = new Set(['R', 'repo', 'identity', 'limit', 'category', 'title', 'body-file', 'reply-to', 'reason', 'index', 'group', 'entry', 'question-file', 'answer-file', 'intro-file',
  'path', 'file', 'reviewers', 'teams', 'of', 'rationale-file', 'branch', 'pr', 'sha', 'workflow', 'out', 'ref', 'input', 'before', 'after',
  'source', 'host', 'env-var', 'user', 'app-id', 'client-id', 'installation-id', 'private-key-path', 'repositories', 'permissions']);
const MULTI_FLAGS = new Set(['input']);
const TOKEN_REFUSAL = 'never pass a token on the command line or store it in config: it comes from GH_TOKEN/GITHUB_TOKEN, `gh auth token` (gh-cli identity) or an App private key (app-key identity).';
const BODY_REFUSAL = (k) => `--${k} with inline text is refused: shell quoting corrupts markdown (backticks, $, quotes, newlines). Write the text to a file and pass the file flag instead (--body-file, --question-file, --answer-file, --rationale-file, --intro-file).`;
const FORBIDDEN_FLAGS = {
  token: TOKEN_REFUSAL, password: TOKEN_REFUSAL, pat: TOKEN_REFUSAL,
  body: BODY_REFUSAL('body'), question: BODY_REFUSAL('question'), answer: BODY_REFUSAL('answer'), rationale: BODY_REFUSAL('rationale'), intro: BODY_REFUSAL('intro'), message: BODY_REFUSAL('body'), comment: BODY_REFUSAL('body'),
};

export function parseArgs(argv) {
  const _ = [];
  const f = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h') { f.help = true; continue; }
    let k;
    let v;
    if (arg === '-R') k = 'R';
    else if (arg.startsWith('--') && arg.length > 2) {
      k = arg.slice(2);
      const eq = k.indexOf('=');
      if (eq >= 0) { v = k.slice(eq + 1); k = k.slice(0, eq); }
    } else { _.push(arg); continue; }
    if (FORBIDDEN_FLAGS[k]) throw guard(FORBIDDEN_FLAGS[k]);
    if (BOOL_FLAGS.has(k)) f[k] = v === undefined ? true : !/^(0|false|no)$/i.test(v);
    else if (VALUE_FLAGS.has(k)) {
      if (v === undefined) {
        v = argv[++i];
        if (v === undefined) throw usage(`--${k} needs a value`);
      }
      if (MULTI_FLAGS.has(k)) (f[k] = f[k] || []).push(v);
      else f[k] = v;
    } else throw usage(`unknown flag --${k}`);
  }
  if (f.repo && !f.R) f.R = f.repo;
  return { _, f };
}

export async function main(argv) {
  COMPACT = false;
  try {
    const a = parseArgs(argv);
    COMPACT = !!a.f.json;
    const cmd = a._[0];
    if (a.f.help || !cmd || cmd === 'help') { out(HELP); return EXIT.OK; }
    const table = { config: cmdConfig, auth: cmdAuth, lint: cmdLint, discussions: cmdDiscussions, faq: cmdFaq, prs: cmdPrs, issues: cmdIssues, actions: cmdActions };
    const fn = table[cmd];
    if (!fn) throw usage(`unknown command "${cmd}" (for anything else use gh)`);
    const ctx = makeCtx(a.f);
    await fn(ctx, a);
    return EXIT.OK;
  } catch (e) {
    if (e instanceof CliError) { errOut(e.message); return e.exitCode; }
    errOut(`ERROR: ${e && e.message ? e.message : String(e)}`);
    return EXIT.USAGE;
  }
}

const isMain = (() => {
  try {
    return !!process.argv[1] && path.resolve(fileURLToPath(import.meta.url)).toLowerCase() === path.resolve(process.argv[1]).toLowerCase();
  } catch {
    return false;
  }
})();
if (isMain) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
