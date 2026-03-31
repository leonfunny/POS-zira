# Minimize ALL windows
$shell = New-Object -ComObject Shell.Application
$shell.MinimizeAll()
Start-Sleep -Seconds 1

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class WinFocus {
    public delegate bool EnumCB(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumCB cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left, Top, Right, Bottom;
    }

    public static IntPtr FindByTitle(string needle) {
        IntPtr result = IntPtr.Zero;
        EnumWindows((hWnd, lp) => {
            var sb = new StringBuilder(256);
            GetWindowText(hWnd, sb, 256);
            if (sb.ToString() == needle) {
                result = hWnd;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return result;
    }
}
"@

$hwnd = [WinFocus]::FindByTitle("Zira AI")
if ($hwnd -ne [IntPtr]::Zero) {
    Write-Output "Found Zira AI: $hwnd"
    # Restore window (SW_RESTORE = 9)
    [WinFocus]::ShowWindow($hwnd, 9) | Out-Null
    Start-Sleep -Milliseconds 300
    # Move and resize to center of screen (1200x800)
    [WinFocus]::MoveWindow($hwnd, 100, 50, 1200, 800, $true) | Out-Null
    Start-Sleep -Milliseconds 200
    [WinFocus]::BringWindowToTop($hwnd) | Out-Null
    [WinFocus]::SetForegroundWindow($hwnd) | Out-Null
    Write-Output "Window shown at 1200x800"
} else {
    Write-Output "Zira AI window not found"
}
