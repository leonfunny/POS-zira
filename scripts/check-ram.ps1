Write-Host "=== Zira AI (Electron) - CPU RAM ===" -ForegroundColor Cyan
$procs = Get-Process electron -ErrorAction SilentlyContinue
if (-not $procs) {
    Write-Host "No Electron processes found"
    exit
}

$table = @()
foreach ($p in $procs) {
    $table += [PSCustomObject]@{
        PID = $p.Id
        RAM_MB = [math]::Round($p.WorkingSet64/1MB, 1)
        Private_MB = [math]::Round($p.PrivateMemorySize64/1MB, 1)
    }
}
$table | Format-Table -AutoSize

$totalRAM = [math]::Round(($procs | Measure-Object WorkingSet64 -Sum).Sum/1MB, 1)
$totalPrivate = [math]::Round(($procs | Measure-Object PrivateMemorySize64 -Sum).Sum/1MB, 1)
Write-Host "Total CPU RAM (Working Set): $totalRAM MB" -ForegroundColor Yellow
Write-Host "Total CPU RAM (Private):     $totalPrivate MB" -ForegroundColor Yellow
Write-Host ""

Write-Host "=== Zira AI (Electron) - GPU RAM ===" -ForegroundColor Cyan
try {
    $gpuCounters = Get-Counter '\GPU Process Memory(*electron*)\Dedicated Usage' -ErrorAction Stop
    $totalGPU = 0
    foreach ($sample in $gpuCounters.CounterSamples) {
        $mb = [math]::Round($sample.CookedValue/1MB, 1)
        $totalGPU += $sample.CookedValue
        $instance = $sample.InstanceName -replace '.*pid_(\d+).*', 'PID $1'
        Write-Host "  $instance : $mb MB"
    }
    Write-Host "Total GPU Dedicated: $([math]::Round($totalGPU/1MB, 1)) MB" -ForegroundColor Yellow
} catch {
    Write-Host "GPU memory: 0 MB (--disable-gpu flag is active)" -ForegroundColor Gray
}

Write-Host ""
Write-Host "=== System RAM Overview ===" -ForegroundColor Cyan
$os = Get-CimInstance Win32_OperatingSystem
$totalSys = [math]::Round($os.TotalVisibleMemorySize/1MB, 1)
$freeSys = [math]::Round($os.FreePhysicalMemory/1MB, 1)
$usedSys = [math]::Round(($os.TotalVisibleMemorySize - $os.FreePhysicalMemory)/1MB, 1)
Write-Host "System Total:  $totalSys GB"
Write-Host "System Used:   $usedSys GB"
Write-Host "System Free:   $freeSys GB"
Write-Host "Zira AI Share: $([math]::Round($totalRAM / ($os.TotalVisibleMemorySize/1KB) * 100, 1))% of total RAM"
