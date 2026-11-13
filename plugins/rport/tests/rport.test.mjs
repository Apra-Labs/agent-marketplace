// Tests for skills/rport/scripts/rport.mjs against a local fake RPort server (127.0.0.1 only).
// No real RPort server is ever contacted.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  normalizeAclSpec, parseAclEntry, resolveAcl, validateAutoClose, validateIdle, computeHardExpiry,
  parseRemote, validateStoredAcl, optionsFromStored, validateStored, aclEquals, aclCoversIp, LIMITS,
  assertAllowedRequest, validateScriptTimeout, pickLibraryScript, buildScriptRunBody, checkBodySize, tailLines, scriptSha256,
  redactSecrets, normalizeScriptText, normScriptSha256, toUtcIso, parseWhen, resolveInterpreter, scriptFlavor, buildLibraryIndex,
  attributeScript, matchAuditStart, prepAuditStarts, slimJob, HISTORY, hasInlineSudo,
} from '../skills/rport/scripts/rport.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'skills', 'rport', 'scripts', 'rport.mjs');
const SENTINEL = 'tok_SENTINEL_9f8e7d6c5b4a3210';
const USER = 'alice';
const BASIC = Buffer.from(`${USER}:${SENTINEL}`).toString('base64');
const SELF = '203.0.113.7';

// ---------------------------------------------------------------- fake server
// Two independent fake RPort servers on one port: "/api/v1" (state) and "/b/api/v1" (stateB),
// with clashing client and stored tunnel names, to test server monikers.
let state;
let stateB;
const allLogs = []; // every request the fakes saw, for the token-leak check
function freshState() {
  return {
    ip: SELF,
    clients: [
      { id: 'c-1', name: 'my-server', connection_state: 'connected' },
      { id: 'c-2', name: 'offline-box', connection_state: 'disconnected' },
    ],
    tunnels: [],
    stored: [], // { client_id, id, created_at, name, scheme, remote_ip, remote_port, public_port, acl, further_options }
    nextId: 1,
    nextPort: 20000,
    nextStored: 1,
    active: new Set(),
    log: [],
    library: [], // { id, name, script, interpreter, cwd, is_sudo, timeout_sec, tags, created_by, created_at, updated_at }
    nextScript: 1,
    jobs: [], // { jid, client_id, ..., _seq: statuses returned by successive GETs, _script }
    nextJid: 1,
    jobSeq: ['successful'], // statuses a new job reports on successive GETs (last one sticks)
    jobOut: { stdout: 'ok\n', stderr: '', summary: 'done' },
    scriptErr: null, // { status, title } returned by POST /clients/{id}/scripts
    multiJobs: [], // { jid, started_at, created_by, schedule_id, client_ids, group_ids, command, jobs: [...] }
    audit: [], // { timestamp, username, remote_ip, application, action, affected_id, client_id, client_hostname, request, response }
    auditStatus: 200, // 403 = the user lacks the auditlog permission
  };
}
function seedScript(fields, S = state) {
  const now = new Date().toISOString();
  const s = { id: `scr-${S.nextScript++}`, name: 'x', script: 'echo hi\n', interpreter: '', cwd: '', is_sudo: false, timeout_sec: 60, tags: [], created_by: USER, created_at: now, updated_at: now, ...fields };
  S.library.push(s);
  return s;
}
const publicJob = ({ _seq, _script, ...rest }) => rest;
function jobNext(j) {
  if (j._seq.length > 1) j.status = j._seq.shift();
  else j.status = j._seq[0];
  if (j.status !== 'running' && !j.finished_at) j.finished_at = new Date().toISOString();
  return j;
}
function resetState() {
  if (state) allLogs.push(...state.log, ...stateB.log);
  state = freshState();
  stateB = freshState();
}
resetState();

function seedStored(clientId, fields, S = state) {
  const s = { client_id: clientId, id: `st-${S.nextStored++}`, created_at: new Date().toISOString(), scheme: 'ssh', remote_ip: '127.0.0.1', remote_port: 22, acl: `${SELF}/32`, further_options: '', ...fields };
  S.stored.push(s);
  return s;
}
const publicStored = ({ client_id, ...rest }) => rest; // ClientID is not serialised

function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(obj === undefined ? '' : JSON.stringify(obj));
}
const errBody = (code, title) => ({ errors: [{ code, title, detail: '' }] });

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const S = url.pathname.startsWith('/b/') ? stateB : state;
    S.log.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, auth: req.headers.authorization || '' });
    if (req.headers.authorization !== `Basic ${BASIC}`) return send(res, 401, errBody('', 'unauthorized'));
    const p = url.pathname.replace(/^(\/b)?\/api\/v1/, '');
    let m;
    if (req.method === 'GET' && p === '/me/ip') return send(res, 200, { data: { ip: S.ip } });
    if (req.method === 'GET' && p === '/me') return send(res, 200, { data: { username: USER, name: 'Test User', groups: ['ops'] } });
    if (req.method === 'GET' && p === '/clients') {
      const n = url.searchParams.get('filter[name]');
      return send(res, 200, { data: S.clients.filter((c) => !n || c.name === n) });
    }
    if (req.method === 'GET' && p === '/tunnels') return send(res, 200, { data: S.tunnels });
    if (req.method === 'GET' && (m = /^\/clients\/([^/]+)$/.exec(p))) {
      const c = S.clients.find((x) => x.id === m[1]);
      return c ? send(res, 200, { data: c }) : send(res, 404, errBody('', 'client not found'));
    }
    if ((m = /^\/clients\/([^/]+)\/stored-tunnels$/.exec(p))) {
      if (req.method === 'GET') {
        const n = url.searchParams.get('filter[name]');
        const list = S.stored.filter((s) => s.client_id === m[1] && (!n || s.name === n)).map(publicStored);
        return send(res, 200, { data: list, meta: { count: list.length } });
      }
      if (req.method === 'POST') {
        const b = JSON.parse(body);
        if (S.stored.some((s) => s.client_id === m[1] && s.name === b.name)) return send(res, 409, errBody('', 'another stored tunnel with the same name exists'));
        return send(res, 201, { data: publicStored(seedStored(m[1], b, S)) });
      }
    }
    if ((m = /^\/clients\/([^/]+)\/stored-tunnels\/([^/]+)$/.exec(p))) {
      const i = S.stored.findIndex((s) => s.client_id === m[1] && s.id === m[2]);
      if (i < 0) return send(res, 404, errBody('', 'cannot find stored tunnel'));
      if (req.method === 'PUT') {
        const { id, created_at, client_id } = S.stored[i];
        S.stored[i] = { ...JSON.parse(body), id, created_at, client_id };
        return send(res, 200, { data: publicStored(S.stored[i]) });
      }
      if (req.method === 'DELETE') { S.stored.splice(i, 1); return send(res, 204); }
    }
    if (req.method === 'PUT' && (m = /^\/clients\/([^/]+)\/tunnels$/.exec(p))) {
      const c = S.clients.find((x) => x.id === m[1]);
      if (!c || c.connection_state !== 'connected') return send(res, 404, errBody('', 'client is not active'));
      const q = url.searchParams;
      if (q.has('skip-idle-timeout') && q.has('idle-timeout-minutes')) return send(res, 400, errBody('ERR_CODE_INVALID_IDLE_TIMEOUT', 'conflict'));
      const remote = q.get('remote');
      const [rhost, rport] = remote.includes(':') ? remote.split(':') : ['0.0.0.0', remote];
      const t = {
        id: String(S.nextId++), client_id: c.id, lhost: '0.0.0.0', lport: q.get('local') || String(S.nextPort++), rhost, rport,
        lport_random: !q.has('local'), scheme: q.get('scheme') || '', protocol: q.get('protocol') || 'tcp', acl: q.get('acl') || '',
        http_proxy: false, host_header: '', tunnel_url: '', idle_timeout_minutes: Number(q.get('idle-timeout-minutes') || 5),
      };
      S.tunnels.push(t);
      return send(res, 200, { data: t });
    }
    if (req.method === 'DELETE' && (m = /^\/clients\/([^/]+)\/tunnels\/([^/]+)$/.exec(p))) {
      const i = S.tunnels.findIndex((x) => x.client_id === m[1] && x.id === m[2]);
      if (i < 0) return send(res, 404, errBody('', 'tunnel not found'));
      if (S.active.has(`${m[1]}/${m[2]}`) && url.searchParams.get('force') !== 'true') return send(res, 409, errBody('', 'tunnel is still active: it has 1 active connection(s)'));
      S.tunnels.splice(i, 1);
      return send(res, 204);
    }
    // ---- script library
    if (p === '/library/scripts') {
      if (req.method === 'GET') {
        const lim = Number(url.searchParams.get('page[limit]') || 50);
        const off = Number(url.searchParams.get('page[offset]') || 0);
        return send(res, 200, { data: S.library.slice(off, off + lim), meta: { count: S.library.length } });
      }
      if (req.method === 'POST') return send(res, 200, { data: seedScript(JSON.parse(body), S) });
    }
    if ((m = /^\/library\/scripts\/([^/]+)$/.exec(p))) {
      const i = S.library.findIndex((s) => s.id === m[1]);
      if (i < 0) return send(res, 404, errBody('', 'script not found'));
      if (req.method === 'GET') return send(res, 200, { data: S.library[i] });
      if (req.method === 'PUT') {
        S.library[i] = { ...S.library[i], ...JSON.parse(body), updated_at: new Date().toISOString() };
        return send(res, 200, { data: S.library[i] });
      }
      if (req.method === 'DELETE') { S.library.splice(i, 1); return send(res, 204); }
    }
    // ---- run on one client + jobs
    if (req.method === 'POST' && (m = /^\/clients\/([^/]+)\/scripts$/.exec(p))) {
      const c = S.clients.find((x) => x.id === m[1]);
      if (!c || c.connection_state !== 'connected') return send(res, 404, errBody('', `Active client with id=${m[1]} not found`));
      if (S.scriptErr) return send(res, S.scriptErr.status, errBody('', S.scriptErr.title));
      const b = JSON.parse(body);
      const j = {
        jid: `job-${S.nextJid++}`, client_id: c.id, client_name: c.name, status: 'running', interpreter: b.interpreter || '/bin/sh', cwd: b.cwd || '',
        is_sudo: b.is_sudo, timeout_sec: b.timeout_sec, started_at: new Date().toISOString(), finished_at: null, created_by: USER, error: '',
        result: { ...S.jobOut }, _seq: [...S.jobSeq], _script: Buffer.from(b.script, 'base64').toString('utf8'),
      };
      S.jobs.push(j);
      return send(res, 200, { data: { jid: j.jid } });
    }
    if (req.method === 'GET' && (m = /^\/clients\/([^/]+)\/commands\/([^/]+)$/.exec(p))) {
      const j = S.jobs.find((x) => x.client_id === m[1] && x.jid === m[2]);
      return j ? send(res, 200, { data: publicJob(jobNext(j)) }) : send(res, 404, errBody('', 'job not found'));
    }
    if (req.method === 'GET' && (m = /^\/clients\/([^/]+)\/commands$/.exec(p))) {
      // Real shape: the list carries only jid, status, finished_at and result.summary.
      const lim = Number(url.searchParams.get('page[limit]') || 50);
      const off = Number(url.searchParams.get('page[offset]') || 0);
      const all = S.jobs.filter((x) => x.client_id === m[1]).reverse();
      const list = all.slice(off, off + lim).map((j) => ({ jid: j.jid, status: j.status, finished_at: j.finished_at, result: { summary: (j.result && j.result.summary) || '' } }));
      return send(res, 200, { data: list, meta: { count: all.length } });
    }
    // ---- multi-client jobs (read-only here) and the audit log
    if (req.method === 'GET' && p === '/commands') {
      const lim = Number(url.searchParams.get('page[limit]') || 50);
      const off = Number(url.searchParams.get('page[offset]') || 0);
      const list = S.multiJobs.slice(off, off + lim).map(({ jid, started_at, created_by, schedule_id }) => ({ jid, started_at, created_by, schedule_id }));
      return send(res, 200, { data: list, meta: { count: S.multiJobs.length } });
    }
    if (req.method === 'GET' && (m = /^\/commands\/([^/]+)$/.exec(p))) {
      const mj = S.multiJobs.find((x) => x.jid === m[1]);
      return mj ? send(res, 200, { data: mj }) : send(res, 404, errBody('', 'multi job not found'));
    }
    if (req.method === 'GET' && p === '/auditlog') {
      if (S.auditStatus !== 200) return send(res, S.auditStatus, errBody('', 'forbidden'));
      const lim = Number(url.searchParams.get('page[limit]') || 50);
      const off = Number(url.searchParams.get('page[offset]') || 0);
      const app = url.searchParams.get('filter[application]');
      const all = S.audit.filter((e) => !app || e.application === app);
      return send(res, 200, { data: all.slice(off, off + lim), meta: { count: all.length } });
    }
    return send(res, 404, errBody('', 'no route'));
  });
});

