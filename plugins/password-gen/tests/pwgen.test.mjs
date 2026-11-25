// Tests for skills/password-gen/scripts/pwgen.mjs. No real clipboard and no real terminal is
// touched: the CLI runs with PWGEN_CLIPBOARD_CMD / PWGEN_CLIPBOARD_READ_CMD / PWGEN_TTY_PATH.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  SETS, LIMITS, EXIT, buildSets, generatePassword, passesSetRule, parseArgs, validateSymbols, sha256Hex,
  clipboardTools, isSsh, isX11Forwarded, osc52Sequence, osc52For, ttyCandidates, shouldClear, buildClearSpawn,
} from '../skills/password-gen/scripts/pwgen.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'skills', 'password-gen', 'scripts', 'pwgen.mjs');
const DEFAULT_ALL = Object.values(SETS).join('');
const DEFAULT_SETS = buildSets();

let tmp;
let copyScript;
let readScript;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pwgen-test-'));
  // Fake clipboard: stdin -> $PWGEN_TEST_CLIP (a file); read prints it.
  copyScript = path.join(tmp, 'fake-copy.mjs');
  fs.writeFileSync(copyScript, "import fs from 'node:fs';\nconst c=[];process.stdin.on('data',d=>c.push(d));process.stdin.on('end',()=>fs.writeFileSync(process.env.PWGEN_TEST_CLIP,Buffer.concat(c)));\n");
  readScript = path.join(tmp, 'fake-read.mjs');
  fs.writeFileSync(readScript, "import fs from 'node:fs';\nprocess.stdout.write(fs.readFileSync(process.env.PWGEN_TEST_CLIP));\n");
});
after(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* a clear child may still hold a file */ }
});

let n = 0;
const tmpFile = (p) => path.join(tmp, `${p}-${++n}`);

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of ['SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY', 'DISPLAY', 'WAYLAND_DISPLAY', 'STY', 'TMUX',
    'PWGEN_CLIPBOARD_CMD', 'PWGEN_CLIPBOARD_READ_CMD', 'PWGEN_TTY_PATH', 'PWGEN_PLATFORM', 'PWGEN_TEST_CLIP']) delete env[k];
  return { ...env, ...extra };
}

function run(args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env, timeout: 30000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout, stderr });
    });
  });
}

const clipEnv = (clip, extra = {}) => cleanEnv({ PWGEN_CLIPBOARD_CMD: copyScript, PWGEN_TEST_CLIP: clip, ...extra });
const onlyAllowed = (pw, all) => [...pw].every((c) => all.includes(c));

// ---------------------------------------------------------------- generator
test('generator: length, every set present, only allowed chars (2,000 samples at 12 and 20)', () => {
  for (const len of [12, 20]) {
    for (let i = 0; i < 2000; i++) {
      const pw = generatePassword(len, DEFAULT_SETS);
      assert.equal(pw.length, len);
      assert.ok(passesSetRule(pw, DEFAULT_SETS), pw);
      assert.ok(onlyAllowed(pw, DEFAULT_ALL));
    }
  }
});

test('generator: no lookalikes in the default sets', () => {
  for (const c of 'IOl01') assert.ok(!DEFAULT_ALL.includes(c), c);
});

