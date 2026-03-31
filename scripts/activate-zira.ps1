# Kill Chrome windows to clear the way
Get-Process chrome -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.MainWindowHandle -ne [IntPtr]::Zero) {
        $_.CloseMainWindow() | Out-Null
    }
}
Start-Sleep -Seconds 1

# Use AppActivate to focus Zira AI
Add-Type -AssemblyName Microsoft.VisualBasic
[Microsoft.VisualBasic.Interaction]::AppActivate("Zira AI")
Start-Sleep -Milliseconds 500
Write-Output "Activated Zira AI"