let BASE;
const homes = [];
const outputs = [];

before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  BASE = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  for (const h of homes) fs.rmSync(h, { recursive: true, force: true });
});
beforeEach(() => resetState());

function newHome() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'rps-'));
  homes.push(h);
  return h;
}

function run(home, args, env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, RPORT_TOKEN: SENTINEL, RPORT_SKILL_HOME: home, RPORT_SKILL_POLL_MS: '20', ...env } }, (err, stdout, stderr) => {
      outputs.push(stdout, stderr);
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr });
    });
  });
}

// Server configured; stored tunnel my-ssh on c-1 (idle 60, auto-close 8h), linked to my-member.
async function setup({ stored = { further_options: JSON.stringify({ 'idle-timeout-minutes': 60, 'auto-close': '8h', protocol: 'tcp' }) }, link = true } = {}) {
  const home = newHome();
  let r = await run(home, ['server', 'add', '--url', BASE, '--user', USER]);
  assert.equal(r.code, 0, r.stderr);
  if (stored) seedStored('c-1', { name: 'my-ssh', ...stored });
  if (stored && link) {
    r = await run(home, ['link', 'add', 'my-ssh', '--client', 'my-server', '--fleet-member', 'my-member']);
    assert.equal(r.code, 0, r.stderr);
  }
  allLogs.push(...state.log);
  state.log = [];
  return home;
}

