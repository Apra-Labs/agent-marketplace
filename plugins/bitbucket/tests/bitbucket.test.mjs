// Tests for skills/bitbucket/scripts/bitbucket.mjs against a local fake Bitbucket (REST + git smart-HTTP)
// on 127.0.0.1 only. No real Bitbucket is ever contacted.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  gitAuthEnv, buildGitInvocation, remoteUrl, restAuthHeader, diagnoseApiError, diagnoseGit, checkGitRunArgs,
  parseArgs, takeRepo, variableValue, parseGitVersion, EXIT, GIT_USERS, CREDENTIAL_TYPES,
} from '../skills/bitbucket/scripts/bitbucket.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'skills', 'bitbucket', 'scripts', 'bitbucket.mjs');
const SENTINEL = 'bbtok_SENTINEL_5a4b3c2d1e0f9876';
const SECRET_VALUE = 'dv_SECRET_VALUE_0123456789';
const EMAIL = 'dev@example.com';
const B64 = (s) => Buffer.from(s).toString('base64');
const REST_BASIC = `Basic ${B64(`${EMAIL}:${SENTINEL}`)}`;
const REST_BEARER = `Bearer ${SENTINEL}`;
const GIT_API = `Basic ${B64(`x-bitbucket-api-token-auth:${SENTINEL}`)}`;
const GIT_ACCESS = `Basic ${B64(`x-token-auth:${SENTINEL}`)}`;
const SHA = 'a'.repeat(40);

let gitAvailable = true;
try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { gitAvailable = false; }

// ---------------------------------------------------------------- fake servers
let state;
const allLogs = [];
const outputs = [];
function fresh() {
  return {
    log: [], storageLog: [], force: null, nearLimit: false,
    envs: [
      { uuid: '{11111111-1111-1111-1111-111111111111}', name: 'Test', slug: 'test', environment_type: { name: 'Test' }, rank: 0 },
      { uuid: '{22222222-2222-2222-2222-222222222222}', name: 'Production', slug: 'production', environment_type: { name: 'Production' }, rank: 2 },
    ],
    vars: {
      '{22222222-2222-2222-2222-222222222222}': [
        { uuid: '{33333333-3333-3333-3333-333333333333}', key: 'API_URL', value: 'https://x.example', secured: false },
        { uuid: '{44444444-4444-4444-4444-444444444444}', key: 'DB_PASS', secured: true },
      ],
    },
  };
}
function resetState() {
  if (state) allLogs.push(...state.log, ...state.storageLog);
  state = fresh();
}
resetState();

const PIPES = [
  { uuid: '{p3}', build_number: 3, state: { name: 'COMPLETED', result: { name: 'FAILED' } }, target: { ref_name: 'main', commit: { hash: SHA } }, created_on: '2026-10-03' },
  { uuid: '{p2}', build_number: 2, state: { name: 'COMPLETED', result: { name: 'SUCCESSFUL' } }, target: { ref_name: 'dev' }, created_on: '2026-10-02' },
  { uuid: '{p1}', build_number: 1, state: { name: 'COMPLETED', result: { name: 'FAILED' } }, target: { ref_name: 'main' }, created_on: '2026-10-01' },
];
const STEPS = [
  { uuid: '{s1}', name: 'Build', state: { name: 'COMPLETED', result: { name: 'SUCCESSFUL' } } },
  { uuid: '{s2}', name: 'Unit tests', state: { name: 'COMPLETED', result: { name: 'FAILED' } } },
  { uuid: '{s3}', name: 'Lint', state: { name: 'COMPLETED', result: { name: 'ERROR' } } },
];
const REPOS = Array.from({ length: 7 }, (_, i) => ({ full_name: `acme/r${i}`, slug: `r${i}`, is_private: true }));

