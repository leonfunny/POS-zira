Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class WinHelper {
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from, uint to, bool attach);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
}
"@

# Minimize Chrome first
Get-Process -Name chrome -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.MainWindowHandle -ne [IntPtr]::Zero) {
        [WinHelper]::ShowWindow($_.MainWindowHandle, 6) | Out-Null
    }
}

Start-Sleep -Milliseconds 500

# Find and focus Zira AI window
$electron = Get-Process -Name electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*Zira*' }
if ($electron) {
    $hwnd = $electron.MainWindowHandle
    Write-Output "Found Zira AI window: $($electron.MainWindowTitle)"

    # Attach to foreground thread to allow SetForegroundWindow
    $fgHwnd = [WinHelper]::GetForegroundWindow()
    $fgPid = [uint32]0
    [WinHelper]::GetWindowThreadProcessId($fgHwnd, [ref]$fgPid) | Out-Null
    $myThread = [WinHelper]::GetCurrentThreadId()
    $fgThread = [uint32]0
    [WinHelper]::GetWindowThreadProcessId($fgHwnd, [ref]$fgThread) | Out-Null

    [WinHelper]::ShowWindow($hwnd, 9) | Out-Null
    [WinHelper]::BringWindowToTop($hwnd) | Out-Null
    [WinHelper]::SetForegroundWindow($hwnd) | Out-Null
    Write-Output "Window brought to front"
} else {
    # Try all electron processes
    $allElectron = Get-Process -Name electron -ErrorAction SilentlyContinue
    foreach ($p in $allElectron) {
        if ($p.MainWindowHandle -ne [IntPtr]::Zero -and $p.MainWindowTitle) {
            Write-Output "Trying: '$($p.MainWindowTitle)'"
            [WinHelper]::ShowWindow($p.MainWindowHandle, 9) | Out-Null
            [WinHelper]::BringWindowToTop($p.MainWindowHandle) | Out-Null
            [WinHelper]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
        }
    }
}
