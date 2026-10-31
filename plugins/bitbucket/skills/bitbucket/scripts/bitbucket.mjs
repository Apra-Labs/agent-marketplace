#!/usr/bin/env node
// bitbucket.mjs - CLI behind the `bitbucket` agent skill (works with any LLM agent that can run apra-fleet tools).
// Node >= 18 (global fetch), no npm dependencies, works the same on Windows, macOS and Linux.
//
// Secret handling: the only secret is the Bitbucket token. It arrives in the environment variable
// BITBUCKET_TOKEN (substituted by apra-fleet's execute_command from {{secret.NAME}}). It is never
// printed, never put in a URL, an argv of a child process, a log line, an error message or a file.
// No credentials file is ever read. Secret values for deployment variables come from the
// environment too (--value-env NAME). Every line this script writes goes through redact().
//
// Auth matrix (verified against Bitbucket Cloud):
//   credential_type   REST Authorization                 git user (Basic, via http.extraHeader)
//   api_token         Basic base64(<email>:<token>)       x-bitbucket-api-token-auth
//   access_token      Bearer <token>                      x-token-auth
// A Bearer header does not work for git, and the email does not work as the git username.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const EXIT = Object.freeze({ OK: 0, USAGE: 1, GUARDRAIL: 2, API: 3, CONFIG: 4, AUTH: 5 });
export const CREDENTIAL_TYPES = Object.freeze(['api_token', 'access_token']);
export const GIT_USERS = Object.freeze({ api_token: 'x-bitbucket-api-token-auth', access_token: 'x-token-auth' });
const DEFAULT_API = 'https://api.bitbucket.org/2.0';
const DEFAULT_GIT = 'https://bitbucket.org';
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 1000;
const MAX_PAGELEN = 50;
const GIT_MIN_VERSION = [2, 31]; // GIT_CONFIG_COUNT/KEY/VALUE need git >= 2.31
const MERGE_STRATEGIES = new Set(['merge_commit', 'squash', 'fast_forward']);
const ENV_TYPES = new Set(['Test', 'Staging', 'Production']);
const UUID_RE = /^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/i;

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
  // Belt and braces: never let an Authorization value through, whatever it is.
  s = s.replace(/(Authorization:\s*(?:Basic|Bearer))\s+(?!\[REDACTED\])[A-Za-z0-9+/=._~-]+/gi, '$1 [REDACTED]');
  return s;
}
function out(line = '') {
  process.stdout.write(redact(line) + '\n');
}
function outJson(obj) {
  out(JSON.stringify(obj, null, 2));
}
function errOut(line) {
  process.stderr.write(redact(line) + '\n');
}

// ---------------------------------------------------------------------------
// Local, non-secret config: <stateDir>/config.json
// { credential_type, email, username, workspace } - never a secret.
// ---------------------------------------------------------------------------
export function stateDir() {
  return process.env.BITBUCKET_SKILL_HOME || path.join(os.homedir(), '.config', 'bitbucket-skill');
}
const configPath = () => path.join(stateDir(), 'config.json');
const CONFIG_KEYS = ['credential_type', 'email', 'username', 'workspace'];

export function loadConfig() {
  const p = configPath();
  if (!fs.existsSync(p)) return {};
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    throw cfgErr(`${p} is not valid JSON (${e.message}).`);
  }
  const clean = {};
  for (const k of CONFIG_KEYS) if (typeof cfg[k] === 'string' && cfg[k] !== '') clean[k] = cfg[k];
  return clean;
}

function saveConfig(cfg) {
  const d = stateDir();
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  const p = configPath();
  const tmp = `${p}.${process.pid}.tmp`;
  const clean = {};
  for (const k of CONFIG_KEYS) if (cfg[k]) clean[k] = cfg[k];
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, p);
  try { fs.chmodSync(p, 0o600); } catch { /* not supported on this OS */ }
}

export function apiBase() {
  return checkBase(process.env.BITBUCKET_API_URL || DEFAULT_API, 'BITBUCKET_API_URL');
}
export function gitBase() {
  return checkBase(process.env.BITBUCKET_GIT_URL || DEFAULT_GIT, 'BITBUCKET_GIT_URL');
}
function checkBase(raw, name) {
  let u;
  try { u = new URL(raw); } catch { throw cfgErr(`${name} "${raw}" is not a valid URL.`); }
  if (u.username || u.password) throw cfgErr(`${name} must not contain credentials.`);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw cfgErr(`${name} must use https:// (got ${u.protocol}//).`);
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

// ---------------------------------------------------------------------------
// Token and auth
// ---------------------------------------------------------------------------
export function readToken() {
  const t = process.env.BITBUCKET_TOKEN;
  if (!t) {
    throw cfgErr("BITBUCKET_TOKEN is not set. Run this script through mcp__apra-fleet__execute_command with BITBUCKET_TOKEN='{{secret.<NAME>}}' in the same command.");
  }
  if (/\{\{\s*secret\./.test(t)) {
    throw cfgErr('BITBUCKET_TOKEN still holds an unsubstituted {{secret.<NAME>}} placeholder. Check the secret name and that its scope includes this member.');
  }
  addSecret(t);
  return t;
}

const OAUTH_REFUSAL = 'OAuth is not supported: OAuth access tokens expire after 1 hour and their refresh tokens rotate, so they cannot be kept in a static secret store. Use an Atlassian API token with Bitbucket scopes (--type api_token --email <you>) or a repository/project/workspace access token (--type access_token).';

function credentialType(cfg) {
  const t = cfg.credential_type;
  if (t === 'oauth') throw cfgErr(OAUTH_REFUSAL);
  if (!t) throw cfgErr(`credential_type is not set. Run: config set --type ${CREDENTIAL_TYPES.join('|')} [--email you@example.com]`);
  if (!CREDENTIAL_TYPES.includes(t)) throw cfgErr(`credential_type "${t}" is not one of ${CREDENTIAL_TYPES.join(', ')}.`);
  return t;
}

// REST Authorization header value for a credential type. Exported for tests.
export function restAuthHeader(type, token, email) {
  if (type === 'api_token') {
    if (!email) throw cfgErr('credential_type api_token needs your Atlassian account email for REST calls: config set --email you@example.com');
    const b = Buffer.from(`${email}:${token}`).toString('base64');
    addSecret(b);
    return `Basic ${b}`;
  }
  if (type === 'access_token') return `Bearer ${token}`;
  throw cfgErr(`unknown credential_type "${type}".`);
}
const authScheme = (cfg) => (cfg.credential_type === 'api_token' ? 'Basic' : cfg.credential_type ? 'Bearer' : '');

// Env for a git child process: auth via http.<gitBase>/.extraHeader, credential managers bypassed,
// no prompts. The token is only in the env (base64), never in argv or the remote URL.
export function gitAuthEnv({ credentialType: type, token, gitBase: base = DEFAULT_GIT }) {
  const user = GIT_USERS[type];
  if (!user) throw cfgErr(`unknown credential_type "${type}".`);
  const b = Buffer.from(`${user}:${token}`).toString('base64');
  addSecret(b);
  return {
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: `http.${base.replace(/\/+$/, '')}/.extraHeader`,
    GIT_CONFIG_VALUE_1: `Authorization: Basic ${b}`,
  };
}

export function remoteUrl(ws, repo, base = DEFAULT_GIT) {
  return `${base.replace(/\/+$/, '')}/${encodeURIComponent(ws)}/${encodeURIComponent(repo)}.git`;
}

// Full child-process spec for git: command, argv, env. Exported for tests.
export function buildGitInvocation({ credentialType: type, token, gitBase: base = DEFAULT_GIT, args, baseEnv = process.env }) {
  const env = { ...baseEnv };
  for (const k of Object.keys(env)) {
    // never hand our secret, inherited git config injection or an askpass helper to git (or its hooks)
    if (/^(BITBUCKET_TOKEN|GIT_ASKPASS|SSH_ASKPASS|GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+|PARAMETERS))$/i.test(k)) delete env[k];
  }
  Object.assign(env, gitAuthEnv({ credentialType: type, token, gitBase: base }), { GCM_INTERACTIVE: 'never' });
  return { command: 'git', args: [...args], env };
}

// ---------------------------------------------------------------------------
// Error diagnosis (pure; exported for tests)
// ---------------------------------------------------------------------------
function parseJson(text) {
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}
function requiredScopes(text) {
  const j = parseJson(text);
  let detail = j && j.error && j.error.detail;
  if (typeof detail === 'string') detail = parseJson(detail) || detail;
  if (detail && typeof detail === 'object') return { required: detail.required || [], granted: detail.granted || [] };
  const m = /"required"\s*:\s*\[([^\]]*)\]/.exec(String(text));
  const g = /"granted"\s*:\s*\[([^\]]*)\]/.exec(String(text));
  const list = (x) => (x ? x[1].split(',').map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean) : []);
  return { required: list(m), granted: list(g) };
}
function bbMessage(text) {
  const j = parseJson(text);
  if (j && j.error) {
    const d = typeof j.error.detail === 'string' ? j.error.detail : j.error.detail ? JSON.stringify(j.error.detail) : '';
    return [j.error.message, d].filter(Boolean).join(': ');
  }
  return String(text || '').slice(0, 300);
}

