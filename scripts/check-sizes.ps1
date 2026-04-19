foreach ($p in @('node_modules','release','dist','.git','src','tests','scripts','docs')) {
  $full = Join-Path 'C:/print-agent-master' $p
  if (Test-Path $full) {
    $s = (Get-ChildItem $full -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
    Write-Host ("{0} : {1} MB" -f $p, [math]::Round($s/1MB,1))
  }
}