let BASE;
let STORAGE;
function send(res, status, obj, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(obj === undefined ? '' : typeof obj === 'string' ? obj : JSON.stringify(obj));
}
// Page through an array the way Bitbucket does: absolute `next` link with ?page=N.
function paged(res, url, list, cap = 100) {
  const pagelen = Math.min(cap, Number(url.searchParams.get('pagelen') || 10));
  const page = Number(url.searchParams.get('page') || 1);
  const values = list.slice((page - 1) * pagelen, page * pagelen);
  const body = { pagelen, page, size: list.length, values };
  if (page * pagelen < list.length) {
    const n = new URL(url.toString());
    n.searchParams.set('page', String(page + 1));
    n.searchParams.set('pagelen', String(pagelen));
    body.next = `${BASE}${n.pathname}${n.search}`;
  }
  send(res, 200, body);
}
const pkt = (s) => (Buffer.byteLength(s) + 4).toString(16).padStart(4, '0') + s;

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const url = new URL(req.url, BASE);
    const p = decodeURIComponent(url.pathname);
    const auth = req.headers.authorization || '';
    state.log.push({ method: req.method, path: p, url: req.url, body, auth, range: req.headers.range || null });
    // ---- git smart HTTP
    if (p.startsWith('/git/')) {
      if (auth !== GIT_API && auth !== GIT_ACCESS) return send(res, 401, 'unauthorized', { 'WWW-Authenticate': 'Basic realm="fake"', 'Content-Type': 'text/plain' });
      if (p === '/git/acme/app.git/info/refs' && url.searchParams.get('service') === 'git-upload-pack') {
        res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-advertisement', 'Cache-Control': 'no-cache' });
        return res.end(pkt('# service=git-upload-pack\n') + '0000' + pkt(`${SHA} refs/heads/main\0report-status agent=fake/1\n`) + pkt(`${'b'.repeat(40)} refs/heads/dev\n`) + '0000');
      }
      return send(res, 404, 'not found', { 'Content-Type': 'text/plain' });
    }
    // ---- REST
    const extra = state.nearLimit ? { 'X-RateLimit-NearLimit': 'true' } : {};
    if (state.force && state.force.match.test(p)) return send(res, state.force.status, state.force.body);
    if (auth !== REST_BASIC && auth !== REST_BEARER) return send(res, 401, { type: 'error', error: { message: 'Unauthorized' } });
    const r = p.replace(/^\/2\.0/, '');
    let m;
    if (req.method === 'GET' && r === '/repositories/acme') return paged(res, url, REPOS);
    if (req.method === 'GET' && r === '/repositories/acme/app') return send(res, 200, { full_name: 'acme/app', slug: 'app' }, extra);
    if (req.method === 'GET' && r === '/repositories/acme/app/pipelines/') return paged(res, url, PIPES);
    if (req.method === 'GET' && (m = /^\/repositories\/acme\/app\/pipelines\/(\{p\d\})$/.exec(r))) return send(res, 200, PIPES.find((x) => x.uuid === m[1]));
    if (req.method === 'GET' && /^\/repositories\/acme\/app\/pipelines\/\{p\d\}\/steps\/$/.test(r)) return paged(res, url, STEPS);
    if (req.method === 'GET' && (m = /^\/repositories\/acme\/app\/pipelines\/\{p\d\}\/steps\/(\{s\d\})\/log$/.exec(r))) {
      res.writeHead(307, { Location: `${STORAGE}/logs/${encodeURIComponent(m[1])}?sig=abc` });
      return res.end();
    }
    if (req.method === 'GET' && r === '/repositories/acme/app/environments/') return paged(res, url, state.envs, 1); // one env per page: resolution must follow `next`
    if ((m = /^\/repositories\/acme\/app\/deployments_config\/environments\/(\{[^}]+\})\/variables\/?(\{[^}]+\})?$/.exec(r))) {
      const list = state.vars[m[1]] || (state.vars[m[1]] = []);
      if (req.method === 'GET' && !m[2]) return paged(res, url, list);
      if (req.method === 'POST') { const v = { uuid: '{55555555-5555-5555-5555-555555555555}', ...JSON.parse(body) }; list.push(v); return send(res, 201, v.secured ? { ...v, value: undefined } : v); }
      if (req.method === 'PUT') { const i = list.findIndex((v) => v.uuid === m[2]); list[i] = JSON.parse(body); return send(res, 200, list[i]); }
      if (req.method === 'DELETE') { state.vars[m[1]] = list.filter((v) => v.uuid !== m[2]); return send(res, 204); }
    }
    if (req.method === 'GET' && r === '/repositories/acme/app/pullrequests/7') return send(res, 200, { id: 7, title: 'x', state: 'OPEN' });
    if (req.method === 'POST' && /^\/repositories\/acme\/app\/pullrequests\/7\/(merge|comments|approve|decline)$/.test(r)) return send(res, 200, { ok: true });
    return send(res, 404, { type: 'error', error: { message: `no route ${req.method} ${r}` } });
  });
});
// A second origin standing in for the log storage host the API redirects to.
const storage = http.createServer((req, res) => {
  state.storageLog.push({ path: req.url, auth: req.headers.authorization || '', range: req.headers.range || null });
  const text = `log for ${decodeURIComponent(req.url)}\nline2\nFAILED here\n`;
  res.writeHead(req.headers.range ? 206 : 200, { 'Content-Type': 'text/plain' });
  res.end(text);
});