test('generator: --no-symbols and --symbols are respected', () => {
  const noSym = buildSets({ noSymbols: true });
  assert.equal(noSym.length, 3);
  for (let i = 0; i < 500; i++) {
    const pw = generatePassword(16, noSym);
    assert.ok(/^[A-Za-z0-9]+$/.test(pw));
    assert.ok(passesSetRule(pw, noSym));
  }
  const custom = buildSets({ symbols: '@$' });
  for (let i = 0; i < 500; i++) {
    const pw = generatePassword(12, custom);
    assert.ok(onlyAllowed(pw, custom.join('')));
    assert.ok(/[@$]/.test(pw));
    assert.ok(!/[!#%*\-_=+?]/.test(pw));
  }
});

test('generator: rough uniformity over 50,000 chars (each within +-25% of expected)', () => {
  const counts = new Map([...DEFAULT_ALL].map((c) => [c, 0]));
  let total = 0;
  while (total < 50000) {
    const pw = generatePassword(250, DEFAULT_SETS);
    for (const c of pw) counts.set(c, counts.get(c) + 1);
    total += pw.length;
  }
  const expected = total / DEFAULT_ALL.length;
  for (const [c, k] of counts) {
    assert.ok(k > expected * 0.75 && k < expected * 1.25, `${c}: ${k} vs ${expected}`);
  }
});

// ---------------------------------------------------------------- arguments
test('args: defaults', () => {
  const o = parseArgs([]);
  assert.equal(o.length, 20);
  assert.equal(o.clearAfter, 45);
  assert.equal(o.echo, false);
  assert.equal(o.osc52, false);
});

test('args: length bounds', () => {
  assert.equal(parseArgs(['--length', '12']).length, 12);
  assert.equal(parseArgs(['--length=256']).length, 256);
  for (const v of ['11', '257', '0', '-5', '20.5', 'abc', '']) {
    assert.throws(() => parseArgs(['--length', v]), (e) => e.exitCode === EXIT.USAGE, v);
  }
  assert.throws(() => parseArgs(['--length']), (e) => e.exitCode === EXIT.USAGE);
});

test('args: --symbols validation and conflict', () => {
  assert.equal(validateSymbols('@@$'), '@$');
  for (const v of ['', 'a!', '!1', '! #', '!\t', '!\u00e9']) {
    assert.throws(() => validateSymbols(v), (e) => e.exitCode === EXIT.USAGE, JSON.stringify(v));
  }
  assert.throws(() => parseArgs(['--no-symbols', '--symbols', '@']), (e) => e.exitCode === EXIT.USAGE && /conflict/.test(e.message));
});

test('args: --clear-after bounds, unknown flags, stray args', () => {
  assert.equal(parseArgs(['--clear-after', '0']).clearAfter, 0);
  assert.equal(parseArgs(['--clear-after', '3600']).clearAfter, 3600);
  assert.throws(() => parseArgs(['--clear-after', '3601']), (e) => e.exitCode === EXIT.USAGE);
  assert.throws(() => parseArgs(['--clear-after', '-1']), (e) => e.exitCode === EXIT.USAGE);
  assert.throws(() => parseArgs(['--bogus']), (e) => e.exitCode === EXIT.USAGE && /unknown flag/.test(e.message));
  assert.throws(() => parseArgs(['hello']), (e) => e.exitCode === EXIT.USAGE);
  assert.throws(() => parseArgs(['--echo=1']), (e) => e.exitCode === EXIT.USAGE);
});

test('args: --_clear is internal and refused with other flags', () => {
  const h = sha256Hex('x');
  assert.deepEqual(parseArgs(['--_clear', h, '45', 'clipboard']).clear, { hash: h, sec: 45, dest: 'clipboard' });
  assert.throws(() => parseArgs(['--echo', '--_clear', h, '45', 'clipboard']), (e) => e.exitCode === EXIT.USAGE);
  assert.throws(() => parseArgs(['--_clear', h, '45', 'clipboard', '--echo']), (e) => e.exitCode === EXIT.USAGE);
  assert.throws(() => parseArgs(['--_clear', 'nothex', '45', 'clipboard']), (e) => e.exitCode === EXIT.USAGE);
  assert.throws(() => parseArgs(['--_clear', h, '45', 'elsewhere']), (e) => e.exitCode === EXIT.USAGE);
});

test('cli: usage errors exit 1, help exits 0', async () => {
  assert.equal((await run(['--length', '5'], cleanEnv())).code, EXIT.USAGE);
  assert.equal((await run(['--nope'], cleanEnv())).code, EXIT.USAGE);
  const h = await run(['--help'], cleanEnv());
  assert.equal(h.code, 0);
  assert.match(h.stdout, /Usage: pwgen\.mjs/);
});

// ---------------------------------------------------------------- never printed
test('normal run: password goes to the clipboard only, never to stdout/stderr', async () => {
  const clip = tmpFile('clip');
  const r = await run(['--clear-after', '0'], clipEnv(clip));
  assert.equal(r.code, 0, r.stderr);
  const pw = fs.readFileSync(clip, 'utf8');
  assert.equal(pw.length, 20);
  assert.ok(passesSetRule(pw, DEFAULT_SETS));
  assert.ok(onlyAllowed(pw, DEFAULT_ALL));
  assert.equal(r.stdout, '');
  assert.ok(!r.stderr.includes(pw));
  assert.match(r.stderr, /Copied \(20 chars\) to the clipboard/);
});

test('normal run: default clear-after note, and --length/--no-symbols reach the clipboard', async () => {
  const clip = tmpFile('clip');
  const r = await run(['--length', '32', '--no-symbols', '--clear-after', '0'], clipEnv(clip));
  assert.equal(r.code, 0, r.stderr);
  const pw = fs.readFileSync(clip, 'utf8');
  assert.ok(/^[A-Za-z0-9]{32}$/.test(pw));
  assert.ok(!(r.stdout + r.stderr).includes(pw));
  assert.match(r.stderr, /auto-clear is off/);
});

test('auto-clear: clears when unchanged, leaves a changed clipboard alone', async () => {
  const same = tmpFile('clip');
  const changed = tmpFile('clip');
  const [a, b] = await Promise.all([
    run(['--clear-after', '1'], clipEnv(same, { PWGEN_CLIPBOARD_READ_CMD: readScript })),
    run(['--clear-after', '1'], clipEnv(changed, { PWGEN_CLIPBOARD_READ_CMD: readScript })),
  ]);
  assert.equal(a.code, 0, a.stderr);
  assert.equal(b.code, 0, b.stderr);
  assert.match(a.stderr, /clears in 1 s if unchanged/);
  assert.equal(fs.readFileSync(same, 'utf8').length, 20);
  fs.writeFileSync(changed, 'something-else');
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && fs.readFileSync(same, 'utf8') !== '') await new Promise((r) => setTimeout(r, 200));
  assert.equal(fs.readFileSync(same, 'utf8'), '');
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(fs.readFileSync(changed, 'utf8'), 'something-else');
});

// ---------------------------------------------------------------- --echo
test('--echo: stdout is exactly the password + newline, warning on stderr, no clipboard', async () => {
  const clip = tmpFile('clip');
  const r = await run(['--echo'], clipEnv(clip));
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^[^\n]{20}\n$/);
  const pw = r.stdout.slice(0, -1);
  assert.ok(passesSetRule(pw, DEFAULT_SETS));
  assert.match(r.stderr, /printed to stdout: anything that captured this output has the password/);
  assert.ok(!r.stderr.includes(pw));
  assert.ok(!fs.existsSync(clip));
});

