#!/usr/bin/env node
// rport.mjs - CLI behind the `rport` agent skill (works with any LLM agent that can run apra-fleet tools).
// Node >= 18 (global fetch), no npm dependencies, works the same on Windows, macOS and Linux.
//
// Model: a tunnel *definition* is an RPort *stored tunnel* on the server
// (GET/POST /clients/{client_id}/stored-tunnels, PUT/DELETE .../stored-tunnels/{id}).
// A *live tunnel* is an instance of it (PUT /clients/{client_id}/tunnels). Locally we keep only
// server config, optional links stored tunnel -> apra-fleet member, and an append-only ledger.
//
// Secret handling: the only secret is the RPort API token. It arrives in the environment
// variable RPORT_TOKEN (substituted by apra-fleet's execute_command from {{secret.NAME}}).
// It is never printed, never put in a URL, a log line, an error message or the ledger.
// Every line this script writes goes through redact() as a second line of defence.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Limits (guardrails). Change only with the operator's agreement; tests pin them.
// ---------------------------------------------------------------------------
export const LIMITS = Object.freeze({
  AUTO_CLOSE_DEFAULT: '2h',
  AUTO_CLOSE_MAX_SECONDS: 12 * 3600, // hard maximum 12h
  AUTO_CLOSE_MIN_SECONDS: 60,
  IDLE_DEFAULT: 30, // minutes
  IDLE_MIN: 1,
  IDLE_MAX: 120,
  ACL_MAX_ENTRIES: 4,
  ACL_MIN_PREFIX: 30, // nothing wider than /30
  WARN_MINUTES: 15,
  CREATE_LOOP_WINDOW_MINUTES: 15,
  CREATE_LOOP_MAX: 3,
  SCRIPT_TIMEOUT_DEFAULT: 60, // seconds; the server's own default
  SCRIPT_TIMEOUT_MAX: 3600, // hard maximum 1h
  SCRIPT_BODY_MAX_BYTES: 10240, // the server's default [api] max_request_bytes
  SCRIPT_WAIT_EXTRA: 15, // default --wait = timeout_sec + this
  SCRIPT_POLL_SECONDS: 2,
  SCRIPT_TAIL_LINES: 60,
  SCRIPT_PREVIEW_LINES: 20,
});

export const EXIT = Object.freeze({ OK: 0, USAGE: 1, GUARDRAIL: 2, API: 3, CONFIG: 4 });

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '0.0.0.0']);
const PROTOCOLS = new Set(['tcp', 'udp', 'tcp+udp']);
const DEFAULT_TOKEN_SECRET = 'RPORT_API_TOKEN';
const DEFAULT_SERVER = 'default';
const MONIKER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ADMIN_NOTE = 'admin change on the RPort server (only on the operator\'s explicit request)';

// Error codes from PUT /clients/{client_id}/tunnels (openrport OpenAPI spec).
const ERROR_HINTS = {
  ERR_CODE_LOCAL_PORT_IN_USE: 'the server-side port is taken. If the stored tunnel pins public_port, something else holds it; otherwise retry once later or ask the operator.',
  ERR_CODE_REMOTE_PORT_NOT_OPEN: 'nothing listens on the remote port of the client (or LAN target). Check the service on the client. Do not disable check_port.',
  ERR_CODE_INVALID_ACL: 'the server rejected the ACL. Check the stored tunnel ACL (def show).',
  ERR_CODE_TUNNEL_EXIST: 'an identical tunnel already exists. Run `tunnels --client <c>` and `status`; revive reuses tracked tunnels.',
  ERR_CODE_TUNNEL_TO_PORT_EXIST: 'a tunnel to this remote port already exists on the client. Run `tunnels --client <c>`; close the old one if it is yours and unused.',
  ERR_CODE_INVALID_IDLE_TIMEOUT: 'the server rejected idle-timeout-minutes. Use 1..120.',
  ERR_CODE_URI_SCHEME_LENGTH_EXCEED: 'the scheme is too long. Use a short scheme such as ssh, rdp, http.',
};
const STATUS_HINTS = {
  401: 'authentication failed: wrong user, or the API token is wrong, expired or revoked (check its expires_at).',
  403: 'not allowed: the token scope or the user rights are too small (writes need a read+write token).',
  404: 'not found.',
  409: 'conflict.',
};

export class CliError extends Error {
  constructor(exitCode, message) {
    super(message);
    this.exitCode = exitCode;
  }
}
export class ApiError extends CliError {
  constructor(status, code, detail, where, hint) {
    const h = hint || (code && ERROR_HINTS[code]) || STATUS_HINTS[status] || '';
    super(EXIT.API, `API error ${status}${code ? ' ' + code : ''} on ${where}: ${detail || 'no detail'}${h ? '\n  hint: ' + h : ''}`);
    this.status = status;
    this.code = code;
  }
}
const guard = (m) => new CliError(EXIT.GUARDRAIL, `REFUSED (guardrail): ${m}`);
const cfgErr = (m) => new CliError(EXIT.CONFIG, `CONFIG: ${m}`);
const usage = (m) => new CliError(EXIT.USAGE, `USAGE: ${m} (see --help)`);

// ---------------------------------------------------------------------------
// Redaction and output
// ---------------------------------------------------------------------------
const SECRETS = new Set();
function addSecret(s) {
  if (typeof s === 'string' && s.length >= 4) SECRETS.add(s);
}
export function redact(text) {
  let s = String(text);
  for (const sec of SECRETS) s = s.split(sec).join('[REDACTED]');
  return s;
}
function out(line = '') {
  process.stdout.write(redact(line) + '\n');
}
function errOut(line) {
  process.stderr.write(redact(line) + '\n');
}

// ---------------------------------------------------------------------------
// Validation (pure; exported for tests)
// ---------------------------------------------------------------------------
const OCTET = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4_RE = new RegExp(`^${OCTET}\\.${OCTET}\\.${OCTET}\\.${OCTET}$`);

export function parseIPv4(s) {
  if (typeof s !== 'string' || !IPV4_RE.test(s)) return null;
  return s.split('.').reduce((acc, o) => acc * 256 + Number(o), 0);
}

// One ACL entry: a single IPv4 address or an IPv4 CIDR no wider than /30.
export function parseAclEntry(raw) {
  const e = String(raw).trim();
  if (e === '') throw guard('an ACL entry is empty. An empty ACL means the tunnel is open to everyone.');
  if (e.includes(':')) throw guard(`"${e}" is IPv6. RPort tunnel ACLs support IPv4 only, so an IPv6 entry cannot narrow the tunnel.`);
  const parts = e.split('/');
  if (parts.length > 2) throw guard(`"${e}" is not an IPv4 address or CIDR.`);
  const net = parseIPv4(parts[0]);
  if (net === null) throw guard(`"${e}" is not a valid IPv4 address (four decimal octets 0-255, no leading zeros).`);
  let prefix = 32;
  if (parts.length === 2) {
    if (!/^\d{1,2}$/.test(parts[1]) || Number(parts[1]) > 32) throw guard(`"${e}" has an invalid prefix length.`);
    prefix = Number(parts[1]);
  }
  if (net === 0 || prefix === 0) throw guard(`"${e}": 0.0.0.0/0 (or 0.0.0.0) opens the tunnel to the whole internet.`);
  if (prefix < LIMITS.ACL_MIN_PREFIX) {
    throw guard(`"${e}" is a /${prefix}, wider than /${LIMITS.ACL_MIN_PREFIX}. A tunnel exposes a client port on the public server; only the exact caller IPs (single /32 or at most a /30) may reach it.`);
  }
  const size = 2 ** (32 - prefix);
  if (net % size !== 0) throw guard(`"${e}" has host bits set; write the network address of the /${prefix}.`);
  return { net, prefix, text: `${parts[0]}/${prefix}` };
}

// ACL given on the command line (def add / def set-acl): "self", a comma list, or a mix.
// Returns an array of "self" | "a.b.c.d/nn".
export function normalizeAclSpec(spec) {
  const list = (spec === undefined || spec === null ? 'self' : String(spec)).split(',').map((s) => s.trim());
  if (list.every((s) => s === '')) {
    throw guard('the ACL is empty. RPort treats an empty ACL as "open to everyone"; use "self" or explicit IPs.');
  }
  if (list.length > LIMITS.ACL_MAX_ENTRIES) {
    throw guard(`the ACL has ${list.length} entries; at most ${LIMITS.ACL_MAX_ENTRIES} are allowed. Keep it to the machines that actually use the tunnel.`);
  }
  const outList = [];
  for (const s of list) {
    const v = s.toLowerCase() === 'self' ? 'self' : parseAclEntry(s).text;
    if (!outList.includes(v)) outList.push(v);
  }
  return outList;
}

// Replace "self" with the caller's public IP as a /32. Returns the comma string to store.
export function resolveAcl(entries, selfIp) {
  return entries
    .map((e) => {
      if (e !== 'self') return e;
      if (!selfIp) throw cfgErr('ACL "self" needs the caller IP from GET /me/ip.');
      if (String(selfIp).includes(':')) {
        throw guard(`your public IP as seen by the server is IPv6 (${selfIp}). RPort ACLs are IPv4-only; use an IPv4 path or an explicit IPv4 ACL.`);
      }
      return parseAclEntry(selfIp).text;
    })
    .join(',');
}

// The RPort web UI stores this placeholder in a stored tunnel's ACL; RPort replaces it with the
// caller's public IP when the tunnel starts. It is the server-side equivalent of "self".
export const CURRENT_IP_PLACEHOLDER = 'CURRENT-IP-ADDRESS';

// ACL read from a stored tunnel: validated strictly, never rewritten.
// A CURRENT-IP-ADDRESS entry is kept as { current: true } and bound at revive time (bindStoredAcl).
export function validateStoredAcl(str) {
  const parts = String(str ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) throw guard('the stored ACL is empty, which RPort treats as open to everyone. Fix it with `def set-acl` (operator approval).');
  if (parts.length > LIMITS.ACL_MAX_ENTRIES) throw guard(`the stored ACL has ${parts.length} entries; at most ${LIMITS.ACL_MAX_ENTRIES} are allowed. Fix it with \`def set-acl\` (operator approval).`);
  const entries = parts.map((p) => {
    if (p.toUpperCase() === CURRENT_IP_PLACEHOLDER) return { current: true, text: CURRENT_IP_PLACEHOLDER };
    if (p.toLowerCase() === 'self') throw guard('the stored ACL contains "self", which RPort cannot interpret. Fix it with `def set-acl <name> self` (operator approval).');
    return parseAclEntry(p);
  });
  return { entries, text: parts.join(',') };
}

// Replace CURRENT-IP-ADDRESS with the caller's public IP as a /32 (same rules as "self"):
// returns the concrete ACL that is sent to RPort and compared against live tunnels.
export function bindStoredAcl(acl, selfIp) {
  if (!acl.entries.some((e) => e.current)) return acl;
  const bound = resolveAcl(acl.entries.map((e) => (e.current ? 'self' : e.text)), selfIp);
  const texts = [...new Set(bound.split(','))];
  return { entries: texts.map(parseAclEntry), text: texts.join(',') };
}

