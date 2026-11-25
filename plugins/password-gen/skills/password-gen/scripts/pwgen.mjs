#!/usr/bin/env node
// pwgen.mjs - CLI behind the `password-gen` agent skill.
// Node >= 18, no npm dependencies, works the same on Windows, macOS and Linux.
//
// Generates a password from four lookalike-free sets with an unbiased CSPRNG
// (crypto.randomInt) and puts it on a clipboard. Hard rule: the password is never
// printed unless --echo. It never reaches stdout/stderr, logs, temp files, process
// arguments or child environments; clipboard tools get it on their stdin only.
// All status lines go to stderr.
//
// Test-only environment hooks (never set them in normal use):
//   PWGEN_CLIPBOARD_CMD       path to a program/script that receives the password on stdin
//                             (replaces the platform clipboard tool; .js/.mjs/.cjs run with node)
//   PWGEN_CLIPBOARD_READ_CMD  path to a program/script that prints the clipboard (auto-clear read-back)
//   PWGEN_TTY_PATH            file opened instead of the controlling terminal for --osc52
//   PWGEN_PLATFORM            overrides process.platform (win32/darwin/linux)

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const SETS = Object.freeze({
  upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ',
  lower: 'abcdefghijkmnopqrstuvwxyz',
  digits: '23456789',
  symbols: '!#%*-_=+?',
});

export const LIMITS = Object.freeze({
  LENGTH_DEFAULT: 20,
  LENGTH_MIN: 12,
  LENGTH_MAX: 256,
  CLEAR_DEFAULT: 45, // seconds
  CLEAR_MAX: 3600,
  TOOL_TIMEOUT_MS: 15000,
  DETACHED_SETTLE_MS: 300, // how long to watch a detached tool (xclip) for an early failure
});

export const EXIT = Object.freeze({ OK: 0, USAGE: 1, GUARDRAIL: 2, CONFIG: 4 });

export class CliError extends Error {
  constructor(exitCode, message) {
    super(message);
    this.exitCode = exitCode;
  }
}
const guard = (m) => new CliError(EXIT.GUARDRAIL, `REFUSED (guardrail): ${m}`);
const cfgErr = (m) => new CliError(EXIT.CONFIG, `CONFIG: ${m}`);
const usage = (m) => new CliError(EXIT.USAGE, `USAGE: ${m} (see --help)`);

function errOut(line) {
  process.stderr.write(line + '\n');
}

// ---------------------------------------------------------------------------
// Generator (pure; exported for tests)
// ---------------------------------------------------------------------------
export function buildSets({ noSymbols = false, symbols } = {}) {
  const sets = [SETS.upper, SETS.lower, SETS.digits];
  if (!noSymbols) sets.push(symbols === undefined ? SETS.symbols : symbols);
  return sets;
}

// Every char uniform over the union (crypto.randomInt is unbiased); the whole password
// is regenerated until it holds at least one char of every set.
export function generatePassword(length, sets) {
  const all = sets.join('');
  for (;;) {
    let pw = '';
    for (let i = 0; i < length; i++) pw += all[crypto.randomInt(all.length)];
    if (passesSetRule(pw, sets)) return pw;
  }
}

export function passesSetRule(pw, sets) {
  return sets.every((set) => [...pw].some((c) => set.includes(c)));
}

export const sha256Hex = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

// ---------------------------------------------------------------------------
// Argument parsing (pure; exported for tests)
// ---------------------------------------------------------------------------
function parseIntStrict(v, flag, min, max) {
  if (typeof v !== 'string' || !/^\d+$/.test(v)) throw usage(`${flag} needs an integer ${min}..${max}`);
  const n = Number(v);
  if (n < min || n > max) throw usage(`${flag} must be ${min}..${max} (got ${v})`);
  return n;
}

export function validateSymbols(v) {
  if (typeof v !== 'string' || v === '') throw usage('--symbols needs a non-empty set');
  for (const c of v) {
    const code = c.codePointAt(0);
    if (code < 0x21 || code > 0x7e) throw usage('--symbols must be printable ASCII without spaces');
    if (/[A-Za-z0-9]/.test(c)) throw usage('--symbols must not contain letters or digits');
  }
  return [...new Set(v)].join(''); // duplicates would bias the pick
}