export function diagnoseApiError(status, text, where = '') {
  const body = String(text || '');
  const at = where ? ` on ${where}` : '';
  if (status === 410 || body.includes('CHANGE-3222')) {
    return authErr(`HTTP ${status}${at}: Bitbucket app passwords were removed on 2026-07-28 (CHANGE-3222). Create an API token with scopes (Atlassian account -> Security -> API tokens), then config set --type api_token --email <your Atlassian email>.`, { status });
  }
  if (status === 401 && /API token must be used with an atlassian registered email/i.test(body)) {
    return authErr(`HTTP 401${at}: REST with an API token needs your Atlassian account email as the username: set \`config set --email <you@example.com>\` (and --type api_token).`, { status });
  }
  if (status === 401) {
    return authErr(`HTTP 401${at}: authentication failed. Check: the credential type matches the token (api_token = Atlassian API token with Bitbucket scopes, used with your account email; access_token = repository/project/workspace access token); the token is not expired or revoked; an API token was created with Bitbucket scopes selected. ${bbMessage(body)}`.trim(), { status });
  }
  if (status === 403 && /lack one or more required privilege scopes/i.test(body)) {
    const s = requiredScopes(body);
    return authErr(`HTTP 403${at}: the token lacks required scopes. Required: ${s.required.join(', ') || '(not listed)'}${s.granted.length ? `; granted: ${s.granted.join(', ')}` : ''}. API-token scopes do not imply each other (write:...:bitbucket does not include read:...:bitbucket); create a new token with every required scope, including the read: scope next to each write: scope.`, { status, required: s.required, granted: s.granted });
  }
  const hints = {
    403: 'not allowed: your account or token lacks permission on this resource (e.g. repo admin or pipelines access).',
    404: 'not found, or no read access (Bitbucket answers 404 for private resources you cannot see). Check workspace/repo slugs and ids.',
    409: 'conflict (already exists or state changed).',
    429: 'rate limited: wait before retrying; do not loop.',
  };
  const h = hints[status] || '';
  return new CliError(EXIT.API, `API error ${status}${at}: ${bbMessage(body) || 'no detail'}${h ? '\n  hint: ' + h : ''}`, { status });
}

export function diagnoseGit(stderr, code) {
  const s = String(stderr || '');
  if (/Authentication failed|could not read (Username|Password)|terminal prompts disabled|HTTP Basic: Access denied|returned error: 40[13]|\b401\b|Invalid username or password/i.test(s)) {
    return authErr(`git authentication failed. Check: git uses the username ${GIT_USERS.api_token} for api_token and x-token-auth for access_token (never your email; this script sets it for you, so check config credential_type matches the token); the token is not expired or revoked; it has the repository read scope (read:repository:bitbucket, plus write:repository:bitbucket to push).\n  git: ${s.trim().split(/\r?\n/).slice(-3).join(' | ')}`);
  }
  if (/repository .* not found|Repository not found|returned error: 404/i.test(s)) {
    return new CliError(EXIT.API, `git: repository not found or no read access. ${s.trim().split(/\r?\n/).slice(-2).join(' | ')}`);
  }
  return new CliError(EXIT.API, `git exited with ${code}: ${s.trim().split(/\r?\n/).slice(-5).join(' | ') || 'no output'}`);
}