const K = ['--client', 'my-server'];
const resultOf = (stdout) => JSON.parse(stdout.split(/\r?\n/).find((l) => l.startsWith('RESULT ')).slice(7));
const ledgerOf = (home) => {
  const p = path.join(home, 'ledger.jsonl');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const writes = () => state.log.filter((e) => e.method !== 'GET');
const tunnelPuts = () => writes().filter((e) => e.method === 'PUT' && /\/tunnels$/.test(e.path));

// ---------------------------------------------------------------- unit: validation
test('ACL validation: /32 and /30 ok; /29, empty, 0.0.0.0/0, IPv6, >4 entries refused', () => {
  assert.deepEqual(normalizeAclSpec('198.51.100.4'), ['198.51.100.4/32']);
  assert.deepEqual(normalizeAclSpec('198.51.100.4/30'), ['198.51.100.4/30']);
  assert.deepEqual(normalizeAclSpec(undefined), ['self']);
  const refused = (fn, re) => assert.throws(fn, (e) => e.exitCode === 2 && re.test(e.message));
  refused(() => normalizeAclSpec('198.51.100.0/29'), /wider than \/30/);
  refused(() => normalizeAclSpec(''), /empty/);
  refused(() => normalizeAclSpec('0.0.0.0/0'), /whole internet/);
  refused(() => normalizeAclSpec('2001:db8::1'), /IPv6/);
  refused(() => normalizeAclSpec('1.1.1.1,2.2.2.2,3.3.3.3,4.4.4.4,5.5.5.5'), /at most 4/);
  refused(() => normalizeAclSpec('256.1.1.1'), /valid IPv4/);
  refused(() => normalizeAclSpec('01.1.1.1'), /valid IPv4/);
  refused(() => normalizeAclSpec('198.51.100.5/30'), /host bits/);
  assert.equal(resolveAcl(['self'], SELF), `${SELF}/32`);
  assert.throws(() => resolveAcl(['self'], '2001:db8::7'), (e) => e.exitCode === 2 && /IPv6/.test(e.message));
  assert.equal(parseAclEntry('10.0.0.8/30').text, '10.0.0.8/30');
  // stored ACLs: same rules, "self" cannot be stored, trailing comma tolerated
  assert.equal(validateStoredAcl('203.0.113.7,').text, '203.0.113.7');
  refused(() => validateStoredAcl(''), /empty/);
  refused(() => validateStoredAcl('0.0.0.0/0'), /whole internet/);
  refused(() => validateStoredAcl('10.0.0.0/24'), /wider/);
  refused(() => validateStoredAcl('self'), /self/);
  refused(() => validateStoredAcl('1.1.1.1,2.2.2.2,3.3.3.3,4.4.4.4,5.5.5.5'), /at most 4/);
  const e = validateStoredAcl('203.0.113.4/30').entries;
  assert.equal(aclCoversIp(e, '203.0.113.7'), true);
  assert.equal(aclCoversIp(e, '203.0.113.8'), false);
  assert.equal(aclEquals('203.0.113.7,', validateStoredAcl('203.0.113.7/32').entries), true);
  assert.equal(aclEquals('', validateStoredAcl('203.0.113.7/32').entries), false);
});

test('auto-close and idle caps', () => {
  assert.deepEqual(validateAutoClose(undefined), { text: '2h', seconds: 7200 });
  assert.equal(validateAutoClose('12h').seconds, 12 * 3600);
  assert.equal(validateAutoClose('1h30m').seconds, 5400);
  const refused = (fn) => assert.throws(fn, (e) => e.exitCode === 2);
  refused(() => validateAutoClose('13h'));
  refused(() => validateAutoClose('12h1m'));
  refused(() => validateAutoClose('0m'));
  refused(() => validateAutoClose('forever'));
  assert.equal(validateIdle(undefined), 30);
  assert.equal(validateIdle(120), 120);
  refused(() => validateIdle(121));
  refused(() => validateIdle(0));
  refused(() => validateIdle('5.5'));
  assert.equal(LIMITS.IDLE_MAX, 120);
});

test('further_options: both key styles, defaults, caps, forbidden options', () => {
  let o = optionsFromStored(JSON.stringify({ 'idle-timeout-minutes': 60, 'auto-close': '8h', protocol: 'udp' }));
  assert.deepEqual([o.idle, o.autoClose.text, o.protocol], [60, '8h', 'udp']);
  o = optionsFromStored(JSON.stringify({ idle_timeout_minutes: 45, auto_close: '3h' }));
  assert.deepEqual([o.idle, o.autoClose.text, o.protocol], [45, '3h', 'tcp']);
  o = optionsFromStored({ idle_timeout_minutes: '15' }); // object form tolerated
  assert.equal(o.idle, 15);
  o = optionsFromStored('');
  assert.deepEqual([o.idle, o.autoClose.text], [30, '2h']);
  const refused = (fo, re) => assert.throws(() => optionsFromStored(fo), (e) => e.exitCode === 2 && re.test(e.message));
  refused(JSON.stringify({ 'idle-timeout-minutes': 500 }), /maximum of 120/);
  refused(JSON.stringify({ auto_close: '24h' }), /12h/);
  refused(JSON.stringify({ 'skip-idle-timeout': 1 }), /skip-idle-timeout/);
  refused(JSON.stringify({ check_port: '0' }), /check_port/);
  refused('not json', /not JSON/);
  assert.equal(validateStored({ name: 'x', remote_ip: '', remote_port: 22, acl: `${SELF}/32`, public_port: 2222 }).publicPort, 2222);
  assert.throws(() => validateStored({ name: 'x', remote_ip: '192.168.1.1', remote_port: 80, acl: `${SELF}/32` }), (e) => e.exitCode === 2 && /allow-lan-target/.test(e.message));
});

test('ledger hard_expires_at = created_at + auto-close', () => {
  assert.equal(computeHardExpiry('2026-10-29T10:00:00.000Z', '2h'), '2026-10-29T12:00:00.000Z');
  assert.equal(computeHardExpiry('2026-10-29T23:30:00.000Z', '1h45m'), '2026-10-30T01:15:00.000Z');
});

test('remote parsing: local vs LAN target, single port only', () => {
  assert.equal(parseRemote('22').local, true);
  assert.equal(parseRemote('127.0.0.1:22').local, true);
  assert.equal(parseRemote('localhost:22').local, true);
  assert.equal(parseRemote('192.168.1.10:80').local, false);
  assert.throws(() => parseRemote('20-30'), (e) => e.exitCode === 2);
  assert.throws(() => parseRemote('22,23'), (e) => e.exitCode === 2);
});

// ---------------------------------------------------------------- stored tunnel CRUD
test('def add / list / show / set-acl / remove with further_options round-trip', async () => {
  const home = await setup({ stored: null });
  let r = await run(home, ['def', 'add', 'my-ssh', ...K, '--remote', '22', '--scheme', 'ssh', '--idle', '60', '--auto-close', '8h']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /admin change/);
  const post = writes().find((e) => e.method === 'POST');
  assert.equal(post.path, '/api/v1/clients/c-1/stored-tunnels');
  const body = JSON.parse(post.body);
  assert.equal(body.acl, `${SELF}/32`, 'self resolved via /me/ip and stored as /32');
  assert.equal(body.remote_ip, '127.0.0.1');
  assert.equal(body.remote_port, 22);
  assert.equal(typeof body.further_options, 'string');
  assert.deepEqual(JSON.parse(body.further_options), { 'idle-timeout-minutes': 60, 'auto-close': '8h', protocol: 'tcp' });
  assert.ok(!('public_port' in body));

  r = await run(home, ['def', 'list', ...K, '--json']);
  const [row] = JSON.parse(r.stdout);
  assert.equal(row.name, 'my-ssh');
  assert.equal(row.check, 'ok');
  r = await run(home, ['def', 'show', 'my-ssh', ...K, '--json']);
  assert.deepEqual(JSON.parse(r.stdout).effective_options, { 'idle-timeout-minutes': 60, 'auto-close': '8h', protocol: 'tcp' });

  r = await run(home, ['def', 'add', 'my-ssh', ...K, '--remote', '22']);
  assert.equal(r.code, 4, 'duplicate name is a config error');

  state.ip = '198.51.100.20';
  r = await run(home, ['def', 'set-acl', 'my-ssh', 'self', ...K]);
  assert.equal(r.code, 0, r.stderr);
  const put = writes().find((e) => e.method === 'PUT');
  const pb = JSON.parse(put.body);
  assert.equal(pb.acl, '198.51.100.20/32');
  assert.equal(pb.name, 'my-ssh', 'full object sent back (no partial updates)');
  assert.equal(pb.further_options, body.further_options, 'further_options preserved');
  assert.equal(state.stored[0].acl, '198.51.100.20/32');

  r = await run(home, ['def', 'set-acl', 'my-ssh', '10.0.0.0/24', ...K]);
  assert.equal(r.code, 2, 'set-acl refuses wide ACL');

  r = await run(home, ['def', 'remove', 'my-ssh', ...K]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(state.stored.length, 0);
});

test('def add refuses guardrail violations with exit 2 and makes no write', async () => {
  const home = await setup({ stored: null });
  for (const extra of [['--acl', '10.0.0.0/29'], ['--acl', ''], ['--acl', '0.0.0.0/0'], ['--idle', '121'], ['--auto-close', '13h'], ['--acl', '::1']]) {
    const r = await run(home, ['def', 'add', 'x', ...K, '--remote', '22', ...extra]);
    assert.equal(r.code, 2, `${extra.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, /REFUSED/);
  }
  let r = await run(home, ['def', 'add', 'x', ...K, '--remote', '22', '--skip-idle-timeout']);
  assert.equal(r.code, 2);
  r = await run(home, ['def', 'add', 'x', ...K, '--remote', '80', '--scheme', 'http', '--http-proxy']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /auth_user/);
  r = await run(home, ['def', 'add', 'router', ...K, '--remote', '192.168.1.1:443', '--scheme', 'https']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /allow-lan-target/);
  r = await run(home, ['server', 'add', 'plain', '--url', 'http://rport.example.invalid', '--user', USER]);
  assert.equal(r.code, 4, 'plain http to a non-loopback server is a config error');
  assert.equal(writes().length, 0, 'no server-side writes');
});

// ---------------------------------------------------------------- revive
test('revive from a stored tunnel: exact stored ACL, options from further_options, never skip-idle-timeout', async () => {
  const home = await setup();
  const r = await run(home, ['revive', 'my-ssh', ...K]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(state.log.some((e) => e.path === '/api/v1/me/ip'), 'self IP checked via /me/ip');
  const puts = tunnelPuts();
  assert.equal(writes().length, 1);
  const q = puts[0].query;
  assert.equal(puts[0].path, '/api/v1/clients/c-1/tunnels');
  assert.equal(q.acl, `${SELF}/32`);
  assert.equal(q['idle-timeout-minutes'], '60');
  assert.equal(q['auto-close'], '8h');
  assert.equal(q.check_port, '1');
  assert.equal(q.remote, '127.0.0.1:22');
  assert.ok(!('skip-idle-timeout' in q), 'skip-idle-timeout never sent');
  assert.ok(!('local' in q), 'no public_port -> random port');
  const res = resultOf(r.stdout);
  assert.equal(res.reused, false);
  assert.equal(res.action, 'create');
  assert.equal(res.port, 20000);
  assert.equal(res.host, '127.0.0.1');
  assert.equal(res.fleet_member, 'my-member', 'fleet member from the local link');
  assert.equal(res.stored_tunnel_id, state.stored[0].id);
  const [rec] = ledgerOf(home);
  assert.equal(rec.action, 'create');
  assert.equal(rec.def, 'my-ssh');
  assert.equal(rec.stored_tunnel_id, state.stored[0].id);
  assert.equal(Date.parse(rec.hard_expires_at) - Date.parse(rec.created_at), 8 * 3600 * 1000);
  assert.equal(res.expires_at, rec.hard_expires_at);
});

test('revive with UI-style snake_case options and with no options (defaults)', async () => {
  let home = await setup({ stored: { further_options: JSON.stringify({ idle_timeout_minutes: 45, auto_close: '3h' }) } });
  let r = await run(home, ['revive', 'my-ssh', ...K]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(tunnelPuts()[0].query['idle-timeout-minutes'], '45');
  assert.equal(tunnelPuts()[0].query['auto-close'], '3h');
  resetState();
  home = await setup({ stored: { further_options: '' }, link: false });
  r = await run(home, ['revive', 'my-ssh', ...K]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(tunnelPuts()[0].query['idle-timeout-minutes'], '30');
  assert.equal(tunnelPuts()[0].query['auto-close'], '2h');
  assert.equal(resultOf(r.stdout).fleet_member, null);
});

test('public_port is passed as local; a CLI --local override is refused', async () => {
  const home = await setup({ stored: { public_port: 2222, further_options: '' } });
  const r = await run(home, ['revive', 'my-ssh', ...K]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(tunnelPuts()[0].query.local, '2222');
  assert.equal(resultOf(r.stdout).port, 2222);
  const bad = await run(home, ['revive', 'my-ssh', ...K, '--local', '3333']);
  assert.equal(bad.code, 2);
});

test('revive is idempotent: reuse, then create when gone', async () => {
  const home = await setup();
  const first = resultOf((await run(home, ['revive', 'my-ssh', ...K])).stdout);
  let r = await run(home, ['revive', 'my-ssh', ...K]);
  assert.equal(r.code, 0, r.stderr);
  let res = resultOf(r.stdout);
  assert.equal(res.reused, true);
  assert.equal(res.action, 'reuse');
  assert.equal(res.port, first.port);
  assert.equal(res.port_changed, false);
  assert.equal(state.tunnels.length, 1);
  assert.equal(writes().length, 1, 'no second create, no ACL endpoint');

  state.tunnels = []; // idle-closed on the server
  r = await run(home, ['revive', 'my-ssh', ...K]);
  res = resultOf(r.stdout);
  assert.equal(res.action, 'create');
  assert.equal(res.port_changed, true);
  assert.equal(res.previous_port, first.port);
  const recs = JSON.parse((await run(home, ['ledger', '--def', 'my-ssh', '--json'])).stdout);
  assert.equal(recs.length, 3);
  assert.equal(recs.filter((x) => x.superseded).length, 2, 'earlier records marked superseded');
});

test('revive refuses when the caller IP is not in the stored ACL, and never rewrites it', async () => {
  const home = await setup();
  state.ip = '198.51.100.20';
  const r = await run(home, ['revive', 'my-ssh', ...K]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, new RegExp(`your IP changed from ${SELF}/32 to 198\\.51\\.100\\.20`));
  assert.match(r.stderr, /def set-acl my-ssh self/);
  assert.equal(writes().length, 0, 'no create, no ACL rewrite');
  assert.equal(state.stored[0].acl, `${SELF}/32`);
});

test('CURRENT-IP-ADDRESS (RPort UI placeholder) is bound to the caller IP at revive, follows IP changes, never stored', async () => {
  const home = await setup({ stored: { acl: 'CURRENT-IP-ADDRESS' } });
  const list = await run(home, ['def', 'list', ...K]);
  assert.equal(list.code, 0, list.stderr);
  assert.doesNotMatch(list.stdout, /UNSAFE/, 'the placeholder is safe: it means "the caller only"');
  let r = await run(home, ['revive', 'my-ssh', ...K]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(tunnelPuts()[0].query.acl, `${SELF}/32`, 'sent as the caller IP /32, never the placeholder');
  assert.equal(resultOf(r.stdout).acl, `${SELF}/32`);
  assert.equal(state.stored[0].acl, 'CURRENT-IP-ADDRESS', 'stored tunnel untouched');
  r = await run(home, ['revive', 'my-ssh', ...K]);
  assert.equal(resultOf(r.stdout).action, 'reuse', 'live /32 matches the bound placeholder');
  state.ip = '198.51.100.20'; // the caller's IP changed: a new tunnel for the new IP, no refusal
  r = await run(home, ['revive', 'my-ssh', ...K]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(resultOf(r.stdout).action, 'create');
  assert.equal(tunnelPuts().at(-1).query.acl, '198.51.100.20/32');
  resetState();
  const mixed = await setup({ stored: { acl: 'current-ip-address,203.0.113.4' } });
  r = await run(mixed, ['revive', 'my-ssh', ...K]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(tunnelPuts()[0].query.acl, `${SELF}/32,203.0.113.4/32`, 'mixed with explicit IPs, case-insensitive');
  resetState();
  const v6 = await setup({ stored: { acl: 'CURRENT-IP-ADDRESS' } });
  state.ip = '2001:db8::1';
  r = await run(v6, ['revive', 'my-ssh', ...K]);
  assert.equal(r.code, 2, 'an IPv6 caller cannot bind the placeholder');
  assert.equal(writes().length, 0);
});

test('def set-options makes a UI stored tunnel safe: drops skip-idle-timeout, keeps other keys, dry-run first', async () => {
  const ui = JSON.stringify({ 'skip-idle-timeout': 1, 'auto-close': '12h0m', protocol: 'tcp', is_service_forwarding: false });
  const home = await setup({ stored: { acl: 'CURRENT-IP-ADDRESS', further_options: ui } });
  let r = await run(home, ['revive', 'my-ssh', ...K]);
  assert.equal(r.code, 2, 'unsafe before the fix');
  r = await run(home, ['def', 'set-options', 'my-ssh', ...K, '--idle', '60', '--dry-run']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /DRY-RUN would call: PUT/);
  assert.equal(writes().length, 0, 'dry-run writes nothing');
  r = await run(home, ['def', 'set-options', 'my-ssh', ...K, '--idle', '60']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /removed skip-idle-timeout/);
  const fo = JSON.parse(state.stored[0].further_options);
  assert.deepEqual(fo, { 'auto-close': '12h0m', protocol: 'tcp', is_service_forwarding: false, 'idle-timeout-minutes': 60 });
  assert.equal(state.stored[0].acl, 'CURRENT-IP-ADDRESS', 'ACL untouched');
  r = await run(home, ['revive', 'my-ssh', ...K]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(tunnelPuts()[0].query['idle-timeout-minutes'], '60');
  assert.ok(!('skip-idle-timeout' in tunnelPuts()[0].query));
  const over = await run(home, ['def', 'set-options', 'my-ssh', ...K, '--auto-close', '24h']);
  assert.equal(over.code, 2, 'cannot set options over the caps');
});

test('revive refuses unsafe stored tunnels (ACL or options) without fixing them', async () => {
  const cases = [
    [{ acl: '' }, /empty/],
    [{ acl: '0.0.0.0/0' }, /whole internet/],
    [{ acl: '203.0.113.0/24' }, /wider than \/30/],
    [{ acl: '1.1.1.1,2.2.2.2,3.3.3.3,4.4.4.4,203.0.113.7' }, /at most 4/],
    [{ acl: '2001:db8::1' }, /IPv6/],
    [{ further_options: JSON.stringify({ 'idle-timeout-minutes': 500 }) }, /maximum of 120/],
    [{ further_options: JSON.stringify({ 'auto-close': '24h' }) }, /12h/],
    [{ further_options: JSON.stringify({ skip_idle_timeout: true }) }, /skip-idle-timeout/],
    [{ remote_ip: '192.168.1.1', remote_port: 80 }, /allow-lan-target/],
  ];
  for (const [fields, re] of cases) {
    resetState();
    const home = await setup({ stored: { further_options: '', ...fields }, link: false });
    const before = JSON.stringify(state.stored);
    const r = await run(home, ['revive', 'my-ssh', ...K]);
    assert.equal(r.code, 2, `${JSON.stringify(fields)}: ${r.stderr}`);
    assert.match(r.stderr, re);
    assert.equal(writes().length, 0);
    assert.equal(JSON.stringify(state.stored), before, 'stored tunnel untouched');
  }
  resetState();
  const home = await setup({ stored: { remote_ip: '192.168.1.1', remote_port: 80, scheme: 'http', further_options: '' }, link: false });
  const r = await run(home, ['revive', 'my-ssh', ...K, '--allow-lan-target']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(tunnelPuts()[0].query.remote, '192.168.1.1:80');
});

// ---------------------------------------------------------------- dry-run on every write
test('dry-run on every write: def add, set-acl, remove, revive, close, link add', async () => {
  const home = await setup();
  const dry = async (args, re) => {
    const before = writes().length;
    const r = await run(home, [...args, '--dry-run']);
    assert.equal(r.code, 0, `${args.join(' ')}: ${r.stderr}`);
    assert.equal(writes().length, before, `${args.join(' ')} made a write`);
    assert.match(r.stdout, re);
    return r;
  };
  await dry(['def', 'add', 'other', ...K, '--remote', '3389', '--scheme', 'rdp'], /DRY-RUN would call: POST .*stored-tunnels.*Authorization: Basic \[REDACTED\]/);
  await dry(['def', 'set-acl', 'my-ssh', '198.51.100.1', ...K], /DRY-RUN would call: PUT .*stored-tunnels\/st-1/);
  await dry(['def', 'remove', 'my-ssh', ...K], /DRY-RUN would call: DELETE .*stored-tunnels\/st-1/);
  await dry(['revive', 'my-ssh', ...K], /^PLAN /m);
  assert.equal(ledgerOf(home).length, 0, 'dry-run revive wrote no ledger');
  await run(home, ['revive', 'my-ssh', ...K]);
  await dry(['close', 'my-ssh', ...K], /DRY-RUN would call: DELETE .*\/tunnels\/1/);
  const cfgBefore = fs.readFileSync(path.join(home, 'config.json'), 'utf8');
  await dry(['link', 'add', 'my-ssh', ...K, '--fleet-member', 'other-member'], /DRY-RUN would save link/);
  assert.equal(fs.readFileSync(path.join(home, 'config.json'), 'utf8'), cfgBefore);
  assert.equal(state.stored.length, 1);
  assert.equal(state.stored[0].acl, `${SELF}/32`);
  assert.equal(state.tunnels.length, 1);
});

// ---------------------------------------------------------------- status, close, misc
test('status: alive, closed-idle, client-offline, expired, none; no-arg covers links and ledger', async () => {
  const home = await setup();
  await run(home, ['revive', 'my-ssh', ...K]);
  let [row] = JSON.parse((await run(home, ['status', 'my-ssh', ...K, '--json'])).stdout);
  assert.equal(row.state, 'alive');
  assert.ok(row.minutes_left >= 479 && row.minutes_left <= 480);
  assert.equal(row.warning, null);
  assert.equal(row.fleet_member, 'my-member');

  state.tunnels = [];
  [row] = JSON.parse((await run(home, ['status', 'my-ssh', ...K, '--json'])).stdout);
  assert.equal(row.state, 'closed-idle');

  const now = Date.now();
  const iso = (ms) => new Date(now + ms).toISOString();
  const base = { server: 'default', action: 'create', host: '127.0.0.1', acl: `${SELF}/32`, auto_close: '2h', idle_timeout_minutes: 30 };
  const lines = [
    { ...base, rec_id: 'r-off', at: iso(-60000), def: 'off', tunnel_id: '9', client_id: 'c-2', lport: '29999', created_at: iso(-60000), hard_expires_at: iso(7140000) },
    { ...base, rec_id: 'r-exp', at: iso(-3 * 3600000), def: 'old', tunnel_id: '8', client_id: 'c-1', lport: '29998', created_at: iso(-3 * 3600000), hard_expires_at: iso(-3600000) },
    { ...base, rec_id: 'r-soon', at: iso(-7000000), def: 'soon', tunnel_id: '7', client_id: 'c-1', lport: '29997', created_at: iso(-7000000), hard_expires_at: iso(200000) },
  ];
  fs.appendFileSync(path.join(home, 'ledger.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  state.tunnels.push({ id: '7', client_id: 'c-1', lhost: '0.0.0.0', lport: '29997', rhost: '0.0.0.0', rport: '22', acl: `${SELF}/32` });
  seedStored('c-1', { name: 'linked-only' });
  assert.equal((await run(home, ['link', 'add', 'linked-only', ...K, '--fleet-member', 'm2'])).code, 0);

  const by = Object.fromEntries(JSON.parse((await run(home, ['status', '--json'])).stdout).map((x) => [x.def, x]));
  assert.equal(by['my-ssh'].state, 'closed-idle');
  assert.equal(by.off.state, 'client-offline');
  assert.equal(by.old.state, 'expired');
  assert.equal(by.soon.state, 'alive');
  assert.match(by.soon.warning, /less than 15 min/);
  assert.equal(by['linked-only'].state, 'none');
  const r = await run(home, ['status']);
  assert.match(r.stdout, /WARNING soon/);
  assert.match(r.stdout, /soft/);
});

test('close without force surfaces the active-connections refusal; --force closes', async () => {
  const home = await setup();
  await run(home, ['revive', 'my-ssh', ...K]);
  state.active.add('c-1/1');
  let r = await run(home, ['close', 'my-ssh', ...K]);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /still has active connections/);
  assert.match(r.stderr, /Do not add --force/);
  assert.equal(state.tunnels.length, 1);
  r = await run(home, ['close', 'my-ssh', ...K, '--force']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(state.tunnels.length, 0);
  assert.equal(state.stored.length, 1, 'closing a live tunnel keeps the stored tunnel');
  const led = ledgerOf(home);
  assert.equal(led.at(-1).action, 'close');
  assert.equal(led.at(-1).forced, true);
  r = await run(home, ['status', 'my-ssh', ...K, '--json']);
  assert.equal(JSON.parse(r.stdout)[0].state, 'closed');
});

test('client offline on create is an API error (exit 3) with a hint', async () => {
  const home = await setup({ stored: null });
  seedStored('c-2', { name: 'my-ssh' });
  const r = await run(home, ['revive', 'my-ssh', '--client', 'offline-box']);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /disconnected/);
});

test('read-only commands: ip, whoami, clients, tunnels', async () => {
  const home = await setup();
  assert.match((await run(home, ['ip'])).stdout, /203\.0\.113\.7/);
  assert.match((await run(home, ['whoami'])).stdout, /alice/);
  assert.equal(JSON.parse((await run(home, ['clients', '--name', 'my-server', '--json'])).stdout)[0].id, 'c-1');
  await run(home, ['revive', 'my-ssh', ...K]);
  const t = JSON.parse((await run(home, ['tunnels', ...K, '--json'])).stdout);
  assert.equal(t[0].def, 'my-ssh');
  assert.ok(t[0].hard_expires_at);
  assert.equal(writes().length, 1, 'only the revive wrote');
});

test('token missing or unsubstituted is a config error (exit 4)', async () => {
  const home = await setup();
  let r = await run(home, ['ip'], { RPORT_TOKEN: '' });
  assert.equal(r.code, 4);
  assert.match(r.stderr, /RPORT_TOKEN is not set/);
  r = await run(home, ['ip'], { RPORT_TOKEN: '{{secret.RPORT_API_TOKEN}}' });
  assert.equal(r.code, 4);
  assert.match(r.stderr, /unsubstituted/);
  assert.equal(state.log.length, 0);
});

test('wrong token: 401 surfaced without echoing anything secret', async () => {
  const home = await setup();
  const r = await run(home, ['ip', '--debug'], { RPORT_TOKEN: 'wrong-token-value' });
  assert.equal(r.code, 3);
  assert.match(r.stderr, /401/);
  assert.ok(!r.stderr.includes('wrong-token-value'));
});

test('debug output redacts Authorization', async () => {
  const home = await setup();
  const r = await run(home, ['revive', 'my-ssh', ...K, '--debug']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /Authorization: Basic \[REDACTED\]/);
});

test('create loop guard: more than 3 creates in 15 min refused', async () => {
  const home = await setup();
  for (let i = 0; i < 3; i++) {
    state.tunnels = [];
    assert.equal((await run(home, ['revive', 'my-ssh', ...K])).code, 0);
  }
  state.tunnels = [];
  const r = await run(home, ['revive', 'my-ssh', ...K]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /create loop/);
});

// ---------------------------------------------------------------- several servers
test('several servers: monikers scope stored tunnels, links and ledger; same names do not clash', async () => {
  const home = newHome();
  assert.equal((await run(home, ['server', 'add', '--url', BASE, '--user', USER])).code, 0, 'no moniker -> "default"');
  assert.equal((await run(home, ['server', 'add', 'lab', '--url', `${BASE}/b`, '--user', USER, '--token-secret', 'RPORT_LAB_TOKEN'])).code, 0);
  const list = JSON.parse((await run(home, ['server', 'list', '--json'])).stdout);
  assert.deepEqual(list.map((s) => [s.moniker, s.token_secret]), [['default', 'RPORT_API_TOKEN'], ['lab', 'RPORT_LAB_TOKEN']]);

  seedStored('c-1', { name: 'my-ssh' }, state);
  seedStored('c-1', { name: 'my-ssh', remote_port: 2222 }, stateB);
  assert.equal((await run(home, ['link', 'add', 'my-ssh', ...K, '--fleet-member', 'member-a'])).code, 0);
  assert.equal((await run(home, ['link', 'add', 'my-ssh', ...K, '--fleet-member', 'member-b', '--server', 'lab'])).code, 0);

  let r = await run(home, ['revive', 'my-ssh', ...K]); // --server optional: "default" exists
  assert.equal(r.code, 0, r.stderr);
  const a = resultOf(r.stdout);
  r = await run(home, ['revive', 'my-ssh', ...K, '--server', 'lab']);
  assert.equal(r.code, 0, r.stderr);
  const b = resultOf(r.stdout);
  assert.deepEqual([a.server, a.fleet_member], ['default', 'member-a']);
  assert.deepEqual([b.server, b.fleet_member], ['lab', 'member-b']);
  assert.equal(state.tunnels.length, 1);
  assert.equal(stateB.tunnels.length, 1);
  assert.equal(stateB.tunnels[0].rport, '2222', 'lab revive used the lab stored tunnel');

  r = await run(home, ['revive', 'my-ssh', ...K, '--server', 'lab']);
  assert.equal(resultOf(r.stdout).action, 'reuse', 'reuse is per server');
  const rows = JSON.parse((await run(home, ['status', '--json'])).stdout);
  assert.deepEqual(rows.map((x) => `${x.server}:${x.def}:${x.state}`).sort(), ['default:my-ssh:alive', 'lab:my-ssh:alive']);
  assert.equal(JSON.parse((await run(home, ['server', 'show', 'lab', '--json'])).stdout).url, `${BASE}/b`);
});

test('several servers without "default": refuse with "pick one"', async () => {
  const home = newHome();
  await run(home, ['server', 'add', 'alpha', '--url', BASE, '--user', USER]);
  let r = await run(home, ['ip']);
  assert.equal(r.code, 0, 'a single server needs no --server');
  await run(home, ['server', 'add', 'beta', '--url', `${BASE}/b`, '--user', USER]);
  r = await run(home, ['ip']);
  assert.equal(r.code, 4);
  assert.match(r.stderr, /pick one: alpha, beta/);
  assert.equal((await run(home, ['ip', '--server', 'beta'])).code, 0);
});

test('runner member: global setting with per-server override', async () => {
  const home = newHome();
  await run(home, ['server', 'add', '--url', BASE, '--user', USER]);
  await run(home, ['server', 'add', 'lab', '--url', `${BASE}/b`, '--user', USER, '--runner-member', 'lab-runner']);
  assert.equal((await run(home, ['runner', 'set', 'my-runner'])).code, 0);
  const info = JSON.parse((await run(home, ['runner', 'show', '--json'])).stdout);
  assert.deepEqual(info, { runner_member: 'my-runner', per_server: { default: 'my-runner', lab: 'lab-runner' } });
  assert.equal(JSON.parse((await run(home, ['server', 'show', '--json'])).stdout).runner_member, 'my-runner');
});

// ---------------------------------------------------------------- scripts
const scriptsHome = async () => setup({ stored: null });
const runPosts = () => writes().filter((e) => e.method === 'POST' && /\/clients\/[^/]+\/scripts$/.test(e.path));
const jobGets = () => state.log.filter((e) => e.method === 'GET' && /\/commands\/[^/]+$/.test(e.path));

test('scripts unit: timeout caps, name resolution, run body, body size, tails, allowed endpoints', () => {
  assert.equal(validateScriptTimeout(undefined, undefined), 60);
  assert.equal(validateScriptTimeout(undefined, 0), 60, 'library 0 -> server default 60');
  assert.equal(validateScriptTimeout(undefined, 300), 300);
  assert.equal(validateScriptTimeout('3600', 300), 3600);
  const refused = (fn, re) => assert.throws(fn, (e) => e.exitCode === 2 && re.test(e.message));
  refused(() => validateScriptTimeout('3601'), /maximum of 3600/);
  refused(() => validateScriptTimeout(undefined, 7200), /maximum of 3600/);
  refused(() => validateScriptTimeout('0'), /timeout 0/);
  refused(() => validateScriptTimeout('1.5'), /whole number/);

  const lib = [{ id: 'a', name: 'Disk-Check' }, { id: 'b', name: 'disk-check' }, { id: 'c', name: 'uptime' }, { id: 'd', name: 'Dup' }, { id: 'e', name: 'Dup' }];
  assert.equal(pickLibraryScript(lib, 'disk-check').id, 'b', 'exact name wins');
  assert.equal(pickLibraryScript(lib, 'UPTIME').id, 'c', 'case-insensitive');
  assert.equal(pickLibraryScript(lib, 'c').id, 'c', 'by id');
  assert.throws(() => pickLibraryScript(lib, 'DISK-CHECK'), (e) => e.exitCode === 1 && /Disk-Check \(id a\).*disk-check \(id b\)/.test(e.message));
  assert.throws(() => pickLibraryScript(lib, 'Dup'), (e) => e.exitCode === 1 && /id d.*id e/.test(e.message));
  assert.throws(() => pickLibraryScript(lib, 'nope'), (e) => e.exitCode === 4);

  const b = buildScriptRunBody({ script: 'echo hi\n', interpreter: 'bash' }, { timeout: 30, cwd: '/tmp' });
  assert.deepEqual(b, { script: Buffer.from('echo hi\n').toString('base64'), interpreter: 'bash', cwd: '/tmp', is_sudo: false, timeout_sec: 30 });
  assert.equal(buildScriptRunBody({ script: 'x' }, { isSudo: true, timeout: 1 }).is_sudo, true);
  assert.ok(!('interpreter' in buildScriptRunBody({ script: 'x', interpreter: '' }, { timeout: 1 })), 'no interpreter -> server default');
  refused(() => checkBodySize({ script: 'x'.repeat(10300) }, 's'), /10240/);
  assert.ok(checkBodySize({ script: 'x' }, 's') < 100);

  assert.equal(tailLines(Array.from({ length: 100 }, (_, i) => `l${i}`).join('\n') + '\n').split('\n').length, 60);
  assert.equal(tailLines(''), '');
  assert.equal(scriptSha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');

  for (const [m, p] of [['POST', '/clients/c-1/commands'], ['POST', '/commands'], ['POST', '/scripts'], ['PUT', '/scripts/x'], ['GET', '/ws/commands'], ['GET', '/ws/scripts'], ['POST', '/client-groups/g/commands'], ['POST', '/client-groups/g/scripts'], ['PUT', '/clients/c-1/scripts'], ['DELETE', '/clients/c-1/commands/j']]) {
    assert.throws(() => assertAllowedRequest(m, p), (e) => e.exitCode === 2, `${m} ${p} must be refused`);
  }
  for (const [m, p] of [['POST', '/clients/c-1/scripts'], ['GET', '/clients/c-1/commands'], ['GET', '/clients/c-1/commands/j'], ['GET', '/library/scripts'], ['POST', '/library/scripts'], ['PUT', '/library/scripts/1'], ['DELETE', '/library/scripts/1'], ['PUT', '/clients/c-1/tunnels']]) {
    assert.doesNotThrow(() => assertAllowedRequest(m, p), `${m} ${p}`);
  }
});

test('scripts list / show: no bodies in list, --query, exact, case-insensitive, id, ambiguous', async () => {
  const home = await scriptsHome();
  seedScript({ name: 'Disk-Check', script: 'df -h\n', interpreter: 'bash', tags: ['disk'] });
  seedScript({ name: 'disk-check', script: 'df -k\n' });
  seedScript({ name: 'uptime', script: 'uptime\n', is_sudo: true, timeout_sec: 10 });
  let r = await run(home, ['scripts', 'list', '--json']);
  assert.equal(r.code, 0, r.stderr);
  const rows = JSON.parse(r.stdout);
  assert.equal(rows.length, 3);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['id', 'interpreter', 'is_sudo', 'name', 'tags', 'timeout_sec', 'updated_at']);
  assert.ok(!r.stdout.includes('df -h'), 'no script bodies in list');
  r = await run(home, ['scripts', 'list', '--query', 'DISK', '--json']);
  assert.deepEqual(JSON.parse(r.stdout).map((s) => s.name), ['Disk-Check', 'disk-check']);
  r = await run(home, ['scripts', 'show', 'disk-check', '--json']);
  assert.equal(JSON.parse(r.stdout).script, 'df -k\n', 'exact name');
  r = await run(home, ['scripts', 'show', 'UPTIME', '--json']);
  assert.equal(JSON.parse(r.stdout).id, 'scr-3', 'case-insensitive');
  assert.equal(JSON.parse(r.stdout).script_sha256, scriptSha256('uptime\n'));
  r = await run(home, ['scripts', 'show', 'scr-1', '--json']);
  assert.equal(JSON.parse(r.stdout).name, 'Disk-Check', 'by id');
  r = await run(home, ['scripts', 'show', 'DISK-CHECK']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Disk-Check \(id scr-1\), disk-check \(id scr-2\)/);
  r = await run(home, ['scripts', 'show', 'nothing']);
  assert.equal(r.code, 4);
  assert.equal(writes().length, 0);
});

test('scripts run --dry-run sends nothing and shows hash, lines, preview, method and url', async () => {
  const home = await scriptsHome();
  const text = Array.from({ length: 30 }, (_, i) => `echo line${i}`).join('\n') + '\n';
  seedScript({ name: 'many', script: text, interpreter: 'bash', cwd: '/srv', timeout_sec: 120 });
  const r = await run(home, ['scripts', 'run', 'many', ...K, '--dry-run']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(writes().length, 0, 'dry-run sent nothing');
  assert.equal(state.jobs.length, 0);
  const plan = JSON.parse(r.stdout.split(/\r?\n/).find((l) => l.startsWith('PLAN ')).slice(5));
  assert.equal(plan.script_sha256, scriptSha256(text));
  assert.equal(plan.script_lines, 30);
  assert.equal(plan.script_preview.length, 20);
  assert.equal(plan.script_preview[0], 'echo line0');
  assert.deepEqual([plan.client_id, plan.script_name, plan.interpreter, plan.cwd, plan.is_sudo, plan.timeout_sec, plan.method], ['c-1', 'many', 'bash', '/srv', false, 120, 'POST']);
  assert.match(plan.url, /\/api\/v1\/clients\/c-1\/scripts$/);
  assert.match(r.stdout, /DRY-RUN would call: POST .*\/clients\/c-1\/scripts  Authorization: Basic \[REDACTED\]/);
  assert.equal(ledgerOf(home).length, 0, 'no ledger record');
  assert.ok(!fs.existsSync(path.join(home, 'jobs')));
});

test('scripts run: base64 body from the library, polls running -> successful, tails and full job file, ledger', async () => {
  const home = await scriptsHome();
  const text = '#!/bin/bash\nfor i in $(seq 1 100); do echo out$i; done\n';
  const lib = seedScript({ name: 'Count', script: text, interpreter: 'bash', cwd: '/tmp', timeout_sec: 120 });
  state.jobSeq = ['running', 'running', 'successful'];
  state.jobOut = { stdout: Array.from({ length: 100 }, (_, i) => `out${i + 1}`).join('\n') + '\n', stderr: 'warn\n', summary: 'done' };
  const r = await run(home, ['scripts', 'run', 'count', ...K]);
  assert.equal(r.code, 0, r.stderr);
  const [post] = runPosts();
  assert.equal(post.path, '/api/v1/clients/c-1/scripts');
  const body = JSON.parse(post.body);
  assert.equal(Buffer.from(body.script, 'base64').toString('utf8'), text, 'standard base64 of the library text');
  assert.deepEqual([body.is_sudo, body.interpreter, body.cwd, body.timeout_sec], [false, 'bash', '/tmp', 120]);
  assert.equal(writes().length, 1, 'exactly one write: the run');
  assert.ok(jobGets().length >= 3, 'polled until done');
  const res = resultOf(r.stdout);
  assert.equal(res.status, 'successful');
  assert.equal(res.jid, 'job-1');
  assert.equal(res.script_name, 'Count');
  assert.equal(res.script_sha256, scriptSha256(text));
  const tail = res.stdout_tail.split('\n');
  assert.equal(tail.length, 60);
  assert.equal(tail.at(-1), 'out100');
  assert.equal(res.stderr_tail, 'warn');
  assert.equal(res.output_file, path.join(home, 'jobs', 'job-1.json'));
  const full = JSON.parse(fs.readFileSync(res.output_file, 'utf8'));
  assert.equal(full.result.stdout.split('\n').filter(Boolean).length, 100, 'full output in the file');
  const [rec] = ledgerOf(home);
  assert.equal(rec.action, 'script-run');
  assert.ok(rec.ts);
  assert.deepEqual([rec.server, rec.client_id, rec.script_id, rec.script_name, rec.sha256, rec.is_sudo, rec.timeout_sec, rec.jid, rec.status],
    ['default', 'c-1', lib.id, 'Count', scriptSha256(text), false, 120, 'job-1', 'successful']);
  const led = await run(home, ['ledger']);
  assert.match(led.stdout, /script-run  Count/);
  // --out, --timeout, --cwd override the library
  const outFile = path.join(home, 'custom', 'job.json');
  const r2 = await run(home, ['scripts', 'run', 'Count', ...K, '--timeout', '30', '--cwd', '/var', '--out', outFile, '--json']);
  assert.equal(r2.code, 0, r2.stderr);
  const b2 = JSON.parse(runPosts()[1].body);
  assert.deepEqual([b2.timeout_sec, b2.cwd], [30, '/var']);
  assert.equal(resultOf(r2.stdout).output_file, outFile);
  assert.ok(fs.existsSync(outFile));
});

test('scripts run: is_sudo library script refused without --sudo, sent with --sudo', async () => {
  const home = await scriptsHome();
  seedScript({ name: 'root-job', script: 'id\n', is_sudo: true });
  seedScript({ name: 'plain', script: 'id\n', is_sudo: false });
  let r = await run(home, ['scripts', 'run', 'root-job', ...K]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /is_sudo=true: it requires elevation/);
  assert.match(r.stderr, /explicitly asks/);
  assert.equal(writes().length, 0);
  r = await run(home, ['scripts', 'run', 'root-job', ...K, '--sudo']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(runPosts()[0].body).is_sudo, true);
  assert.equal(ledgerOf(home)[0].is_sudo, true);
  r = await run(home, ['scripts', 'run', 'plain', ...K]);
  assert.equal(JSON.parse(runPosts()[1].body).is_sudo, false, 'never sudo unless asked');
});

test('scripts run guardrails: timeout > 3600, body > 10240, disconnected client, ad-hoc flags', async () => {
  const home = await scriptsHome();
  seedScript({ name: 'small', script: 'echo hi\n' });
  seedScript({ name: 'long', script: 'sleep 1\n', timeout_sec: 7200 });
  seedScript({ name: 'big', script: '# pad\n' + 'x'.repeat(8000) + '\n' });
  let r = await run(home, ['scripts', 'run', 'small', ...K, '--timeout', '3601']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /maximum of 3600/);
  r = await run(home, ['scripts', 'run', 'long', ...K]);
  assert.equal(r.code, 2, 'library timeout above the cap is refused too');
  r = await run(home, ['scripts', 'run', 'big', ...K]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /above the server limit of 10240 bytes/);
  assert.match(r.stderr, /[Ss]plit/);
  r = await run(home, ['scripts', 'run', 'small', '--client', 'offline-box']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /not connected/);
  r = await run(home, ['scripts', 'run', 'small']);
  assert.equal(r.code, 1, '--client is required');
  r = await run(home, ['scripts', 'run', 'small', 'other', ...K]);
  assert.equal(r.code, 1, 'one script per run');
  for (const f of [['--script', 'rm -rf /'], ['--command', 'id'], ['--clients', 'a,b'], ['--group', 'g']]) {
    r = await run(home, ['scripts', 'run', 'small', ...K, ...f]);
    assert.equal(r.code, 2, f[0]);
  }
  assert.equal(writes().length, 0, 'nothing sent');
});

test('scripts run: server/client refusals mapped to clear explanations', async () => {
  const home = await scriptsHome();
  seedScript({ name: 'small', script: 'echo hi\n' });
  const cases = [
    [{ status: 409, title: 'remote scripts are disabled' }, [/REFUSED by the client/, /\[remote-scripts\] enabled = true/, /\[remote-commands\] enabled = true/, /rport\.conf/]],
    [{ status: 409, title: 'remote commands execution is disabled' }, [/\[remote-commands\] enabled = true/]],
    [{ status: 409, title: 'a previous command is still running' }, [/still running/, /scripts jobs/]],
    [{ status: 403, title: 'the scope of the provided token is not authorized for this operation' }, [/read\+write token/]],
    [{ status: 401, title: 'the scope of the provided token is not authorized for this operation' }, [/read\+write token/]],
    [{ status: 403, title: 'forbidden' }, [/`scripts` permission/, /access to that client/]],
  ];
  for (const [err, res] of cases) {
    state.scriptErr = err;
    const r = await run(home, ['scripts', 'run', 'small', ...K]);
    assert.equal(r.code, 3, `${err.title}: ${r.stderr}`);
    for (const re of res) assert.match(r.stderr, re, err.title);
  }
  assert.equal(ledgerOf(home).length, 0, 'no ledger record for a refused run');
  state.scriptErr = null;
  state.clients[0].connection_state = 'connected';
  state.clients.push({ id: 'c-3', name: 'paused', connection_state: 'connected' });
  // A client that looks connected but the server says is not active (e.g. paused) -> 404 hint.
  state.clients[2].connection_state = 'paused';
  const r = await run(home, ['scripts', 'run', 'small', '--client', 'paused']);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /not active \(disconnected or paused\)/);
});

test('scripts run: still running after --wait, and status unknown', async () => {
  const home = await scriptsHome();
  seedScript({ name: 'slow', script: 'sleep 999\n', timeout_sec: 900 });
  state.jobSeq = ['running'];
  let r = await run(home, ['scripts', 'run', 'slow', ...K, '--wait', '0']);
  assert.equal(r.code, 0, r.stderr);
  let res = resultOf(r.stdout);
  assert.equal(res.status, 'running');
  assert.equal(res.jid, 'job-1');
  assert.match(res.note, /scripts job c-1 job-1/);
  assert.ok(fs.existsSync(res.output_file), 'partial job file written');
  assert.equal(ledgerOf(home)[0].status, 'running');

  state.jobSeq = ['running', 'unknown'];
  r = await run(home, ['scripts', 'run', 'slow', ...K]);
  res = resultOf(r.stdout);
  assert.equal(res.status, 'unknown');
  assert.match(res.note, /may still be running on the client/);
  assert.match(r.stdout, /NOTE: .*may still be running/);
});

test('scripts job / jobs', async () => {
  const home = await scriptsHome();
  seedScript({ name: 'small', script: 'echo hi\n' });
  await run(home, ['scripts', 'run', 'small', ...K]);
  state.jobOut = { stdout: 'second\n', stderr: '', summary: '' };
  await run(home, ['scripts', 'run', 'small', ...K]);
  const outFile = path.join(home, 'one.json');
  let r = await run(home, ['scripts', 'job', 'my-server', 'job-1', '--out', outFile, '--json']);
  assert.equal(r.code, 0, r.stderr);
  const res = resultOf(r.stdout);
  assert.deepEqual([res.jid, res.status, res.stdout_tail, res.output_file], ['job-1', 'successful', 'ok', outFile]);
  assert.equal(JSON.parse(fs.readFileSync(outFile, 'utf8')).jid, 'job-1');
  r = await run(home, ['scripts', 'jobs', 'my-server', '--limit', '1', '--json']);
  assert.equal(r.code, 0, r.stderr);
  const rows = JSON.parse(r.stdout);
  assert.equal(rows.length, 1);
  assert.ok(!('result' in rows[0]), 'no full output in the job list');
  assert.equal(state.log.find((e) => e.path === '/api/v1/clients/c-1/commands').query['page[limit]'], '1');
  r = await run(home, ['scripts', 'job', 'my-server', 'job-99']);
  assert.equal(r.code, 3);
  assert.equal(writes().length, 2, 'only the two runs wrote');
});

test('scripts add / update / delete: dry-run sends nothing; real calls carry the file content', async () => {
  const home = await scriptsHome();
  const file = path.join(home, 'check.sh');
  fs.writeFileSync(file, '#!/bin/sh\ndf -h\nuptime\n');
  const dry = async (args, re) => {
    const r = await run(home, [...args, '--dry-run']);
    assert.equal(r.code, 0, `${args.join(' ')}: ${r.stderr}`);
    assert.equal(writes().length, 0, `${args.join(' ')} made a write`);
    assert.match(r.stdout, re);
    return r;
  };
  let r = await dry(['scripts', 'add', 'check', '--file', file, '--interpreter', 'sh', '--tags', 'disk, ops', '--timeout', '90'], /DRY-RUN would call: POST .*\/library\/scripts/);
  assert.match(r.stdout, new RegExp(`sha256 ${scriptSha256('#!/bin/sh\ndf -h\nuptime\n')}`));
  assert.match(r.stdout, /\| df -h/);
  assert.ok(!r.stdout.includes('"script":"#!/bin/sh'), 'script text not inlined in the plan');
  assert.equal(state.library.length, 0);

  r = await run(home, ['scripts', 'add', 'check', '--file', file, '--interpreter', 'sh', '--tags', 'disk, ops', '--timeout', '90']);
  assert.equal(r.code, 0, r.stderr);
  const post = writes()[0];
  assert.deepEqual([post.method, post.path], ['POST', '/api/v1/library/scripts']);
  assert.deepEqual(JSON.parse(post.body), { name: 'check', script: '#!/bin/sh\ndf -h\nuptime\n', interpreter: 'sh', is_sudo: false, timeout_sec: 90, tags: ['disk', 'ops'] });
  assert.equal((await run(home, ['scripts', 'add', 'check', '--file', file])).code, 4, 'duplicate name');
  assert.equal((await run(home, ['scripts', 'add', 'other'])).code, 1, '--file required');
  assert.equal((await run(home, ['scripts', 'add', 'other', '--file', path.join(home, 'missing.sh')])).code, 4);
  assert.equal((await run(home, ['scripts', 'add', 'other', '--script', 'id'])).code, 2, 'no script text on argv');

  state.log = [];
  fs.writeFileSync(file, 'uptime\n');
  await dry(['scripts', 'update', 'check', '--file', file, '--sudo'], /DRY-RUN .*changes: script, is_sudo[\s\S]*PUT .*\/library\/scripts\/scr-1/);
  assert.equal(state.library[0].script, '#!/bin/sh\ndf -h\nuptime\n');
  r = await run(home, ['scripts', 'update', 'check', '--file', file, '--sudo', '--name', 'check2']);
  assert.equal(r.code, 0, r.stderr);
  const put = writes()[0];
  assert.deepEqual([put.method, put.path], ['PUT', '/api/v1/library/scripts/scr-1']);
  const pb = JSON.parse(put.body);
  assert.deepEqual([pb.name, pb.script, pb.is_sudo, pb.interpreter, pb.timeout_sec, pb.tags], ['check2', 'uptime\n', true, 'sh', 90, ['disk', 'ops']], 'full object, other fields kept');
  r = await run(home, ['scripts', 'update', 'check2', '--no-sudo']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(state.library[0].is_sudo, false);
  assert.equal((await run(home, ['scripts', 'update', 'check2'])).code, 1, 'nothing to change');
  assert.equal((await run(home, ['scripts', 'update', 'check2', '--sudo', '--no-sudo'])).code, 1);

  state.log = [];
  await dry(['scripts', 'delete', 'check2'], /DRY-RUN would call: DELETE .*\/library\/scripts\/scr-1/);
  assert.equal(state.library.length, 1);
  r = await run(home, ['scripts', 'delete', 'CHECK2']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual([writes()[0].method, writes()[0].path], ['DELETE', '/api/v1/library/scripts/scr-1']);
  assert.equal(state.library.length, 0);
});

// ---------------------------------------------------------------- scripts history (read-only)
const isoAt = (ms) => new Date(ms).toISOString();
// "2026-10-30T15:36:27.160+05:30": the client's clock, as RPort reports it.
const withOffset = (ms, offMin) => {
  const a = Math.abs(offMin);
  return `${new Date(ms + offMin * 60000).toISOString().replace('Z', '')}${offMin >= 0 ? '+' : '-'}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
};
function seedJob(fields) {
  const j = {
    jid: `h-${state.nextJid++}`, client_id: 'c-1', client_name: 'my-server', status: 'successful', interpreter: '', cwd: '', pid: 100,
    is_sudo: false, is_script: true, timeout_sec: 60, created_by: USER, multi_job_id: null, schedule_id: null, error: '',
    result: { stdout: 'ok\n', stderr: '', summary: '' }, command: 'echo hi\n', ...fields,
  };
  j._seq = [j.status];
  state.jobs.push(j);
  return j;
}
const audit = (fields) => state.audit.push({ remote_ip: '198.51.100.2', client_id: '', client_hostname: '', affected_id: '', response: '', ...fields });

// Five jobs: J1 library script (CRLF variant, +05:30 clock, multi job, audited by multi id, secrets in
// stdout); J2 an older audited library version (audited by fallback); J3 sudo run 10 min after a library
// edit, no audit record; J4 bash/docker script with interpreter "" on a Windows client, empty
// client_name, status unknown; J5 an old failed ad-hoc command.
async function historyHome() {
  const home = await scriptsHome();
  const NOW = Date.now();
  const T = { created: NOW - 30 * 86400000, edit: NOW - 3 * 3600000, j1: NOW - 3600000, j2: NOW - 2 * 86400000, j3: NOW - 3 * 3600000 + 10 * 60000, j4: NOW - 30 * 60000, j5: NOW - 10 * 86400000 };
  state.clients = [
    { id: 'c-1', name: 'my-server', connection_state: 'connected', os_kernel: 'linux' },
    { id: 'c-2', name: 'offline-box', connection_state: 'disconnected', os_kernel: 'linux' },
    { id: 'c-3', name: 'win-box', connection_state: 'connected', os_kernel: 'windows' },
  ];
  seedScript({ name: 'disk-check', script: 'df -h\nuptime\n', created_at: isoAt(T.created), updated_at: isoAt(T.created), created_by: 'bob', updated_by: 'bob' });
  const deploy = seedScript({ name: 'deploy', script: 'echo v2\n', created_at: isoAt(T.created), updated_at: isoAt(T.edit), created_by: 'bob', updated_by: 'bob' });
  audit({ timestamp: isoAt(T.created), username: 'bob', application: 'library.script', action: 'create', request: JSON.stringify({ name: 'deploy', script: 'echo v1\n', is_sudo: false, interpreter: '' }), response: JSON.stringify({ id: deploy.id, updated_by: 'bob', updated_at: isoAt(T.created) }) });
  audit({ timestamp: isoAt(T.edit), username: 'bob', application: 'library.script', action: 'update', request: JSON.stringify({ name: 'deploy', script: 'echo v2\n' }), response: JSON.stringify({ id: deploy.id, updated_by: 'bob', updated_at: isoAt(T.edit) }) });
  const J = {};
  J.j1 = seedJob({
    command: 'df -h  \r\nuptime\r\n', started_at: withOffset(T.j1, 330), finished_at: withOffset(T.j1 + 5000, 330), multi_job_id: 'multi-1', created_by: 'alice',
    result: { stdout: 'Filesystem ok\npassword=hunter2\naws AKIAABCDEFGHIJKLMNOP\n', stderr: '', summary: '' },
  });
  audit({ timestamp: isoAt(T.j1 - 1000), username: 'alice', remote_ip: '198.51.100.9', application: 'client.script', action: 'execute.start', affected_id: 'multi-1', request: JSON.stringify({ client_ids: ['c-1', 'c-3'], command: 'df -h\nuptime\n', interpreter: '', is_sudo: false }) });
  audit({ timestamp: isoAt(T.j1 + 6000), username: 'alice', remote_ip: '198.51.100.9', application: 'client.script', action: 'execute.done', affected_id: 'multi-1' });
  state.multiJobs.push({ jid: 'multi-1', started_at: isoAt(T.j1), created_by: 'alice', schedule_id: null, client_ids: ['c-1', 'c-3'], group_ids: [], command: 'df -h', interpreter: '', is_sudo: false, execute_concurrently: true, abort_on_error: false, jobs: [{ jid: 'h-1', status: 'successful' }, { jid: 'zz', status: 'successful' }] });
  J.j2 = seedJob({ command: 'echo v1\n', started_at: isoAt(T.j2), finished_at: isoAt(T.j2 + 1000), created_by: 'bob' });
  audit({ timestamp: isoAt(T.j2 + 30000), username: 'bob', remote_ip: '198.51.100.7', application: 'client.script', action: 'execute.start', affected_id: 'other-multi', client_id: 'c-1', client_hostname: 'my-server', request: JSON.stringify({ client_ids: ['c-1'], command: Buffer.from('echo v1\n').toString('base64') }) });
  J.j3 = seedJob({ command: 'echo v2\n', started_at: isoAt(T.j3), finished_at: isoAt(T.j3 + 1000), created_by: 'bob', is_sudo: true });
  J.j4 = seedJob({
    client_id: 'c-3', client_name: '', status: 'unknown', command: "#!/bin/bash\ndocker ps\nexport DB_PASSWORD='s3cr3t-value'\n", started_at: isoAt(T.j4), finished_at: isoAt(T.j4 + 60000), created_by: 'carol',
    result: { stdout: '', stderr: "'docker' is not recognized\nAuthorization: Bearer abcdefghijkl\n", summary: '' },
  });
  J.j5 = seedJob({ is_script: false, command: 'uname -a', status: 'failed', error: 'exit status 1', started_at: isoAt(T.j5), finished_at: isoAt(T.j5 + 1000), created_by: 'alice' });
  state.log = [];
  return { home, T, J };
}
const histOf = (r) => { assert.equal(r.code, 0, r.stderr); return JSON.parse(r.stdout); };
const runFor = (h, jid) => h.runs.find((x) => x.jid === jid);
const codes = (run) => run.flags.map((f) => f.code);
const detailGets = () => state.log.filter((e) => e.method === 'GET' && /^\/api\/v1\/clients\/[^/]+\/commands\/[^/]+$/.test(e.path)).map((e) => e.path.split('/').pop());

test('history unit: redaction, CRLF-insensitive hash, UTC normalisation, relative times, interpreter, flavor, GET-only guard', () => {
  const red = redactSecrets("password=hunter2 token: abc123\nexport DB_PASSWORD='x y'\nset API_KEY=zz\nAuthorization: Basic Zm9v\ncurl -H 'Authorization: Bearer tok123456'\nAKIAABCDEFGHIJKLMNOP\n-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----\nplain line");
  for (const s of ['hunter2', 'abc123', 'x y', 'zz', 'Zm9v', 'tok123456', 'AKIAABCDEFGHIJKLMNOP', 'MIIE']) assert.ok(!red.includes(s), `${s} redacted`);
  assert.match(red, /plain line/);
  assert.match(red, /DB_PASSWORD=\[REDACTED\]/);
  assert.equal(normScriptSha256('df -h  \r\nuptime\r\n\r\n'), normScriptSha256('df -h\nuptime'));
  assert.equal(normalizeScriptText('a\t\r\nb \r\n'), 'a\nb');
  assert.notEqual(normScriptSha256('echo v1'), normScriptSha256('echo v2'));
  assert.equal(toUtcIso('2026-10-30T15:36:27.16+05:30'), '2026-10-30T10:06:27.160Z');
  assert.equal(toUtcIso('2026-10-30T10:06:27Z'), '2026-10-30T10:06:27.000Z');
  assert.equal(toUtcIso('0001-01-01T00:00:00Z'), null);
  assert.equal(parseWhen('7d', 1e12), 1e12 - 7 * 86400000);
  assert.equal(parseWhen('24h', 1e12), 1e12 - 86400000);
  assert.equal(parseWhen('2026-10-30T00:00:00Z'), Date.parse('2026-10-30T00:00:00Z'));
  assert.throws(() => parseWhen('yesterday'), (e) => e.exitCode === 1);
  assert.equal(resolveInterpreter('', 'windows').resolved, 'cmd (server default, Windows)');
  assert.equal(resolveInterpreter('', 'unix').resolved, '/bin/sh (server default, Unix)');
  assert.equal(resolveInterpreter('powershell', 'windows').kind, 'powershell');
  assert.equal(resolveInterpreter('/bin/bash', 'unix').kind, 'posix');
  assert.ok(scriptFlavor('#!/bin/bash\ndocker ps\n').posix.includes('shebang'));
  assert.deepEqual(scriptFlavor('@echo off\necho %PATH%\n').posix, []);
  assert.equal(slimJob({ jid: 'j', command: "X_TOKEN='abc'\n", result: { stdout: 'a\n'.repeat(40) } }).stdout_tail.split('\n').length, HISTORY.TAIL_LINES);
  assert.ok(!JSON.stringify(slimJob({ jid: 'j', command: "X_TOKEN='abc'\n" })).includes('abc'), 'cache form holds no secret');
  // history's requests are all GETs, which the guard lets through; the same paths stay closed to writes
  for (const p of ['/commands', '/commands/m-1', '/auditlog', '/clients/c-1/commands', '/clients/c-1/commands/j-1', '/library/scripts']) assert.doesNotThrow(() => assertAllowedRequest('GET', p));
  for (const [m, p] of [['POST', '/commands'], ['POST', '/clients/c-1/commands'], ['DELETE', '/commands/m-1']]) assert.throws(() => assertAllowedRequest(m, p), (e) => e.exitCode === 2);
  // library versions + attribution
  const idx = buildLibraryIndex(
    [{ id: 's1', name: 'deploy', script: 'echo v2\n', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-02-01T00:00:00Z', updated_by: 'bob' }],
    [{ timestamp: '2026-01-01T00:00:00Z', username: 'bob', action: 'create', request: JSON.stringify({ name: 'deploy', script: 'echo v1\r\n' }), response: JSON.stringify({ id: 's1' }) },
      { timestamp: '2026-02-01T00:00:00Z', username: 'bob', action: 'update', request: JSON.stringify({ name: 'deploy', script: 'echo v2\n' }), response: JSON.stringify({ id: 's1' }) }],
  );
  assert.deepEqual(idx.get('s1').versions.map((v) => [v.index, !!v.current]), [[1, false], [2, true]]);
  const old = attributeScript(normScriptSha256('echo v1'), Date.parse('2026-01-15T00:00:00Z'), idx);
  assert.deepEqual([old.library_name, old.version, old.versions_total, old.is_current], ['deploy', 1, 2, false]);
  assert.equal(attributeScript(normScriptSha256('rm -rf /tmp/x'), Date.now(), idx), null);
  const starts = prepAuditStarts([{ timestamp: '2026-01-15T00:00:30Z', action: 'execute.start', client_id: 'c-1', affected_id: 'm-9', request: JSON.stringify({ command: 'echo v1' }) }]);
  assert.equal(matchAuditStart({ jid: 'j', multi_job_id: 'm-9', client_id: 'c-9', started_utc: '2020-01-01T00:00:00Z', norm_sha256: 'x' }, starts).by, 'multi_job_id');
  assert.equal(matchAuditStart({ jid: 'j', client_id: 'c-1', started_utc: '2026-01-15T00:00:00Z', norm_sha256: normScriptSha256('echo v1') }, starts).by, 'client+sha+time');
  assert.equal(matchAuditStart({ jid: 'j', client_id: 'c-1', started_utc: '2026-01-15T00:05:00Z', norm_sha256: normScriptSha256('echo v1') }, starts), null, 'outside 2 min');
});

test('scripts history: GET only; list+detail join, UTC times, attribution, audit match, flags, redaction, report', async () => {
  const { home, T, J } = await historyHome();
  const r = await run(home, ['scripts', 'history']);
  const h = histOf(r);
  assert.deepEqual(state.log.filter((e) => e.method !== 'GET'), [], 'history sent only GET requests');
  assert.ok(state.log.some((e) => e.path === '/api/v1/commands') && state.log.some((e) => e.path === '/api/v1/auditlog'));
  assert.equal(h.server, 'default');
  assert.deepEqual(h.runs.map((x) => x.jid), [J.j4.jid, J.j1.jid, J.j3.jid, J.j2.jid, J.j5.jid], 'most recent first');
  assert.deepEqual([h.coverage.clients_scanned, h.coverage.jobs, h.coverage.details_fetched, h.coverage.from_cache, h.coverage.multi_jobs, h.coverage.audit_available, h.coverage.audit_matched_runs], [3, 5, 6, 0, 1, true, 2]);
  assert.equal(h.coverage.audit_script_entries, 3);

  const r1 = runFor(h, J.j1.jid);
  assert.equal(r1.started_utc, isoAt(T.j1), '+05:30 normalised to UTC');
  assert.match(r1.started_local, /\+05:30$/);
  assert.equal(r1.duration_s, 5);
  assert.deepEqual([r1.script.library_name, r1.script.is_current, r1.attribution], ['disk-check', true, 'disk-check@v1/1'], 'CRLF/trailing-space variant attributed');
  assert.notEqual(r1.sha256, scriptSha256('df -h\nuptime\n'), 'raw sha256 is of the job text as sent');
  assert.deepEqual([r1.audit_match, r1.remote_ip, r1.created_by, r1.multi_targets], ['multi_job_id', '198.51.100.9', 'alice', 2]);
  assert.ok(codes(r1).includes('MULTI_CLIENT'));
  assert.ok(!codes(r1).includes('NO_AUDIT_RECORD') && !codes(r1).includes('NOT_FROM_LIBRARY'));
  assert.ok(!r1.stdout_tail.includes('hunter2') && !r1.stdout_tail.includes('AKIAABCDEFGHIJKLMNOP') && r1.stdout_tail.includes('[REDACTED]'));

  const r2 = runFor(h, J.j2.jid);
  assert.deepEqual([r2.script.library_name, r2.script.version, r2.script.versions_total, r2.script.is_current], ['deploy', 1, 2, false]);
  assert.ok(codes(r2).includes('LIBRARY_VERSION_OUTDATED'));
  assert.deepEqual([r2.audit_match, r2.remote_ip], ['client+sha+time', '198.51.100.7'], 'fallback audit match (base64 request text)');

  const r3 = runFor(h, J.j3.jid);
  assert.ok(codes(r3).includes('RAN_SOON_AFTER_LIBRARY_EDIT'));
  assert.ok(codes(r3).includes('SUDO') && codes(r3).includes('NO_AUDIT_RECORD'));
  assert.ok(!codes(r3).includes('LIBRARY_VERSION_OUTDATED'));

  const r4 = runFor(h, J.j4.jid);
  assert.deepEqual([r4.client_name, r4.client_name_source, r4.client_os_family], ['win-box', 'clients list', 'windows'], 'empty client_name falls back');
  assert.equal(r4.interpreter_resolved, 'cmd (server default, Windows)');
  for (const c of ['INTERPRETER_OS_MISMATCH', 'NOT_FROM_LIBRARY', 'EMPTY_CLIENT_NAME', 'UNKNOWN_MAY_STILL_RUN', 'NO_AUDIT_RECORD']) assert.ok(codes(r4).includes(c), c);
  assert.equal(r4.attribution, 'not in library (ad-hoc)');
  assert.ok(!r4.command_preview.includes('s3cr3t-value') && r4.command_preview.includes('DB_PASSWORD=[REDACTED]'));
  assert.ok(!r4.stderr_tail.includes('abcdefghijkl'));

  const r5 = runFor(h, J.j5.jid);
  assert.equal(r5.kind, 'command');
  assert.ok(codes(r5).includes('FAILED'));
  assert.equal(r5.error, 'exit status 1');

  assert.deepEqual(h.summary.by_status, { unknown: 1, successful: 3, failed: 1 });
  assert.equal(h.summary.by_user.bob, 2);
  assert.equal(h.summary.flags.NO_AUDIT_RECORD, 3);
  for (const s of ['hunter2', 's3cr3t-value', 'abcdefghijkl', 'AKIAABCDEFGHIJKLMNOP']) assert.ok(!r.stdout.includes(s), `${s} not on stdout`);

  assert.ok(h.report_file.startsWith(path.join(home, 'reports')));
  const md = fs.readFileSync(h.report_file, 'utf8');
  for (const s of ['## Coverage', 'The audit log covers 2 of 5 runs', '## Timeline', '| UTC time | user | client | script@version | sudo | status | flags |', '## Per script', '## Per user', '## Per client', '## Attention', 'INTERPRETER_OS_MISMATCH', 'deploy@v1/2']) assert.ok(md.includes(s), s);
  assert.ok(!md.includes('hunter2') && !md.includes('s3cr3t-value'));
  // the cache holds no secrets either
  const cacheFiles = fs.readdirSync(path.join(home, 'history-cache', 'default'));
  assert.ok(cacheFiles.includes(`${J.j1.jid}.json`) && !cacheFiles.includes(`${J.j4.jid}.json`), 'finished cached, unknown not');
  for (const f of cacheFiles) assert.ok(!fs.readFileSync(path.join(home, 'history-cache', 'default', f), 'utf8').includes('s3cr3t-value'));

  const rep = path.join(home, 'my', 'report.md');
  const outFile = path.join(home, 'my', 'h.json');
  const h2 = histOf(await run(home, ['scripts', 'history', '--report', rep, '--out', outFile, '--json']));
  assert.equal(h2.report_file, rep);
  assert.ok(fs.existsSync(rep));
  assert.equal(JSON.parse(fs.readFileSync(outFile, 'utf8')).runs.length, 5);
});

test('scripts history: finished job details come from the cache; unknown/running are refetched; --refresh bypasses', async () => {
  const { home, J } = await historyHome();
  histOf(await run(home, ['scripts', 'history']));
  assert.equal(detailGets().length, 5);
  state.log = [];
  let h = histOf(await run(home, ['scripts', 'history']));
  assert.deepEqual(detailGets(), [J.j4.jid], 'only the unknown job is fetched again');
  assert.ok(!state.log.some((e) => e.path === '/api/v1/commands/multi-1'), 'finished multi job cached');
  assert.deepEqual([h.coverage.details_fetched, h.coverage.from_cache], [1, 5]);
  state.log = [];
  h = histOf(await run(home, ['scripts', 'history', '--refresh']));
  assert.equal(detailGets().length, 5);
  assert.deepEqual([h.coverage.details_fetched, h.coverage.from_cache], [6, 0]);
});

test('scripts history: audit log 403 -> continues, audit_available=false, no NO_AUDIT_RECORD', async () => {
  const { home, J } = await historyHome();
  state.auditStatus = 403;
  const h = histOf(await run(home, ['scripts', 'history']));
  assert.equal(h.coverage.audit_available, false);
  assert.match(h.coverage.audit_reason, /403/);
  assert.equal(h.runs.length, 5);
  assert.ok(h.runs.every((x) => !codes(x).includes('NO_AUDIT_RECORD')), 'not spammed when the audit log is unavailable');
  assert.ok(h.runs.every((x) => x.remote_ip === null));
  assert.ok(codes(runFor(h, J.j2.jid)).includes('NOT_FROM_LIBRARY'), 'without audited versions the old text is not attributable');
  assert.match(fs.readFileSync(h.report_file, 'utf8'), /Audit log unavailable/);
  assert.equal(state.log.filter((e) => e.path === '/api/v1/auditlog').length, 1, 'stops asking after the first 403');
});

test('scripts history filters: --client, --user, --script, --since relative, --status, --limit', async () => {
  const { home, J } = await historyHome();
  let h = histOf(await run(home, ['scripts', 'history', '--client', 'win-box']));
  assert.deepEqual(h.runs.map((x) => x.jid), [J.j4.jid]);
  assert.equal(h.coverage.clients_scanned, 1);
  assert.ok(!state.log.some((e) => e.path === '/api/v1/clients/c-1/commands'), 'only the named client listed');
  state.log = [];
  h = histOf(await run(home, ['scripts', 'history', '--since', '7d']));
  assert.ok(!h.runs.some((x) => x.jid === J.j5.jid) && h.runs.length === 4);
  assert.ok(!detailGets().includes(J.j5.jid), 'a job finished before --since is not fetched');
  h = histOf(await run(home, ['scripts', 'history', '--user', 'BOB']));
  assert.deepEqual(h.runs.map((x) => x.jid).sort(), [J.j2.jid, J.j3.jid].sort());
  h = histOf(await run(home, ['scripts', 'history', '--script', 'deploy']));
  assert.deepEqual(h.runs.map((x) => x.jid).sort(), [J.j2.jid, J.j3.jid].sort());
  h = histOf(await run(home, ['scripts', 'history', '--script', 'ad-hoc']));
  assert.deepEqual(h.runs.map((x) => x.jid).sort(), [J.j4.jid, J.j5.jid].sort());
  h = histOf(await run(home, ['scripts', 'history', '--status', 'failed']));
  assert.deepEqual(h.runs.map((x) => x.jid), [J.j5.jid]);
  h = histOf(await run(home, ['scripts', 'history', '--limit', '2']));
  assert.deepEqual([h.runs_returned, h.runs_matched, h.runs[0].jid], [2, 5, J.j4.jid]);
  assert.equal((await run(home, ['scripts', 'history', '--since', 'yesterday'])).code, 1);
  assert.equal((await run(home, ['scripts', 'run', 'deploy', '--client', 'my-server', '--script', 'x'])).code, 2, '--script stays forbidden outside history');
  assert.deepEqual(writes(), []);
});

test('history flags: MULTI_CLIENT only for >1 target, STALE_RUNNING vs STILL_RUNNING, INLINE_SUDO, old UNKNOWN', async () => {
  assert.ok(hasInlineSudo('sudo docker ps'));
  assert.ok(hasInlineSudo('cd /x && sudo reboot'));
  assert.ok(hasInlineSudo('echo $(sudo -n id)'));
  assert.ok(hasInlineSudo('echo x | sudo tee /etc/y'));
  assert.ok(hasInlineSudo('a;sudo b'));
  assert.ok(!hasInlineSudo('# sudo reboot\necho hi'), 'comment line');
  assert.ok(!hasInlineSudo('  #sudo x'));
  assert.ok(!hasInlineSudo('pseudo foo\ncat /etc/sudoers\necho nosudo'), 'not a command word');

  const { home, J } = await historyHome();
  const NOW = Date.now();
  state.multiJobs.push({ jid: 'multi-2', started_at: isoAt(NOW - 7200000), created_by: 'alice', schedule_id: null, client_ids: ['c-1'], group_ids: [], command: 'x', interpreter: '', is_sudo: false, jobs: [{ jid: 'h-6', status: 'successful' }] });
  const single = seedJob({ multi_job_id: 'multi-2', command: 'sudo docker ps\n# sudo in a comment\n', started_at: isoAt(NOW - 7200000), finished_at: isoAt(NOW - 7199000) });
  const reboot = seedJob({ status: 'running', command: 'sudo reboot', timeout_sec: 60, started_at: '2026-06-27T08:00:00+05:30', finished_at: null });
  const recent = seedJob({ status: 'running', command: 'sleep 30', timeout_sec: 60, started_at: isoAt(NOW - 60000), finished_at: null });
  const comment = seedJob({ command: '# sudo reboot\necho hi\n', started_at: isoAt(NOW - 5000000), finished_at: isoAt(NOW - 4999000) });
  const winPs = seedJob({ client_id: 'c-3', client_name: 'win-box', interpreter: 'powershell', command: 'sudo foo\n', started_at: isoAt(NOW - 4000000), finished_at: isoAt(NOW - 3999000) });
  const elevated = seedJob({ is_sudo: true, command: 'sudo apt-get update\n', started_at: isoAt(NOW - 3000000), finished_at: isoAt(NOW - 2999000) });
  const oldUnknown = seedJob({ status: 'unknown', command: 'lsof', started_at: isoAt(NOW - 3 * 86400000), finished_at: isoAt(NOW - 3 * 86400000 + 60000) });

  const h = histOf(await run(home, ['scripts', 'history']));
  const r1 = runFor(h, J.j1.jid);
  assert.ok(codes(r1).includes('MULTI_CLIENT') && r1.multi_targets === 2, '2 targets -> MULTI_CLIENT');
  const s = runFor(h, single.jid);
  assert.deepEqual([s.multi_job_id, s.multi_targets], ['multi-2', 1], 'multi fields kept');
  assert.ok(!codes(s).includes('MULTI_CLIENT'), '1 target -> no MULTI_CLIENT');
  assert.ok(codes(s).includes('INLINE_SUDO') && !codes(s).includes('SUDO'));
  const rb = runFor(h, reboot.jid);
  assert.ok(codes(rb).includes('STALE_RUNNING') && !codes(rb).includes('STILL_RUNNING'), 'months-old running is stale');
  assert.match(rb.flags.find((f) => f.code === 'STALE_RUNNING').text, /never finalised.*disconnected, rebooted or lost the job/);
  assert.ok(codes(rb).includes('INLINE_SUDO'));
  const rc = runFor(h, recent.jid);
  assert.ok(codes(rc).includes('STILL_RUNNING') && !codes(rc).includes('STALE_RUNNING'));
  assert.ok(!codes(runFor(h, comment.jid)).includes('INLINE_SUDO'), 'sudo only in a comment');
  assert.ok(!codes(runFor(h, winPs.jid)).includes('INLINE_SUDO'), 'ignored for cmd/powershell');
  const el = runFor(h, elevated.jid);
  assert.ok(codes(el).includes('SUDO') && !codes(el).includes('INLINE_SUDO'));
  assert.match(runFor(h, oldUnknown.jid).flags.find((f) => f.code === 'UNKNOWN_MAY_STILL_RUN').text, /long past its timeout; check the client before assuming anything/);
  assert.doesNotMatch(runFor(h, J.j4.jid).flags.find((f) => f.code === 'UNKNOWN_MAY_STILL_RUN').text, /long past/, 'recent unknown');
  assert.deepEqual([h.summary.flags.MULTI_CLIENT, h.summary.flags.STALE_RUNNING, h.summary.flags.STILL_RUNNING, h.summary.flags.INLINE_SUDO], [1, 1, 1, 2]);
  assert.match(h.summary.flag_legend.INLINE_SUDO, /client's sudo rules, not RPort's is_sudo/);
  const md = fs.readFileSync(h.report_file, 'utf8');
  const attention = md.slice(md.indexOf('## Attention'));
  for (const re of [/\| STALE_RUNNING \| 1 \| status never finalised/, /\| INLINE_SUDO \| 2 \|/, /\| MULTI_CLIENT \| 1 \|/, /INLINE_SUDO: runs commands with sudo/]) assert.match(attention, re);
  assert.match(md, /\| inline \|/, 'timeline marks inline sudo');
  assert.deepEqual(writes(), []);
});

test('scripts job reuses history attribution, flags and UTC times', async () => {
  const { home, J, T } = await historyHome();
  let r = await run(home, ['scripts', 'job', 'win-box', J.j4.jid, '--json']);
  assert.equal(r.code, 0, r.stderr);
  let res = resultOf(r.stdout);
  for (const c of ['INTERPRETER_OS_MISMATCH', 'NOT_FROM_LIBRARY', 'EMPTY_CLIENT_NAME', 'UNKNOWN_MAY_STILL_RUN']) assert.ok(codes(res.history).includes(c), c);
  r = await run(home, ['scripts', 'job', 'my-server', J.j1.jid]);
  assert.equal(r.code, 0, r.stderr);
  res = resultOf(r.stdout);
  assert.deepEqual([res.history.script.library_name, res.history.started_utc, res.history.remote_ip, res.history.multi_targets], ['disk-check', isoAt(T.j1), '198.51.100.9', 2]);
  assert.match(r.stdout, /what: script disk-check@v1\/1/);
  assert.match(r.stdout, /FLAG MULTI_CLIENT/);
  assert.deepEqual(writes(), []);
});

test('no request ever went to an ad-hoc execution endpoint, and none can', () => {
  allLogs.push(...state.log, ...stateB.log);
  state.log = [];
  stateB.log = [];
  const bad = allLogs.filter((e) => {
    const p = e.path.replace(/^(\/b)?\/api\/v1/, '');
    if (/(^|\/)ws(\/|$)/.test(p)) return true;
    if (e.method === 'GET') return false;
    return /^\/commands(\/|$)/.test(p) || /^\/scripts(\/|$)/.test(p) || /^\/clients\/[^/]+\/commands(\/|$)/.test(p) || /^\/client-groups\//.test(p);
  });
  assert.deepEqual(bad, []);
  assert.ok(allLogs.some((e) => e.method === 'POST' && /\/clients\/c-1\/scripts$/.test(e.path)), 'the library run path was exercised');
  // Static: the source names no other execution endpoint, and every request goes through the guard.
  const src = fs.readFileSync(CLI, 'utf8');
  const multi = src.match(/['"`]\/commands['"`]/g) || [];
  assert.equal(multi.length, 1, 'the multi-job path is named exactly once');
  assert.match(src, /\nconst MULTI_JOBS = '\/commands'; \/\/ multi-client jobs: read with GET only/);
  const uses = src.split('\n').filter((l) => l.includes('MULTI_JOBS') && !l.startsWith('const MULTI_JOBS'));
  assert.ok(uses.length > 0 && uses.every((l) => /getAllPages\(ctx, conn, MULTI_JOBS,|api\(ctx, conn, 'GET', `\$\{MULTI_JOBS\}\//.test(l)), `MULTI_JOBS only read: ${uses.join(' / ')}`);
  assert.match(src, /async function getAllPages\([^)]*\) \{[\s\S]{0,200}await api\(ctx, conn, 'GET', p,/, 'getAllPages only GETs');
  assert.ok(!/['"`]\/scripts['"`]/.test(src) && !/['"`]\/ws/.test(src), 'no literal ad-hoc endpoint');
  assert.equal((src.match(/await fetch\(/g) || []).length, 1, 'one fetch call site');
  assert.match(src, /async function api\([^)]*\) \{\n  assertAllowedRequest\(method, p\);/);
});

test('the token never appears in stdout, stderr, ledger, config, URLs or bodies', () => {
  allLogs.push(...state.log, ...stateB.log);
  assert.ok(outputs.length > 40, 'collected output from the CLI runs');
  for (const o of outputs) {
    assert.ok(!o.includes(SENTINEL), 'sentinel token leaked to output');
    assert.ok(!o.includes(BASIC), 'basic auth header leaked to output');
  }
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const h of homes) {
    for (const f of walk(h)) {
      const c = fs.readFileSync(f, 'utf8');
      assert.ok(!c.includes(SENTINEL) && !c.includes(BASIC), `token leaked into ${f}`);
    }
  }
  assert.ok(allLogs.length > 50, 'collected server request log');
  for (const e of allLogs) {
    assert.ok(!e.path.includes(SENTINEL) && !JSON.stringify(e.query).includes(SENTINEL), 'token in URL');
    assert.ok(!e.body.includes(SENTINEL), 'token in a request body');
  }
});

// Minimal frontmatter reader: the block between the first two '---' lines, `key: value` pairs,
// values optionally wrapped in double or single quotes. Enough for name/description.
function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!m) throw new Error('SKILL.md has no frontmatter block');
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) throw new Error(`frontmatter line is not "key: value": ${line}`);
    let v = kv[2].trim();
    if (v.startsWith('"')) v = JSON.parse(v);
    else if (v.startsWith("'")) v = v.slice(1, -1).replace(/''/g, "'");
    fm[kv[1]] = v;
  }
  return fm;
}

test('SKILL.md frontmatter parses', () => {
  const fm = parseFrontmatter(fs.readFileSync(path.join(here, '..', 'skills', 'rport', 'SKILL.md'), 'utf8'));
  assert.equal(fm.name, 'rport');
  assert.match(fm.description, /tunnel/i);
});