const CLEAR_RE = /^[0-9a-f]{64}$/;
const DESTS = new Set(['clipboard', 'osc52']);

export function parseArgs(argv) {
  if (argv.includes('--_clear')) {
    if (argv[0] !== '--_clear' || argv.length !== 4) throw usage('--_clear is internal and takes no other flags');
    const [, hash, sec, dest] = argv;
    if (!CLEAR_RE.test(hash)) throw usage('--_clear needs a sha256 hex digest');
    const n = parseIntStrict(sec, '--_clear seconds', 1, LIMITS.CLEAR_MAX);
    if (!DESTS.has(dest)) throw usage('--_clear destination must be clipboard or osc52');
    return { clear: { hash, sec: n, dest } };
  }
  const o = { length: LIMITS.LENGTH_DEFAULT, noSymbols: false, symbols: undefined, osc52: false, echo: false, clearAfter: LIMITS.CLEAR_DEFAULT, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') { o.help = true; continue; }
    if (!arg.startsWith('--')) throw usage(`unexpected argument "${arg}"`);
    const eq = arg.indexOf('=');
    const k = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    const value = () => {
      if (inline !== undefined) return inline;
      const v = argv[++i];
      if (v === undefined) throw usage(`--${k} needs a value`);
      return v;
    };
    const noValue = () => { if (inline !== undefined) throw usage(`--${k} takes no value`); };
    switch (k) {
      case 'length': o.length = parseIntStrict(value(), '--length', LIMITS.LENGTH_MIN, LIMITS.LENGTH_MAX); break;
      case 'no-symbols': noValue(); o.noSymbols = true; break;
      case 'symbols': o.symbols = validateSymbols(value()); break;
      case 'osc52': noValue(); o.osc52 = true; break;
      case 'echo': noValue(); o.echo = true; break;
      case 'clear-after': o.clearAfter = parseIntStrict(value(), '--clear-after', 0, LIMITS.CLEAR_MAX); break;
      default: throw usage(`unknown flag --${k}`);
    }
  }
  if (o.noSymbols && o.symbols !== undefined) throw usage('--no-symbols and --symbols conflict');
  return o;
}

// ---------------------------------------------------------------------------
// Environment detection (pure; exported for tests)
// ---------------------------------------------------------------------------
export function currentPlatform(env = process.env) {
  return env.PWGEN_PLATFORM || process.platform;
}

export function isSsh(env) {
  return !!(env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY);
}

// ssh -X/-Y sets DISPLAY to host:N (e.g. localhost:10.0); a local session is :N.
export function isX11Forwarded(display) {
  return typeof display === 'string' && /^[^:/\s]+:\d+(\.\d+)?$/.test(display);
}

function scriptSpec(p, args = []) {
  return /\.(m|c)?js$/i.test(p) ? { cmd: process.execPath, args: [p, ...args] } : { cmd: p, args };
}

