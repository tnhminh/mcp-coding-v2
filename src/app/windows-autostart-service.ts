import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './errors.js';
import { runSafeProcess, type SafeProcessResult } from './safe-process-runner.js';

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = 'MCP-Coding-v2';

export interface WindowsAutoStartStatus {
  supported: boolean;
  enabled: boolean;
  provider: 'windows-hkcu-run';
  launcherPath: string;
  note: string;
}

interface WindowsAutoStartOptions {
  projectRoot: string;
  runtimeRoot: string;
  host: string;
  port: number;
  nodeExecutable?: string;
  commandRunner?: (spec: {
    executable: string;
    args: readonly string[];
    cwd: string;
    timeoutSeconds: number;
  }) => Promise<SafeProcessResult>;
}

function psLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export class WindowsAutoStartService {
  private readonly projectRoot: string;
  private readonly launcherPath: string;
  private readonly nodeExecutable: string;
  private readonly commandRunner: NonNullable<WindowsAutoStartOptions['commandRunner']>;

  constructor(private readonly options: WindowsAutoStartOptions) {
    this.projectRoot = path.resolve(options.projectRoot);
    this.launcherPath = path.resolve(options.runtimeRoot, 'tunnel', 'autostart.ps1');
    this.nodeExecutable = path.resolve(options.nodeExecutable ?? process.execPath);
    this.commandRunner = options.commandRunner ?? (async (spec) => runSafeProcess({ ...spec, maxOutputBytes: 64 * 1024 }));
  }

  async status(): Promise<WindowsAutoStartStatus> {
    if (process.platform !== 'win32') return this.snapshot(false, false, 'Windows auto-start is unavailable on this platform.');
    const result = await this.runReg(['query', RUN_KEY, '/v', RUN_VALUE]);
    return this.snapshot(true, result.success, result.success ? 'Starts MCP Coding at Windows sign-in for the current user.' : 'Auto-start is disabled.');
  }

  async enable(): Promise<WindowsAutoStartStatus> {
    if (process.platform !== 'win32') throw new AppError({ code: 'SERVICE_UNAVAILABLE', message: 'Windows auto-start is unavailable on this platform.', httpStatus: 503, expose: true });
    await this.writeLauncher();
    const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    const command = `"${powershell}" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${this.launcherPath}"`;
    const result = await this.runReg(['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', command, '/f']);
    if (!result.success) throw new AppError({ code: 'COMMAND_FAILED', message: 'Windows auto-start registry entry could not be created.', httpStatus: 500, expose: true });
    return this.snapshot(true, true, 'Starts MCP Coding at Windows sign-in for the current user.');
  }

  async disable(): Promise<WindowsAutoStartStatus> {
    if (process.platform !== 'win32') throw new AppError({ code: 'SERVICE_UNAVAILABLE', message: 'Windows auto-start is unavailable on this platform.', httpStatus: 503, expose: true });
    const current = await this.status();
    if (!current.enabled) return current;
    const result = await this.runReg(['delete', RUN_KEY, '/v', RUN_VALUE, '/f']);
    if (!result.success) throw new AppError({ code: 'COMMAND_FAILED', message: 'Windows auto-start registry entry could not be removed.', httpStatus: 500, expose: true });
    return this.snapshot(true, false, 'Auto-start is disabled.');
  }

  private snapshot(supported: boolean, enabled: boolean, note: string): WindowsAutoStartStatus {
    return { supported, enabled, provider: 'windows-hkcu-run', launcherPath: this.launcherPath, note };
  }

  private async writeLauncher(): Promise<void> {
    await mkdir(path.dirname(this.launcherPath), { recursive: true });
    const health = `http://${this.options.host}:${this.options.port}/health/ready`;
    const source = [
      '$ErrorActionPreference = "SilentlyContinue"',
      `$health = ${psLiteral(health)}`,
      'try {',
      '  $response = Invoke-WebRequest -UseBasicParsing -Uri $health -TimeoutSec 2',
      '  if ($response.StatusCode -eq 200) { exit 0 }',
      '} catch {}',
      `$node = ${psLiteral(this.nodeExecutable)}`,
      `$root = ${psLiteral(this.projectRoot)}`,
      "$entry = Join-Path $root 'dist/entrypoints/http.js'",
      'Start-Process -FilePath $node -ArgumentList @($entry) -WorkingDirectory $root -WindowStyle Hidden',
      'exit 0',
      '',
    ].join('\r\n');
    await writeFile(this.launcherPath, source, { encoding: 'utf8', mode: 0o600 });
  }

  private runReg(args: readonly string[]): Promise<SafeProcessResult> {
    return this.commandRunner({
      executable: 'C:\\Windows\\System32\\reg.exe',
      args,
      cwd: this.projectRoot,
      timeoutSeconds: 10,
    });
  }
}