test('--echo --osc52: both, still no local clipboard', async () => {
  const clip = tmpFile('clip');
  const tty = tmpFile('tty');
  fs.writeFileSync(tty, '');
  const r = await run(['--echo', '--osc52', '--clear-after', '0'], clipEnv(clip, { PWGEN_TTY_PATH: tty }));
  assert.equal(r.code, 0, r.stderr);
  const pw = r.stdout.slice(0, -1);
  assert.equal(fs.readFileSync(tty, 'utf8'), osc52For(pw, {}));
  assert.ok(!fs.existsSync(clip));
});

// ---------------------------------------------------------------- SSH guard
test('SSH: local clipboard refused (exit 2) with an --osc52 suggestion', async () => {
  for (const k of ['SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY']) {
    const clip = tmpFile('clip');
    const r = await run(['--clear-after', '0'], clipEnv(clip, { [k]: '203.0.113.7 5555 10.0.0.1 22' }));
    assert.equal(r.code, EXIT.GUARDRAIL, k);
    assert.match(r.stderr, /--osc52/);
    assert.match(r.stderr, /remote host/);
    assert.ok(!fs.existsSync(clip));
  }
});

test('SSH: X11-forwarded DISPLAY on linux is allowed', async () => {
  const clip = tmpFile('clip');
  const r = await run(['--clear-after', '0'], clipEnv(clip, { PWGEN_PLATFORM: 'linux', SSH_CLIENT: '203.0.113.7 5555 22', DISPLAY: 'localhost:10.0' }));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fs.readFileSync(clip, 'utf8').length, 20);
});