// Which clipboard tool(s) to use for platform + env. Returns an ordered list of tools,
// each { name, install, write, read, clear } with spawn specs { cmd, args, detached }.
// Throws a guardrail when the local clipboard is not the user's (SSH, no graphical session).
export function clipboardTools(platform, env) {
  const forwarded = platform === 'linux' && isX11Forwarded(env.DISPLAY);
  if (isSsh(env) && !forwarded) {
    throw guard('this is an SSH session: the clipboard of THIS machine belongs to the remote host, not to you, so the password would land where you cannot paste it. Use --osc52 (your terminal\'s clipboard) or --echo to pipe it.');
  }
  if (env.PWGEN_CLIPBOARD_CMD) {
    return [{
      name: 'PWGEN_CLIPBOARD_CMD',
      install: 'a working PWGEN_CLIPBOARD_CMD',
      write: scriptSpec(env.PWGEN_CLIPBOARD_CMD),
      read: env.PWGEN_CLIPBOARD_READ_CMD ? scriptSpec(env.PWGEN_CLIPBOARD_READ_CMD) : null,
      clear: { ...scriptSpec(env.PWGEN_CLIPBOARD_CMD), input: '' },
    }];
  }
  if (platform === 'win32') {
    const sys32 = path.win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32');
    const clip = path.win32.join(sys32, 'clip.exe');
    const ps = path.win32.join(sys32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return [{
      name: 'clip.exe',
      install: `clip.exe (expected at ${clip})`,
      write: { cmd: clip, args: [] },
      read: { cmd: ps, args: ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard -Raw'] },
      clear: { cmd: clip, args: [], input: '' }, // empty stdin empties the clipboard
    }];
  }
  if (platform === 'darwin') {
    return [{
      name: 'pbcopy',
      install: 'pbcopy (/usr/bin/pbcopy, part of macOS)',
      write: { cmd: '/usr/bin/pbcopy', args: [] },
      read: { cmd: '/usr/bin/pbpaste', args: [] },
      clear: { cmd: '/usr/bin/pbcopy', args: [], input: '' },
    }];
  }
  // Linux and other unixes
  if (env.WAYLAND_DISPLAY && !(isSsh(env) && forwarded)) {
    return [{
      name: 'wl-copy',
      install: 'wl-clipboard (wl-copy/wl-paste)',
      write: { cmd: 'wl-copy', args: [] },
      read: { cmd: 'wl-paste', args: ['-n'] },
      clear: { cmd: 'wl-copy', args: ['--clear'] },
    }];
  }
  if (env.DISPLAY) {
    return [
      {
        name: 'xclip',
        install: 'xclip or xsel',
        write: { cmd: 'xclip', args: ['-selection', 'clipboard'], detached: true },
        read: { cmd: 'xclip', args: ['-selection', 'clipboard', '-o'] },
        clear: { cmd: 'xclip', args: ['-selection', 'clipboard'], detached: true, input: '' },
      },
      {
        name: 'xsel',
        install: 'xclip or xsel',
        write: { cmd: 'xsel', args: ['--clipboard', '--input'] },
        read: { cmd: 'xsel', args: ['--clipboard', '--output'] },
        clear: { cmd: 'xsel', args: ['--clipboard', '--clear'] },
      },
    ];
  }
  throw guard('no graphical session (no WAYLAND_DISPLAY/DISPLAY): use --osc52 or --echo');
}

// ---------------------------------------------------------------------------
// Child processes: the password only ever goes to a child's stdin.
// ---------------------------------------------------------------------------
function waitSpawn(child) {
  return new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
}

// Resolves { code } or rejects with the spawn error (err.code === 'ENOENT' when missing).
export async function runWithInput(spec, input) {
  const child = spawn(spec.cmd, spec.args, {
    stdio: ['pipe', 'ignore', 'ignore'], // a forking tool (wl-copy) must not hold our pipes open
    detached: !!spec.detached,
    windowsHide: true,
  });
  child.stdin.on('error', () => {});
  const spawned = waitSpawn(child);
  child.on('error', () => {}); // later errors surface as a non-zero exit
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  await spawned;
  child.stdin.end(input);
  if (spec.detached) {
    // xclip keeps running to serve the selection; only catch an early failure.
    const r = await Promise.race([exited, new Promise((res) => setTimeout(() => res(null), LIMITS.DETACHED_SETTLE_MS).unref())]);
    child.unref();
    return r && r.code !== 0 ? r : { code: 0 };
  }
  let timer;
  const timeout = new Promise((res) => { timer = setTimeout(() => { child.kill(); res({ code: null, signal: 'timeout' }); }, LIMITS.TOOL_TIMEOUT_MS); });
  const r = await Promise.race([exited, timeout]);
  clearTimeout(timer);
  return r;
}

export async function runCapture(spec) {
  const child = spawn(spec.cmd, spec.args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  const chunks = [];
  let size = 0;
  child.stdout.on('data', (d) => { size += d.length; if (size <= 1 << 20) chunks.push(d); });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code));
  });
  const timer = setTimeout(() => child.kill(), LIMITS.TOOL_TIMEOUT_MS);
  try {
    const code = await done;
    if (code !== 0) return null;
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    clearTimeout(timer);
  }
}

