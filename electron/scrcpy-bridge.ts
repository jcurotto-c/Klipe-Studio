/**
 * scrcpy + adb bridge for Android phone screen recording.
 *
 * Resolves the bundled scrcpy.exe + adb.exe under `binaries/` (dev) or
 * `process.resourcesPath/binaries` (packaged), exposes:
 *
 *   listAdbDevices()    — `adb devices -l`, parsed into typed records.
 *   spawnScrcpy(args)   — start scrcpy with --record=<file>, store the
 *                         process handle module-locally (single-session
 *                         invariant).
 *   stopScrcpy()        — SIGINT the process so it flushes the MP4 muxer,
 *                         await exit, return the recorded file path.
 *   readScrcpyFile(p)   — read the MP4 into an ArrayBuffer for the
 *                         renderer to wrap as a Blob, then delete the file.
 *   onDisconnect(cb)    — fires when scrcpy exits unexpectedly (phone
 *                         unplugged, crash) so the HUD can clear state.
 *   cleanupAllScrcpy()  — used on app quit.
 */

import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';

const isDev = process.env['NODE_ENV'] === 'development';

function binariesRoot(): string {
  if (isDev) {
    // electron-dist/scrcpy-bridge.js → ../binaries at the project root.
    return path.join(__dirname, '..', 'binaries');
  }
  // Packaged: electron-builder's `extraResources` lands under resources/.
  return path.join(process.resourcesPath, 'binaries');
}

function scrcpyExePath(): string { return path.join(binariesRoot(), 'scrcpy.exe'); }
function adbExePath(): string { return path.join(binariesRoot(), 'adb.exe'); }
function scrcpyStopScriptPath(): string {
  // Bundled via electron-builder `extraResources` so the .ps1 lives
  // alongside binaries/ in both dev and packaged builds. In dev it's
  // resolved off the project root; in prod off process.resourcesPath.
  if (isDev) return path.join(__dirname, '..', 'scripts', 'scrcpy-stop.ps1');
  return path.join(process.resourcesPath, 'scripts', 'scrcpy-stop.ps1');
}

export function binariesAvailable(): boolean {
  try {
    return fs.existsSync(scrcpyExePath()) && fs.existsSync(adbExePath());
  } catch { return false; }
}

// ─── adb device listing ────────────────────────────────────────────────

export interface AdbDevice {
  serial: string;
  /** Pretty model name from adb's `-l` long output. Falls back to serial. */
  model: string;
  /**
   * 'device'       — ready to be recorded
   * 'unauthorized' — phone needs the user to tap "Allow USB debugging"
   * 'offline'      — phone is connected but adb can't talk to it
   * 'recovery'     — phone is in recovery; not useful for our purposes
   */
  state: 'device' | 'unauthorized' | 'offline' | 'recovery' | 'unknown';
}

export async function listAdbDevices(): Promise<AdbDevice[]> {
  if (!binariesAvailable()) return [];
  return new Promise<AdbDevice[]>((resolve) => {
    execFile(adbExePath(), ['devices', '-l'], { timeout: 6000 }, (err, stdout) => {
      if (err) {
        console.warn('[scrcpy-bridge] adb devices failed:', err);
        resolve([]);
        return;
      }
      resolve(parseAdbDevices(stdout));
    });
  });
}

/**
 * Parse `adb devices -l` output. Format:
 *   List of devices attached
 *   ABC123  device usb:1-2 product:foo model:bar transport_id:1
 *   DEF456  unauthorized
 *   GHI789  offline
 */
function parseAdbDevices(stdout: string): AdbDevice[] {
  const lines = stdout.split(/\r?\n/);
  const out: AdbDevice[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('List of devices')) continue;
    if (trimmed.startsWith('*')) continue; // daemon-start noise
    const parts = trimmed.split(/\s+/);
    const serial = parts[0];
    const stateRaw = parts[1];
    if (!serial || !stateRaw) continue;
    const state: AdbDevice['state'] =
      stateRaw === 'device' ? 'device'
      : stateRaw === 'unauthorized' ? 'unauthorized'
      : stateRaw === 'offline' ? 'offline'
      : stateRaw === 'recovery' ? 'recovery'
      : 'unknown';
    // Pull `model:Pixel_7_Pro` out of the long suffix when present.
    let model = serial;
    for (const tok of parts.slice(2)) {
      if (tok.startsWith('model:')) { model = tok.slice('model:'.length).replace(/_/g, ' '); break; }
    }
    out.push({ serial, model, state });
  }
  return out;
}

// ─── scrcpy spawn / stop ───────────────────────────────────────────────

