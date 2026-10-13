/**
 * NautilusTrader ("노틸러스 엔진") as the desk's execution simulator.
 *
 * The desk keeps deciding; NautilusTrader executes. The replay exports every
 * evaluation that could open or close a trade (replay.ts collectSignals), and
 * resources/nautilus/desk_backtest.py feeds Binance's historical aggregate
 * trades to Nautilus's simulated exchange as TradeTicks, submits the desk's
 * bracket orders against them, and reports the fills.
 *
 * Python and nautilus_trader stay out of the app bundle: on first use the desk
 * finds a Python 3.12–3.14, creates <userData>/trading/nautilus/venv and pip
 * installs the pinned nautilus_trader there. Nothing touches the system Python.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { NautilusStatusView } from '../../shared/trading';

export const NAUTILUS_VERSION = '1.231.0';

export interface ProcResult { code: number | null; stdout: string; stderr: string }

/** How the desk starts processes (injected so tests never spawn Python). */
export type Runner = (cmd: string, args: string[], opts?: { cwd?: string; onLine?: (line: string) => void; timeoutMs?: number }) => Promise<ProcResult>;

export const spawnRunner: Runner = (cmd, args, opts = {}) => new Promise((resolve) => {
  let stdout = '';
  let stderr = '';
  let buf = '';
  let child;
  try {
    child = spawn(cmd, args, { cwd: opts.cwd, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
  } catch (e) {
    resolve({ code: -1, stdout: '', stderr: e instanceof Error ? e.message : String(e) });
    return;
  }
  const timer = opts.timeoutMs ? setTimeout(() => child.kill(), opts.timeoutMs) : null;
  child.stdout.on('data', (d: Buffer) => {
    const s = d.toString('utf8');
    stdout += s;
    buf += s;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      opts.onLine?.(buf.slice(0, i).replace(/\r$/, ''));
      buf = buf.slice(i + 1);
    }
  });
  child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
  child.on('error', (e) => { if (timer) clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + e.message }); });
  child.on('close', (code) => {
    if (timer) clearTimeout(timer);
    if (buf) opts.onLine?.(buf);
    resolve({ code, stdout, stderr });
  });
});

/** Python launchers to try, most specific first. */
export function pythonCandidates(platform: NodeJS.Platform = process.platform): Array<{ cmd: string; args: string[] }> {
  if (platform === 'win32') {
    return [
      { cmd: 'py', args: ['-3.13'] }, { cmd: 'py', args: ['-3.12'] }, { cmd: 'py', args: ['-3.14'] },
      { cmd: 'python', args: [] }, { cmd: 'python3', args: [] }
    ];
  }
  return [
    { cmd: 'python3.13', args: [] }, { cmd: 'python3.12', args: [] }, { cmd: 'python3.14', args: [] }, { cmd: 'python3', args: [] }
  ];
}

/** "Python 3.12.4" → [3, 12]; supported: 3.12 ≤ v < 3.15 (nautilus_trader 1.231.0). */
export function parsePythonVersion(out: string): { major: number; minor: number; ok: boolean } | null {
  const m = /Python\s+(\d+)\.(\d+)/i.exec(out);
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return { major, minor, ok: major === 3 && minor >= 12 && minor < 15 };
}

export function venvPython(venvDir: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? path.join(venvDir, 'Scripts', 'python.exe') : path.join(venvDir, 'bin', 'python');
}

export class NautilusEnv {
  private installing = false;
  private lastStatus: NautilusStatusView | null = null;

  constructor(
    private readonly root: string,
    private readonly scriptDir: string,
    private readonly run: Runner = spawnRunner,
    private readonly platform: NodeJS.Platform = process.platform
  ) {}

  get venvDir(): string { return path.join(this.root, 'venv'); }
  get python(): string { return venvPython(this.venvDir, this.platform); }
  get script(): string { return path.join(this.scriptDir, 'desk_backtest.py'); }

