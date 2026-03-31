Write-Host "=== NODE PROCESSES ==="
$procs = Get-WmiObject Win32_Process | Where-Object { $_.Name -eq 'node.exe' }
foreach ($p in $procs) {
    Write-Host "PID=$($p.ProcessId) CMD=$($p.CommandLine)"
}

Write-Host "`n=== ALL PROCESSES with 'claude' or 'discord' in cmdline ==="
$all = Get-WmiObject Win32_Process | Where-Object { $_.CommandLine -like '*claude*' -or $_.CommandLine -like '*discord*' }
foreach ($p in $all) {
    Write-Host "PID=$($p.ProcessId) NAME=$($p.Name) CMD=$($p.CommandLine)"
}

Write-Host "`n=== LOCK/PID FILES ==="
Write-Host "manager.lock: $(Get-Content $env:USERPROFILE\.claude\channels\discord\manager.lock -ErrorAction SilentlyContinue)"
Write-Host "claude-session.pid: $(Get-Content $env:USERPROFILE\.claude\channels\discord\claude-session.pid -ErrorAction SilentlyContinue)"