interface ActiveScrcpy {
  proc: ChildProcessWithoutNullStreams;
  filePath: string;
  serial: string;
  /** Resolved when the process exits — for stopScrcpy to await. */
  exited: Promise<{ exitCode: number | null }>;
  /** Did we explicitly ask scrcpy to stop? If not and it exits, that's a disconnect. */
  expectingExit: boolean;
  /** Captured stderr (last ~64 KB) to surface failure reasons. */
  stderrTail: string;
}

let active: ActiveScrcpy | null = null;

type DisconnectListener = (serial: string, reason: string) => void;
const disconnectListeners = new Set<DisconnectListener>();

export function onScrcpyDisconnect(cb: DisconnectListener): () => void {
  disconnectListeners.add(cb);
  return () => { disconnectListeners.delete(cb); };
}

function emitDisconnect(serial: string, reason: string): void {
  for (const cb of disconnectListeners) {
    try { cb(serial, reason); } catch { /* ignore */ }
  }
}

export interface SpawnArgs {
  serial: string;
  filePath: string;
}

export interface SpawnResult {
  ok: boolean;
  error?: string;
}

export async function spawnScrcpy({ serial, filePath }: SpawnArgs): Promise<SpawnResult> {
  if (active) {
    return { ok: false, error: 'already-recording' };
  }
  if (!binariesAvailable()) {
    return { ok: false, error: 'scrcpy binaries not installed — run `npm run setup:scrcpy`' };
  }

  // Defensive: make sure the target directory exists and the file doesn't yet.
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
  } catch (err) {
    return { ok: false, error: `Couldn't prep output file: ${err instanceof Error ? err.message : String(err)}` };
  }

  const args = [
    `--serial=${serial}`,
    '--no-window',           // headless — no preview window on the desktop
    '--no-audio',            // audio not captured in v1
    `--record=${filePath}`,  // muxes directly to MP4 (H.264 video)
  ];

  // Force SDL to use the "dummy" video driver. scrcpy's Ctrl+C handler
  // works by pushing an SDL_QUIT event, which the main thread can only
  // consume if SDL was initialized — and `--no-window` skips SDL_INIT_VIDEO
  // unless we coerce SDL into using the headless driver. Without this,
  // sending Ctrl+C never reaches scrcpy's cleanup path and the MP4 muxer
  // is never finalized, leaving us with an unplayable file.
  let proc: ChildProcessWithoutNullStreams;
  try {
    proc = spawn(scrcpyExePath(), args, {
      windowsHide: true,
      env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' },
    });
  } catch (err) {
    return { ok: false, error: `Couldn't spawn scrcpy: ${err instanceof Error ? err.message : String(err)}` };
  }

  console.info(`[scrcpy-bridge] spawned scrcpy PID ${proc.pid} for serial=${serial}, file=${filePath}`);

  let stderrTail = '';
  const STDERR_MAX = 64 * 1024;
  proc.stderr.on('data', (chunk: Buffer) => {
    const s = chunk.toString();
    stderrTail += s;
    if (stderrTail.length > STDERR_MAX) stderrTail = stderrTail.slice(-STDERR_MAX);
    // Forward to main console as the recording proceeds so the user can
    // see why a recording is broken without re-running.
    for (const line of s.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) console.info(`[scrcpy] ${trimmed}`);
    }
  });
  proc.stdout.on('data', () => { /* scrcpy is quiet on stdout in --no-window mode */ });

  let exitResolve!: (v: { exitCode: number | null }) => void;
  const exited = new Promise<{ exitCode: number | null }>((resolve) => { exitResolve = resolve; });

  proc.on('exit', (code) => {
    const wasActive = active;
    if (wasActive && wasActive.proc === proc) {
      const unexpected = !wasActive.expectingExit;
      // Mark as exited but keep the handle so stopScrcpy() can still
      // resolve the file path; cleanup happens after readScrcpyFile().
      if (unexpected) {
        const reason = (stderrTail.split('\n').filter(Boolean).pop() || 'unknown').slice(0, 240);
        emitDisconnect(wasActive.serial, reason);
        active = null;
      }
    }
    exitResolve({ exitCode: code });
  });

  proc.on('error', (err) => {
    console.warn('[scrcpy-bridge] proc error:', err);
  });

  active = {
    proc,
    filePath,
    serial,
    exited,
    expectingExit: false,
    stderrTail: '',
  };

  // Give scrcpy a brief moment to fail fast (e.g. binary missing, phone
  // disappeared between listDevices and now). If it exits within 1.2s, the
  // recording isn't going to happen.
  const fastFail = await Promise.race([
    exited.then((r) => ({ done: true as const, ...r })),
    new Promise<{ done: false }>((resolve) => setTimeout(() => resolve({ done: false }), 1200)),
  ]);
  if (fastFail.done) {
    active = null;
    const tail = stderrTail.split('\n').filter(Boolean).pop() || `exit ${fastFail.exitCode}`;
    return { ok: false, error: tail.slice(0, 240) };
  }

  return { ok: true };
}

