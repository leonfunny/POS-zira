Add-Type @"
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;

public class WindowCapture {
    public delegate bool EnumCB(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumCB cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rc);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hDC, uint nFlags);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    public static IntPtr FindByTitle(string title) {
        IntPtr result = IntPtr.Zero;
        EnumWindows((hWnd, lp) => {
            var sb = new StringBuilder(256);
            GetWindowText(hWnd, sb, 256);
            if (sb.ToString() == title) { result = hWnd; return false; }
            return true;
        }, IntPtr.Zero);
        return result;
    }

    public static void CaptureWindow(IntPtr hWnd, string path) {
        RECT rc;
        GetWindowRect(hWnd, out rc);
        int w = rc.Right - rc.Left;
        int h = rc.Bottom - rc.Top;
        if (w <= 0 || h <= 0) throw new Exception("Window has zero size");

        using (var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb)) {
            using (var g = Graphics.FromImage(bmp)) {
                IntPtr hdc = g.GetHdc();
                // PW_RENDERFULLCONTENT = 2 (captures GPU content too)
                PrintWindow(hWnd, hdc, 2);
                g.ReleaseHdc(hdc);
            }
            bmp.Save(path, ImageFormat.Png);
        }
    }
}
"@

$hwnd = [WindowCapture]::FindByTitle("Zira AI")
if ($hwnd -ne [IntPtr]::Zero) {
    $path = "C:\Users\maxis\enail\print-agent\window-capture.png"
    [WindowCapture]::CaptureWindow($hwnd, $path)
    Write-Output "Captured to $path"
} else {
    Write-Output "Zira AI not found"
}
