$root = 'C:\print-agent-master'
$out = 'C:\Users\pc\print-agent-master.zip'
if (Test-Path $out) { Remove-Item $out -Force }

$excludeDirs = @('node_modules','release','.vs','.idea')
$excludeFiles = @('tmp-*.log','tmp-*.ps1','tmp-app.log')

Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open($out, 'Create')
try {
  $all = Get-ChildItem -Path $root -Recurse -Force -File -ErrorAction SilentlyContinue
  $count = 0
  foreach ($f in $all) {
    $rel = $f.FullName.Substring($root.Length + 1).Replace('\','/')
    $first = ($rel -split '/')[0]
    if ($excludeDirs -contains $first) { continue }
    $skip = $false
    foreach ($pat in $excludeFiles) { if ($f.Name -like $pat) { $skip = $true; break } }
    if ($skip) { continue }
    try {
      [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f.FullName, $rel, 'Optimal') | Out-Null
      $count++
    } catch { Write-Host "skip: $rel ($($_.Exception.Message))" }
  }
  Write-Host "Added $count files"
} finally { $zip.Dispose() }

$sz = (Get-Item $out).Length
Write-Host ("ZIP size: {0} MB" -f [math]::Round($sz/1MB,1))
Write-Host "Path: $out"