test('SSH detection helpers', () => {
  assert.equal(isSsh({}), false);
  assert.equal(isSsh({ SSH_TTY: '/dev/pts/1' }), true);
  assert.equal(isX11Forwarded('localhost:10.0'), true);
  assert.equal(isX11Forwarded('localhost:10'), true);
  assert.equal(isX11Forwarded(':0'), false);
  assert.equal(isX11Forwarded(':1.0'), false);
  assert.equal(isX11Forwarded(undefined), false);
});

// ---------------------------------------------------------------- --osc52
test('--osc52: the tty receives exactly the OSC 52 sequence; nothing on stdout', async () => {
  const tty = tmpFile('tty');
  fs.writeFileSync(tty, '');
  const r = await run(['--osc52', '--clear-after', '0'], cleanEnv({ PWGEN_TTY_PATH: tty }));
  assert.equal(r.code, 0, r.stderr);
  const got = fs.readFileSync(tty, 'utf8');
  const m = /^\x1b\]52;c;([A-Za-z0-9+/=]+)\x07$/.exec(got);
  assert.ok(m, JSON.stringify(got));
  const pw = Buffer.from(m[1], 'base64').toString('utf8');
  assert.equal(pw.length, 20);
  assert.ok(passesSetRule(pw, DEFAULT_SETS));
  assert.equal(r.stdout, '');
  assert.ok(!r.stderr.includes(pw) && !r.stderr.includes(m[1]));
  assert.match(r.stderr, /OSC 52/);
});

test('--osc52 works over SSH and notes tmux set-clipboard', async () => {
  const tty = tmpFile('tty');
  fs.writeFileSync(tty, '');
  const r = await run(['--osc52', '--clear-after', '0'], cleanEnv({ PWGEN_TTY_PATH: tty, SSH_CONNECTION: 'x', TMUX: '/tmp/tmux-1/default,1,0' }));
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /set -g set-clipboard on/);
  assert.match(fs.readFileSync(tty, 'utf8'), /^\x1b\]52;c;/);
});

test('--osc52 inside GNU screen: wrapped in DCS passthrough', async () => {
  const tty = tmpFile('tty');
  fs.writeFileSync(tty, '');
  const r = await run(['--osc52', '--clear-after', '0'], cleanEnv({ PWGEN_TTY_PATH: tty, STY: '1234.pts-0.host' }));
  assert.equal(r.code, 0, r.stderr);
  assert.match(fs.readFileSync(tty, 'utf8'), /^\x1bP\x1b\]52;c;[A-Za-z0-9+/=]+\x07\x1b\\$/);
});

test('--osc52 without a terminal: exit 2', async () => {
  const r = await run(['--osc52', '--clear-after', '0'], cleanEnv({ PWGEN_TTY_PATH: path.join(tmp, 'no', 'such', 'dir', 'tty') }));
  assert.equal(r.code, EXIT.GUARDRAIL);
  assert.match(r.stderr, /no terminal attached/);
  assert.equal(r.stdout, '');
});

