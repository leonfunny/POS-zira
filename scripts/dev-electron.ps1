$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $repoRoot

$env:NODE_ENV = 'development'

function Test-LocalPort {
  param([int]$Port)

  $client = New-Object Net.Sockets.TcpClient
  try {
    $connect = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $connect.AsyncWaitHandle.WaitOne(500, $false)) {
      return $false
    }
    $client.EndConnect($connect)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

Write-Host '[dev-electron] Waiting for main build output...'
while (-not (Test-Path (Join-Path $repoRoot 'dist/main/index.js'))) {
  Start-Sleep -Milliseconds 500
}

Write-Host '[dev-electron] Waiting for Vite on http://localhost:3100...'
while (-not (Test-LocalPort -Port 3100)) {
  Start-Sleep -Milliseconds 500
}

Write-Host '[dev-electron] Starting Electron in development mode...'
electron .
