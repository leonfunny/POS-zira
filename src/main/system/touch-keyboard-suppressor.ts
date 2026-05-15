import { execFile } from 'child_process';
import { promisify } from 'util';
import logger from '../logger';

// Strategy:
//  1. Flip HKCU registry flag EnableDesktopModeAutoInvoke=0 so Windows
//     stops auto-popping the touch keyboard on focus. This is the only
//     reliable way — taskkill alone races with the OS and the keyboard
//     window flashes before we can close it.
//  2. Kill any currently-running touch keyboard processes immediately,
//     then keep polling at 500ms as a safety net in case some Windows
//     code path still launches them.
//  3. On shutdown, restore the previous registry value so the user's
//     normal touch typing works outside Zira AI.
//
// Targets cover both Windows 10 (TabTip) and Windows 11 (TextInputHost
// + the UWP InputApp host). taskkill silently no-ops when a process
// isn't running, so listing all of them is safe.

const execFileAsync = promisify(execFile);

const TARGET_PROCESSES = [
  'TabTip.exe',
  'TabTip32.exe',
  'TextInputHost.exe',
  'WindowsInternal.ComposableShell.Experiences.TextInput.InputApp.exe',
];

const REGISTRY_PATH = 'HKCU:\\SOFTWARE\\Microsoft\\TabletTip\\1.7';
const REGISTRY_VALUE_NAME = 'EnableDesktopModeAutoInvoke';
const POLL_INTERVAL_MS = 500;

let pollTimer: NodeJS.Timeout | null = null;
let previousAutoInvokeValue: number | null | undefined = undefined; // undefined = not captured, null = key did not exist

function killTouchKeyboardProcesses(): void {
  const args = ['/F'];
  for (const name of TARGET_PROCESSES) {
    args.push('/IM', name);
  }
  execFile('taskkill', args, { windowsHide: true }, () => {
    // Ignore errors — "process not found" is the common case.
  });
}

async function runPowerShell(command: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', command],
    { windowsHide: true, timeout: 5000 },
  );
  return stdout;
}

async function disableAutoInvoke(): Promise<void> {
  // Capture the existing value (if any) before overwriting so we can
  // restore it on exit. Output format:
  //   PREV:<number>  → key existed with that DWORD value
  //   PREV:none      → key did not exist
  const command = `
    $path = '${REGISTRY_PATH}';
    $name = '${REGISTRY_VALUE_NAME}';
    if (-not (Test-Path $path)) { New-Item -Path $path -Force | Out-Null }
    try {
      $current = (Get-ItemProperty -Path $path -Name $name -ErrorAction Stop).$name;
      Write-Output ('PREV:' + $current)
    } catch {
      Write-Output 'PREV:none'
    }
    Set-ItemProperty -Path $path -Name $name -Value 0 -Type DWord -Force
  `;
  try {
    const stdout = await runPowerShell(command);
    const match = stdout.match(/PREV:(\S+)/);
    if (match) {
      previousAutoInvokeValue = match[1] === 'none' ? null : Number(match[1]);
    } else {
      previousAutoInvokeValue = null;
    }
    logger.info(
      `[TouchKeyboardSuppressor] Auto-invoke disabled (previous: ${previousAutoInvokeValue ?? 'unset'})`,
    );
  } catch (err: any) {
    logger.warn(`[TouchKeyboardSuppressor] Failed to disable auto-invoke: ${err?.message}`);
  }
}

async function restoreAutoInvoke(): Promise<void> {
  if (previousAutoInvokeValue === undefined) return; // never captured, nothing to restore

  const command =
    previousAutoInvokeValue === null
      ? `Remove-ItemProperty -Path '${REGISTRY_PATH}' -Name '${REGISTRY_VALUE_NAME}' -ErrorAction SilentlyContinue`
      : `Set-ItemProperty -Path '${REGISTRY_PATH}' -Name '${REGISTRY_VALUE_NAME}' -Value ${previousAutoInvokeValue} -Type DWord -Force`;

  try {
    await runPowerShell(command);
    logger.info(
      `[TouchKeyboardSuppressor] Auto-invoke restored to ${previousAutoInvokeValue ?? 'unset'}`,
    );
  } catch (err: any) {
    logger.warn(`[TouchKeyboardSuppressor] Failed to restore auto-invoke: ${err?.message}`);
  } finally {
    previousAutoInvokeValue = undefined;
  }
}

export async function startSuppressingTouchKeyboard(): Promise<void> {
  if (process.platform !== 'win32') return;
  if (pollTimer) return;

  await disableAutoInvoke();
  killTouchKeyboardProcesses();
  pollTimer = setInterval(killTouchKeyboardProcesses, POLL_INTERVAL_MS);
  logger.info('[TouchKeyboardSuppressor] Started');
}

export async function stopSuppressingTouchKeyboard(): Promise<void> {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  await restoreAutoInvoke();
  logger.info('[TouchKeyboardSuppressor] Stopped — Windows touch keyboard restored');
}