export interface StopResult {
  filePath: string | null;
  exitCode: number | null;
  /** True when scrcpy was no longer active when stop was called (e.g. disconnected). */
  alreadyExited?: boolean;
}

export async function stopScrcpy(): Promise<StopResult> {
  const cur = active;
  if (!cur) {
    return { filePath: null, exitCode: null, alreadyExited: true };
  }
  cur.expectingExit = true;

  // Windows: Node's `child.kill()` is always TerminateProcess — scrcpy's
  // signal handler never runs, the libavformat muxer never writes the
  // moov atom, and the resulting MP4 is unplayable. The only way to
  // deliver a true Ctrl+C signal between processes on Windows is via
  // GenerateConsoleCtrlEvent, which we invoke through a tiny PowerShell
  // helper that AttachConsoles to scrcpy first.
  console.info(`[scrcpy-bridge] sending Ctrl+C to scrcpy PID ${cur.proc.pid}…`);
  await sendCtrlCToScrcpy(cur.proc.pid!).catch((err) => {
    console.warn('[scrcpy-bridge] Ctrl+C helper failed:', err);
  });

  // Wait for scrcpy to actually exit. No artificial timeout — scrcpy
  // needs as long as it needs to flush the muxer, and rushing it produces
  // truncated files. If for some reason scrcpy never exits, we escalate
  // to a force kill after a generous 10-second window.
  const exitedBy = await Promise.race([
    cur.exited.then((r) => ({ ok: true as const, ...r })),
    new Promise<{ ok: false }>((resolve) => setTimeout(() => resolve({ ok: false }), 10_000)),
  ]);

  if (!exitedBy.ok) {
    console.warn('[scrcpy-bridge] scrcpy did not exit in 10s — escalating to TerminateProcess');
    try { cur.proc.kill(); } catch { /* ignore */ }
    await cur.exited;
  }

  const final = await cur.exited;
  active = null;

  // Log the resulting file size for debugging; a tiny file means the
  // muxer didn't flush.
  let sizeBytes = 0;
  try { sizeBytes = fs.statSync(cur.filePath).size; } catch { /* ignore */ }
  console.info(`[scrcpy-bridge] scrcpy exited (code=${final.exitCode}); file ${cur.filePath} is ${sizeBytes} bytes`);

  return { filePath: cur.filePath, exitCode: final.exitCode };
}

function sendCtrlCToScrcpy(pid: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const scriptPath = scrcpyStopScriptPath();
    if (!fs.existsSync(scriptPath)) {
      reject(new Error(`scrcpy-stop.ps1 not found at ${scriptPath}`));
      return;
    }
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
      '-TargetPid', String(pid),
    ];
    execFile('powershell.exe', args, { timeout: 4000 }, (err, stdout, stderr) => {
      if (stdout) console.info(`[scrcpy-bridge] PS stdout: ${stdout.trim()}`);
      if (err) {
        const msg = (stderr && stderr.trim()) || err.message;
        console.warn(`[scrcpy-bridge] PS Ctrl+C helper failed: ${msg}`);
        reject(new Error(msg));
        return;
      }
      resolve();
    });
  });
}

export async function readScrcpyFile(filePath: string): Promise<ArrayBuffer> {
  const buf = await fs.promises.readFile(filePath);
  // Best-effort delete; the temp file isn't ours after the renderer has it.
  fs.promises.unlink(filePath).catch(() => { /* ignore */ });
  // Copy into a fresh ArrayBuffer; Node's Buffer is a slice over a shared
  // pool and we don't want IPC serialization to leak the rest of the pool.
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return ab;
}

export function cleanupAllScrcpy(): void {
  if (!active) return;
  active.expectingExit = true;
  try { active.proc.kill('SIGINT'); } catch { /* ignore */ }
  // We don't await — `before-quit` should be fast. scrcpy may leave a
  // partial MP4 on disk; the temp file will be cleaned up by the OS.
  try {
    if (active.filePath) fs.unlinkSync(active.filePath);
  } catch { /* ignore */ }
  active = null;
}

export function makeTempMobilePath(): string {
  const name = `klipe-mobile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`;
  return path.join(app.getPath('temp'), name);
}