  /** The first supported system Python, or null. */
  async findPython(): Promise<{ cmd: string; args: string[]; version: string } | null> {
    for (const c of pythonCandidates(this.platform)) {
      const r = await this.run(c.cmd, [...c.args, '--version'], { timeoutMs: 15_000 });
      const v = parsePythonVersion(`${r.stdout} ${r.stderr}`);
      if (r.code === 0 && v?.ok) return { ...c, version: `${v.major}.${v.minor}` };
    }
    return null;
  }

  async status(): Promise<NautilusStatusView> {
    if (this.installing) return { state: 'installing', message: this.lastStatus?.message };
    if (existsSync(this.python)) {
      const r = await this.run(this.python, ['-c', 'import nautilus_trader, sys; print(nautilus_trader.__version__); print(sys.version.split()[0])'], { timeoutMs: 60_000 });
      if (r.code === 0) {
        const [version, py] = r.stdout.trim().split(/\r?\n/);
        return (this.lastStatus = { state: 'ready', version, python: py });
      }
      return (this.lastStatus = { state: 'not-installed', message: '가상환경은 있지만 nautilus_trader를 불러오지 못했습니다' });
    }
    const py = await this.findPython();
    return (this.lastStatus = py ? { state: 'not-installed', python: py.version } : { state: 'missing-python' });
  }

  /** Create the venv and pip install the pinned nautilus_trader (a few hundred MB, several minutes). */
  async install(onLine?: (line: string) => void): Promise<NautilusStatusView> {
    if (this.installing) return { state: 'installing' };
    this.installing = true;
    try {
      mkdirSync(this.root, { recursive: true });
      if (!existsSync(this.python)) {
        const py = await this.findPython();
        if (!py) return (this.lastStatus = { state: 'missing-python', message: 'Python 3.12 이상을 찾지 못했습니다' });
        onLine?.(`Python ${py.version}로 가상환경을 만듭니다`);
        const v = await this.run(py.cmd, [...py.args, '-m', 'venv', this.venvDir], { timeoutMs: 300_000, onLine });
        if (v.code !== 0) return (this.lastStatus = { state: 'error', message: `가상환경 생성 실패: ${(v.stderr || v.stdout).slice(-400)}` });
      }
      onLine?.(`nautilus_trader ${NAUTILUS_VERSION} 설치 중 (몇 분 걸립니다)`);
      await this.run(this.python, ['-m', 'pip', 'install', '--upgrade', 'pip'], { timeoutMs: 600_000, onLine });
      const r = await this.run(this.python, ['-m', 'pip', 'install', `nautilus_trader==${NAUTILUS_VERSION}`], { timeoutMs: 1_800_000, onLine });
      if (r.code !== 0) return (this.lastStatus = { state: 'error', message: `설치 실패: ${(r.stderr || r.stdout).slice(-600)}` });
    } finally {
      this.installing = false;
    }
    return this.status();
  }

  /**
   * Run one job. `job.out` receives the result; PROGRESS lines are relayed.
   */
  async runJob(jobDir: string, job: Record<string, unknown>, onProgress: (pct: number, msg: string) => void): Promise<Record<string, unknown>> {
    mkdirSync(jobDir, { recursive: true });
    const jobPath = path.join(jobDir, 'job.json');
    const out = path.join(jobDir, 'result.json');
    writeFileSync(jobPath, JSON.stringify({ ...job, out }), 'utf8');
    const r = await this.run(this.python, [this.script, jobPath], {
      cwd: jobDir,
      timeoutMs: 6 * 3_600_000,
      onLine: (line) => {
        const m = /^PROGRESS\s+([\d.]+)\s+(.*)$/.exec(line);
        if (m) onProgress(Number(m[1]), m[2]);
      }
    });
    if (!existsSync(out)) throw new Error(`노틸러스 실행 실패 (종료 코드 ${r.code}): ${(r.stderr || r.stdout).slice(-800)}`);
    const result = JSON.parse(readFileSync(out, 'utf8')) as Record<string, unknown>;
    if (typeof result.error === 'string') throw new Error(`노틸러스 오류: ${result.error}`);
    return result;
  }
}