// git run guardrails: no URLs with userinfo (credentials in a URL), no force push without --allow-force.
export function checkGitRunArgs(args, { allowForce = false } = {}) {
  if (!args.length) throw usage('git run needs git arguments after --');
  for (const a of args) {
    if (/[a-z][a-z0-9+.-]*:\/\/[^/\s?#]*@/i.test(a)) {
      throw guard(`"${a.replace(/\/\/[^/\s?#]*@/, '//***@')}" is a URL with userinfo, which is refused. This script injects auth through the environment.`);
    }
  }
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    if (['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(args[i])) i += 2;
    else i += 1;
  }
  const sub = args[i];
  if (sub === 'push' && !allowForce) {
    for (const a of args.slice(i + 1)) {
      const force = a === '--force' || a === '--mirror' || a.startsWith('--force-with-lease') || a === '--force-if-includes'
        || (/^-[A-Za-z]+$/.test(a) && a.includes('f')) || (!a.startsWith('-') && a.startsWith('+'));
      if (force) throw guard(`force push ("${a}") rewrites remote history. Only with the operator's explicit request, and then pass --allow-force.`);
    }
  }
  return { subcommand: sub };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
function makeCtx(flags) {
  return { cfg: loadConfig(), dryRun: !!flags['dry-run'], debug: !!flags.debug, warned: false, auth: null };
}

function authFor(ctx) {
  if (!ctx.auth) {
    const type = credentialType(ctx.cfg);
    const token = readToken();
    ctx.auth = { type, token, header: restAuthHeader(type, token, ctx.cfg.email) };
  }
  return ctx.auth;
}

function buildUrl(p, query) {
  const base = apiBase();
  let url;
  if (/^https?:\/\//i.test(p)) {
    url = new URL(p);
    const b = new URL(base);
    if (url.origin !== b.origin) throw new CliError(EXIT.API, `API: refusing to follow a link to ${url.origin} (not ${b.origin}); the token is only sent to the API host.`);
  } else url = new URL(base + p);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  return url;
}

function dryRunPlan(ctx, method, url, body) {
  const scheme = authScheme(ctx.cfg);
  const plan = { dry_run: true, method, url: decodeURIComponent(url.toString()), headers: { Authorization: `${scheme ? scheme + ' ' : ''}[REDACTED]` } };
  if (body !== undefined) plan.body = body;
  return plan;
}

// One HTTP call to the Bitbucket API. Follows redirects manually: the Authorization header goes only
// to the API origin (pipeline logs redirect to a storage host, which must not get the token).
export async function api(ctx, method, p, { query, body, write = false, raw = false, headers: extra = {}, allow = [] } = {}) {
  const url = buildUrl(p, query);
  if (write && ctx.dryRun) return { status: 0, dryRun: true, plan: dryRunPlan(ctx, method, url, body) };
  const auth = authFor(ctx);
  const apiOrigin = new URL(apiBase()).origin;
  let target = url;
  let m = method;
  let res;
  for (let hop = 0; hop < 6; hop++) {
    const headers = { Accept: raw ? '*/*' : 'application/json', ...extra };
    if (target.origin === apiOrigin) headers.Authorization = auth.header;
    if (body !== undefined && m !== 'GET') headers['Content-Type'] = 'application/json';
    if (ctx.debug) errOut(`DEBUG > ${m} ${decodeURIComponent(target.toString())}${headers.Authorization ? '  Authorization: ' + authScheme(ctx.cfg) + ' [REDACTED]' : ''}${body !== undefined && m !== 'GET' ? '  body: ' + JSON.stringify(body) : ''}`);
    try {
      res = await fetch(target, { method: m, headers, body: body !== undefined && m !== 'GET' ? JSON.stringify(body) : undefined, redirect: 'manual', signal: AbortSignal.timeout(120000) });
    } catch (e) {
      throw new CliError(EXIT.API, `API: ${m} ${target.origin}${target.pathname} failed: ${(e.cause && e.cause.code) || e.message}`);
    }
    if (ctx.debug) errOut(`DEBUG < ${res.status}`);
    const near = res.headers.get('x-ratelimit-nearlimit');
    if (near && near !== 'false' && !ctx.warned) {
      ctx.warned = true;
      errOut('WARNING: Bitbucket reports X-RateLimit-NearLimit: you are close to the API rate limit. Slow down; avoid polling loops.');
    }
    const loc = res.headers.get('location');
    if ([301, 302, 303, 307, 308].includes(res.status) && loc) {
      target = new URL(loc, target);
      if (res.status === 303) m = 'GET';
      continue;
    }
    break;
  }
  const where = `${method} ${url.pathname}`;
  if (allow.includes(res.status)) return { status: res.status, data: null, text: '', buffer: Buffer.alloc(0), headers: res.headers };
  if (!res.ok) throw diagnoseApiError(res.status, await res.text(), where);
  if (raw) {
    const buffer = Buffer.from(await res.arrayBuffer());
    return { status: res.status, buffer, text: buffer.toString('utf8'), headers: res.headers };
  }
  const text = await res.text();
  return { status: res.status, data: parseJson(text), text, headers: res.headers };
}

// Follow `next` links until `limit` matching values are collected (or maxPages pages are read).
export async function paginate(ctx, p, { query = {}, limit = DEFAULT_LIMIT, filter, maxPages = 50 } = {}) {
  const values = [];
  let next = p;
  let q = { ...query, pagelen: query.pagelen || Math.min(limit, MAX_PAGELEN) };
  let pages = 0;
  let more = false;
  while (next) {
    if (pages >= maxPages) { more = true; break; }
    const r = await api(ctx, 'GET', next, { query: q });
    pages++;
    const d = r.data || {};
    const page = Array.isArray(d.values) ? d.values : [];
    for (const v of page) {
      if (filter && !filter(v)) continue;
      if (values.length >= limit) { more = true; break; }
      values.push(v);
    }
    next = d.next || null;
    q = undefined; // the next link carries its own query
    if (values.length >= limit) { more = more || !!next; break; }
  }
  return { count: values.length, more, values };
}

// ---------------------------------------------------------------------------
// Argument helpers
// ---------------------------------------------------------------------------
const seg = encodeURIComponent;
const repoPath = (ws, repo) => `/repositories/${seg(ws)}/${seg(repo)}`;
export const braced = (u) => (String(u).startsWith('{') ? String(u) : `{${u}}`);

function parseLimit(v, def = DEFAULT_LIMIT) {
  if (v === undefined) return def;
  if (!/^\d+$/.test(String(v)) || Number(v) < 1 || Number(v) > MAX_LIMIT) throw usage(`--limit must be 1..${MAX_LIMIT}`);
  return Number(v);
}
function posInt(v, name) {
  if (!/^\d+$/.test(String(v))) throw usage(`${name} must be a whole number`);
  return Number(v);
}

// The repo is ONE positional: "<ws>/<repo>", or "<repo>" alone (workspace from config).
// There is deliberately no two-token "<repo>" form: with a configured workspace it is
// ambiguous against a following positional (pipeline, branch, dir, ...).
export function takeRepo(cfg, args) {
  const t = args[0];
  if (!t) throw usage('missing <ws>/<repo> (or <repo> with config set --workspace W)');
  if (t.includes('/')) {
    const parts = t.split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw usage(`"${t}" is not <ws>/<repo>`);
    return { ws: parts[0], repo: parts[1], args: args.slice(1) };
  }
  if (!cfg.workspace) throw usage(`"${t}" has no workspace: write <ws>/${t}, or config set --workspace W`);
  return { ws: cfg.workspace, repo: t, args: args.slice(1) };
}
function takeWs(cfg, args, rest = 0) {
  if (args.length >= rest + 1) return { ws: args[0], args: args.slice(1) };
  if (cfg.workspace) return { ws: cfg.workspace, args };
  throw usage('missing <workspace> (pass it, or config set --workspace W)');
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------
function cmdConfig(ctx, a) {
  const sub = a._[1] || 'show';
  if (sub === 'show') {
    return outJson({ config_path: configPath(), ...Object.fromEntries(CONFIG_KEYS.map((k) => [k, ctx.cfg[k] || null])), api_url: apiBase(), git_url: gitBase(), token_in_env: !!process.env.BITBUCKET_TOKEN });
  }
  if (sub === 'set') {
    const next = { ...ctx.cfg };
    const f = a.f;
    if (f.type !== undefined) {
      if (String(f.type).toLowerCase() === 'oauth') throw cfgErr(OAUTH_REFUSAL);
      if (!CREDENTIAL_TYPES.includes(f.type)) throw usage(`--type must be one of ${CREDENTIAL_TYPES.join(', ')}`);
      next.credential_type = f.type;
    }
    if (f.email !== undefined) {
      if (f.email && !/^[^@\s]+@[^@\s]+$/.test(f.email)) throw usage('--email must be an email address');
      next.email = f.email;
    }
    if (f.username !== undefined) {
      if (f.username.includes('@')) throw usage('--username is your Bitbucket username, not an email');
      next.username = f.username;
    }
    if (f.workspace !== undefined) next.workspace = f.workspace;
    if (f.type === undefined && f.email === undefined && f.username === undefined && f.workspace === undefined) throw usage('config set needs --type, --email, --username and/or --workspace');
    const clean = Object.fromEntries(CONFIG_KEYS.filter((k) => next[k]).map((k) => [k, next[k]]));
    if (ctx.dryRun) return outJson({ dry_run: true, would_save: clean, config_path: configPath() });
    saveConfig(clean);
    return outJson({ saved: clean, config_path: configPath() });
  }
  throw usage(`unknown config subcommand "${sub}"`);
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------
function spawnGit(inv, { cwd, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(inv.command, inv.args, { cwd, env: inv.env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return reject(e);
    }
    const so = [];
    const se = [];
    let timer;
    if (timeoutMs) timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, timeoutMs);
    child.stdout.on('data', (c) => so.push(c));
    child.stderr.on('data', (c) => se.push(c));
    child.on('error', (e) => {
      clearTimeout(timer);
      if (e.code === 'ENOENT') reject(cfgErr('git was not found on PATH. Install git (>= 2.31).'));
      else reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code === null ? 1 : code, stdout: Buffer.concat(so).toString('utf8'), stderr: Buffer.concat(se).toString('utf8') });
    });
  });
}

export function parseGitVersion(s) {
  const m = /git version (\d+)\.(\d+)/.exec(String(s));
  return m ? [Number(m[1]), Number(m[2])] : null;
}

async function checkGitVersion(ctx) {
  if (ctx.gitChecked) return;
  const r = await spawnGit({ command: 'git', args: ['--version'], env: { ...process.env, BITBUCKET_TOKEN: '' } });
  const v = parseGitVersion(r.stdout);
  if (!v) throw cfgErr(`could not read the git version ("${r.stdout.trim()}").`);
  if (v[0] < GIT_MIN_VERSION[0] || (v[0] === GIT_MIN_VERSION[0] && v[1] < GIT_MIN_VERSION[1])) {
    throw cfgErr(`git ${v.join('.')} is too old: auth injection needs git >= ${GIT_MIN_VERSION.join('.')} (GIT_CONFIG_COUNT).`);
  }
  ctx.gitChecked = true;
}

function gitPlan(ctx, args, cwd) {
  const type = ctx.cfg.credential_type || '(unset)';
  return {
    dry_run: true,
    command: 'git',
    args,
    cwd: cwd || process.cwd(),
    env: {
      GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: `http.${gitBase()}/.extraHeader`, GIT_CONFIG_VALUE_1: `Authorization: Basic [REDACTED] (${GIT_USERS[type] || '?'}:<token>)`,
    },
  };
}

async function runGitAuthed(ctx, args, { cwd, timeoutMs } = {}) {
  await checkGitVersion(ctx);
  const type = credentialType(ctx.cfg);
  const token = readToken();
  const inv = buildGitInvocation({ credentialType: type, token, gitBase: gitBase(), args });
  if (ctx.debug) errOut(`DEBUG git ${args.join(' ')}  (auth via env http.extraHeader, ${GIT_USERS[type]})`);
  return spawnGit(inv, { cwd, timeoutMs });
}

async function gitLsRemote(ctx, ws, repo) {
  const url = remoteUrl(ws, repo, gitBase());
  const r = await runGitAuthed(ctx, ['ls-remote', '--heads', '--', url], { timeoutMs: 120000 });
  if (r.code !== 0) throw diagnoseGit(r.stderr, r.code);
  const heads = r.stdout.split(/\r?\n/).filter(Boolean).map((l) => {
    const [sha, ref] = l.split('\t');
    return { sha, ref };
  });
  return { url, heads };
}

async function cmdGit(ctx, a) {
  const sub = a._[1];
  const pos = a._.slice(2);
  if (sub === 'ls-remote') {
    const { ws, repo } = takeRepo(ctx.cfg, pos);
    return outJson(await gitLsRemote(ctx, ws, repo));
  }
  if (sub === 'clone') {
    const { ws, repo, args } = takeRepo(ctx.cfg, pos);
    const dir = args[0] || repo;
    const gargs = ['clone'];
    if (a.f.branch) gargs.push('--branch', a.f.branch);
    gargs.push('--', remoteUrl(ws, repo, gitBase()), dir);
    if (ctx.dryRun) return outJson(gitPlan(ctx, gargs));
    const r = await runGitAuthed(ctx, gargs);
    if (r.code !== 0) throw diagnoseGit(r.stderr, r.code);
    return outJson({ cloned: `${ws}/${repo}`, directory: path.resolve(dir), remote: remoteUrl(ws, repo, gitBase()), note: 'the remote URL carries no credentials; use `git run -C <dir> -- <args>` for fetch/pull/push' });
  }
  if (sub === 'run') {
    const gargs = a.rest || [];
    checkGitRunArgs(gargs, { allowForce: !!a.f['allow-force'] });
    const cwd = a.f.C ? path.resolve(a.f.C) : undefined;
    if (cwd && !fs.existsSync(cwd)) throw usage(`-C ${a.f.C}: directory not found`);
    if (ctx.dryRun) return outJson(gitPlan(ctx, gargs, cwd));
    const r = await runGitAuthed(ctx, gargs, { cwd });
    if (r.stdout) process.stdout.write(redact(r.stdout));
    if (r.stderr) process.stderr.write(redact(r.stderr));
    if (r.code !== 0) throw diagnoseGit(r.stderr, r.code);
    return undefined;
  }
  throw usage(`unknown git subcommand "${sub}" (clone | ls-remote | run)`);
}

// ---------------------------------------------------------------------------
// auth test
// ---------------------------------------------------------------------------
async function cmdAuth(ctx, a) {
  if (a._[1] !== 'test') throw usage('auth test [<ws>/<repo>]');
  const pos = a._.slice(2);
  const report = { credential_type: ctx.cfg.credential_type || null, email_set: !!ctx.cfg.email, workspace: ctx.cfg.workspace || null, rest: null, git: null, ok: false };
  let ws;
  let repo = null;
  if (pos.length) ({ ws, repo } = takeRepo(ctx.cfg, pos));
  else ({ ws } = takeWs(ctx.cfg, []));
  const failures = [];
  const restPath = repo ? repoPath(ws, repo) : `/repositories/${seg(ws)}`;
  try {
    const r = await api(ctx, 'GET', restPath, { query: repo ? undefined : { pagelen: 1 } });
    report.rest = { ok: true, check: `GET ${restPath}`, status: r.status, ...(repo ? { repo: r.data && r.data.full_name } : { repos_visible: r.data && r.data.size !== undefined ? r.data.size : null }) };
  } catch (e) {
    if (!(e instanceof CliError) || e.exitCode === EXIT.CONFIG) throw e;
    report.rest = { ok: false, check: `GET ${restPath}`, status: e.status || null, diagnosis: redact(e.message) };
    failures.push(e);
  }
  if (repo) {
    try {
      const g = await gitLsRemote(ctx, ws, repo);
      report.git = { ok: true, check: `git ls-remote --heads ${g.url}`, git_username: GIT_USERS[ctx.cfg.credential_type], heads: g.heads.length };
    } catch (e) {
      if (!(e instanceof CliError) || e.exitCode === EXIT.CONFIG) throw e;
      report.git = { ok: false, check: `git ls-remote --heads ${remoteUrl(ws, repo, gitBase())}`, git_username: GIT_USERS[ctx.cfg.credential_type], diagnosis: redact(e.message) };
      failures.push(e);
    }
  } else report.git = { skipped: 'no <ws>/<repo> given' };
  report.ok = failures.length === 0;
  outJson(report);
  if (failures.length) {
    const code = failures.some((e) => e.exitCode === EXIT.AUTH) ? EXIT.AUTH : failures[0].exitCode;
    throw new CliError(code, 'auth test failed: see the report on stdout.');
  }
}

// ---------------------------------------------------------------------------
// pipelines
// ---------------------------------------------------------------------------
const pipelineStatus = (p) => [p.state && p.state.name, p.state && p.state.result && p.state.result.name].filter(Boolean).map((s) => String(s).toUpperCase());
const stepResult = (s) => s.state && s.state.result && s.state.result.name;

async function listPipelines(ctx, ws, repo, { status, branch, limit }) {
  const st = status ? String(status).toUpperCase() : undefined;
  return paginate(ctx, `${repoPath(ws, repo)}/pipelines/`, {
    query: { sort: '-created_on', 'target.branch': branch, status: st },
    limit,
    maxPages: 10,
    filter: (p) => (!st || pipelineStatus(p).includes(st)) && (!branch || (p.target && p.target.ref_name) === branch),
  });
}

// "123" / "#123" (build number), "{uuid}" or a bare uuid -> pipeline object.
async function resolvePipeline(ctx, ws, repo, id) {
  const s = String(id);
  if (UUID_RE.test(s)) return (await api(ctx, 'GET', `${repoPath(ws, repo)}/pipelines/${seg(braced(s))}`)).data;
  const n = s.replace(/^#/, '');
  if (!/^\d+$/.test(n)) throw usage(`"${id}" is not a pipeline build number or uuid`);
  const found = await paginate(ctx, `${repoPath(ws, repo)}/pipelines/`, { query: { sort: '-created_on', pagelen: 100 }, limit: 1, maxPages: 5, filter: (p) => p.build_number === Number(n) });
  if (!found.values.length) throw new CliError(EXIT.API, `pipeline #${n} not found in the 500 most recent pipelines of ${ws}/${repo}; pass its uuid.`);
  return found.values[0];
}

async function latestPipeline(ctx, ws, repo, { status, branch } = {}) {
  const r = await listPipelines(ctx, ws, repo, { status, branch, limit: 1 });
  return r.values[0] || null;
}

async function pipelineSteps(ctx, ws, repo, pipe) {
  return (await paginate(ctx, `${repoPath(ws, repo)}/pipelines/${seg(braced(pipe.uuid))}/steps/`, { limit: MAX_LIMIT })).values;
}

const safeName = (s) => String(s || 'unnamed').replace(/[^A-Za-z0-9-]/g, '_').slice(0, 80);

async function fetchStepLog(ctx, ws, repo, pipe, step, tailBytes) {
  const p = `${repoPath(ws, repo)}/pipelines/${seg(braced(pipe.uuid))}/steps/${seg(braced(step.uuid))}/log`;
  const headers = tailBytes ? { Range: `bytes=-${tailBytes}` } : {};
  let r;
  try {
    r = await api(ctx, 'GET', p, { raw: true, headers, allow: [416] });
  } catch (e) {
    if (e instanceof CliError && e.status === 404) {
      throw new CliError(EXIT.API, `log not available for step "${step.name || step.uuid}" of pipeline #${pipe.build_number ?? pipe.uuid}: Bitbucket expires pipeline logs after a while, or the step produced no log.`, { status: 404, logMissing: true });
    }
    throw e;
  }
  return r.buffer;
}

function writeLog(dir, pipe, step, buf, used) {
  fs.mkdirSync(dir, { recursive: true });
  let base = `pipeline-${pipe.build_number ?? 'x'}-${safeName(step.name)}`;
  let name = `${base}.log`;
  for (let i = 2; used.has(name); i++) name = `${base}-${i}.log`;
  used.add(name);
  const file = path.join(dir, name);
  fs.writeFileSync(file, buf);
  return file;
}

function summarizePipeline(p) {
  return {
    uuid: p.uuid, build_number: p.build_number, state: p.state && p.state.name, result: p.state && p.state.result && p.state.result.name,
    branch: p.target && p.target.ref_name, commit: p.target && p.target.commit && p.target.commit.hash,
    created_on: p.created_on, completed_on: p.completed_on, duration_in_seconds: p.duration_in_seconds,
  };
}
const summarizeStep = (s) => ({ uuid: s.uuid, name: s.name, state: s.state && s.state.name, result: stepResult(s), started_on: s.started_on, completed_on: s.completed_on, duration_in_seconds: s.duration_in_seconds });

async function cmdPipelines(ctx, a) {
  const sub = a._[1] || 'list';
  const pos = a._.slice(2);
  const f = a.f;
  const outDir = path.resolve(f.out || '.pipeline-logs');
  if (sub === 'list') {
    const { ws, repo } = takeRepo(ctx.cfg, pos);
    const r = await listPipelines(ctx, ws, repo, { status: f.status, branch: f.branch, limit: parseLimit(f.limit, 10) });
    return outJson({ ...r, values: r.values.map(summarizePipeline) });
  }
  if (sub === 'get') {
    const { ws, repo, args } = takeRepo(ctx.cfg, pos);
    if (!args[0]) throw usage('pipelines get <repo> <build#|uuid>');
    return outJson(await resolvePipeline(ctx, ws, repo, args[0]));
  }
  if (sub === 'latest' || sub === 'latest-failed') {
    const { ws, repo } = takeRepo(ctx.cfg, pos);
    const p = await latestPipeline(ctx, ws, repo, { status: sub === 'latest-failed' ? 'FAILED' : f.status, branch: f.branch });
    return outJson(p ? summarizePipeline(p) : null);
  }
  if (sub === 'steps') {
    const { ws, repo, args } = takeRepo(ctx.cfg, pos);
    if (!args[0]) throw usage('pipelines steps <repo> <build#|uuid>');
    const pipe = await resolvePipeline(ctx, ws, repo, args[0]);
    return outJson((await pipelineSteps(ctx, ws, repo, pipe)).map(summarizeStep));
  }
  if (sub === 'failed-steps' || sub === 'failed-logs') {
    const { ws, repo, args } = takeRepo(ctx.cfg, pos);
    const pipe = args[0] ? await resolvePipeline(ctx, ws, repo, args[0]) : await latestPipeline(ctx, ws, repo, { status: 'FAILED', branch: f.branch });
    if (!pipe) return outJson({ pipeline: null, failed_steps: [], note: 'no failed pipeline found' });
    const failed = (await pipelineSteps(ctx, ws, repo, pipe)).filter((s) => ['FAILED', 'ERROR'].includes(stepResult(s)));
    if (sub === 'failed-steps') return outJson({ pipeline: summarizePipeline(pipe), failed_steps: failed.map(summarizeStep) });
    const used = new Set();
    const logs = [];
    for (const s of failed) {
      try {
        const buf = await fetchStepLog(ctx, ws, repo, pipe, s);
        logs.push({ step: s.name, step_uuid: s.uuid, result: stepResult(s), file: writeLog(outDir, pipe, s, buf, used), bytes: buf.length });
      } catch (e) {
        if (!(e instanceof CliError) || e.exitCode === EXIT.AUTH || e.exitCode === EXIT.CONFIG) throw e;
        logs.push({ step: s.name, step_uuid: s.uuid, result: stepResult(s), log_missing: !!e.logMissing, error: redact(e.message) });
      }
    }
    return outJson({ pipeline: summarizePipeline(pipe), out_dir: outDir, logs });
  }
  if (sub === 'log') {
    const { ws, repo, args } = takeRepo(ctx.cfg, pos);
    if (args.length < 2) throw usage('pipelines log <repo> <build#|uuid> <step-uuid|step-name> [--tail BYTES] [--out DIR]');
    const pipe = await resolvePipeline(ctx, ws, repo, args[0]);
    let step;
    if (UUID_RE.test(args[1])) step = { uuid: args[1] };
    const steps = await pipelineSteps(ctx, ws, repo, pipe);
    step = steps.find((s) => (step ? braced(s.uuid).toLowerCase() === braced(step.uuid).toLowerCase() : s.name === args[1])) || step;
    if (!step) throw usage(`no step "${args[1]}" in pipeline #${pipe.build_number}. Steps: ${steps.map((s) => s.name).join(', ')}`);
    const tail = f.tail !== undefined ? posInt(f.tail, '--tail') : undefined;
    const buf = await fetchStepLog(ctx, ws, repo, pipe, step, tail);
    const file = writeLog(outDir, pipe, step, buf, new Set());
    return outJson({ pipeline: pipe.build_number, step: step.name || step.uuid, file, bytes: buf.length, tail_bytes: tail || null });
  }
  if (sub === 'status') {
    const { ws, repo, args } = takeRepo(ctx.cfg, pos);
    const pipe = args[0] ? await resolvePipeline(ctx, ws, repo, args[0]) : await latestPipeline(ctx, ws, repo, { branch: f.branch });
    if (!pipe) return outJson({ pipeline: null, note: 'no pipelines found' });
    const lines = f['tail-lines'] !== undefined ? posInt(f['tail-lines'], '--tail-lines') : 20;
    const steps = await pipelineSteps(ctx, ws, repo, pipe);
    const by = (n) => steps.filter((s) => s.state && s.state.name === n);
    const running = [];
    for (const s of by('IN_PROGRESS')) {
      let tail = null;
      try {
        const buf = await fetchStepLog(ctx, ws, repo, pipe, s, lines * 100);
        tail = buf.toString('utf8').replace(/\s+$/, '').split(/\r?\n/).slice(-lines).join('\n');
      } catch (e) {
        if (!(e instanceof CliError) || e.exitCode === EXIT.AUTH) throw e;
      }
      running.push({ ...summarizeStep(s), log_tail: tail });
    }
    return outJson({
      pipeline: summarizePipeline(pipe),
      progress: { total: steps.length, completed: by('COMPLETED').length, running: running.length, pending: by('PENDING').length },
      failed_steps: steps.filter((s) => ['FAILED', 'ERROR'].includes(stepResult(s))).map((s) => s.name),
      running,
    });
  }
  if (sub === 'run') {
    const { ws, repo } = takeRepo(ctx.cfg, pos);
    if (!f.branch) throw usage('pipelines run <repo> --branch B [--custom NAME] [--commit SHA]');
    const target = { type: 'pipeline_ref_target', ref_type: 'branch', ref_name: f.branch };
    if (f.commit) target.commit = { type: 'commit', hash: f.commit };
    if (f.custom) target.selector = { type: 'custom', pattern: f.custom };
    const r = await api(ctx, 'POST', `${repoPath(ws, repo)}/pipelines/`, { body: { target }, write: true });
    return outJson(r.dryRun ? r.plan : summarizePipeline(r.data || {}));
  }
  if (sub === 'stop') {
    const { ws, repo, args } = takeRepo(ctx.cfg, pos);
    if (!args[0]) throw usage('pipelines stop <repo> <build#|uuid>');
    const pipe = await resolvePipeline(ctx, ws, repo, args[0]);
    const r = await api(ctx, 'POST', `${repoPath(ws, repo)}/pipelines/${seg(braced(pipe.uuid))}/stopPipeline`, { write: true });
    return outJson(r.dryRun ? r.plan : { stopped: pipe.build_number, uuid: pipe.uuid });
  }
  throw usage(`unknown pipelines subcommand "${sub}"`);
}

// ---------------------------------------------------------------------------
// deployments: environments + variables
// ---------------------------------------------------------------------------
async function listEnvs(ctx, ws, repo) {
  return paginate(ctx, `${repoPath(ws, repo)}/environments/`, { limit: MAX_LIMIT });
}

// Environment by name (exact, then case-insensitive) or uuid -> uuid.
export async function resolveEnvUuid(ctx, ws, repo, ident) {
  if (UUID_RE.test(ident)) return braced(ident);
  const envs = (await listEnvs(ctx, ws, repo)).values;
  let hit = envs.filter((e) => e.name === ident);
  if (!hit.length) hit = envs.filter((e) => String(e.name).toLowerCase() === String(ident).toLowerCase());
  if (hit.length === 1) return hit[0].uuid;
  if (hit.length > 1) throw cfgErr(`environment name "${ident}" is ambiguous in ${ws}/${repo}; use its uuid.`);
  throw new CliError(EXIT.API, `environment "${ident}" not found in ${ws}/${repo}. Available: ${envs.map((e) => e.name).join(', ') || '(none)'}`);
}

const varsPath = (ws, repo, envUuid) => `${repoPath(ws, repo)}/deployments_config/environments/${seg(envUuid)}/variables`;

async function listVars(ctx, ws, repo, envUuid) {
  return (await paginate(ctx, `${varsPath(ws, repo, envUuid)}/`, { limit: MAX_LIMIT })).values;
}

function findVar(vars, ident) {
  if (UUID_RE.test(ident)) return vars.find((v) => braced(v.uuid).toLowerCase() === braced(ident).toLowerCase()) || null;
  return vars.find((v) => v.key === ident) || null;
}

// Value for a deployment variable: --value-env NAME (secret, from env) or --value (non-secret only).
export function variableValue(f, { required = true } = {}) {
  const secured = f.secured === undefined ? (f['value-env'] !== undefined ? true : undefined) : !!f.secured;
  if (f.value !== undefined && f['value-env'] !== undefined) throw usage('pass --value or --value-env, not both');
  if (f.value !== undefined && secured) {
    throw guard('--value with --secured would put a secret on the command line. Pass it from the environment: --value-env NAME (e.g. NAME=\'{{secret.X}}\' in the same execute_command).');
  }
  if (f['value-env'] !== undefined) {
    const name = f['value-env'];
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw usage(`--value-env "${name}" is not an environment variable name`);
    if (name === 'BITBUCKET_TOKEN') throw guard('--value-env BITBUCKET_TOKEN would copy the API token into a variable.');
    const v = process.env[name];
    if (v === undefined || v === '') throw cfgErr(`environment variable ${name} (from --value-env) is not set or empty.`);
    if (/\{\{\s*secret\./.test(v)) throw cfgErr(`environment variable ${name} still holds an unsubstituted {{secret.<NAME>}} placeholder.`);
    addSecret(v);
    return { value: v, secured: secured !== false, fromEnv: true };
  }
  if (f.value !== undefined) return { value: f.value, secured: false, fromEnv: false };
  if (required) throw usage('pass --value-env NAME (secret) or --value V (non-secret)');
  return { value: undefined, secured, fromEnv: false };
}

function shownBody(body, secret) {
  return secret && body.value !== undefined ? { ...body, value: '[REDACTED]' } : body;
}

async function cmdDeploy(ctx, a) {
  const sub = a._[1] || 'envs';
  const pos = a._.slice(2);
  const f = a.f;
  if (sub === 'envs') {
    const { ws, repo } = takeRepo(ctx.cfg, pos);
    const r = await listEnvs(ctx, ws, repo);
    return outJson({ ...r, values: r.values.map((e) => ({ uuid: e.uuid, name: e.name, slug: e.slug, environment_type: e.environment_type && e.environment_type.name, rank: e.rank })) });
  }
  if (sub === 'env-create') {
    const { ws, repo, args } = takeRepo(ctx.cfg, pos);
    if (!args[0]) throw usage('deploy env-create <repo> <name> [--type Test|Staging|Production] [--rank N]');
    const type = f.type || 'Test';
    if (!ENV_TYPES.has(type)) throw usage('--type must be Test, Staging or Production');
    const body = { name: args[0], environment_type: { name: type } };
    if (f.rank !== undefined) body.rank = posInt(f.rank, '--rank');
    const r = await api(ctx, 'POST', `${repoPath(ws, repo)}/environments/`, { body, write: true });
    return outJson(r.dryRun ? r.plan : r.data);
  }
  if (sub === 'vars') {
    const { ws, repo, args } = takeRepo(ctx.cfg, pos);
    if (!args[0]) throw usage('deploy vars <repo> <env-name|uuid>');
    const envUuid = await resolveEnvUuid(ctx, ws, repo, args[0]);
    const vars = await listVars(ctx, ws, repo, envUuid);
    return outJson({ environment_uuid: envUuid, count: vars.length, values: vars.map((v) => ({ uuid: v.uuid, key: v.key, secured: !!v.secured, value: v.secured ? null : v.value })) });
  }
  if (sub === 'var-set' || sub === 'var-update') {
    const { ws, repo, args } = takeRepo(ctx.cfg, pos);
    if (args.length < 2) throw usage(`deploy ${sub} <repo> <env-name|uuid> <key${sub === 'var-update' ? '|uuid' : ''}> (--value-env NAME | --value V) [--secured]${sub === 'var-update' ? ' [--new-key K]' : ''}`);
    const val = variableValue(f, { required: sub === 'var-set' });
    const envUuid = await resolveEnvUuid(ctx, ws, repo, args[0]);
    const vars = await listVars(ctx, ws, repo, envUuid);
    const existing = findVar(vars, args[1]);
    let method;
    let p;
    let body;
    if (sub === 'var-set' && !existing) {
      if (UUID_RE.test(args[1])) throw usage('var-set creates by key; a uuid must already exist');
      method = 'POST';
      p = `${varsPath(ws, repo, envUuid)}/`;
      body = { key: args[1], value: val.value, secured: !!val.secured };
    } else {
      if (!existing) throw new CliError(EXIT.API, `variable "${args[1]}" not found in environment ${args[0]}. Keys: ${vars.map((v) => v.key).join(', ') || '(none)'}`);
      const secured = val.secured === undefined ? !!existing.secured : !!val.secured;
      let value = val.value;
      if (value === undefined) {
        if (existing.secured) throw usage('a secured variable\'s value cannot be read back; pass --value-env NAME with the new value');
        value = existing.value;
      }
      method = 'PUT';
      p = `${varsPath(ws, repo, envUuid)}/${seg(braced(existing.uuid))}`;
      body = { uuid: existing.uuid, key: f['new-key'] || existing.key, value, secured };
    }
    const r = await api(ctx, method, p, { body, write: true });
    if (r.dryRun) return outJson({ ...r.plan, body: shownBody(body, val.fromEnv || body.secured) });
    const d = r.data || {};
    return outJson({ action: method === 'POST' ? 'created' : 'updated', environment_uuid: envUuid, uuid: d.uuid, key: d.key, secured: !!d.secured, value: d.secured ? null : d.value });
  }
  if (sub === 'var-delete') {
    const { ws, repo, args } = takeRepo(ctx.cfg, pos);
    if (args.length < 2) throw usage('deploy var-delete <repo> <env-name|uuid> <key|uuid>');
    const envUuid = await resolveEnvUuid(ctx, ws, repo, args[0]);
    const v = findVar(await listVars(ctx, ws, repo, envUuid), args[1]);
    if (!v) throw new CliError(EXIT.API, `variable "${args[1]}" not found in environment ${args[0]}.`);
    const r = await api(ctx, 'DELETE', `${varsPath(ws, repo, envUuid)}/${seg(braced(v.uuid))}`, { write: true });
    return outJson(r.dryRun ? r.plan : { deleted: v.key, uuid: v.uuid, environment_uuid: envUuid });
  }
  if (sub === 'env-delete') throw guard('deleting a deployment environment is not offered (it destroys its variables and deployment history). Do it in the Bitbucket UI if the operator really wants it.');
  throw usage(`unknown deploy subcommand "${sub}"`);
}

// ---------------------------------------------------------------------------
// pull requests
// ---------------------------------------------------------------------------
const summarizePr = (p) => ({
  id: p.id, title: p.title, state: p.state, author: p.author && (p.author.display_name || p.author.nickname),
  source: p.source && p.source.branch && p.source.branch.name, destination: p.destination && p.destination.branch && p.destination.branch.name,
  created_on: p.created_on, updated_on: p.updated_on, url: p.links && p.links.html && p.links.html.href,
});

async function cmdPrs(ctx, a) {
  const sub = a._[1] || 'list';
  const pos = a._.slice(2);
  const f = a.f;
  if (sub === 'list') {
    const { ws, repo } = takeRepo(ctx.cfg, pos);
    const r = await paginate(ctx, `${repoPath(ws, repo)}/pullrequests`, { query: { state: f.state ? String(f.state).toUpperCase() : undefined, q: f.query }, limit: parseLimit(f.limit) });
    return outJson({ ...r, values: r.values.map(summarizePr) });
  }
  if (sub === 'create') {
    const { ws, repo } = takeRepo(ctx.cfg, pos);
    if (!f.title || !f.source) throw usage('prs create <repo> --title T --source BRANCH [--dest BRANCH] [--description D] [--reviewers uuid,uuid] [--close-source] [--draft]');
    const body = { title: f.title, source: { branch: { name: f.source } } };
    if (f.dest) body.destination = { branch: { name: f.dest } };
    if (f.description) body.description = f.description;
    if (f.reviewers) body.reviewers = String(f.reviewers).split(',').map((s) => s.trim()).filter(Boolean).map((u) => (UUID_RE.test(u) ? { uuid: braced(u) } : { account_id: u }));
    if (f['close-source']) body.close_source_branch = true;
    if (f.draft) body.draft = true;
    const r = await api(ctx, 'POST', `${repoPath(ws, repo)}/pullrequests`, { body, write: true });
    return outJson(r.dryRun ? r.plan : summarizePr(r.data || {}));
  }
  const { ws, repo, args } = takeRepo(ctx.cfg, pos);
  const id = args[0];
  if (!id || !/^\d+$/.test(id)) throw usage(`prs ${sub} <repo> <pr-id>`);
  const pr = `${repoPath(ws, repo)}/pullrequests/${id}`;
  const write = async (method, p, body) => {
    const r = await api(ctx, method, p, { body, write: true });
    return outJson(r.dryRun ? r.plan : (r.data || { ok: true, status: r.status }));
  };
  switch (sub) {
    case 'get': return outJson((await api(ctx, 'GET', pr)).data);
    case 'diff': {
      const r = await api(ctx, 'GET', `${pr}/diff`, { raw: true });
      if (f.out) { fs.writeFileSync(path.resolve(f.out), r.buffer); return outJson({ file: path.resolve(f.out), bytes: r.buffer.length }); }
      process.stdout.write(redact(r.text));
      return undefined;
    }
    case 'diffstat': return outJson(await paginate(ctx, `${pr}/diffstat`, { limit: parseLimit(f.limit, 500) }));
    case 'comments': {
      const r = await paginate(ctx, `${pr}/comments`, { limit: parseLimit(f.limit, 100) });
      return outJson({ ...r, values: r.values.map((c) => ({ id: c.id, author: c.user && c.user.display_name, created_on: c.created_on, parent: c.parent ? c.parent.id : null, inline: c.inline || null, deleted: !!c.deleted, body: c.content && c.content.raw })) });
    }
    case 'activity': return outJson(await paginate(ctx, `${pr}/activity`, { limit: parseLimit(f.limit, 50) }));
    case 'comment': {
      if (!f.body) throw usage('prs comment <repo> <id> --body TEXT [--reply-to ID] [--path FILE --line N]');
      const body = { content: { raw: f.body } };
      if (f['reply-to']) body.parent = { id: posInt(f['reply-to'], '--reply-to') };
      if (f.path || f.line) {
        if (!f.path || !f.line) throw usage('an inline comment needs both --path and --line');
        body.inline = { path: f.path, to: posInt(f.line, '--line') };
      }
      return write('POST', `${pr}/comments`, body);
    }
    case 'approve': return write('POST', `${pr}/approve`);
    case 'unapprove': return write('DELETE', `${pr}/approve`);
    case 'request-changes': return write('POST', `${pr}/request-changes`);
    case 'merge': {
      const strategy = f.strategy || 'merge_commit';
      if (!MERGE_STRATEGIES.has(strategy)) throw usage('--strategy must be merge_commit, squash or fast_forward');
      const body = { type: 'pullrequest', merge_strategy: strategy, close_source_branch: !!f['close-source'] };
      if (f.message) body.message = f.message;
      return write('POST', `${pr}/merge`, body);
    }
    case 'decline': return write('POST', `${pr}/decline`, f.message ? { message: f.message } : undefined);
    default: throw usage(`unknown prs subcommand "${sub}"`);
  }
}

// ---------------------------------------------------------------------------
// repositories
// ---------------------------------------------------------------------------
async function cmdRepos(ctx, a) {
  const sub = a._[1] || 'list';
  const pos = a._.slice(2);
  const f = a.f;
  if (sub === 'list') {
    const { ws } = takeWs(ctx.cfg, pos);
    const q = f.query ? `name ~ "${String(f.query).replace(/"/g, '')}"` : undefined;
    const r = await paginate(ctx, `/repositories/${seg(ws)}`, { query: { q, role: f.role, sort: '-updated_on' }, limit: parseLimit(f.limit) });
    return outJson({ ...r, values: r.values.map((x) => ({ full_name: x.full_name, slug: x.slug, is_private: x.is_private, mainbranch: x.mainbranch && x.mainbranch.name, updated_on: x.updated_on })) });
  }
  if (sub === 'search') {
    const { ws, args } = takeWs(ctx.cfg, pos, 1);
    if (!args[0]) throw usage('repos search [<ws>] <query>');
    const r = await paginate(ctx, `/workspaces/${seg(ws)}/search/code`, { query: { search_query: args.join(' ') }, limit: parseLimit(f.limit, 20) });
    return outJson({ ...r, values: r.values.map((m) => ({ repo: m.file && m.file.links && m.file.links.self && m.file.links.self.href ? (/\/repositories\/([^/]+\/[^/]+)\//.exec(m.file.links.self.href) || [])[1] || null : null, path: m.file && m.file.path, matches: m.content_match_count, lines: (m.content_matches || []).flatMap((c) => (c.lines || []).map((l) => ({ line: l.line, text: (l.segments || []).map((s) => s.text).join('') }))) })) });
  }
  if (sub === 'get') {
    const { ws, repo } = takeRepo(ctx.cfg, pos);
    return outJson((await api(ctx, 'GET', repoPath(ws, repo))).data);
  }
  if (sub === 'branches' || sub === 'tags') {
    const { ws, repo } = takeRepo(ctx.cfg, pos);
    const q = f.query ? `name ~ "${String(f.query).replace(/"/g, '')}"` : undefined;
    const r = await paginate(ctx, `${repoPath(ws, repo)}/refs/${sub}`, { query: { q, sort: sub === 'tags' ? '-target.date' : undefined }, limit: parseLimit(f.limit) });
    return outJson({ ...r, values: r.values.map((b) => ({ name: b.name, hash: b.target && b.target.hash, date: b.target && b.target.date })) });
  }
  if (sub === 'branch-create') {
    const { ws, repo, args } = takeRepo(ctx.cfg, pos);
    if (!args[0] || !f.from) throw usage('repos branch-create <repo> <name> --from <branch|commit>');
    let hash = f.from;
    if (!/^[0-9a-f]{7,40}$/i.test(hash)) {
      const b = await api(ctx, 'GET', `${repoPath(ws, repo)}/refs/branches/${seg(f.from)}`);
      hash = b.data && b.data.target && b.data.target.hash;
      if (!hash) throw new CliError(EXIT.API, `could not resolve --from ${f.from} to a commit.`);
    }
    const r = await api(ctx, 'POST', `${repoPath(ws, repo)}/refs/branches`, { body: { name: args[0], target: { hash } }, write: true });
    return outJson(r.dryRun ? r.plan : { created: r.data && r.data.name, hash: r.data && r.data.target && r.data.target.hash });
  }
  if (sub === 'commits') {
    const { ws, repo, args } = takeRepo(ctx.cfg, pos);
    const p = args[0] ? `${repoPath(ws, repo)}/commits/${seg(args[0])}` : `${repoPath(ws, repo)}/commits`;
    const r = await paginate(ctx, p, { limit: parseLimit(f.limit, 20) });
    return outJson({ ...r, values: r.values.map((c) => ({ hash: c.hash, date: c.date, author: c.author && c.author.raw, message: c.message && c.message.split(/\r?\n/)[0] })) });
  }
  if (sub === 'compare') {
    const { ws, repo, args } = takeRepo(ctx.cfg, pos);
    const m = /^(.+?)\.\.(.+)$/.exec(args[0] || '');
    if (!m) throw usage('repos compare <repo> A..B   (Bitbucket semantics: changes on A since it diverged from B)');
    const r = await paginate(ctx, `${repoPath(ws, repo)}/diffstat/${seg(m[1])}..${seg(m[2])}`, { limit: parseLimit(f.limit, 500) });
    return outJson({ spec: args[0], ...r, values: r.values.map((d) => ({ status: d.status, old: d.old && d.old.path, new: d.new && d.new.path, lines_added: d.lines_added, lines_removed: d.lines_removed })) });
  }
  if (sub === 'file') {
    const { ws, repo, args } = takeRepo(ctx.cfg, pos);
    if (args.length < 2) throw usage('repos file <repo> <ref> <path> [--out FILE]');
    const fp = args[1].replace(/^\/+/, '').split('/').map(seg).join('/');
    const r = await api(ctx, 'GET', `${repoPath(ws, repo)}/src/${seg(args[0])}/${fp}`, { raw: true });
    if (f.out) {
      const target = path.resolve(f.out);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, r.buffer);
      return outJson({ file: target, bytes: r.buffer.length });
    }
    process.stdout.write(redact(r.text));
    return undefined;
  }
  throw usage(`unknown repos subcommand "${sub}"`);
}

// ---------------------------------------------------------------------------
// help, args, main
// ---------------------------------------------------------------------------
export const HELP = `bitbucket.mjs - Bitbucket Cloud helper for the bitbucket agent skill (Node >= 18, no deps)

Run it through mcp__apra-fleet__execute_command with the token in BITBUCKET_TOKEN for that
one command only:
  BITBUCKET_TOKEN='{{secret.BITBUCKET_TOKEN}}' node <skill>/scripts/bitbucket.mjs <command> ...

<repo> is one token: <ws>/<repo>, or a bare <repo> when config has a workspace.
<pipeline> is a build number (123 or #123) or a uuid. Output is JSON on stdout.

Config (non-secret; the token is never stored):
  config show
  config set [--type api_token|access_token] [--email E] [--username U] [--workspace W]
Auth:
  auth test [<ws>/<repo>]              REST check + git ls-remote check, JSON report with diagnosis
Pipelines:
  pipelines list <repo> [--status S] [--branch B] [--limit N]
  pipelines get|steps <repo> <pipeline>
  pipelines latest <repo> [--branch B] [--status S]
  pipelines latest-failed <repo> [--branch B]
  pipelines failed-steps <repo> [<pipeline>]      default: latest failed
  pipelines failed-logs <repo> [<pipeline>] [--out DIR]   writes logs (default .pipeline-logs/)
  pipelines log <repo> <pipeline> <step-uuid|name> [--tail BYTES] [--out DIR]
  pipelines status <repo> [<pipeline>] [--tail-lines N]  progress + running step log tails
  pipelines run <repo> --branch B [--custom NAME] [--commit SHA]   (write)
  pipelines stop <repo> <pipeline>                                  (write)
Deployments:
  deploy envs <repo>
  deploy env-create <repo> <name> [--type Test|Staging|Production] [--rank N]   (write)
  deploy vars <repo> <env-name|uuid>
  deploy var-set <repo> <env> <key> (--value-env NAME | --value V) [--secured[=false]]  (create or update)
  deploy var-update <repo> <env> <key|uuid> [--value-env NAME | --value V] [--secured[=false]] [--new-key K]
  deploy var-delete <repo> <env> <key|uuid>                         (write)
    --value-env reads the value from that env var and defaults to secured; --value is for
    non-secret values only and is refused with --secured. Deleting environments is not offered.
Pull requests:
  prs list <repo> [--state OPEN|MERGED|DECLINED|SUPERSEDED] [--limit N]
  prs get|diff|diffstat|comments|activity <repo> <id>   (diff: raw text, or --out FILE)
  prs create <repo> --title T --source B [--dest B] [--description D] [--reviewers u1,u2] [--close-source] [--draft]
  prs comment <repo> <id> --body TEXT [--reply-to ID] [--path FILE --line N]
  prs approve|unapprove|request-changes <repo> <id>
  prs merge <repo> <id> [--strategy merge_commit|squash|fast_forward] [--close-source] [--message M]
  prs decline <repo> <id> [--message M]
Repositories:
  repos list [<ws>] [--query NAME] [--role member|contributor|admin|owner] [--limit N]
  repos get|branches|tags <repo> [--query NAME]
  repos branch-create <repo> <name> --from <branch|commit>        (write)
  repos commits <repo> [<branch>]
  repos compare <repo> A..B       diffstat
  repos file <repo> <ref> <path> [--out FILE]
  repos search [<ws>] <query>          workspace code search
Git (auth injected via env http.extraHeader; remote URLs never hold credentials):
  git clone <repo> [dir] [--branch B]
  git ls-remote <repo>
  git run [-C dir] [--allow-force] -- <git args...>     e.g. -- push origin my-branch

Global flags: --dry-run (writes print method/URL/body, nothing is sent)  --limit N  --debug
Env: BITBUCKET_TOKEN (secret), BITBUCKET_SKILL_HOME (config dir, default ~/.config/bitbucket-skill),
     BITBUCKET_API_URL (default ${DEFAULT_API}), BITBUCKET_GIT_URL (default ${DEFAULT_GIT})
Exit codes: 0 ok, 1 usage, 2 guardrail refusal, 3 API error, 4 config error, 5 auth problem.`;

const BOOL_FLAGS = new Set(['dry-run', 'debug', 'help', 'secured', 'close-source', 'draft', 'allow-force']);
const VALUE_FLAGS = new Set(['type', 'email', 'username', 'workspace', 'status', 'branch', 'limit', 'custom', 'commit', 'out', 'tail', 'tail-lines',
  'rank', 'value', 'value-env', 'new-key', 'state', 'title', 'source', 'dest', 'description', 'reviewers', 'body', 'reply-to', 'path', 'line',
  'strategy', 'message', 'from', 'query', 'role', 'C']);
const FORBIDDEN_FLAGS = {
  token: 'never pass the token on the command line; it comes only from BITBUCKET_TOKEN.',
  password: 'never pass a password on the command line; the token comes only from BITBUCKET_TOKEN.',
};

export function parseArgs(argv) {
  const _ = [];
  const f = {};
  let rest;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { rest = argv.slice(i + 1); break; }
    if (arg === '-h') { f.help = true; continue; }
    let k;
    let v;
    if (arg === '-C') k = 'C';
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
      f[k] = v;
    } else throw usage(`unknown flag --${k}`);
  }
  return { _, f, rest };
}

export async function main(argv) {
  try {
    const a = parseArgs(argv);
    const cmd = a._[0];
    if (a.f.help || !cmd || cmd === 'help') { out(HELP); return EXIT.OK; }
    if (a.rest && cmd !== 'git') throw usage('"--" is only for git run');
    const table = { config: cmdConfig, auth: cmdAuth, pipelines: cmdPipelines, deploy: cmdDeploy, prs: cmdPrs, repos: cmdRepos, git: cmdGit };
    const fn = table[cmd];
    if (!fn) throw usage(`unknown command "${cmd}"`);
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
