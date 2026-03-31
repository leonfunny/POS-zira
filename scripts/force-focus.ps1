# Minimize ALL windows first (Win+D equivalent)
$shell = New-Object -ComObject Shell.Application
$shell.MinimizeAll()
Start-Sleep -Seconds 1

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;

public class FocusHelper {
    public delegate bool EnumCB(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumCB cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);

    public static IntPtr FindByTitle(string needle) {
        IntPtr result = IntPtr.Zero;
        EnumWindows((hWnd, lp) => {
            var sb = new StringBuilder(256);
            GetWindowText(hWnd, sb, 256);
            if (sb.ToString().Contains(needle)) {
                result = hWnd;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return result;
    }
}
"@

$hwnd = [FocusHelper]::FindByTitle("Zira AI")
if ($hwnd -ne [IntPtr]::Zero) {
    Write-Output "Found Zira AI window handle: $hwnd"
    [FocusHelper]::ShowWindow($hwnd, 3) | Out-Null  # SW_MAXIMIZE
    [FocusHelper]::BringWindowToTop($hwnd) | Out-Null
    [FocusHelper]::SetForegroundWindow($hwnd) | Out-Null
    Write-Output "Maximized and focused"
} else {
    Write-Output "Zira AI window not found!"
    # List all windows with titles
    [FocusHelper]::EnumWindows({
        param($h, $l)
        $sb = New-Object System.Text.StringBuilder 256
        [FocusHelper]::GetWindowText($h, $sb, 256) | Out-Null
        $t = $sb.ToString()
        if ($t -and $t.Length -gt 1) { Write-Output "  [$h] $t" }
        return $true
    }, [IntPtr]::Zero) | Out-Null
}