function lenientAcl(str) {
  const parts = String(str || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  try {
    return parts.map(parseAclEntry);
  } catch {
    return null;
  }
}
export function aclCoversIp(entries, ip) {
  const n = parseIPv4(String(ip));
  if (n === null) return false;
  return entries.some((e) => Math.floor(n / 2 ** (32 - e.prefix)) === Math.floor(e.net / 2 ** (32 - e.prefix)));
}
const aclKey = (entries) => entries.map((e) => `${e.net}/${e.prefix}`).sort().join(',');
// A live tunnel's ACL equals the stored ACL (as sets; "1.2.3.4" == "1.2.3.4/32").
export function aclEquals(liveAcl, storedEntries) {
  const live = lenientAcl(liveAcl);
  return !!live && aclKey(live) === aclKey(storedEntries);
}

export function parseDuration(s) {
  const t = String(s ?? '').trim();
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t);
  if (!t || !m || (!m[1] && !m[2] && !m[3])) throw guard(`"${t}" is not a duration like 20m, 2h or 1h30m.`);
  return (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
}

export function validateAutoClose(v) {
  const text = v === undefined || v === null || v === '' ? LIMITS.AUTO_CLOSE_DEFAULT : String(v).trim();
  const seconds = parseDuration(text);
  if (seconds < LIMITS.AUTO_CLOSE_MIN_SECONDS) throw guard(`auto-close ${text} is below 1m. Every tunnel must auto-close; 0 would mean never.`);
  if (seconds > LIMITS.AUTO_CLOSE_MAX_SECONDS) throw guard(`auto-close ${text} is above the hard maximum of 12h. Tunnels are short-lived; revive again later instead.`);
  return { text, seconds };
}

export function validateIdle(v) {
  const x = v === undefined || v === null || v === '' ? LIMITS.IDLE_DEFAULT : v;
  if (!/^\d+$/.test(String(x))) throw guard(`idle timeout "${x}" must be a whole number of minutes.`);
  const n = Number(x);
  if (n < LIMITS.IDLE_MIN) throw guard('idle timeout 0 would disable idle closing. Every tunnel must close when unused.');
  if (n > LIMITS.IDLE_MAX) throw guard(`idle timeout ${n} min is above the maximum of ${LIMITS.IDLE_MAX}. Long idle timeouts are only for intermittent SSH use by agents (e.g. a fleet member); 120 is the cap.`);
  return n;
}

// remote: "22" or "host:port". One port only: no ranges, no lists (no port scanning).
export function parseRemote(s) {
  const t = String(s ?? '').trim();
  let host = '';
  let port;
  if (/^\d+$/.test(t)) port = t;
  else {
    if (t.startsWith('[') || (t.match(/:/g) || []).length > 1) throw guard(`remote "${t}" is IPv6; RPort tunnels here are IPv4 only.`);
    const i = t.lastIndexOf(':');
    if (i <= 0) throw guard(`remote "${t}" must be a port ("22") or host:port ("127.0.0.1:22").`);
    host = t.slice(0, i);
    port = t.slice(i + 1);
  }
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw guard(`remote "${t}" must name exactly one port 1-65535. Port ranges and lists are refused (no port scanning through tunnels).`);
  }
  const local = host === '' || LOCAL_HOSTS.has(host.toLowerCase());
  return { host: local ? '127.0.0.1' : host, port: Number(port), local, text: t };
}

export function computeHardExpiry(createdAtIso, autoCloseText) {
  return new Date(Date.parse(createdAtIso) + parseDuration(autoCloseText) * 1000).toISOString();
}

const isOn = (v) => v === true || v === 1 || v === '1' || v === 'true';
const isOff = (v) => v === false || v === 0 || v === '0' || v === 'false';
const pick = (o, ...keys) => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
  return undefined;
};

// further_options of a stored tunnel: a free JSON string (or object) the server stores but does
// not interpret. We read the create endpoint's query-param names and, for stored tunnels made in
// the RPort UI, the snake_case variants.
export function optionsFromStored(fo) {
  let o = fo;
  if (o === undefined || o === null || o === '') o = {};
  else if (typeof o === 'string') {
    try { o = JSON.parse(o); } catch { throw guard('further_options is not JSON. Fix the stored tunnel (operator approval).'); }
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw guard('further_options must be a JSON object.');
  if (isOn(pick(o, 'skip-idle-timeout', 'skip_idle_timeout'))) throw guard('further_options sets skip-idle-timeout, which is never allowed. Fix the stored tunnel (operator approval).');
  if (isOff(pick(o, 'check_port', 'check-port'))) throw guard('further_options disables check_port, which is never allowed. Fix the stored tunnel (operator approval).');
  const idle = validateIdle(pick(o, 'idle-timeout-minutes', 'idle_timeout_minutes'));
  const autoClose = validateAutoClose(pick(o, 'auto-close', 'auto_close'));
  const protocol = String(pick(o, 'protocol') || 'tcp');
  if (!PROTOCOLS.has(protocol)) throw guard(`protocol "${protocol}" must be tcp, udp or tcp+udp.`);
  return {
    idle, autoClose, protocol,
    httpProxy: isOn(pick(o, 'http_proxy', 'http-proxy')),
    authUser: pick(o, 'auth_user', 'auth-user'),
    hostHeader: pick(o, 'host_header', 'host-header'),
  };
}

// Validate a stored tunnel as a definition (at add time and again at revive time).
export function validateStored(st, { allowLanTarget = false } = {}) {
  if (!st || !st.name) throw cfgErr('stored tunnel has no name.');
  const ip = String(st.remote_ip ?? '').trim() || '127.0.0.1';
  const remote = parseRemote(`${ip}:${st.remote_port}`);
  if (!remote.local && !allowLanTarget) {
    throw guard(`remote ${ip}:${st.remote_port} reaches a host on the client's network beyond the client itself. That needs an explicit operator yes and --allow-lan-target.`);
  }
  if (st.scheme && !/^[a-z][a-z0-9+.-]{0,15}$/.test(st.scheme)) throw guard(`scheme "${st.scheme}" is not a short URI scheme such as ssh, rdp, http.`);
  const acl = validateStoredAcl(st.acl);
  const opts = optionsFromStored(st.further_options);
  if (opts.httpProxy) {
    if (!['http', 'https'].includes(st.scheme)) throw guard('http_proxy needs scheme http or https.');
    if (!opts.authUser) throw guard('http_proxy without auth_user/auth_password would put an unauthenticated web proxy on the public server.');
  }
  let publicPort = null;
  const pp = st.public_port;
  if (pp !== undefined && pp !== null && pp !== '' && Number(pp) !== 0) {
    if (!/^\d+$/.test(String(pp)) || Number(pp) > 65535) throw guard(`public_port "${pp}" is not a port.`);
    publicPort = Number(pp);
  }
  return { remote, remoteText: `${remote.host}:${remote.port}`, acl, opts, publicPort };
}

// ---------------------------------------------------------------------------
// Local state: ~/.config/rport-skill/{config.json, ledger.jsonl}
// config.json = { runner_member, servers: {moniker: {url, user, token_secret, runner_member?}}, links: [...] }
// Everything server-side (stored tunnels, links, ledger entries) is scoped by server moniker.
// ---------------------------------------------------------------------------
export function stateDir() {
  return process.env.RPORT_SKILL_HOME || path.join(os.homedir(), '.config', 'rport-skill');
}
const configPath = () => path.join(stateDir(), 'config.json');
const ledgerPath = () => path.join(stateDir(), 'ledger.jsonl');

function ensureStateDir() {
  const d = stateDir();
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(d, 0o700); } catch { /* not supported on this OS */ }
}

export function loadConfig() {
  const p = configPath();
  if (!fs.existsSync(p)) return { runner_member: null, servers: {}, links: [] };
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    throw cfgErr(`${p} is not valid JSON (${e.message}).`);
  }
  return { runner_member: cfg.runner_member || null, servers: cfg.servers || {}, links: Array.isArray(cfg.links) ? cfg.links : [] };
}

function saveConfig(cfg) {
  ensureStateDir();
  const p = configPath();
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ runner_member: cfg.runner_member || null, servers: cfg.servers, links: cfg.links }, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, p);
  try { fs.chmodSync(p, 0o600); } catch { /* not supported on this OS */ }
}

export function readLedger() {
  const p = ledgerPath();
  if (!fs.existsSync(p)) return [];
  const recs = [];
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { recs.push(JSON.parse(line)); } catch { /* skip a torn line */ }
  }
  const replaced = new Set(recs.map((r) => r.supersedes).filter(Boolean));
  return recs.map((r) => (replaced.has(r.rec_id) ? { ...r, superseded: true } : r));
}

function appendLedger(rec) {
  ensureStateDir();
  const p = ledgerPath();
  fs.appendFileSync(p, redact(JSON.stringify(rec)) + '\n', { mode: 0o600 });
  try { fs.chmodSync(p, 0o600); } catch { /* not supported on this OS */ }
}

const makeRecord = (fields) => ({ rec_id: crypto.randomUUID(), at: new Date().toISOString(), ...fields });
const sameDef = (r, server, clientId, name) => r.server === server && String(r.client_id) === String(clientId) && r.def === name;
function lastRecordFor(ledger, server, clientId, name) {
  for (let i = ledger.length - 1; i >= 0; i--) if (sameDef(ledger[i], server, clientId, name)) return ledger[i];
  return null;
}
const findLink = (cfg, server, clientId, name) => cfg.links.find((l) => sameDef({ ...l, def: l.name }, server, clientId, name)) || null;

// ---------------------------------------------------------------------------
// Server connection + HTTP
// ---------------------------------------------------------------------------
export function checkServerUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw cfgErr(`server url "${raw}" is not a valid URL.`); }
  if (u.username || u.password) throw cfgErr('server url must not contain credentials.');
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) {
    throw cfgErr(`server url must use https:// (plain http would send the API token in clear text); got ${u.protocol}//`);
  }
  let p = u.pathname.replace(/\/+$/, '');
  if (!p.endsWith('/api/v1')) p += '/api/v1';
  return { base: `${u.origin}${p}`, host: u.hostname };
}

// Like an ssh client with several hosts: --server <moniker> picks one. Without it, use "default"
// if it exists, else the only server; with several and no "default", refuse.
export function pickServer(cfg, moniker) {
  const names = Object.keys(cfg.servers);
  if (moniker) {
    if (!cfg.servers[moniker]) throw cfgErr(`unknown server "${moniker}". Configured: ${names.join(', ') || 'none'}.`);
    return moniker;
  }
  if (cfg.servers[DEFAULT_SERVER]) return DEFAULT_SERVER;
  if (names.length === 1) return names[0];
  if (!names.length) throw cfgErr('no server configured. Run: server add --url https://<server> --user <user>');
  throw cfgErr(`several servers configured and none is "${DEFAULT_SERVER}"; pick one: ${names.join(', ')} (--server <moniker>).`);
}

const runnerFor = (cfg, moniker) => (cfg.servers[moniker] && cfg.servers[moniker].runner_member) || cfg.runner_member || null;

function connFor(cfg, moniker) {
  const n = pickServer(cfg, moniker);
  const s = cfg.servers[n];
  if (!s.user) throw cfgErr(`server "${n}" has no user.`);
  const u = checkServerUrl(s.url);
  return { name: n, user: s.user, base: u.base, host: u.host, token_secret: s.token_secret || DEFAULT_TOKEN_SECRET };
}