const homes = [];
before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  await new Promise((r) => storage.listen(0, '127.0.0.1', r));
  STORAGE = `http://127.0.0.1:${storage.address().port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => storage.close(r));
  for (const h of homes) fs.rmSync(h, { recursive: true, force: true });
});
beforeEach(() => resetState());

function newHome() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'bbs-'));
  homes.push(h);
  return h;
}
function run(home, args, env = {}, cwd = home) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, BITBUCKET_TOKEN: SENTINEL, BITBUCKET_SKILL_HOME: home, BITBUCKET_API_URL: `${BASE}/2.0`, BITBUCKET_GIT_URL: `${BASE}/git`, ...env },
    }, (err, stdout, stderr) => {
      outputs.push(stdout, stderr);
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr });
    });
  });
}
async function setup(type = 'api_token', { email = EMAIL, workspace } = {}) {
  const home = newHome();
  const args = ['config', 'set', '--type', type];
  if (email) args.push('--email', email);
  if (workspace) args.push('--workspace', workspace);
  const r = await run(home, args);
  assert.equal(r.code, 0, r.stderr);
  return home;
}
const writes = () => state.log.filter((e) => e.method !== 'GET' && !e.path.startsWith('/git/'));
const json = (r) => JSON.parse(r.stdout);

// ---------------------------------------------------------------- unit
test('git env: correct username per type, empty credential.helper, extraHeader keyed on the git base', () => {
  assert.deepEqual(CREDENTIAL_TYPES, ['api_token', 'access_token']);
  for (const [type, user] of [['api_token', 'x-bitbucket-api-token-auth'], ['access_token', 'x-token-auth']]) {
    const env = gitAuthEnv({ credentialType: type, token: SENTINEL, gitBase: 'https://bitbucket.org' });
    assert.equal(GIT_USERS[type], user);
    assert.equal(env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(env.GIT_CONFIG_COUNT, '2');
    assert.equal(env.GIT_CONFIG_KEY_0, 'credential.helper');
    assert.equal(env.GIT_CONFIG_VALUE_0, '');
    assert.equal(env.GIT_CONFIG_KEY_1, 'http.https://bitbucket.org/.extraHeader');
    assert.equal(env.GIT_CONFIG_VALUE_1, `Authorization: Basic ${B64(`${user}:${SENTINEL}`)}`);
    assert.ok(!JSON.stringify(env).includes(SENTINEL), 'raw token never in env values');
  }
  assert.throws(() => gitAuthEnv({ credentialType: 'oauth', token: SENTINEL }), (e) => e.exitCode === EXIT.CONFIG);
  const inv = buildGitInvocation({ credentialType: 'access_token', token: SENTINEL, gitBase: 'https://bitbucket.org', args: ['ls-remote', '--heads', '--', remoteUrl('acme', 'app')], baseEnv: { PATH: 'x', BITBUCKET_TOKEN: SENTINEL, GIT_ASKPASS: 'evil', GIT_CONFIG_KEY_5: 'x' } });
  assert.equal(inv.command, 'git');
  assert.ok(!inv.args.join(' ').includes(SENTINEL) && !inv.args.join(' ').includes(B64(`x-token-auth:${SENTINEL}`)), 'no token in argv');
  assert.ok(inv.args.includes('https://bitbucket.org/acme/app.git'), 'remote URL without userinfo');
  assert.equal(inv.env.BITBUCKET_TOKEN, undefined, 'token env var not passed to git');
  assert.equal(inv.env.GIT_ASKPASS, undefined);
  assert.equal(inv.env.GIT_CONFIG_KEY_5, undefined);
  assert.equal(inv.env.PATH, 'x');
});

test('REST auth header: Basic email:token for api_token (email required), Bearer for access_token', () => {
  assert.equal(restAuthHeader('api_token', SENTINEL, EMAIL), REST_BASIC);
  assert.equal(restAuthHeader('access_token', SENTINEL), REST_BEARER);
  assert.throws(() => restAuthHeader('api_token', SENTINEL, ''), (e) => e.exitCode === EXIT.CONFIG && /email/.test(e.message));
});

test('error diagnosis: 401 email, 403 scopes, 410 / CHANGE-3222, generic 401, 404', () => {
  let e = diagnoseApiError(401, '{"type":"error","error":{"message":"API token must be used with an atlassian registered email"}}');
  assert.equal(e.exitCode, EXIT.AUTH);
  assert.match(e.message, /config set --email/);
  e = diagnoseApiError(403, JSON.stringify({ type: 'error', error: { message: 'Your credentials lack one or more required privilege scopes.', detail: { granted: ['write:pullrequest:bitbucket'], required: ['read:pullrequest:bitbucket'] } } }));
  assert.equal(e.exitCode, EXIT.AUTH);
  assert.match(e.message, /Required: read:pullrequest:bitbucket/);
  assert.match(e.message, /do not imply each other/);
  assert.deepEqual(e.required, ['read:pullrequest:bitbucket']);
  e = diagnoseApiError(403, JSON.stringify({ error: { message: 'Your credentials lack one or more required privilege scopes.', detail: JSON.stringify({ required: ['read:repository:bitbucket'] }) } }));
  assert.deepEqual(e.required, ['read:repository:bitbucket'], 'detail as a JSON string');
  for (const [s, b] of [[410, ''], [401, 'see CHANGE-3222']]) {
    e = diagnoseApiError(s, b);
    assert.equal(e.exitCode, EXIT.AUTH);
    assert.match(e.message, /2026-07-28/);
  }
  e = diagnoseApiError(401, '{"error":{"message":"Unauthorized"}}');
  assert.equal(e.exitCode, EXIT.AUTH);
  assert.match(e.message, /expired or revoked/);
  e = diagnoseApiError(404, '{}');
  assert.equal(e.exitCode, EXIT.API);
  assert.equal(diagnoseGit("fatal: Authentication failed for 'https://bitbucket.org/a/b.git/'", 128).exitCode, EXIT.AUTH);
  assert.equal(diagnoseGit("fatal: could not read Username for 'https://x': terminal prompts disabled", 128).exitCode, EXIT.AUTH);
  assert.equal(diagnoseGit('fatal: not a git repository', 128).exitCode, EXIT.API);
});

test('git run guardrails: URL userinfo refused, force push needs --allow-force', () => {
  const refused = (args, opts) => assert.throws(() => checkGitRunArgs(args, opts), (e) => e.exitCode === EXIT.GUARDRAIL);
  refused(['push', 'https://user:pw@bitbucket.org/a/b.git', 'main']);
  refused(['remote', 'set-url', 'origin', 'https://x-token-auth@bitbucket.org/a/b.git']);
  refused(['-c', 'remote.o.url=https://u:p@h/x', 'fetch']);
  for (const f of [['--force'], ['-f'], ['-uf'], ['--force-with-lease'], ['--force-with-lease=main'], ['+main:main'], ['--mirror']]) refused(['push', 'origin', ...f]);
  refused(['-C', 'x', 'push', '--force']);
  assert.equal(checkGitRunArgs(['push', 'origin', '--force'], { allowForce: true }).subcommand, 'push');
  assert.equal(checkGitRunArgs(['push', '-u', 'origin', 'feat/x']).subcommand, 'push');
  assert.equal(checkGitRunArgs(['fetch', 'origin']).subcommand, 'fetch');
  assert.throws(() => checkGitRunArgs([]), (e) => e.exitCode === EXIT.USAGE);
});

test('arg parsing: -- rest for git run, forbidden token flags, repo forms, git version', () => {
  const a = parseArgs(['git', 'run', '-C', 'd', '--allow-force', '--', 'push', '--force']);
  assert.deepEqual(a.rest, ['push', '--force']);
  assert.equal(a.f.C, 'd');
  assert.throws(() => parseArgs(['repos', 'list', '--token', 'x']), (e) => e.exitCode === EXIT.GUARDRAIL);
  assert.deepEqual(takeRepo({}, ['acme/app', '7']), { ws: 'acme', repo: 'app', args: ['7'] });
  // a configured workspace never turns "<repo> <next>" into ws=<repo>, repo=<next>
  assert.deepEqual(takeRepo({ workspace: 'acme' }, ['app', '108']), { ws: 'acme', repo: 'app', args: ['108'] });
  assert.deepEqual(takeRepo({ workspace: 'acme' }, ['other/app', 'main']), { ws: 'other', repo: 'app', args: ['main'] });
  assert.throws(() => takeRepo({}, ['app', '7']), (e) => e.exitCode === EXIT.USAGE && /<ws>\/app/.test(e.message));
  assert.throws(() => takeRepo({}, ['a/b/c']), (e) => e.exitCode === EXIT.USAGE);
  assert.throws(() => takeRepo({ workspace: 'acme' }, []), (e) => e.exitCode === EXIT.USAGE);
  assert.deepEqual(parseGitVersion('git version 2.45.1.windows.1'), [2, 45]);
});

test('variableValue: --value-env reads env and defaults to secured; --value refused with --secured', () => {
  process.env.BB_TEST_SECRET_X = SECRET_VALUE;
  try {
    assert.deepEqual(variableValue({ 'value-env': 'BB_TEST_SECRET_X' }), { value: SECRET_VALUE, secured: true, fromEnv: true });
    assert.equal(variableValue({ 'value-env': 'BB_TEST_SECRET_X', secured: false }).secured, false);
  } finally { delete process.env.BB_TEST_SECRET_X; }
  assert.throws(() => variableValue({ value: 'x', secured: true }), (e) => e.exitCode === EXIT.GUARDRAIL);
  assert.throws(() => variableValue({ 'value-env': 'BB_TEST_UNSET_Y' }), (e) => e.exitCode === EXIT.CONFIG);
  assert.throws(() => variableValue({ 'value-env': 'BITBUCKET_TOKEN' }), (e) => e.exitCode === EXIT.GUARDRAIL);
  assert.deepEqual(variableValue({ value: 'plain' }), { value: 'plain', secured: false, fromEnv: false });
});

// ---------------------------------------------------------------- end to end
test('config set/show: no secrets stored; oauth refused with a CONFIG error', async () => {
  const home = newHome();
  let r = await run(home, ['config', 'set', '--type', 'api_token', '--email', EMAIL, '--username', 'dev', '--workspace', 'acme']);
  assert.equal(r.code, 0, r.stderr);
  const saved = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  assert.deepEqual(saved, { credential_type: 'api_token', email: EMAIL, username: 'dev', workspace: 'acme' });
  r = await run(home, ['config', 'show']);
  const shown = json(r);
  assert.equal(shown.workspace, 'acme');
  assert.equal(shown.token_in_env, true);
  assert.ok(!r.stdout.includes(SENTINEL));
  r = await run(home, ['config', 'set', '--type', 'oauth']);
  assert.equal(r.code, EXIT.CONFIG);
  assert.match(r.stderr, /1 hour/);
  r = await run(home, ['config', 'set', '--token', SENTINEL]);
  assert.equal(r.code, EXIT.GUARDRAIL);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).credential_type, 'api_token');
  r = await run(home, ['repos', 'list'], { BITBUCKET_TOKEN: '' });
  assert.equal(r.code, EXIT.CONFIG);
  r = await run(home, ['repos', 'list'], { BITBUCKET_TOKEN: '{{secret.BB}}' });
  assert.equal(r.code, EXIT.CONFIG);
  assert.match(r.stderr, /unsubstituted/);
});

test('auth header shape per credential type; api_token without email is a config error', async () => {
  let home = await setup('api_token');
  let r = await run(home, ['repos', 'get', 'acme/app']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(state.log.at(-1).auth, REST_BASIC);
  home = await setup('access_token', { email: null });
  r = await run(home, ['repos', 'get', 'acme/app']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(state.log.at(-1).auth, REST_BEARER);
  home = await setup('api_token', { email: null });
  const before = state.log.length;
  r = await run(home, ['repos', 'get', 'acme/app']);
  assert.equal(r.code, EXIT.CONFIG);
  assert.match(r.stderr, /email/);
  assert.equal(state.log.length, before, 'nothing sent');
});

test('error diagnosis end to end: exit 5 with the right message', async () => {
  const home = await setup();
  const cases = [
    [401, { type: 'error', error: { message: 'API token must be used with an atlassian registered email' } }, /config set --email/],
    [403, { type: 'error', error: { message: 'Your credentials lack one or more required privilege scopes.', detail: { required: ['read:repository:bitbucket', 'read:pipeline:bitbucket'] } } }, /Required: read:repository:bitbucket, read:pipeline:bitbucket/],
    [410, { type: 'error', error: { message: 'Gone' } }, /CHANGE-3222/],
    [401, { type: 'error', error: { message: 'Bad credentials CHANGE-3222' } }, /removed on 2026-07-28/],
    [401, { type: 'error', error: { message: 'Unauthorized' } }, /expired or revoked/],
  ];
  for (const [status, body, re] of cases) {
    state.force = { match: /repositories\/acme\/app$/, status, body };
    const r = await run(home, ['repos', 'get', 'acme/app']);
    assert.equal(r.code, EXIT.AUTH, `${status}: ${r.stderr}`);
    assert.match(r.stderr, re);
  }
});

test('rate limit near-limit header is surfaced as a stderr warning', async () => {
  const home = await setup();
  state.nearLimit = true;
  const r = await run(home, ['repos', 'get', 'acme/app']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /X-RateLimit-NearLimit/);
});

test('pagination follows next up to --limit; workspace defaults from config', async () => {
  const home = await setup('api_token', { workspace: 'acme' });
  let r = await run(home, ['repos', 'list', '--limit', '5']);
  assert.equal(r.code, 0, r.stderr);
  let d = json(r);
  assert.equal(d.count, 5);
  assert.equal(d.more, true);
  assert.deepEqual(d.values.map((x) => x.slug), ['r0', 'r1', 'r2', 'r3', 'r4']);
  resetState();
  r = await run(home, ['repos', 'list', '--limit', '100']);
  d = json(r);
  assert.equal(d.count, 7);
  assert.equal(d.more, false);
  resetState();
  r = await run(home, ['repos', 'list', '--limit', '3']);
  assert.equal(json(r).count, 3);
  assert.ok(state.log.every((e) => e.auth === REST_BASIC), 'every page authenticated');
});

test('pipelines: latest-failed, failed-steps, failed-logs to --out, log --tail uses Range, storage host never gets the token', async () => {
  const home = await setup();
  let r = await run(home, ['pipelines', 'latest-failed', 'acme/app']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(json(r).build_number, 3);
  r = await run(home, ['pipelines', 'failed-steps', 'acme/app']);
  assert.deepEqual(json(r).failed_steps.map((s) => s.name), ['Unit tests', 'Lint']);
  const outDir = path.join(home, 'logs');
  r = await run(home, ['pipelines', 'failed-logs', 'acme/app', '#1', '--out', outDir]);
  assert.equal(r.code, 0, r.stderr);
  const logs = json(r).logs;
  assert.equal(logs.length, 2);
  assert.ok(logs.every((l) => fs.existsSync(l.file) && l.file.startsWith(outDir)));
  assert.match(path.basename(logs[0].file), /^pipeline-1-Unit_tests\.log$/);
  assert.match(fs.readFileSync(logs[0].file, 'utf8'), /FAILED here/);
  r = await run(home, ['pipelines', 'log', 'acme/app', '3', 'Lint', '--tail', '500']);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(json(r).file.startsWith(path.join(home, '.pipeline-logs')), 'default out dir under cwd');
  assert.equal(state.log.filter((e) => /\/log$/.test(e.path)).at(-1).range, 'bytes=-500');
  assert.equal(state.storageLog.at(-1).range, 'bytes=-500', 'Range kept across the redirect');
  assert.ok(state.storageLog.length >= 3);
  assert.ok(state.storageLog.every((e) => e.auth === ''), 'no Authorization sent to the storage host');
  r = await run(home, ['pipelines', 'status', 'acme/app', '3']);
  assert.equal(json(r).progress.total, 3);
});

test('bare <repo> with a configured workspace: following positionals are never taken as the repo', async () => {
  const home = await setup('api_token', { workspace: 'acme' });
  let r = await run(home, ['pipelines', 'status', 'app', '3']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(json(r).pipeline.build_number, 3);
  r = await run(home, ['pipelines', 'failed-steps', 'app', '1']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(json(r).pipeline.build_number, 1);
  r = await run(home, ['git', 'clone', 'app', 'mydir', '--dry-run']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(json(r).args, ['clone', '--', `${BASE}/git/acme/app.git`, 'mydir']);
  assert.ok(state.log.every((e) => !e.path.includes('/repositories/app/')), 'never ws=<repo>');
  const noWs = await setup();
  r = await run(noWs, ['pipelines', 'get', 'acme', 'app', '3']);
  assert.equal(r.code, EXIT.USAGE, 'the two-token <ws> <repo> form is gone');
});

test('a step log Bitbucket no longer has (404) is reported clearly; failed-logs continues', async () => {
  const home = await setup();
  state.force = { match: /steps\/\{s2\}\/log$/, status: 404, body: { type: 'error', error: { message: 'Not found' } } };
  let r = await run(home, ['pipelines', 'log', 'acme/app', '1', 'Unit tests']);
  assert.equal(r.code, EXIT.API);
  assert.match(r.stderr, /log not available for step "Unit tests" of pipeline #1/);
  assert.match(r.stderr, /expires pipeline logs/);
  assert.doesNotMatch(r.stderr, /API error 404/);
  r = await run(home, ['pipelines', 'failed-logs', 'acme/app', '1', '--out', path.join(home, 'l')]);
  assert.equal(r.code, 0, r.stderr);
  const logs = json(r).logs;
  assert.equal(logs.length, 2);
  assert.equal(logs[0].log_missing, true);
  assert.match(logs[0].error, /expires pipeline logs/);
  assert.ok(fs.existsSync(logs[1].file), 'the other failed step log was still downloaded');
});

test('dry-run sends nothing for every write', async () => {
  const home = await setup();
  process.env.BB_DRY_SECRET = SECRET_VALUE;
  const cases = [
    ['pipelines', 'run', 'acme/app', '--branch', 'main', '--custom', 'deploy'],
    ['pipelines', 'stop', 'acme/app', '3'],
    ['prs', 'merge', 'acme/app', '7', '--strategy', 'squash', '--close-source'],
    ['prs', 'comment', 'acme/app', '7', '--body', 'hi', '--path', 'a.js', '--line', '3'],
    ['prs', 'approve', 'acme/app', '7'],
    ['prs', 'decline', 'acme/app', '7'],
    ['prs', 'create', 'acme/app', '--title', 't', '--source', 'feat/x'],
    ['repos', 'branch-create', 'acme/app', 'feat/y', '--from', SHA],
    ['deploy', 'env-create', 'acme/app', 'staging', '--type', 'Staging'],
    ['deploy', 'var-set', 'acme/app', 'Production', 'NEW_SECRET', '--value-env', 'BB_DRY_SECRET'],
    ['deploy', 'var-delete', 'acme/app', 'Production', 'API_URL'],
  ];
  for (const args of cases) {
    const r = await run(home, [...args, '--dry-run'], { BB_DRY_SECRET: SECRET_VALUE });
    assert.equal(r.code, 0, `${args.join(' ')}: ${r.stderr}`);
    const plan = json(r);
    assert.equal(plan.dry_run, true);
    assert.equal(plan.headers.Authorization, 'Basic [REDACTED]');
    assert.ok(plan.method && plan.url);
    assert.ok(!r.stdout.includes(SECRET_VALUE), 'secret variable value not shown');
  }
  delete process.env.BB_DRY_SECRET;
  assert.equal(writes().length, 0, 'no write reached the server');
  const merge = await run(home, ['prs', 'merge', 'acme/app', '7', '--strategy', 'squash', '--dry-run']);
  assert.deepEqual(json(merge).body, { type: 'pullrequest', merge_strategy: 'squash', close_source_branch: false });
  const bad = await run(home, ['prs', 'merge', 'acme/app', '7', '--strategy', 'rebase', '--dry-run']);
  assert.equal(bad.code, EXIT.USAGE);
});

test('deploy vars: env name -> uuid across pages; --value-env sets a secured var; --value with --secured refused', async () => {
  const home = await setup();
  const r0 = await run(home, ['deploy', 'envs', 'acme/app']);
  assert.equal(json(r0).count, 2);
  let r = await run(home, ['deploy', 'vars', 'acme/app', 'production']);
  assert.equal(r.code, 0, r.stderr);
  const d = json(r);
  assert.equal(d.environment_uuid, '{22222222-2222-2222-2222-222222222222}');
  assert.deepEqual(d.values.map((v) => [v.key, v.secured, v.value]), [['API_URL', false, 'https://x.example'], ['DB_PASS', true, null]]);

  r = await run(home, ['deploy', 'var-set', 'acme/app', 'Production', 'TOKEN_X', '--value-env', 'BB_SEC'], { BB_SEC: SECRET_VALUE });
  assert.equal(r.code, 0, r.stderr);
  const post = writes().find((e) => e.method === 'POST');
  assert.match(post.path, /environments\/\{22222222-2222-2222-2222-222222222222\}\/variables\/$/);
  assert.deepEqual(JSON.parse(post.body), { key: 'TOKEN_X', value: SECRET_VALUE, secured: true });
  assert.ok(!r.stdout.includes(SECRET_VALUE) && !r.stderr.includes(SECRET_VALUE));

  r = await run(home, ['deploy', 'var-set', 'acme/app', 'Production', 'DB_PASS', '--value', 'hunter2', '--secured']);
  assert.equal(r.code, EXIT.GUARDRAIL);
  assert.match(r.stderr, /--value-env/);

  r = await run(home, ['deploy', 'var-update', 'acme/app', '{22222222-2222-2222-2222-222222222222}', 'API_URL', '--value', 'https://y.example']);
  assert.equal(r.code, 0, r.stderr);
  const put = writes().find((e) => e.method === 'PUT');
  assert.match(put.path, /variables\/\{33333333-3333-3333-3333-333333333333\}$/);
  assert.deepEqual(JSON.parse(put.body), { uuid: '{33333333-3333-3333-3333-333333333333}', key: 'API_URL', value: 'https://y.example', secured: false });

  r = await run(home, ['deploy', 'var-update', 'acme/app', 'Production', 'DB_PASS', '--new-key', 'DB_PASSWORD']);
  assert.equal(r.code, EXIT.USAGE, 'secured value cannot be read back');
  r = await run(home, ['deploy', 'vars', 'acme/app', 'Nope']);
  assert.equal(r.code, EXIT.API);
  assert.match(r.stderr, /Available: Test, Production/);
  r = await run(home, ['deploy', 'env-delete', 'acme/app', 'Test']);
  assert.equal(r.code, EXIT.GUARDRAIL);
  assert.equal(writes().filter((e) => e.method === 'DELETE').length, 0);
});

test('a next link to another host is refused (token only goes to the API host)', async () => {
  const home = await setup();
  state.force = { match: /repositories\/acme$/, status: 200, body: { values: [REPOS[0]], next: 'https://evil.example/2.0/repositories/acme?page=2' } };
  const r = await run(home, ['repos', 'list', 'acme', '--limit', '10']);
  assert.equal(r.code, EXIT.API);
  assert.match(r.stderr, /refusing to follow/);
});

test('git run: URL userinfo and force push refused end to end, nothing spawned', async () => {
  const home = await setup();
  let r = await run(home, ['git', 'run', '--', 'clone', 'https://me:pw@bitbucket.org/acme/app.git']);
  assert.equal(r.code, EXIT.GUARDRAIL);
  assert.ok(!r.stderr.includes('pw@'));
  r = await run(home, ['git', 'run', '-C', home, '--', 'push', '--force', 'origin', 'main']);
  assert.equal(r.code, EXIT.GUARDRAIL);
  assert.match(r.stderr, /--allow-force/);
  r = await run(home, ['git', 'run', '-C', home, '--allow-force', '--dry-run', '--', 'push', '--force', 'origin', 'main']);
  assert.equal(r.code, 0, r.stderr);
  const plan = json(r);
  assert.deepEqual(plan.args, ['push', '--force', 'origin', 'main']);
  assert.equal(plan.env.GIT_CONFIG_VALUE_0, '');
  assert.match(plan.env.GIT_CONFIG_VALUE_1, /\[REDACTED\]/);
});

test('auth test: REST + git with the right git username per type; git 401 diagnosed', { skip: !gitAvailable && 'git not installed' }, async () => {
  for (const [type, gitAuth] of [['api_token', GIT_API], ['access_token', GIT_ACCESS]]) {
    resetState();
    const home = await setup(type, { email: type === 'api_token' ? EMAIL : null });
    const r = await run(home, ['auth', 'test', 'acme/app']);
    assert.equal(r.code, 0, `${type}: ${r.stdout} ${r.stderr}`);
    const rep = json(r);
    assert.equal(rep.ok, true);
    assert.equal(rep.rest.repo, 'acme/app');
    assert.equal(rep.git.heads, 2);
    assert.equal(rep.git.git_username, GIT_USERS[type]);
    const gitReqs = state.log.filter((e) => e.path.startsWith('/git/'));
    assert.ok(gitReqs.length >= 1);
    assert.ok(gitReqs.every((e) => e.auth === gitAuth), `${type}: git sent ${gitReqs.map((e) => e.auth.slice(0, 10)).join(',')}`);
    assert.ok(gitReqs.every((e) => !e.url.includes(SENTINEL)));
    assert.equal(state.log.find((e) => e.path === '/2.0/repositories/acme/app').auth, type === 'api_token' ? REST_BASIC : REST_BEARER);
  }
  // git ls-remote standalone + clone
  resetState();
  const home = await setup('access_token', { email: null });
  let r = await run(home, ['git', 'ls-remote', 'acme/app']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(json(r).heads.map((h) => h.ref), ['refs/heads/main', 'refs/heads/dev']);
  // wrong token: REST 401 and git auth failure, exit 5
  r = await run(home, ['auth', 'test', 'acme/app'], { BITBUCKET_TOKEN: 'wrong-token-value-xyz' });
  assert.equal(r.code, EXIT.AUTH);
  const rep = json(r);
  assert.equal(rep.rest.ok, false);
  assert.equal(rep.git.ok, false);
  assert.match(rep.git.diagnosis, /git authentication failed/);
  assert.ok(!r.stdout.includes('wrong-token-value-xyz') && !r.stderr.includes('wrong-token-value-xyz'));
});

test('auth test without a repo: GET /repositories/{ws}?pagelen=1, git skipped', async () => {
  const home = await setup('api_token', { workspace: 'acme' });
  const r = await run(home, ['auth', 'test']);
  assert.equal(r.code, 0, r.stderr);
  const rep = json(r);
  assert.equal(rep.rest.ok, true);
  assert.ok(rep.git.skipped);
  const req = state.log.find((e) => e.path === '/2.0/repositories/acme');
  assert.match(req.url, /pagelen=1/);
  assert.ok(!state.log.some((e) => e.path === '/2.0/user'), '/user is never called');
});

test('debug output redacts Authorization; help names no removed credential kinds', async () => {
  const home = await setup();
  let r = await run(home, ['repos', 'get', 'acme/app', '--debug']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /Authorization: Basic \[REDACTED\]/);
  r = await run(home, ['help']);
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.stdout, /oauth|app.?password|unscoped|credentials? file/i);
});

test('the token never appears in stdout, stderr, config files, URLs or bodies', () => {
  allLogs.push(...state.log, ...state.storageLog);
  assert.ok(outputs.length > 40, 'collected CLI output');
  for (const o of outputs) {
    assert.ok(!o.includes(SENTINEL), 'sentinel token leaked to output');
    for (const h of [REST_BASIC, GIT_API, GIT_ACCESS]) assert.ok(!o.includes(h.slice(6)), 'auth header value leaked');
  }
  for (const h of homes) {
    const p = path.join(h, 'config.json');
    if (fs.existsSync(p)) assert.ok(!fs.readFileSync(p, 'utf8').includes(SENTINEL));
  }
  for (const e of allLogs) {
    assert.ok(!String(e.url || e.path).includes(SENTINEL), 'token in URL');
    assert.ok(!String(e.body || '').includes(SENTINEL), 'token in body');
  }
});
