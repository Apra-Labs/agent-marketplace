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
  };
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
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, RPORT_TOKEN: SENTINEL, RPORT_SKILL_HOME: home, ...env } }, (err, stdout, stderr) => {
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

test('the token never appears in stdout, stderr, ledger, config, URLs or bodies', () => {
  allLogs.push(...state.log, ...stateB.log);
  assert.ok(outputs.length > 40, 'collected output from the CLI runs');
  for (const o of outputs) {
    assert.ok(!o.includes(SENTINEL), 'sentinel token leaked to output');
    assert.ok(!o.includes(BASIC), 'basic auth header leaked to output');
  }
  for (const h of homes) {
    for (const f of fs.readdirSync(h)) {
      const c = fs.readFileSync(path.join(h, f), 'utf8');
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
