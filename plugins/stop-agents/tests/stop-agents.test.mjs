// Tests for bin/stop-agents (bash) and bin/stop-agents.ps1 against a FAKE `claude` placed first on PATH.
// The real claude is never asked to stop anything: a before() guard checks that `claude` resolves to the fake.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, '..', 'bin');
const fwd = (p) => p.replace(/\\/g, '/');
const IS_WIN = process.platform === 'win32';

// No cwd fields on purpose (JSON backslashes bite). No "id" on the interactive session.
const FIXTURE = [
  { pid: 1111, kind: 'interactive', sessionId: 'ed21', name: 'ui-session', status: 'idle' },
  { pid: 2222, id: 'a877af9b', kind: 'background', sessionId: 's-a877', name: 'alpha', state: 'done', status: 'finished' },
  { pid: 3333, kind: 'background', id: 'deadbeef', sessionId: 's-dead', name: 'nopid-id', state: 'working', status: 'x' },
  { pid: 4444, id: 'selfself', kind: 'background', sessionId: 'SELF', name: 'me', state: 'blocked', status: 'waiting' },
  { pid: 5555, id: 'badbad00', kind: 'background', sessionId: 's-bad', name: 'bad', state: 'working', status: 'busy' },
];
delete FIXTURE[2].pid; // deadbeef has an id but no pid

const FAKE_SH = `#!/usr/bin/env bash
case "\${1:-}" in
  agents) cat "$FAKE_FIXTURE" ;;
  stop)
    echo "\${2:-}" >> "$FAKE_LOG"
    if [ -z "\${2:-}" ] || [ "$2" = "badbad00" ]; then exit 1; fi ;;
esac
`;
const FAKE_CMD = [
  '@echo off',
  'if "%~1"=="agents" type "%FAKE_FIXTURE%"',
  'if "%~1"=="agents" exit /b 0',
  'if not "%~1"=="stop" exit /b 0',
  '>>"%FAKE_LOG%" echo %~2',
  'if "%~2"=="" exit /b 1',
  'if "%~2"=="badbad00" exit /b 1',
  'exit /b 0',
  '',
].join('\r\n');

let tmp, fixtureFile, logFile, fakeEnv;
const bashExe = (() => {
  if (!IS_WIN) return 'bash';
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')]) {
    if (!base) continue;
    const p = path.join(base, 'Git', 'bin', 'bash.exe');
    if (fs.existsSync(p)) return p;
  }
  return 'bash';
})();

function makeEnv() {
  const env = { ...process.env, FAKE_FIXTURE: fixtureFile, FAKE_LOG: logFile };
  delete env.CLAUDE_CODE_SESSION_ID;
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
  env[key] = tmp + path.delimiter + (env[key] || '');
  return env;
}

function runBash(args, extraEnv = {}) {
  return spawnSync(bashExe, [fwd(path.join(BIN, 'stop-agents')), ...args], {
    env: { ...fakeEnv, ...extraEnv }, input: '', encoding: 'utf8', timeout: 60000,
    detached: !IS_WIN, // no controlling terminal on POSIX, so /dev/tty cannot be opened
  });
}
function runPs(args, extraEnv = {}) {
  return spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(BIN, 'stop-agents.ps1'), ...args], {
    env: { ...fakeEnv, ...extraEnv }, input: '', encoding: 'utf8', timeout: 120000,
  });
}
const stopped = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).sort() : []);

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-agents-test-'));
  fixtureFile = path.join(tmp, 'fixture.json');
  logFile = path.join(tmp, 'stopped.log');
  fs.writeFileSync(fixtureFile, JSON.stringify(FIXTURE));
  fs.writeFileSync(path.join(tmp, 'claude'), FAKE_SH, { mode: 0o755 });
  fs.writeFileSync(path.join(tmp, 'claude.cmd'), FAKE_CMD);
  fakeEnv = makeEnv();
  // Safety guard: `claude` must resolve to the fake in both shells, or no test runs.
  const probe = spawnSync(bashExe, ['-c', 'claude agents --json'], { env: fakeEnv, encoding: 'utf8', input: '', timeout: 30000 });
  assert.equal(probe.stdout, JSON.stringify(FIXTURE), 'bash does not see the fake claude first on PATH; refusing to run');
  if (IS_WIN) {
    const p2 = spawnSync('powershell', ['-NoProfile', '-Command', '& claude agents --json'], { env: fakeEnv, encoding: 'utf8', input: '', timeout: 60000 });
    assert.equal(p2.stdout.trim(), JSON.stringify(FIXTURE), 'PowerShell does not see the fake claude first on PATH; refusing to run');
  }
});
after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });
beforeEach(() => { fs.rmSync(logFile, { force: true }); });

const flavors = [
  ['bash', runBash, false],
  ['powershell', runPs, !IS_WIN],
];

for (const [name, run, skip] of flavors) {
  const t = (title, fn) => test(`${name}: ${title}`, { skip }, fn);

  t('dry-run lists only entries with id and pid, stops nothing', () => {
    const r = run(['--dry-run']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Found 3 background agent/);
    for (const id of ['a877af9b', 'badbad00', 'selfself']) assert.ok(r.stdout.includes(id), id);
    assert.ok(!r.stdout.includes('deadbeef'));
    assert.ok(!r.stdout.includes('ui-session'));
    assert.match(r.stdout, /Dry run: nothing stopped/);
    assert.deepEqual(stopped(), []);
  });

  t('-y stops id+pid entries, never the interactive one or the one without a pid', () => {
    const r = run(['-y']);
    assert.deepEqual(stopped(), ['a877af9b', 'badbad00', 'selfself']);
    assert.ok(!r.stdout.includes('deadbeef'));
  });

  t('CLAUDE_CODE_SESSION_ID skips the current session with a message', () => {
    const r = run(['-y'], { CLAUDE_CODE_SESSION_ID: 'SELF' });
    assert.match(r.stdout, /Skipping selfself \(me\): this is the current session\./);
    assert.deepEqual(stopped(), ['a877af9b', 'badbad00']);
    const d = run(['--dry-run'], { CLAUDE_CODE_SESSION_ID: 'SELF' });
    assert.match(d.stdout, /Skipping selfself \(me\): this is the current session\./);
    assert.match(d.stdout, /Found 2 background agent/);
  });

  t('a failed stop is reported, the others still stop, exit code 1', () => {
    const r = run(['-y']);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /Stopping badbad00 \(bad\)\.\.\. failed/);
    assert.match(r.stdout, /Stopping a877af9b \(alpha\)\.\.\. ok/);
    assert.match(r.stdout, /Done: 2 stopped, 1 failed\./);
    assert.deepEqual(stopped(), ['a877af9b', 'badbad00', 'selfself']);
  });

  t('no -y and no terminal: says so, stops nothing, exit 0', () => {
    const r = run([]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /No terminal to confirm; rerun with -y to stop them\./);
    assert.deepEqual(stopped(), []);
  });

  t('-s done restricts by state', () => {
    const d = run(['-s', 'done', '--dry-run']);
    assert.match(d.stdout, /Found 1 background agent/);
    assert.ok(d.stdout.includes('a877af9b'));
    assert.ok(!d.stdout.includes('badbad00'));
    const r = run(['-s', 'done', '-y']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(stopped(), ['a877af9b']);
  });
}