function readToken(conn) {
  const t = process.env.RPORT_TOKEN;
  if (!t) {
    throw cfgErr(`RPORT_TOKEN is not set. Run this script through mcp__apra-fleet__execute_command on the runner member with RPORT_TOKEN={{secret.${conn.token_secret}}} (bare: apra-fleet substitutes it already quoted) in the same command.`);
  }
  if (/\{\{\s*secret\./.test(t)) {
    throw cfgErr(`RPORT_TOKEN still holds an unsubstituted {{secret.…}} placeholder. Check the secret name (${conn.token_secret}), that its "members" scope includes this runner member, and that its network_policy is allow or confirm.`);
  }
  addSecret(t);
  return t;
}

function displayUrl(url) {
  const u = new URL(url);
  if (u.searchParams.has('auth_password')) u.searchParams.set('auth_password', '[REDACTED]');
  return decodeURIComponent(u.toString());
}

// No ad-hoc execution: the only execution endpoint ever written to is POST /clients/{id}/scripts,
// and only cmdScriptsRun calls it, with the text of a library script. Every request passes here.
export function assertAllowedRequest(method, p) {
  const route = String(p).split('?')[0];
  if (/(^|\/)ws(\/|$)/.test(route)) throw guard(`${route}: websocket endpoints are never used (no interactive/ad-hoc execution).`);
  if (String(method).toUpperCase() === 'GET') return;
  if (!/\/(commands|scripts)(\/|$)/.test(route)) return;
  if (/^\/library\/scripts(\/[^/]+)?$/.test(route)) return; // script library admin
  if (String(method).toUpperCase() === 'POST' && /^\/clients\/[^/]+\/scripts$/.test(route)) return; // one library script, one client
  throw guard(`${method} ${route}: ad-hoc commands, multi-client runs and group runs are never sent. Only a script from the server's library runs, on one client (scripts run).`);
}

async function api(ctx, conn, method, p, { query, body, write = false, hint404 } = {}) {
  assertAllowedRequest(method, p);
  const url = new URL(conn.base + p);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  const shown = displayUrl(url);
  if (write && ctx.dryRun) {
    const plan = { method, url: shown, headers: { Authorization: 'Basic [REDACTED]' } };
    if (body !== undefined) plan.body = body;
    ctx.plans.push(plan);
    return { status: 0, dryRun: true, data: null };
  }
  const token = readToken(conn);
  const basic = Buffer.from(`${conn.user}:${token}`).toString('base64');
  addSecret(basic);
  const headers = { Authorization: `Basic ${basic}`, Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (ctx.debug) errOut(`DEBUG > ${method} ${shown}  Authorization: Basic [REDACTED]${body !== undefined ? '  body: ' + JSON.stringify(body) : ''}`);
  let res;
  try {
    res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
  } catch (e) {
    throw new CliError(EXIT.API, `API: ${method} ${shown} failed: ${(e.cause && e.cause.code) || e.message}`);
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (ctx.debug) errOut(`DEBUG < ${res.status}`);
  if (!res.ok) {
    const e0 = (json && Array.isArray(json.errors) && json.errors[0]) || {};
    const detail = [e0.title, e0.detail].filter(Boolean).join(': ') || text.slice(0, 200);
    throw new ApiError(res.status, e0.code, detail, `${method} ${new URL(shown).pathname}`, res.status === 404 ? hint404 : undefined);
  }
  return { status: res.status, data: json && Object.prototype.hasOwnProperty.call(json, 'data') ? json.data : json };
}

async function getSelfIp(ctx, conn) {
  const r = await api(ctx, conn, 'GET', '/me/ip');
  const ip = r.data && r.data.ip;
  if (!ip) throw new CliError(EXIT.API, 'API: GET /me/ip returned no ip.');
  return ip;
}

async function resolveClient(ctx, conn, ref) {
  if (!ref) throw usage('--client <id|name> is required');
  const r = await api(ctx, conn, 'GET', '/clients', { query: { 'filter[name]': ref } });
  const list = Array.isArray(r.data) ? r.data : [];
  const exact = list.filter((c) => c.name === ref);
  if (exact.length === 1) return String(exact[0].id);
  if (exact.length > 1) throw cfgErr(`client name "${ref}" matches ${exact.length} clients; use the client id.`);
  return String(ref); // not a name: treat as a client id
}

async function clientState(ctx, conn, id) {
  try {
    const r = await api(ctx, conn, 'GET', `/clients/${encodeURIComponent(id)}`);
    const st = r.data && r.data.connection_state;
    return st === 'disconnected' ? 'disconnected' : 'connected';
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return 'disconnected';
    throw e;
  }
}

async function liveTunnels(ctx, conn) {
  const r = await api(ctx, conn, 'GET', '/tunnels');
  return Array.isArray(r.data) ? r.data : [];
}

const storedPath = (clientId) => `/clients/${encodeURIComponent(clientId)}/stored-tunnels`;

async function listStored(ctx, conn, clientId, name) {
  const query = { 'page[limit]': 100 };
  if (name) query['filter[name]'] = name;
  const r = await api(ctx, conn, 'GET', storedPath(clientId), { query });
  const list = Array.isArray(r.data) ? r.data : [];
  return name ? list.filter((s) => s.name === name) : list;
}

async function getStored(ctx, conn, clientId, name) {
  const list = await listStored(ctx, conn, clientId, name);
  if (!list.length) throw cfgErr(`client ${clientId} has no stored tunnel named "${name}". See: def list --client <client>`);
  if (list.length > 1) throw cfgErr(`client ${clientId} has ${list.length} stored tunnels named "${name}"; rename them in RPort first.`);
  return list[0];
}

const sameTunnel = (t, rec) => String(t.client_id) === String(rec.client_id) && String(t.id) === String(rec.tunnel_id) && String(t.lport) === String(rec.lport);

function matchesRemote(t, remote) {
  if (String(t.rport) !== String(remote.port)) return false;
  const h = String(t.rhost || '').toLowerCase();
  const tLocal = h === '' || LOCAL_HOSTS.has(h);
  return remote.local ? tLocal : h === remote.host.toLowerCase();
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
function fmtLeft(ms) {
  if (ms <= 0) return '0m';
  const m = Math.floor(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}
function fmtTime(iso) {
  if (!iso) return 'unknown';
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `${iso} (runner local: ${new Date(iso).toLocaleString()} ${tz})`;
}
function printPlans(ctx) {
  for (const p of ctx.plans) out(`DRY-RUN would call: ${p.method} ${p.url}  Authorization: Basic [REDACTED]${p.body ? '  body: ' + JSON.stringify(p.body) : ''}`);
}
function verdict(st) {
  try {
    const v = validateStored(st, { allowLanTarget: true });
    return v.remote.local ? 'ok' : 'ok (LAN target: revive needs --allow-lan-target)';
  } catch (e) {
    return `UNSAFE: ${e.message.replace(/^REFUSED \(guardrail\): /, '')}`;
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
async function cmdIp(ctx, a) {
  const conn = connFor(ctx.cfg, a.f.server);
  const ip = await getSelfIp(ctx, conn);
  if (ctx.json) out(JSON.stringify({ ip }));
  else out(`public IP as seen by ${conn.host}: ${ip}`);
}

async function cmdWhoami(ctx, a) {
  const conn = connFor(ctx.cfg, a.f.server);
  const r = await api(ctx, conn, 'GET', '/me');
  const d = r.data || {};
  const info = { server: conn.name, username: d.username, name: d.name, groups: d.groups };
  if (ctx.json) out(JSON.stringify(info));
  else out(`server ${conn.name}: user ${d.username || '?'}${d.name ? ' (' + d.name + ')' : ''}${Array.isArray(d.groups) ? ', groups: ' + d.groups.join(', ') : ''}`);
}

async function cmdClients(ctx, a) {
  const conn = connFor(ctx.cfg, a.f.server);
  const r = await api(ctx, conn, 'GET', '/clients', { query: a.f.name ? { 'filter[name]': a.f.name } : undefined });
  const list = (Array.isArray(r.data) ? r.data : []).map((c) => ({ id: c.id, name: c.name, connection_state: c.connection_state }));
  if (ctx.json) return out(JSON.stringify(list));
  if (!list.length) return out('no clients matched');
  for (const c of list) out(`${c.id}  ${c.name || ''}  ${c.connection_state || ''}`);
}

async function cmdTunnels(ctx, a) {
  const conn = connFor(ctx.cfg, a.f.server);
  let live = await liveTunnels(ctx, conn);
  if (a.f.client) {
    const id = await resolveClient(ctx, conn, a.f.client);
    live = live.filter((t) => String(t.client_id) === id);
  }
  const ledger = readLedger();
  const now = Date.now();
  const rows = live.map((t) => {
    const rec = [...ledger].reverse().find((r) => r.server === conn.name && r.action !== 'close' && sameTunnel(t, r));
    return {
      tunnel_id: t.id, client_id: t.client_id, host: conn.host, port: Number(t.lport), remote: `${t.rhost || ''}:${t.rport}`,
      scheme: t.scheme || null, acl: t.acl || '', def: rec ? rec.def : null,
      hard_expires_at: rec ? rec.hard_expires_at : null,
      minutes_left: rec && rec.hard_expires_at ? Math.floor((Date.parse(rec.hard_expires_at) - now) / 60000) : null,
      idle_timeout_minutes: rec ? rec.idle_timeout_minutes : (t.idle_timeout_minutes ?? null),
    };
  });
  if (ctx.json) return out(JSON.stringify(rows));
  if (!rows.length) return out('no live tunnels');
  for (const r of rows) {
    out(`${r.tunnel_id}@${r.client_id}  ${r.host}:${r.port} -> ${r.remote}  acl=${r.acl || '(OPEN TO EVERYONE)'}  ${r.def ? 'def=' + r.def + '  expires ' + fmtTime(r.hard_expires_at) + '  left ' + fmtLeft(Date.parse(r.hard_expires_at) - now) : 'untracked (not created by this skill; expiry unknown)'}`);
  }
}

function serverRow(cfg, name) {
  const s = cfg.servers[name];
  return { moniker: name, url: s.url, user: s.user, token_secret: s.token_secret || DEFAULT_TOKEN_SECRET, runner_member: runnerFor(cfg, name), runner_override: !!s.runner_member };
}

function cmdServer(ctx, a) {
  const sub = a._[1];
  const cfg = ctx.cfg;
  if (sub === 'list' || !sub) {
    const rows = Object.keys(cfg.servers).map((n) => serverRow(cfg, n));
    if (ctx.json) return out(JSON.stringify(rows));
    if (!rows.length) return out('no servers configured');
    for (const r of rows) out(`${r.moniker}  ${r.url}  user=${r.user}  secret=${r.token_secret}  runner=${r.runner_member || '-'}${r.runner_override ? ' (server override)' : ''}`);
    return;
  }
  if (sub === 'show') {
    const r = serverRow(cfg, pickServer(cfg, a._[2] || a.f.server));
    return out(JSON.stringify(r, null, ctx.json ? 0 : 2));
  }
  const name = a._[2] || (sub === 'add' ? DEFAULT_SERVER : undefined);
  if (!name) throw usage(`server ${sub} needs a moniker`);
  if (!MONIKER_RE.test(name)) throw usage(`server moniker "${name}" may use letters, digits, . _ - only`);
  if (sub === 'add') {
    if (!a.f.url || !a.f.user) throw usage('server add [<moniker>] needs --url and --user');
    checkServerUrl(a.f.url);
    if (cfg.servers[name] && !a.f.replace) throw cfgErr(`server "${name}" exists; pass --replace to overwrite.`);
    const s = { url: a.f.url, user: a.f.user, token_secret: a.f['token-secret'] || DEFAULT_TOKEN_SECRET };
    if (a.f['runner-member']) s.runner_member = a.f['runner-member'];
    if (ctx.dryRun) return out(`DRY-RUN would save server ${name}: ${JSON.stringify(s)}`);
    cfg.servers[name] = s;
    saveConfig(cfg);
    return out(`saved server ${name}`);
  }
  if (sub === 'remove') {
    if (!cfg.servers[name]) throw cfgErr(`unknown server "${name}".`);
    const users = cfg.links.filter((l) => l.server === name).map((l) => l.name);
    if (users.length) throw cfgErr(`server "${name}" still has links: ${users.join(', ')}.`);
    if (ctx.dryRun) return out(`DRY-RUN would remove server ${name}`);
    delete cfg.servers[name];
    saveConfig(cfg);
    return out(`removed server ${name}`);
  }
  throw usage(`unknown server subcommand "${sub}"`);
}

// runner = the local apra-fleet member that runs this script (global; per-server override via server add --runner-member).
function cmdRunner(ctx, a) {
  const sub = a._[1] || 'show';
  const cfg = ctx.cfg;
  if (sub === 'show') {
    const info = { runner_member: cfg.runner_member, per_server: Object.fromEntries(Object.keys(cfg.servers).map((n) => [n, runnerFor(cfg, n)])) };
    return out(ctx.json ? JSON.stringify(info) : `runner_member: ${cfg.runner_member || '(not set)'}${Object.keys(info.per_server).length ? '\n' + Object.entries(info.per_server).map(([n, m]) => `  ${n}: ${m || '(not set)'}`).join('\n') : ''}`);
  }
  if (sub === 'set') {
    const m = a._[2];
    if (!m) throw usage('runner set <member>');
    if (ctx.dryRun) return out(`DRY-RUN would set runner_member to ${m}`);
    cfg.runner_member = m;
    saveConfig(cfg);
    return out(`runner_member set to ${m}`);
  }
  if (sub === 'clear') {
    if (ctx.dryRun) return out('DRY-RUN would clear runner_member');
    cfg.runner_member = null;
    saveConfig(cfg);
    return out('runner_member cleared');
  }
  throw usage(`unknown runner subcommand "${sub}"`);
}

// def = RPort stored tunnel on the server. add / set-acl / remove are admin changes.
async function cmdDef(ctx, a) {
  const sub = a._[1] || 'list';
  const conn = connFor(ctx.cfg, a.f.server);
  const clientId = await resolveClient(ctx, conn, a.f.client);
  if (sub === 'list') {
    const list = await listStored(ctx, conn, clientId);
    const rows = list.map((s) => ({ ...s, check: verdict(s) }));
    if (ctx.json) return out(JSON.stringify(rows));
    if (!rows.length) return out(`client ${clientId} has no stored tunnels`);
    for (const s of rows) out(`${s.name}  id=${s.id}  ${s.remote_ip || '127.0.0.1'}:${s.remote_port}  public_port=${s.public_port || 'random'}  scheme=${s.scheme || '-'}  acl=${s.acl || '(OPEN TO EVERYONE)'}  options=${typeof s.further_options === 'string' ? s.further_options : JSON.stringify(s.further_options || {})}  [${s.check}]`);
    return;
  }
  const name = a._[2];
  if (!name) throw usage(`def ${sub} needs a stored tunnel name`);
  if (sub === 'show') {
    const s = await getStored(ctx, conn, clientId, name);
    let options = null;
    try {
      const o = optionsFromStored(s.further_options);
      options = { 'idle-timeout-minutes': o.idle, 'auto-close': o.autoClose.text, protocol: o.protocol };
    } catch { /* reported in check */ }
    const link = findLink(ctx.cfg, conn.name, clientId, name);
    const row = { ...s, client_id: clientId, effective_options: options, fleet_member: link ? link.fleet_member : null, check: verdict(s) };
    return out(JSON.stringify(row, null, ctx.json ? 0 : 2));
  }
  if (sub === 'add') {
    if (a.f.remote === undefined) throw usage('def add needs --remote <port|host:port>');
    const allowLanTarget = !!a.f['allow-lan-target'];
    const remote = parseRemote(a.f.remote);
    const fo = {
      'idle-timeout-minutes': validateIdle(a.f.idle),
      'auto-close': validateAutoClose(a.f['auto-close']).text,
      protocol: a.f.protocol || 'tcp',
    };
    if (a.f['http-proxy']) {
      fo.http_proxy = true;
      if (a.f['auth-user']) fo.auth_user = a.f['auth-user'];
      if (a.f['host-header']) fo.host_header = a.f['host-header'];
    }
    const aclSpec = normalizeAclSpec(a.f.acl);
    const draft = { name, scheme: a.f.scheme || '', remote_ip: remote.host, remote_port: remote.port, acl: '', further_options: JSON.stringify(fo) };
    if (a.f['public-port'] !== undefined) draft.public_port = Number(a.f['public-port']);
    // Validate everything except the ACL before asking the server anything.
    validateStored({ ...draft, acl: '192.0.2.1/32' }, { allowLanTarget });
    const selfIp = aclSpec.includes('self') ? await getSelfIp(ctx, conn) : null;
    draft.acl = resolveAcl(aclSpec, selfIp);
    validateStored(draft, { allowLanTarget });
    if ((await listStored(ctx, conn, clientId, name)).length) throw cfgErr(`client ${clientId} already has a stored tunnel "${name}". Use def set-acl, or def remove first.`);
    const r = await api(ctx, conn, 'POST', storedPath(clientId), { body: draft, write: true });
    if (ctx.dryRun) { out(`DRY-RUN (${ADMIN_NOTE})`); return printPlans(ctx); }
    const saved = r.data || {};
    if (ctx.json) return out(JSON.stringify(saved));
    return out(`created stored tunnel ${name} (id ${saved.id}) on client ${clientId}: ${draft.remote_ip}:${draft.remote_port} acl=${draft.acl} options=${draft.further_options} [${ADMIN_NOTE}]`);
  }
  if (sub === 'set-acl') {
    const spec = a._[3];
    if (spec === undefined) throw usage('def set-acl <name> self|<ip>[,<ip>...] --client X');
    const aclSpec = normalizeAclSpec(spec);
    const s = await getStored(ctx, conn, clientId, name);
    const selfIp = aclSpec.includes('self') ? await getSelfIp(ctx, conn) : null;
    const acl = resolveAcl(aclSpec, selfIp);
    validateStoredAcl(acl);
    // Partial updates are not supported: send every field back.
    const body = { name: s.name, scheme: s.scheme, remote_ip: s.remote_ip, remote_port: s.remote_port, acl, further_options: s.further_options };
    if (s.public_port !== undefined && s.public_port !== null) body.public_port = s.public_port;
    await api(ctx, conn, 'PUT', `${storedPath(clientId)}/${encodeURIComponent(s.id)}`, { body, write: true });
    if (ctx.dryRun) { out(`DRY-RUN (${ADMIN_NOTE})`); return printPlans(ctx); }
    if (ctx.json) return out(JSON.stringify({ name, id: s.id, client_id: clientId, previous_acl: s.acl || '', acl }));
    return out(`stored tunnel ${name}: acl ${s.acl || '(empty)'} -> ${acl} [${ADMIN_NOTE}]. A live tunnel keeps its old ACL; revive creates the next one with the new ACL.`);
  }
  if (sub === 'set-options') {
    // Make a stored tunnel's further_options safe: drop forbidden keys (skip-idle-timeout, check_port
    // off), set the idle timeout / auto-close / protocol given (or keep the stored ones, defaulting
    // the idle timeout), keep every other key the RPort UI stored there.
    const s = await getStored(ctx, conn, clientId, name);
    let fo = s.further_options;
    const wasString = typeof fo === 'string';
    if (fo === undefined || fo === null || fo === '') fo = {};
    else if (wasString) {
      try { fo = JSON.parse(fo); } catch { throw guard('further_options is not JSON; remove and re-add the stored tunnel instead.'); }
    }
    if (!fo || typeof fo !== 'object' || Array.isArray(fo)) throw guard('further_options must be a JSON object; remove and re-add the stored tunnel instead.');
    const next = { ...fo };
    const dropped = ['skip-idle-timeout', 'skip_idle_timeout'].filter((k) => k in next);
    for (const k of ['check_port', 'check-port']) if (k in next && isOff(next[k])) dropped.push(k);
    for (const k of dropped) delete next[k];
    const idle = validateIdle(a.f.idle ?? pick(fo, 'idle-timeout-minutes', 'idle_timeout_minutes'));
    const autoClose = validateAutoClose(a.f['auto-close'] ?? pick(fo, 'auto-close', 'auto_close')).text;
    const protocol = String(a.f.protocol ?? pick(fo, 'protocol') ?? 'tcp');
    for (const k of ['idle_timeout_minutes', 'auto_close']) delete next[k];
    Object.assign(next, { 'idle-timeout-minutes': idle, 'auto-close': autoClose, protocol });
    const further = wasString ? JSON.stringify(next) : next;
    const body = { name: s.name, scheme: s.scheme, remote_ip: s.remote_ip, remote_port: s.remote_port, acl: s.acl, further_options: further };
    if (s.public_port !== undefined && s.public_port !== null) body.public_port = s.public_port;
    validateStored({ ...body, id: s.id }, { allowLanTarget: true }); // the result must pass the guardrails
    await api(ctx, conn, 'PUT', `${storedPath(clientId)}/${encodeURIComponent(s.id)}`, { body, write: true });
    if (ctx.dryRun) { out(`DRY-RUN (${ADMIN_NOTE})`); return printPlans(ctx); }
    const shown = JSON.stringify(next);
    if (ctx.json) return out(JSON.stringify({ name, id: s.id, client_id: clientId, previous_options: s.further_options ?? null, options: next, dropped }));
    return out(`stored tunnel ${name}: options ${typeof s.further_options === 'string' ? s.further_options : JSON.stringify(s.further_options ?? {})} -> ${shown}${dropped.length ? ` (removed ${dropped.join(', ')})` : ''} [${ADMIN_NOTE}]. A live tunnel keeps its old options; revive creates the next one with these.`);
  }
  if (sub === 'remove') {
    const s = await getStored(ctx, conn, clientId, name);
    await api(ctx, conn, 'DELETE', `${storedPath(clientId)}/${encodeURIComponent(s.id)}`, { write: true });
    if (ctx.dryRun) { out(`DRY-RUN (${ADMIN_NOTE})`); return printPlans(ctx); }
    return out(`removed stored tunnel ${name} (id ${s.id}) [${ADMIN_NOTE}]. Live tunnels stay open until close or expiry; remove a link with: link remove.`);
  }
  throw usage(`unknown def subcommand "${sub}"`);
}

// link = local, fleet-specific: (server, client, stored tunnel name) -> apra-fleet member.
async function cmdLink(ctx, a) {
  const sub = a._[1] || 'list';
  const cfg = ctx.cfg;
  if (sub === 'list') {
    if (ctx.json) return out(JSON.stringify(cfg.links));
    if (!cfg.links.length) return out('no links');
    for (const l of cfg.links) out(`${l.name}  server=${l.server}  client=${l.client_id}${l.client && l.client !== l.client_id ? ' (' + l.client + ')' : ''}  fleet_member=${l.fleet_member}`);
    return;
  }
  const name = a._[2];
  if (!name) throw usage(`link ${sub} needs a stored tunnel name`);
  const conn = connFor(cfg, a.f.server);
  const clientId = await resolveClient(ctx, conn, a.f.client);
  const existing = findLink(cfg, conn.name, clientId, name);
  if (sub === 'add') {
    if (!a.f['fleet-member']) throw usage('link add needs --fleet-member <member>');
    await getStored(ctx, conn, clientId, name); // the stored tunnel must exist
    const link = { server: conn.name, client_id: clientId, client: a.f.client, name, fleet_member: a.f['fleet-member'] };
    if (ctx.dryRun) return out(`DRY-RUN would save link: ${JSON.stringify(link)}`);
    cfg.links = cfg.links.filter((l) => l !== existing).concat([link]);
    saveConfig(cfg);
    return out(`linked ${name} on client ${clientId} to fleet member ${link.fleet_member}`);
  }
  if (sub === 'remove') {
    if (!existing) throw cfgErr(`no link for ${name} on client ${clientId}.`);
    if (ctx.dryRun) return out(`DRY-RUN would remove link ${name} -> ${existing.fleet_member}`);
    cfg.links = cfg.links.filter((l) => l !== existing);
    saveConfig(cfg);
    return out(`removed link ${name} -> ${existing.fleet_member}`);
  }
  throw usage(`unknown link subcommand "${sub}"`);
}

async function cmdRevive(ctx, a) {
  if (a._.length !== 2) throw guard('revive takes exactly one stored tunnel name: one create per request, no loops.');
  const name = a._[1];
  const conn = connFor(ctx.cfg, a.f.server);
  const clientId = await resolveClient(ctx, conn, a.f.client);
  const st = await getStored(ctx, conn, clientId, name);
  const v = validateStored(st, { allowLanTarget: !!a.f['allow-lan-target'] });

  const selfIp = await getSelfIp(ctx, conn);
  v.acl = bindStoredAcl(v.acl, selfIp); // CURRENT-IP-ADDRESS -> this caller's IP /32
  if (!aclCoversIp(v.acl.entries, selfIp)) {
    throw guard(`your IP changed from ${v.acl.text} to ${selfIp}; run \`def set-acl ${name} self --client ${a.f.client}\` (operator approval) and revive again.`);
  }

  let proxyPassword;
  if (v.opts.httpProxy) {
    proxyPassword = process.env.RPORT_PROXY_PASSWORD;
    if (!proxyPassword) throw guard('http_proxy needs auth_password: pass it as RPORT_PROXY_PASSWORD from a fleet secret.');
    addSecret(proxyPassword);
  }

  const ledger = readLedger();
  const link = findLink(ctx.cfg, conn.name, clientId, name);
  const live = await liveTunnels(ctx, conn);
  const prev = lastRecordFor(ledger, conn.name, clientId, name);
  const tracked = prev && prev.action !== 'close' ? live.find((t) => sameTunnel(t, prev)) : null;
  const fits = (t) => String(t.client_id) === clientId && matchesRemote(t, v.remote) && (t.protocol || 'tcp') === v.opts.protocol
    && aclEquals(t.acl, v.acl.entries) && (v.publicPort === null || Number(t.lport) === v.publicPort);
  const notes = [];

  let action;
  let t;
  let createdAt;
  let hard;
  if (tracked && fits(tracked)) {
    action = 'reuse';
    t = tracked;
    createdAt = prev.created_at;
    hard = prev.hard_expires_at;
  } else {
    if (tracked) notes.push(`note: previous tunnel ${tracked.id} no longer matches the stored tunnel (ACL or remote changed); it stays open until it expires or you close it (close --tunnel ${tracked.id}).`);
    const since = Date.now() - LIMITS.CREATE_LOOP_WINDOW_MINUTES * 60000;
    const recent = ledger.filter((r) => sameDef(r, conn.name, clientId, name) && r.action === 'create' && Date.parse(r.at) >= since).length;
    if (recent >= LIMITS.CREATE_LOOP_MAX) {
      throw guard(`${recent} tunnels were already created for ${name} in the last ${LIMITS.CREATE_LOOP_WINDOW_MINUTES} minutes. That looks like a create loop; stop and find out why the tunnels die (status, troubleshooting).`);
    }
    action = 'create';
    const query = {
      remote: v.remoteText,
      local: v.publicPort === null ? undefined : v.publicPort, // only when the stored tunnel pins it
      scheme: st.scheme,
      protocol: v.opts.protocol,
      acl: v.acl.text, // exactly the stored ACL
      check_port: '1',
      'idle-timeout-minutes': v.opts.idle,
      'auto-close': v.opts.autoClose.text,
    };
    if (v.opts.httpProxy) Object.assign(query, { http_proxy: 'true', host_header: v.opts.hostHeader, auth_user: v.opts.authUser, auth_password: proxyPassword });
    createdAt = new Date().toISOString(); // request time: conservative start of the auto-close clock
    hard = computeHardExpiry(createdAt, v.opts.autoClose.text);
    const r = await api(ctx, conn, 'PUT', `/clients/${encodeURIComponent(clientId)}/tunnels`, {
      query, write: true,
      hint404: `client ${a.f.client} is disconnected (or does not exist). Check it with: clients --name <name>.`,
    });
    t = r.dryRun ? null : (r.data && r.data.tunnel) || r.data; // older servers wrap the tunnel in {success, tunnel}
  }

  if (ctx.dryRun) {
    printPlans(ctx);
    out(`PLAN ${JSON.stringify({ name, action, client_id: clientId, stored_tunnel_id: st.id, acl: v.acl.text, idle_timeout_minutes: v.opts.idle, auto_close: v.opts.autoClose.text, local: v.publicPort, tunnel_id: t ? t.id : null })}`);
    for (const n of notes) out(n);
    return;
  }
  if (!t || t.lport === undefined) throw new CliError(EXIT.API, 'API: the create reply had no tunnel data.');

  const fleetMember = link ? link.fleet_member : null;
  const prevPort = prev && prev.lport !== undefined ? Number(prev.lport) : null;
  const rec = makeRecord({
    def: name, server: conn.name, action, stored_tunnel_id: String(st.id), tunnel_id: String(t.id), client_id: clientId, host: conn.host,
    lport: String(t.lport), acl: v.acl.text, created_at: createdAt || null,
    auto_close: action === 'create' ? v.opts.autoClose.text : (prev && prev.auto_close) || null,
    hard_expires_at: hard || null,
    idle_timeout_minutes: action === 'create' ? v.opts.idle : (prev && prev.idle_timeout_minutes) ?? v.opts.idle,
    fleet_member: fleetMember,
  });
  if (prev && prev.action !== 'close') rec.supersedes = prev.rec_id;
  appendLedger(rec);

  const result = {
    name, server: conn.name, host: conn.host, port: Number(t.lport), expires_at: rec.hard_expires_at,
    reused: action === 'reuse', action, tunnel_id: String(t.id), client_id: clientId, stored_tunnel_id: String(st.id),
    acl: v.acl.text, idle_timeout_minutes: rec.idle_timeout_minutes, fleet_member: fleetMember,
    previous_port: prevPort, port_changed: prevPort !== null && prevPort !== Number(t.lport),
  };
  if (t.tunnel_url) result.tunnel_url = t.tunnel_url;
  if (!ctx.json) {
    out(`${action === 'create' ? 'created' : 'reused'} tunnel ${t.id} on client ${clientId} from stored tunnel ${name}: ${conn.host}:${t.lport} -> ${v.remoteText}${st.scheme ? ' (' + st.scheme + ')' : ''}`);
    out(`ACL: ${v.acl.text}`);
    out(`hard expiry: ${fmtTime(rec.hard_expires_at)}`);
    out(`idle: closes after ${rec.idle_timeout_minutes} minutes without traffic (soft; may close before the hard expiry)`);
    if (fleetMember && (result.port_changed || prevPort === null)) out(`fleet member ${fleetMember}: point it at ${conn.host}:${t.lport} (update_member)`);
    for (const n of notes) out(n);
  }
  out(`RESULT ${JSON.stringify(result)}`);
}

async function cmdStatus(ctx, a) {
  const ledger = readLedger();
  const targets = [];
  const seen = new Set();
  const addTarget = (server, clientId, name) => {
    const k = `${server}|${clientId}|${name}`;
    if (!seen.has(k)) { seen.add(k); targets.push({ server, clientId: String(clientId), name }); }
  };
  if (a._[1]) {
    const conn = connFor(ctx.cfg, a.f.server);
    addTarget(conn.name, await resolveClient(ctx, conn, a.f.client), a._[1]);
  } else {
    for (const l of ctx.cfg.links) addTarget(l.server, l.client_id, l.name);
    for (const r of ledger) if (r.server && r.client_id && r.def) addTarget(r.server, r.client_id, r.def);
  }
  const now = Date.now();
  const liveBy = new Map();
  const rows = [];
  for (const tg of targets) {
    const conn = connFor(ctx.cfg, tg.server);
    if (!liveBy.has(conn.name)) liveBy.set(conn.name, await liveTunnels(ctx, conn));
    const live = liveBy.get(conn.name);
    const rec = lastRecordFor(ledger, conn.name, tg.clientId, tg.name);
    const link = findLink(ctx.cfg, conn.name, tg.clientId, tg.name);
    const row = { def: tg.name, server: conn.name, client_id: tg.clientId, state: 'none', host: conn.host, port: null, tunnel_id: null, hard_expires_at: null, minutes_left: null, idle_timeout_minutes: null, warning: null, fleet_member: link ? link.fleet_member : null };
    if (rec) Object.assign(row, { port: Number(rec.lport), tunnel_id: rec.tunnel_id, hard_expires_at: rec.hard_expires_at || null, idle_timeout_minutes: rec.idle_timeout_minutes ?? null });
    if (!rec) row.state = 'none';
    else if (rec.action === 'close') row.state = 'closed';
    else if (live.some((t) => sameTunnel(t, rec))) row.state = 'alive';
    else if (rec.hard_expires_at && now >= Date.parse(rec.hard_expires_at)) row.state = 'expired';
    else row.state = (await clientState(ctx, conn, tg.clientId)) === 'disconnected' ? 'client-offline' : 'closed-idle';
    if (row.state === 'alive' && rec.hard_expires_at) {
      const left = Date.parse(rec.hard_expires_at) - now;
      row.minutes_left = Math.max(0, Math.floor(left / 60000));
      if (left < LIMITS.WARN_MINUTES * 60000) row.warning = `less than ${LIMITS.WARN_MINUTES} min to hard expiry`;
    }
    rows.push(row);
  }
  if (ctx.json) return out(JSON.stringify(rows));
  if (!rows.length) return out('nothing to report: no links and no ledger entries (pass <name> --client X)');
  const explain = {
    expired: 'gone: hard expiry (auto-close) passed; revive to get a new tunnel',
    'closed-idle': 'gone before hard expiry: closed after idle timeout (or closed outside this skill); revive',
    'client-offline': 'gone: the client is disconnected; nothing to revive until it reconnects',
    closed: 'closed by this skill',
    none: 'no live tunnel created by this skill yet; revive',
  };
  for (const r of rows) {
    let line = `${r.def}@${r.client_id}  ${r.state}`;
    if (r.state === 'alive') line += `  ${r.host}:${r.port}  hard expiry ${fmtTime(r.hard_expires_at)}  left ${r.minutes_left === null ? 'unknown' : fmtLeft(r.minutes_left * 60000 + 1)}  idle-timeout ${r.idle_timeout_minutes}m (soft: closes after that many idle minutes)`;
    else line += `  (${explain[r.state]})`;
    out(line);
    if (r.warning) out(`WARNING ${r.def}: ${r.warning}`);
  }
}

async function cmdClose(ctx, a) {
  const force = !!a.f.force;
  const conn = connFor(ctx.cfg, a.f.server);
  const ledger = readLedger();
  let clientId;
  let tunnelId;
  let prev = null;
  if (a.f.tunnel) {
    const live = await liveTunnels(ctx, conn);
    let matches = live.filter((t) => String(t.id) === String(a.f.tunnel));
    if (a.f.client) {
      const cid = await resolveClient(ctx, conn, a.f.client);
      matches = matches.filter((t) => String(t.client_id) === cid);
    }
    if (!matches.length) throw cfgErr(`no live tunnel ${a.f.tunnel}${a.f.client ? ' on client ' + a.f.client : ''}.`);
    if (matches.length > 1) throw usage(`tunnel id ${a.f.tunnel} exists on several clients; add --client`);
    clientId = String(matches[0].client_id);
    tunnelId = String(matches[0].id);
    prev = [...ledger].reverse().find((r) => r.server === conn.name && r.action !== 'close' && sameTunnel(matches[0], r)) || null;
    if (prev && lastRecordFor(ledger, conn.name, clientId, prev.def) !== prev) prev = null;
  } else {
    const name = a._[1];
    if (!name) throw usage('close <name> --client X, or close --tunnel <id>');
    clientId = await resolveClient(ctx, conn, a.f.client);
    prev = lastRecordFor(ledger, conn.name, clientId, name);
    if (!prev || prev.action === 'close') throw cfgErr(`stored tunnel ${name} on client ${clientId} has no tracked live tunnel to close.`);
    const live = await liveTunnels(ctx, conn);
    if (!live.some((t) => sameTunnel(t, prev))) {
      if (ctx.json) out(JSON.stringify({ def: name, closed: false, reason: 'already gone' }));
      else out(`tunnel ${prev.tunnel_id} for ${name} is already gone; nothing to close`);
      return;
    }
    tunnelId = prev.tunnel_id;
  }
  try {
    await api(ctx, conn, 'DELETE', `/clients/${encodeURIComponent(clientId)}/tunnels/${encodeURIComponent(tunnelId)}`, { query: force ? { force: 'true' } : undefined, write: true });
  } catch (e) {
    if (e instanceof ApiError && e.status === 409 && !force) {
      throw new CliError(EXIT.API, `REFUSED by server: tunnel ${tunnelId} still has active connections, so it was not closed. Do not add --force unless the operator explicitly asks to cut those connections.\n  (${e.message.split('\n')[0]})`);
    }
    throw e;
  }
  if (ctx.dryRun) return printPlans(ctx);
  if (prev) {
    appendLedger(makeRecord({ def: prev.def, server: conn.name, action: 'close', stored_tunnel_id: prev.stored_tunnel_id, tunnel_id: tunnelId, client_id: clientId, host: conn.host, lport: prev.lport, forced: force, supersedes: prev.rec_id }));
  }
  const defName = prev ? prev.def : null;
  if (ctx.json) out(JSON.stringify({ def: defName, tunnel_id: tunnelId, client_id: clientId, closed: true, forced: force }));
  else out(`closed tunnel ${tunnelId} on client ${clientId}${defName ? ' (' + defName + ')' : ''}${force ? ' (forced)' : ''}`);
}

function cmdLedger(ctx, a) {
  let recs = readLedger();
  if (a.f.def) recs = recs.filter((r) => r.def === a.f.def);
  if (a.f.since) {
    let t = Date.parse(a.f.since);
    if (Number.isNaN(t)) t = Date.now() - parseDuration(a.f.since) * 1000;
    recs = recs.filter((r) => Date.parse(r.at) >= t);
  }
  if (ctx.json) return out(JSON.stringify(recs));
  if (!recs.length) return out('ledger is empty for that selection');
  for (const r of recs) if (r.action === 'script-run') out(`${r.at}  script-run  ${r.script_name} (id ${r.script_id}, sha256 ${String(r.sha256 || '').slice(0, 12)})  client ${r.client_id}  jid=${r.jid}  status=${r.status}  sudo=${r.is_sudo}  timeout=${r.timeout_sec}s`);
  else out(`${r.at}  ${r.def}  ${r.action}  tunnel ${r.tunnel_id}@${r.client_id}  ${r.host}:${r.lport}${r.acl ? '  acl=' + r.acl : ''}${r.hard_expires_at ? '  hard_expires_at=' + r.hard_expires_at : ''}${r.superseded ? '  (superseded)' : ''}`);
}

// ---------------------------------------------------------------------------
// Scripts: the server's script library, and running ONE library script on ONE client.
// RPort has no "run library script by id" call: we read the entry and POST its exact text
// (base64) to /clients/{id}/scripts, then poll /clients/{id}/commands/{jid}.
// ---------------------------------------------------------------------------
const LIB = '/library/scripts';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// RPORT_SKILL_POLL_MS: test hook to poll faster than every 2s.
const pollMs = () => (Number(process.env.RPORT_SKILL_POLL_MS) > 0 ? Number(process.env.RPORT_SKILL_POLL_MS) : LIMITS.SCRIPT_POLL_SECONDS * 1000);

export const scriptSha256 = (text) => crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
export function scriptLines(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}
export function tailLines(text, n = LIMITS.SCRIPT_TAIL_LINES) {
  if (text === undefined || text === null || text === '') return '';
  return scriptLines(text).slice(-n).join('\n');
}

function wholeNumber(v, what) {
  if (!/^\d+$/.test(String(v))) throw usage(`${what} "${v}" must be a whole number`);
  return Number(v);
}

// timeout_sec for a run (or a library entry): given value, else the fallback (library), else 60; 1..3600.
export function validateScriptTimeout(v, fallback) {
  const given = v !== undefined && v !== null && v !== '';
  const noFallback = fallback === undefined || fallback === null || fallback === '' || Number(fallback) === 0;
  const x = given ? v : (noFallback ? LIMITS.SCRIPT_TIMEOUT_DEFAULT : fallback);
  if (!/^\d+$/.test(String(x))) throw guard(`timeout "${x}" must be a whole number of seconds.`);
  const n = Number(x);
  if (n < 1) throw guard('timeout 0 is not allowed; every script run needs a timeout (default 60s).');
  if (n > LIMITS.SCRIPT_TIMEOUT_MAX) throw guard(`timeout ${n}s is above the maximum of ${LIMITS.SCRIPT_TIMEOUT_MAX}s (1h). Split long work into shorter scripts.`);
  return n;
}

// Library entry by exact name, then case-insensitive name, then id. Ambiguous -> usage error.
export function pickLibraryScript(list, ref) {
  const r = String(ref ?? '');
  if (!r) throw usage('a library script name or id is required');
  const ids = (xs) => xs.map((s) => `${s.name} (id ${s.id})`).join(', ');
  const exact = list.filter((s) => s.name === r);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw usage(`script name "${r}" matches ${exact.length} library scripts: ${ids(exact)}; use the id`);
  const ci = list.filter((s) => String(s.name ?? '').toLowerCase() === r.toLowerCase());
  if (ci.length === 1) return ci[0];
  if (ci.length > 1) throw usage(`script name "${r}" matches ${ci.length} library scripts (case-insensitive): ${ids(ci)}; use the exact name or the id`);
  const byId = list.filter((s) => String(s.id) === r);
  if (byId.length === 1) return byId[0];
  throw cfgErr(`no library script named or with id "${r}". See: scripts list`);
}

// The body of POST /clients/{id}/scripts. is_sudo is always explicit (false unless --sudo).
export function buildScriptRunBody(s, { isSudo = false, timeout, cwd } = {}) {
  const body = { script: Buffer.from(String(s.script ?? ''), 'utf8').toString('base64') };
  if (s.interpreter) body.interpreter = s.interpreter;
  if (cwd) body.cwd = cwd;
  body.is_sudo = !!isSudo;
  body.timeout_sec = timeout;
  return body;
}

export function checkBodySize(body, what) {
  const bytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
  if (bytes > LIMITS.SCRIPT_BODY_MAX_BYTES) {
    throw guard(`${what}: the request body is ${bytes} bytes, above the server limit of ${LIMITS.SCRIPT_BODY_MAX_BYTES} bytes ([api] max_request_bytes; base64 adds about a third). Split the script into smaller ones, or ask the RPort admin to raise max_request_bytes.`);
  }
  return bytes;
}

// Clear explanations for the refusals RPort and the client send back on script calls.
export function mapScriptApiError(e) {
  if (!(e instanceof ApiError)) return e;
  const first = e.message.split('\n')[0];
  const msg = e.message.toLowerCase();
  if (msg.includes('scope of the provided token')) {
    return new CliError(EXIT.API, `${first}\n  hint: the API token has read-only scope. Running or changing scripts needs a read+write token; the operator creates one in RPort and updates the fleet secret.`);
  }
  if (e.status === 409 && /remote (scripts|commands)[^\n]*disabled/.test(msg)) {
    return new CliError(EXIT.API, `REFUSED by the client: remote scripts are disabled on it.\n  (${first})\n  hint: running scripts needs both [remote-scripts] enabled = true and [remote-commands] enabled = true in the client's rport.conf, then a client restart. That is the operator's decision; do not work around it.`);
  }
  if (e.status === 409 && /still running/.test(msg)) {
    return new CliError(EXIT.API, `REFUSED by the client: a previous command or script is still running on it.\n  (${first})\n  hint: wait, and check it with \`scripts jobs <client>\` / \`scripts job <client> <jid>\`. Do not start another run meanwhile.`);
  }
  if (e.status === 403) {
    return new CliError(EXIT.API, `${first}\n  hint: the RPort user needs the \`scripts\` permission (user group) and access to that client; an RPort admin grants it.`);
  }
  return e;
}

async function scriptApi(ctx, conn, method, p, opts) {
  try {
    return await api(ctx, conn, method, p, opts);
  } catch (e) {
    throw mapScriptApiError(e);
  }
}

async function listLibrary(ctx, conn) {
  const all = [];
  const page = 100;
  for (let offset = 0; offset < page * 50; offset += page) {
    const r = await scriptApi(ctx, conn, 'GET', LIB, { query: { 'page[limit]': page, 'page[offset]': offset } });
    const list = Array.isArray(r.data) ? r.data : [];
    all.push(...list);
    if (list.length < page) break;
  }
  return all;
}

async function getLibraryScript(ctx, conn, ref) {
  const hit = pickLibraryScript(await listLibrary(ctx, conn), ref);
  const r = await scriptApi(ctx, conn, 'GET', `${LIB}/${encodeURIComponent(hit.id)}`, { hint404: `library script ${hit.id} vanished; run scripts list.` });
  return r.data || hit;
}

async function getClient(ctx, conn, id) {
  try {
    return (await api(ctx, conn, 'GET', `/clients/${encodeURIComponent(id)}`)).data || null;
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

const libRow = (s) => ({ id: s.id, name: s.name, interpreter: s.interpreter || null, is_sudo: isOn(s.is_sudo), timeout_sec: s.timeout_sec ?? null, tags: Array.isArray(s.tags) ? s.tags : [], updated_at: s.updated_at || null });
const jobPath = (clientId, jid) => `/clients/${encodeURIComponent(clientId)}/commands/${encodeURIComponent(jid)}`;
const serverFlag = (a) => (a.f.server ? ` --server ${a.f.server}` : '');

function readScriptFile(file) {
  const p = path.resolve(String(file));
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw cfgErr(`script file ${p} does not exist.`);
  const text = fs.readFileSync(p, 'utf8');
  if (!text.trim()) throw cfgErr(`script file ${p} is empty.`);
  return text;
}

function parseTags(v) {
  return String(v).split(',').map((t) => t.trim()).filter(Boolean);
}

function previewOf(text) {
  const lines = scriptLines(text);
  return { script_sha256: scriptSha256(text), script_bytes: Buffer.byteLength(String(text), 'utf8'), script_lines: lines.length, preview: lines.slice(0, LIMITS.SCRIPT_PREVIEW_LINES) };
}

// Dry-run plans of library writes: the script text is shown as hash + first lines, not inline.
function printScriptPlans(ctx, text) {
  for (const p of ctx.plans) {
    const b = p.body && p.body.script !== undefined ? { ...p.body, script: `<${Buffer.byteLength(String(text), 'utf8')} bytes, sha256 ${scriptSha256(text)}>` } : p.body;
    out(`DRY-RUN would call: ${p.method} ${p.url}  Authorization: Basic [REDACTED]${b ? '  body: ' + JSON.stringify(b) : ''}`);
  }
  if (text !== undefined) {
    const pv = previewOf(text);
    out(`script sha256 ${pv.script_sha256}, ${pv.script_lines} lines, ${pv.script_bytes} bytes; first lines:`);
    for (const l of pv.preview) out(`  | ${l}`);
  }
}

function writeJobFile(job, outFile, jid) {
  let p;
  if (outFile) {
    p = path.resolve(String(outFile));
    fs.mkdirSync(path.dirname(p), { recursive: true });
  } else {
    ensureStateDir();
    const d = path.join(stateDir(), 'jobs');
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    p = path.join(d, `${String(jid).replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
  }
  fs.writeFileSync(p, redact(JSON.stringify(job ?? { jid, status: 'running', note: 'job not visible on the server yet' }, null, 2)) + '\n', { mode: 0o600 });
  return p;
}

// Summary of a job: status, timing, error, output tails (never the full output).
export function jobSummary(job, { jid, clientId, timeout } = {}) {
  const j = job || {};
  const res = j.result || {};
  const status = j.status || 'running';
  const s = {
    jid: j.jid || jid, client_id: j.client_id || clientId, client_name: j.client_name || null, status,
    exit_code: j.exit_code ?? res.exit_code ?? null,
    interpreter: j.interpreter || null, cwd: j.cwd || null, is_sudo: j.is_sudo ?? null, timeout_sec: j.timeout_sec ?? timeout ?? null,
    started_at: j.started_at || null, finished_at: j.finished_at || null, created_by: j.created_by || null,
    error: j.error || null, summary: res.summary || null,
    stdout_tail: tailLines(res.stdout), stderr_tail: tailLines(res.stderr),
  };
  if (status === 'unknown') {
    s.note = `the server stopped observing after timeout_sec=${s.timeout_sec}s, so the status is unknown: the process may still be running on the client. RPort cannot cancel it. Do not re-run blindly; check the client later.`;
  }
  return s;
}

function printJob(ctx, result) {
  if (!ctx.json) {
    out(`job ${result.jid} on client ${result.client_id}${result.client_name ? ' (' + result.client_name + ')' : ''}: ${result.status}${result.exit_code !== null ? ', exit code ' + result.exit_code : ''}`);
    if (result.started_at) out(`started ${fmtTime(result.started_at)}${result.finished_at ? ', finished ' + fmtTime(result.finished_at) : ''}`);
    if (result.error) out(`error: ${result.error}`);
    if (result.summary) out(`summary: ${result.summary}`);
    if (result.stdout_tail) out(`--- stdout (last ${LIMITS.SCRIPT_TAIL_LINES} lines) ---\n${result.stdout_tail}`);
    if (result.stderr_tail) out(`--- stderr (last ${LIMITS.SCRIPT_TAIL_LINES} lines) ---\n${result.stderr_tail}`);
    if (result.note) out(`NOTE: ${result.note}`);
    if (result.output_file) out(`full job JSON: ${result.output_file}`);
  }
  out(`RESULT ${JSON.stringify(result)}`);
}

async function cmdScriptsRun(ctx, a, conn) {
  if (a._.length !== 3) throw usage('scripts run <script> --client <client>: exactly one library script per run');
  if (!a.f.client) throw usage('scripts run needs --client <id|name> (one client per run)');
  const clientId = await resolveClient(ctx, conn, a.f.client);
  const client = await getClient(ctx, conn, clientId);
  if (!client || client.connection_state === 'disconnected') {
    throw guard(`client ${a.f.client} (${clientId}) is not connected. RPort runs scripts only on connected clients; check it with: clients --name <name>.`);
  }
  const s = await getLibraryScript(ctx, conn, a._[2]);
  if (typeof s.script !== 'string' || !s.script.trim()) throw cfgErr(`library script ${s.name} (id ${s.id}) has no script text.`);
  if (isOn(s.is_sudo) && !a.f.sudo) {
    throw guard(`library script "${s.name}" is stored with is_sudo=true: it requires elevation. Elevation is used only when the operator explicitly asks for it for this run; ask them, then pass --sudo.`);
  }
  const isSudo = !!a.f.sudo;
  const timeout = validateScriptTimeout(a.f.timeout, s.timeout_sec);
  const cwd = a.f.cwd !== undefined ? a.f.cwd : (s.cwd || undefined);
  const body = buildScriptRunBody(s, { isSudo, timeout, cwd });
  checkBodySize(body, `script "${s.name}"`);
  const wait = a.f.wait !== undefined ? wholeNumber(a.f.wait, '--wait') : timeout + LIMITS.SCRIPT_WAIT_EXTRA;
  const sha = scriptSha256(s.script);
  const runPath = `/clients/${encodeURIComponent(clientId)}/scripts`;

  if (ctx.dryRun) {
    const url = displayUrl(new URL(conn.base + runPath));
    const pv = previewOf(s.script);
    out(`DRY-RUN would call: POST ${url}  Authorization: Basic [REDACTED]  body: ${JSON.stringify({ ...body, script: `<base64 of ${pv.script_bytes} bytes>` })}`);
    const plan = {
      client_id: clientId, client_name: client.name || null, script_id: s.id, script_name: s.name,
      interpreter: s.interpreter || null, cwd: cwd || null, is_sudo: isSudo, timeout_sec: timeout, wait_sec: wait,
      script_sha256: pv.script_sha256, script_lines: pv.script_lines, script_preview: pv.preview, method: 'POST', url,
    };
    out(`PLAN ${JSON.stringify(plan)}`);
    if (!ctx.json) {
      out(`script ${s.name} (id ${s.id}) sha256 ${pv.script_sha256}, ${pv.script_lines} lines; first lines:`);
      for (const l of pv.preview) out(`  | ${l}`);
    }
    return;
  }

  const r = await scriptApi(ctx, conn, 'POST', runPath, {
    body, write: true,
    hint404: `client ${a.f.client} is not active (disconnected or paused): RPort answers "Active client with id=... not found". Check it with: clients --name <name>.`,
  });
  const jid = r.data && r.data.jid;
  if (!jid) throw new CliError(EXIT.API, 'API: the run reply had no jid.');

  // Poll until the job leaves "running" or --wait elapses.
  const deadline = Date.now() + wait * 1000;
  let job = null;
  for (;;) {
    try {
      job = (await scriptApi(ctx, conn, 'GET', jobPath(clientId, jid))).data || job;
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) throw e; // not visible yet: keep polling
    }
    if (job && job.status && job.status !== 'running') break;
    const left = deadline - Date.now();
    if (left <= 0) break;
    await sleep(Math.min(pollMs(), left));
  }

  const result = { ...jobSummary(job, { jid, clientId, timeout }), script_id: s.id, script_name: s.name, script_sha256: sha, server: conn.name };
  if (result.status === 'running') {
    result.note = `still running after --wait ${wait}s. Check it later with: scripts job ${clientId} ${jid}${serverFlag(a)}`;
  }
  result.output_file = writeJobFile(job, a.f.out, jid);
  const at = new Date().toISOString();
  appendLedger({
    ...makeRecord({ action: 'script-run', server: conn.name, client_id: clientId, client: a.f.client, script_id: String(s.id), script_name: s.name, sha256: sha, is_sudo: isSudo, timeout_sec: timeout, jid: String(jid), status: result.status }),
    at, ts: at,
  });
  printJob(ctx, result);
}

async function cmdScripts(ctx, a) {
  const sub = a._[1] || 'list';
  const conn = connFor(ctx.cfg, a.f.server);
  if (sub === 'list') {
    let list = (await listLibrary(ctx, conn)).map(libRow);
    if (a.f.query) list = list.filter((s) => String(s.name ?? '').toLowerCase().includes(String(a.f.query).toLowerCase()));
    if (ctx.json) return out(JSON.stringify(list));
    if (!list.length) return out('no library scripts matched');
    for (const s of list) out(`${s.id}  ${s.name}  interpreter=${s.interpreter || '(server default)'}  sudo=${s.is_sudo}  timeout=${s.timeout_sec ?? '-'}s  tags=${s.tags.join(',') || '-'}  updated=${s.updated_at || '-'}`);
    return;
  }
  if (sub === 'show') {
    const s = await getLibraryScript(ctx, conn, a._[2]);
    return out(JSON.stringify({ ...s, script_sha256: scriptSha256(s.script ?? '') }, null, ctx.json ? 0 : 2));
  }
  if (sub === 'run') return cmdScriptsRun(ctx, a, conn);
  if (sub === 'job') {
    const [ref, jid] = [a._[2], a._[3]];
    if (!ref || !jid) throw usage('scripts job <client> <jid>');
    const clientId = await resolveClient(ctx, conn, ref);
    const job = (await scriptApi(ctx, conn, 'GET', jobPath(clientId, jid), { hint404: `no job ${jid} on client ${clientId}; list them with: scripts jobs ${ref}` })).data;
    const result = jobSummary(job, { jid, clientId });
    result.output_file = writeJobFile(job, a.f.out, jid);
    return printJob(ctx, result);
  }
  if (sub === 'jobs') {
    const ref = a._[2];
    if (!ref) throw usage('scripts jobs <client> [--limit N]');
    const limit = a.f.limit !== undefined ? wholeNumber(a.f.limit, '--limit') : 20;
    if (limit < 1) throw usage('--limit must be at least 1');
    const clientId = await resolveClient(ctx, conn, ref);
    const r = await scriptApi(ctx, conn, 'GET', `/clients/${encodeURIComponent(clientId)}/commands`, { query: { 'page[limit]': limit } });
    const rows = (Array.isArray(r.data) ? r.data : [])
      .map((j) => ({ jid: j.jid, status: j.status, started_at: j.started_at || null, finished_at: j.finished_at || null, created_by: j.created_by || null, interpreter: j.interpreter || null, is_sudo: j.is_sudo ?? null, timeout_sec: j.timeout_sec ?? null, error: j.error || null, summary: (j.result && j.result.summary) || null }))
      .sort((x, y) => String(y.started_at || '').localeCompare(String(x.started_at || '')))
      .slice(0, limit);
    if (ctx.json) return out(JSON.stringify(rows));
    if (!rows.length) return out(`no jobs on client ${clientId}`);
    for (const j of rows) out(`${j.jid}  ${j.status}  started=${j.started_at || '-'}  finished=${j.finished_at || '-'}  by=${j.created_by || '-'}  sudo=${j.is_sudo}${j.error ? '  error=' + j.error : ''}`);
    return;
  }
  if (sub === 'add') {
    const name = a._[2];
    if (!name || a._.length !== 3) throw usage('scripts add <name> --file <path>');
    if (!a.f.file) throw usage('scripts add needs --file <path>: script text comes only from a local file');
    const text = readScriptFile(a.f.file);
    const body = { name, script: text };
    if (a.f.interpreter) body.interpreter = a.f.interpreter;
    if (a.f.cwd) body.cwd = a.f.cwd;
    body.is_sudo = !!a.f.sudo;
    if (a.f.timeout !== undefined) body.timeout_sec = validateScriptTimeout(a.f.timeout);
    if (a.f.tags !== undefined) body.tags = parseTags(a.f.tags);
    checkBodySize(body, `library script "${name}"`);
    if ((await listLibrary(ctx, conn)).some((s) => s.name === name)) throw cfgErr(`the library already has a script named "${name}". Use scripts update.`);
    const r = await scriptApi(ctx, conn, 'POST', LIB, { body, write: true });
    if (ctx.dryRun) { out(`DRY-RUN (${ADMIN_NOTE})`); return printScriptPlans(ctx, text); }
    const saved = r.data || {};
    if (ctx.json) return out(JSON.stringify(libRow(saved)));
    return out(`added library script ${name} (id ${saved.id}), sha256 ${scriptSha256(text)} [${ADMIN_NOTE}]`);
  }
  if (sub === 'update') {
    if (a.f.sudo && a.f['no-sudo']) throw usage('pass --sudo or --no-sudo, not both');
    const s = await getLibraryScript(ctx, conn, a._[2]);
    const next = { name: s.name, script: s.script, interpreter: s.interpreter || '', cwd: s.cwd || '', is_sudo: isOn(s.is_sudo), timeout_sec: s.timeout_sec ?? LIMITS.SCRIPT_TIMEOUT_DEFAULT, tags: Array.isArray(s.tags) ? s.tags : [] };
    const changed = [];
    const set = (k, v) => { if (JSON.stringify(next[k]) !== JSON.stringify(v)) { next[k] = v; changed.push(k); } };
    if (a.f.file !== undefined) set('script', readScriptFile(a.f.file));
    if (a.f.name !== undefined) set('name', a.f.name);
    if (a.f.interpreter !== undefined) set('interpreter', a.f.interpreter);
    if (a.f.cwd !== undefined) set('cwd', a.f.cwd);
    if (a.f.sudo) set('is_sudo', true);
    if (a.f['no-sudo']) set('is_sudo', false);
    if (a.f.timeout !== undefined) set('timeout_sec', validateScriptTimeout(a.f.timeout));
    if (a.f.tags !== undefined) set('tags', parseTags(a.f.tags));
    if (!changed.length) throw usage('scripts update: nothing to change (give --file, --name, --interpreter, --cwd, --sudo/--no-sudo, --timeout or --tags)');
    if (changed.includes('name') && (await listLibrary(ctx, conn)).some((x) => x.name === next.name && String(x.id) !== String(s.id))) {
      throw cfgErr(`the library already has another script named "${next.name}".`);
    }
    checkBodySize(next, `library script "${next.name}"`);
    // Full object sent back (no partial updates).
    await scriptApi(ctx, conn, 'PUT', `${LIB}/${encodeURIComponent(s.id)}`, { body: next, write: true });
    if (ctx.dryRun) {
      out(`DRY-RUN (${ADMIN_NOTE}) changes: ${changed.join(', ')}`);
      return printScriptPlans(ctx, next.script);
    }
    if (ctx.json) return out(JSON.stringify({ id: s.id, name: next.name, changed, script_sha256: scriptSha256(next.script) }));
    return out(`updated library script ${next.name} (id ${s.id}): ${changed.join(', ')}; sha256 ${scriptSha256(next.script)} [${ADMIN_NOTE}]`);
  }
  if (sub === 'delete') {
    const s = await getLibraryScript(ctx, conn, a._[2]);
    await scriptApi(ctx, conn, 'DELETE', `${LIB}/${encodeURIComponent(s.id)}`, { write: true });
    if (ctx.dryRun) { out(`DRY-RUN (${ADMIN_NOTE})`); return printScriptPlans(ctx); }
    if (ctx.json) return out(JSON.stringify({ id: s.id, name: s.name, deleted: true }));
    return out(`deleted library script ${s.name} (id ${s.id}) [${ADMIN_NOTE}]`);
  }
  throw usage(`unknown scripts subcommand "${sub}"`);
}

export const HELP = `rport.mjs - RPort helper for the rport agent skill (Node >= 18)

Run it through mcp__apra-fleet__execute_command on the runner member (a local
apra-fleet member), with the API token in RPORT_TOKEN for that one command only:
  RPORT_TOKEN={{secret.RPORT_API_TOKEN}} node <skill>/scripts/rport.mjs <command> ...

A tunnel definition is an RPort stored tunnel (per server, per client, by name).
A live tunnel is an instance of it. Locally: servers, runner, links, a ledger.
Several servers: --server <moniker> picks one; optional when only one server
exists or one is called "default".

Read-only:
  ip                                   caller public IP (GET /me/ip)
  whoami                               current user (GET /me)
  clients [--name X]                   list clients (GET /clients?filter[name]=X)
  tunnels [--client X]                 live tunnels joined with ledger expiry
  def list --client X                  stored tunnels, each with a safety check
  def show <name> --client X           one stored tunnel, effective options, link
  status [<name> --client X]           alive | expired | closed-idle | client-offline | closed | none
  ledger [--def <name>] [--since ISO|24h]
Tunnel lifecycle:
  revive <name> --client X [--allow-lan-target]
                                       reuse or create from the stored tunnel; prints RESULT {...}
  close <name> --client X | --tunnel <id> [--client X] [--force]
Admin changes on the server (only on the operator's explicit request; --dry-run first):
  def add <name> --client X --remote <port|host:port> [--acl self|ip[/30..32],...]
          [--idle 30] [--auto-close 2h] [--scheme ssh] [--protocol tcp] [--public-port P]
          [--allow-lan-target] [--http-proxy --auth-user U [--host-header H]]
  def set-acl <name> self|<ip>[,<ip>...] --client X
  def set-options <name> --client X [--idle N] [--auto-close D] [--protocol P]
          drops skip-idle-timeout / check_port=0, keeps other stored keys
  def remove <name> --client X
Scripts (only library scripts, one client per run; <script> = name, case-insensitive name or id):
  scripts list [--query TEXT]          library entries, no script bodies
  scripts show <script>                one entry with its script text and sha256
  scripts run <script> --client X [--sudo] [--timeout SEC] [--cwd DIR] [--wait SEC] [--out FILE]
                                       run it on one connected client, poll the job, print RESULT {...}
                                       (status, output tails); full job JSON to --out or <state>/jobs/<jid>.json
  scripts job <client> <jid> [--out FILE]   one job: status, error, output tails, full file
  scripts jobs <client> [--limit N]    recent jobs on that client
Script library admin changes (only on the operator's explicit request; --dry-run first):
  scripts add <name> --file <path> [--interpreter I] [--cwd D] [--sudo] [--timeout SEC] [--tags a,b]
  scripts update <script> [--file <path>] [--name N] [--interpreter I] [--cwd D] [--sudo|--no-sudo]
          [--timeout SEC] [--tags a,b]
  scripts delete <script>
Local config:
  server list | show [<moniker>] | remove <moniker>
  server add [<moniker>] --url https://host --user U [--token-secret S] [--runner-member M]
                                       moniker defaults to "default", secret to RPORT_API_TOKEN
  runner show | set <member> | clear   global local runner member (per-server override above)
  link list | add <name> --client X --fleet-member M | remove <name> --client X

Global flags: --json  --dry-run (writes print the planned call, token redacted)
              --server <moniker>  --debug (requests to stderr, Authorization redacted)

Guardrails: auto-close default 2h, max 12h; idle timeout default 30, max 120 min,
never skip-idle-timeout; ACL never empty / 0.0.0.0/0 / wider than /30, max 4 entries,
IPv4 only; "self" is resolved via GET /me/ip and stored as a /32; revive uses exactly
the stored ACL and refuses if your IP is not in it; check_port always on; LAN targets
need --allow-lan-target; http_proxy needs auth; no force-close unless asked.
Scripts: no ad-hoc commands or scripts, no multi-client/group/websocket runs; script
text only from the library (and into it only from a file); is_sudo only with --sudo
for that run (a library script marked is_sudo is refused without it); timeout default
library or 60s, max 3600s; request body max 10240 bytes; status "unknown" means the
server stopped watching and the process may still run (no cancel exists).

Exit codes: 0 ok, 1 usage, 2 guardrail refusal, 3 API error, 4 config error.
State: ~/.config/rport-skill/ (config.json, ledger.jsonl, jobs/); override with RPORT_SKILL_HOME.`;

const BOOL_FLAGS = new Set(['json', 'dry-run', 'force', 'allow-lan-target', 'debug', 'replace', 'http-proxy', 'help', 'sudo', 'no-sudo']);
const VALUE_FLAGS = new Set(['server', 'client', 'remote', 'acl', 'idle', 'auto-close', 'scheme', 'protocol', 'public-port', 'fleet-member', 'name', 'def', 'since', 'tunnel', 'url', 'user', 'token-secret', 'runner-member', 'auth-user', 'host-header',
  'query', 'timeout', 'cwd', 'wait', 'out', 'file', 'interpreter', 'tags', 'limit']);
const FORBIDDEN_FLAGS = {
  script: 'script text is never passed on the command line: run a library script (scripts run), or add one from a file (scripts add --file).',
  command: 'ad-hoc commands are never run: only a script from the server\'s library runs (scripts run).',
  clients: 'one client per run: no multi-client script runs.',
  group: 'one client per run: no client-group script runs.',
  'skip-idle-timeout': 'skip-idle-timeout is never allowed: every tunnel must close when idle.',
  'check-port': 'check_port always stays on.',
  check_port: 'check_port always stays on.',
  'no-check-port': 'check_port always stays on.',
  local: 'no --local override: the server port comes only from the stored tunnel\'s public_port (or is random).',
  token: 'never pass the token on the command line; it comes only from RPORT_TOKEN.',
};

export function parseArgs(argv) {
  const _ = [];
  const f = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h') { f.help = true; continue; }
    if (!arg.startsWith('--')) { _.push(arg); continue; }
    let k = arg.slice(2);
    let v;
    const eq = k.indexOf('=');
    if (eq >= 0) { v = k.slice(eq + 1); k = k.slice(0, eq); }
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
  return { _, f };
}

export async function main(argv) {
  try {
    const a = parseArgs(argv);
    const cmd = a._[0];
    if (a.f.help || !cmd || cmd === 'help') { out(HELP); return EXIT.OK; }
    const ctx = { cfg: loadConfig(), json: !!a.f.json, dryRun: !!a.f['dry-run'], debug: !!a.f.debug, plans: [] };
    const table = {
      ip: cmdIp, whoami: cmdWhoami, clients: cmdClients, tunnels: cmdTunnels,
      server: cmdServer, runner: cmdRunner, def: cmdDef, link: cmdLink, status: cmdStatus, revive: cmdRevive, close: cmdClose, ledger: cmdLedger,
      scripts: cmdScripts,
    };
    const fn = table[cmd];
    if (!fn) throw usage(`unknown command "${cmd}"`);
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