export async function copyToClipboard(pw, tools) {
  for (const t of tools) {
    let r;
    try {
      r = await runWithInput(t.write, pw);
    } catch (e) {
      if (e && e.code === 'ENOENT') continue;
      throw cfgErr(`could not start ${t.name}: ${e && e.code ? e.code : 'spawn failed'}`);
    }
    if (r.code !== 0) throw cfgErr(`${t.name} failed (${r.signal ? 'signal ' + r.signal : 'exit ' + r.code}); the clipboard was not set.`);
    return t;
  }
  throw cfgErr(`no clipboard tool found: install ${tools[0].install}. Or use --osc52 / --echo.`);
}

// ---------------------------------------------------------------------------
// OSC 52 (the user's terminal clipboard), written straight to the controlling terminal
// ---------------------------------------------------------------------------
export function osc52Sequence(payloadB64, env) {
  const seq = `\x1b]52;c;${payloadB64}\x07`;
  // GNU screen swallows OSC; its DCS passthrough forwards it to the outer terminal.
  // tmux forwards OSC 52 itself when `set -g set-clipboard on`.
  return env.STY ? `\x1bP${seq}\x1b\\` : seq;
}
export const osc52For = (pw, env) => osc52Sequence(Buffer.from(pw, 'utf8').toString('base64'), env);

export function ttyCandidates(platform, env) {
  if (env.PWGEN_TTY_PATH) return [{ path: env.PWGEN_TTY_PATH, flags: 'a' }];
  if (platform === 'win32') return [{ path: '\\\\.\\CONOUT$', flags: 'r+' }, { path: 'CONOUT$', flags: 'r+' }];
  return [{ path: '/dev/tty', flags: fs.constants.O_WRONLY }];
}

export function openTty(platform, env) {
  for (const c of ttyCandidates(platform, env)) {
    try {
      return fs.openSync(c.path, c.flags);
    } catch { /* try the next one */ }
  }
  return null;
}