test('--osc52 auto-clear writes an empty OSC 52 sequence', async () => {
  const tty = tmpFile('tty');
  fs.writeFileSync(tty, '');
  const r = await run(['--osc52', '--clear-after', '1'], cleanEnv({ PWGEN_TTY_PATH: tty }));
  assert.equal(r.code, 0, r.stderr);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !fs.readFileSync(tty, 'utf8').endsWith('\x1b]52;c;\x07')) await new Promise((res) => setTimeout(res, 200));
  assert.match(fs.readFileSync(tty, 'utf8'), /^\x1b\]52;c;[A-Za-z0-9+/=]+\x07\x1b\]52;c;\x07$/);
});

test('osc52 helpers and tty candidates', () => {
  assert.equal(osc52Sequence('QUJD', {}), '\x1b]52;c;QUJD\x07');
  assert.equal(osc52Sequence('QUJD', { STY: 's' }), '\x1bP\x1b]52;c;QUJD\x07\x1b\\');
  assert.equal(osc52For('ABC', {}), '\x1b]52;c;QUJD\x07');
  assert.deepEqual(ttyCandidates('linux', {}).map((c) => c.path), ['/dev/tty']);
  assert.deepEqual(ttyCandidates('darwin', {}).map((c) => c.path), ['/dev/tty']);
  assert.deepEqual(ttyCandidates('win32', {}).map((c) => c.path), ['\\\\.\\CONOUT$', 'CONOUT$']);
  assert.deepEqual(ttyCandidates('win32', { PWGEN_TTY_PATH: 'x' }).map((c) => c.path), ['x']);
});

// ---------------------------------------------------------------- auto-clear helper
test('shouldClear: hash match -> clear, mismatch -> leave', () => {
  const pw = 'Abc2#defghijkmnp';
  const h = sha256Hex(pw);
  assert.equal(shouldClear(pw, h), true);
  assert.equal(shouldClear(pw + '\r\n', h), true); // Get-Clipboard appends a newline
  assert.equal(shouldClear(pw + '\n', h), true);
  assert.equal(shouldClear('something else', h), false);
  assert.equal(shouldClear('', h), false);
  assert.equal(shouldClear(null, h), false);
});

test('clear child argv carries only the hash, never the password', () => {
  const pw = generatePassword(20, DEFAULT_SETS);
  const h = sha256Hex(pw);
  for (const platform of ['linux', 'darwin', 'win32']) {
    for (const dest of ['clipboard', 'osc52']) {
      const s = buildClearSpawn(h, 45, dest, platform, '/x/pwgen.mjs', { SystemRoot: 'C:\\Windows' });
      const argv = [s.cmd, ...s.args].join(' ');
      assert.ok(!argv.includes(pw), `${platform} ${dest}`);
      assert.ok(argv.includes(`--_clear ${h} 45 ${dest}`) || argv.includes(`"--_clear" "${h}" "45" "${dest}"`), argv);
      assert.equal(s.options.stdio, 'ignore');
      assert.equal(s.options.env, undefined); // inherits the parent env, which never holds the password
    }
  }
  assert.deepEqual(buildClearSpawn(h, 45, 'clipboard', 'linux', '/x/pwgen.mjs').args, ['/x/pwgen.mjs', '--_clear', h, '45', 'clipboard']);
  assert.equal(buildClearSpawn(h, 45, 'clipboard', 'linux').options.detached, true);
  assert.equal(buildClearSpawn(h, 45, 'osc52', 'linux').options.detached, false); // keeps the controlling tty
  const w = buildClearSpawn(h, 45, 'osc52', 'win32', 'C:\\x\\pwgen.mjs', { SystemRoot: 'C:\\Windows' });
  assert.equal(w.cmd, 'C:\\Windows\\System32\\cmd.exe'); // start /b keeps the console, escapes the job
  assert.match(w.args.at(-1), /^"start "" \/b "/);
});

