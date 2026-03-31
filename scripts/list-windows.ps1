Get-Process | Where-Object {
    $_.MainWindowTitle -ne '' -and $_.MainWindowHandle -ne 0
} | Select-Object Id, ProcessName, MainWindowTitle | Format-Table -AutoSize