function writeTty(platform, env, data, { requireConsole = false } = {}) {
  // A hidden console (agent, service) still opens CONOUT$ on Windows; require a real terminal on a std stream.
  if (requireConsole && platform === 'win32' && !env.PWGEN_TTY_PATH && !(process.stdin.isTTY || process.stdout.isTTY || process.stderr.isTTY)) return false;
  const fd = openTty(platform, env);
  if (fd === null) return false;
  try {
    fs.writeSync(fd, data);
    return true;
  } finally {
    fs.closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Auto-clear: a separate child that only ever sees the SHA-256 of the password
// ---------------------------------------------------------------------------
export function shouldClear(current, expectedHash) {
  if (typeof current !== 'string') return false;
  const v = current.replace(/\r?\n$/, ''); // Get-Clipboard / some tools append a newline
  if (v === '') return false;
  return sha256Hex(v) === expectedHash;
}

export function buildClearSpawn(hash, sec, dest, platform = process.platform, scriptPath = fileURLToPath(import.meta.url), env = process.env) {
  const args = [scriptPath, '--_clear', hash, String(sec), dest];
  if (platform === 'win32' && dest === 'osc52') {
    // Windows: a detached child has no console (no CONOUT$), and a non-detached node child sits in
    // libuv's kill-on-close job and dies with us. `start /b` from cmd.exe launches the clearer
    // outside that job (silent breakaway) on the same console. argv still holds only the hash.
    const cmd = env.ComSpec || path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
    const q = (s) => `"${s}"`;
    return {
      cmd,
      args: ['/d', '/s', '/c', q(`start "" /b ${q(process.execPath)} ${args.map(q).join(' ')}`)],
      options: { detached: false, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true },
    };
  }
  return {
    cmd: process.execPath,
    args,
    // The POSIX osc52 clearer must keep the controlling terminal, so it is not detached (setsid would drop it).
    options: { detached: dest === 'clipboard', stdio: 'ignore', windowsHide: true },
  };
}

async function spawnClearer(hash, sec, dest, platform) {
  try {
    const s = buildClearSpawn(hash, sec, dest, platform);
    const child = spawn(s.cmd, s.args, s.options);
    if (s.cmd !== process.execPath) {
      // cmd.exe `start /b`: wait for it to hand off, or our exit kills it before the clearer starts.
      return await new Promise((resolve) => {
        const t = setTimeout(() => resolve(false), LIMITS.TOOL_TIMEOUT_MS);
        child.once('error', () => { clearTimeout(t); resolve(false); });
        child.once('exit', (code) => { clearTimeout(t); resolve(code === 0); });
      });
    }
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export async function runClear({ hash, sec, dest }, env = process.env, platform = currentPlatform(env)) {
  await new Promise((res) => setTimeout(res, sec * 1000));
  try {
    if (dest === 'osc52') {
      writeTty(platform, env, osc52Sequence('', env)); // cannot read back; just clear
      return;
    }
    for (const t of clipboardTools(platform, env)) {
      if (!t.read) return;
      let current;
      try {
        current = await runCapture(t.read);
      } catch (e) {
        if (e && e.code === 'ENOENT') continue;
        return;
      }
      if (shouldClear(current, hash)) await runWithInput(t.clear, t.clear.input || '');
      return;
    }
  } catch { /* best effort, silent */ }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
export const HELP = `pwgen.mjs - password generator for the password-gen skill (Node >= 18)

Usage: pwgen.mjs [--length N] [--no-symbols] [--symbols SET] [--osc52] [--echo]
                 [--clear-after SEC] [--help]

Picks every char uniformly (crypto.randomInt) from upper, lower, digits and
symbols without lookalikes (no I O l 0 1); at least one char of each set.
The password is never printed unless --echo.

  --length N         12..256 (default 20)
  --no-symbols       letters and digits only
  --symbols SET      replace the symbol set (printable ASCII, no spaces/letters/digits)
  --osc52            send it to YOUR terminal's clipboard (OSC 52) instead of this
                     machine's clipboard; works over SSH. tmux needs
                     \`set -g set-clipboard on\`. Needs a real terminal.
  --echo             print only the password to stdout (for piping). No clipboard
                     unless --osc52 is also given.
  --clear-after SEC  clear the clipboard after SEC s if it still holds the password
                     (default 45, 0 = never, max 3600)

Local clipboard: clip.exe (Windows), pbcopy (macOS), wl-copy / xclip / xsel (Linux).
Refused over SSH (that clipboard is the remote host's), except X11 forwarding.

Exit codes: 0 ok, 1 usage, 2 refused (guardrail), 4 config (missing tool).
`;

export async function main(argv, env = process.env) {
  try {
    const o = parseArgs(argv);
    if (o.clear) { await runClear(o.clear, env); return EXIT.OK; }
    if (o.help) { process.stdout.write(HELP); return EXIT.OK; }
    const platform = currentPlatform(env);
    const toClipboard = !o.echo && !o.osc52;
    // Check the destination before generating anything.
    const tools = toClipboard ? clipboardTools(platform, env) : null;

    const pw = generatePassword(o.length, buildSets(o));
    const clearNote = async (dest) => {
      if (o.clearAfter === 0) return 'auto-clear is off';
      const hash = sha256Hex(pw);
      if (!(await spawnClearer(hash, o.clearAfter, dest, process.platform))) return 'auto-clear could not be started';
      return dest === 'osc52' ? `it clears in ${o.clearAfter} s` : `it clears in ${o.clearAfter} s if unchanged`;
    };

    if (o.osc52) {
      if (!writeTty(platform, env, osc52For(pw, env), { requireConsole: true })) {
        throw guard('no terminal attached (agents and services have none); run it yourself in a terminal');
      }
    }
    if (o.echo) {
      errOut('WARNING: printed to stdout: anything that captured this output has the password');
      process.stdout.write(pw + '\n');
    }
    if (o.osc52) {
      const extra = env.TMUX ? ' (tmux: needs `set -g set-clipboard on`)' : '';
      errOut(`Sent (${pw.length} chars) to your terminal's clipboard via OSC 52${extra}; ${await clearNote('osc52')}.`);
    }
    if (toClipboard) {
      await copyToClipboard(pw, tools);
      errOut(`Copied (${pw.length} chars) to the clipboard; ${await clearNote('clipboard')}.`);
    }
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