// ---------------------------------------------------------------- tool selection per platform
test('clipboardTools: windows uses System32 clip.exe and powershell Get-Clipboard', () => {
  const [t] = clipboardTools('win32', { SystemRoot: 'C:\\Windows' });
  assert.equal(t.write.cmd, 'C:\\Windows\\System32\\clip.exe');
  assert.deepEqual(t.write.args, []);
  assert.match(t.read.cmd, /WindowsPowerShell\\v1\.0\\powershell\.exe$/);
  assert.ok(t.read.args.includes('-NoProfile') && t.read.args.includes('-NonInteractive'));
  assert.match(t.read.args.at(-1), /Get-Clipboard/);
  assert.equal(t.clear.input, '');
});

test('clipboardTools: macOS uses pbcopy/pbpaste', () => {
  const [t] = clipboardTools('darwin', {});
  assert.equal(t.write.cmd, '/usr/bin/pbcopy');
  assert.equal(t.read.cmd, '/usr/bin/pbpaste');
});

test('clipboardTools: linux wayland -> wl-copy, X11 -> xclip then xsel, none -> guardrail', () => {
  const [w] = clipboardTools('linux', { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' });
  assert.equal(w.write.cmd, 'wl-copy');
  assert.deepEqual(w.read.args, ['-n']);
  assert.deepEqual(w.clear.args, ['--clear']);
  assert.match(w.install, /wl-clipboard/);
  const x = clipboardTools('linux', { DISPLAY: ':0' });
  assert.deepEqual(x.map((t) => t.name), ['xclip', 'xsel']);
  assert.deepEqual(x[0].write.args, ['-selection', 'clipboard']);
  assert.equal(x[0].write.detached, true);
  assert.deepEqual(x[0].read.args, ['-selection', 'clipboard', '-o']);
  assert.deepEqual(x[1].write.args, ['--clipboard', '--input']);
  assert.deepEqual(x[1].read.args, ['--clipboard', '--output']);
  assert.throws(() => clipboardTools('linux', {}), (e) => e.exitCode === EXIT.GUARDRAIL && /no graphical session/.test(e.message));
});

test('clipboardTools: SSH refuses everywhere except linux X11 forwarding (which uses X11 even with wayland)', () => {
  for (const p of ['win32', 'darwin', 'linux']) {
    assert.throws(() => clipboardTools(p, { SSH_CONNECTION: 'x', DISPLAY: ':0' }), (e) => e.exitCode === EXIT.GUARDRAIL, p);
  }
  assert.throws(() => clipboardTools('darwin', { SSH_CONNECTION: 'x', DISPLAY: 'localhost:10.0' }), (e) => e.exitCode === EXIT.GUARDRAIL);
  const t = clipboardTools('linux', { SSH_CONNECTION: 'x', DISPLAY: 'localhost:10.0', WAYLAND_DISPLAY: 'wayland-0' });
  assert.equal(t[0].name, 'xclip');
});

test('clipboardTools: PWGEN_CLIPBOARD_CMD override (test hook) runs scripts with node', () => {
  const [t] = clipboardTools('linux', { PWGEN_CLIPBOARD_CMD: '/x/copy.mjs', PWGEN_CLIPBOARD_READ_CMD: '/x/read.mjs' });
  assert.equal(t.write.cmd, process.execPath);
  assert.deepEqual(t.write.args, ['/x/copy.mjs']);
  assert.deepEqual(t.read.args, ['/x/read.mjs']);
  const [b] = clipboardTools('linux', { PWGEN_CLIPBOARD_CMD: '/x/copy-bin' });
  assert.equal(b.write.cmd, '/x/copy-bin');
  assert.equal(b.read, null);
});

test('limits are pinned', () => {
  assert.equal(LIMITS.LENGTH_DEFAULT, 20);
  assert.equal(LIMITS.LENGTH_MIN, 12);
  assert.equal(LIMITS.LENGTH_MAX, 256);
  assert.equal(LIMITS.CLEAR_DEFAULT, 45);
  assert.equal(LIMITS.CLEAR_MAX, 3600);
});
