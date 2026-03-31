Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;

public class WinAPI2 {
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint procId);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr FindWindow(string cls, string title);

    public delegate bool EnumCB(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumCB cb, IntPtr lParam);

    public static List<IntPtr> FindByPids(uint[] pids) {
        var result = new List<IntPtr>();
        EnumWindows((hWnd, lp) => {
            uint wpid;
            GetWindowThreadProcessId(hWnd, out wpid);
            foreach (var p in pids) {
                if (wpid == p) {
                    var sb = new StringBuilder(256);
                    GetWindowText(hWnd, sb, 256);
                    if (sb.Length > 0) result.Add(hWnd);
                }
            }
            return true;
        }, IntPtr.Zero);
        return result;
    }
}
"@

$electronPids = @((Get-Process -Name electron -ErrorAction SilentlyContinue).Id | ForEach-Object { [uint32]$_ })
Write-Output "Electron PIDs: $($electronPids -join ', ')"

$windows = [WinAPI2]::FindByPids($electronPids)
Write-Output "Found $($windows.Count) window(s)"

foreach ($hwnd in $windows) {
    $sb = New-Object System.Text.StringBuilder 256
    [WinAPI2]::GetWindowText($hwnd, $sb, 256) | Out-Null
    Write-Output "  Window: '$($sb.ToString())' -> Showing & focusing"
    [WinAPI2]::ShowWindow($hwnd, 9) | Out-Null
    [WinAPI2]::SetForegroundWindow($hwnd) | Out-Null
}
