Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force
Write-Host "Electron killed"
