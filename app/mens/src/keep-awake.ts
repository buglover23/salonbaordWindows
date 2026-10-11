import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';

// While the tool runs on Windows, the PC must not fall asleep by itself: a sleeping PC runs nothing, so the posting slots
// would pass unposted. A hidden PowerShell holds SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) until its
// stdin closes, which happens when this process ends in any way (stop, crash, the window closed). The display may still
// turn off; a manual sleep or a closed laptop lid still stops the PC (Windows does not let a program refuse those).
// On a Mac, caffeinate -i -s -w <pid> does the same and ends by itself with this process; a closed lid still sleeps.

const ES_CONTINUOUS_SYSTEM_REQUIRED = 0x80000001;
const SCRIPT = [
  "$t = Add-Type -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);' -Name KeepAwake -Namespace SalonBoard -PassThru",
  `[void]$t::SetThreadExecutionState([uint32]${ES_CONTINUOUS_SYSTEM_REQUIRED})`,
  '[void][Console]::In.ReadLine()',
].join('; ');

type Spawn = (
  command: string,
  args: string[],
  options: { stdio: ['pipe' | 'ignore', 'ignore', 'ignore']; windowsHide: true },
) => Pick<ChildProcess, 'stdin' | 'on' | 'kill'>;

/** Keeps Windows or macOS from sleeping by itself until `release` (no-op elsewhere or when the helper cannot start). */
export function keepAwake(o: { platform?: NodeJS.Platform; spawn?: Spawn; pid?: number } = {}): { release: () => void } {
  const platform = o.platform ?? process.platform;
  if (platform !== 'win32' && platform !== 'darwin') return { release: () => undefined };
  try {
    const spawn = o.spawn ?? (nodeSpawn as unknown as Spawn);
    if (platform === 'darwin') {
      const child = spawn('/usr/bin/caffeinate', ['-i', '-s', '-w', String(o.pid ?? process.pid)], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
      child.on('error', () => undefined);
      return { release: () => void child.kill() };
    }
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    child.on('error', () => undefined);
    return { release: () => child.stdin?.end() };
  } catch {
    return { release: () => undefined };
  }
}

/** The start message's note on sleep: on a Mac, a closed lid still sleeps (unless an external display keeps it awake). */
export function awakeNoteJa(platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin'
    ? '動いている間は Mac が自動でスリープしません。画面が消えるのは大丈夫ですが、ふたを閉じるとスリープして投稿できません（外部ディスプレイにつないだクラムシェルモードは除きます）'
    : '動いている間はパソコンが自動でスリープしません。画面が消えるのは大丈夫です';
}
