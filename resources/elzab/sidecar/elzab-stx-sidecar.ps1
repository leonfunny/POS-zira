param(
  [Parameter(Position = 0)]
  [string]$Command,
  [Parameter(Position = 1)]
  [string]$EncodedPayload
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

function Write-Result {
  param(
    [bool]$Ok,
    [string]$Code,
    [string]$Detail,
    $Data
  )

  $result = [ordered]@{ ok = $Ok }
  if ($Code) { $result.code = $Code }
  if ($Detail) { $result.detail = $Detail }
  if ($null -ne $Data) { $result.data = $Data }
  [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress -Depth 32))
}

function Get-Property {
  param($Object, [string]$Name, $Default = $null)
  if ($null -eq $Object) { return $Default }
  if ($Object.PSObject.Properties.Name -contains $Name) { return $Object.$Name }
  return $Default
}

function Find-ElzabDll {
  $candidates = @()
  if ($env:ZIRA_ELZABDR_DLL) { $candidates += $env:ZIRA_ELZABDR_DLL }
  if ($env:ZIRA_ELZABDR_DIR) { $candidates += (Join-Path $env:ZIRA_ELZABDR_DIR 'ElzabDR.dll') }

  $arch = if ([Environment]::Is64BitProcess) { 'x64' } else { 'x86' }
  if ($env:APPDATA) {
    $candidates += (Join-Path $env:APPDATA "zira-ai\elzab\elzabdr\Windows\$arch\ElzabDR.dll")
  }
  $candidates += (Join-Path $PSScriptRoot "..\dll\$arch\ElzabDR.dll")
  $candidates += (Join-Path $PSScriptRoot "..\..\Windows\$arch\ElzabDR.dll")

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }
  return $null
}

function Decode-Payload {
  if (!$EncodedPayload) { return @{} }
  $json = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($EncodedPayload))
  if (!$json.Trim()) { return @{} }
  return ($json | ConvertFrom-Json)
}

function Native-Error {
  param([int]$Number)
  $message = New-Object System.Text.StringBuilder 512
  try { [void][ElzabNative]::pErrMessage($Number, $message) } catch {}
  return $message.ToString()
}

function Is-LocalMenuError {
  param([string]$Message)
  return $Message -match 'TRYB MENU LOKALNEGO|local menu'
}

function Get-Dll-Version {
  $version = New-Object System.Text.StringBuilder 255
  $r = [ElzabNative]::pDllVersion($version)
  if ($r -ne 0) { return $null }
  return $version.ToString()
}

function Open-Elzab {
  param($Config)

  $port = [string](Get-Property $Config 'port' '')
  $address = [string](Get-Property $Config 'address' '')
  $baudRate = [int](Get-Property $Config 'baudRate' 9600)
  $timeout = [int](Get-Property $Config 'timeoutSeconds' 8)
  if ($timeout -lt 5) { $timeout = 5 }

  if ($port) {
    if ($port -notmatch '^COM(\d{1,3})$') {
      return @{ ok = $false; code = 'ELZAB_TARGET_MISSING'; detail = "Invalid ELZAB COM port '$port'." }
    }
    $portNo = [int]$Matches[1]
    $r = [ElzabNative]::CommunicationInit($portNo, $baudRate, $timeout)
    if ($r -ne 0) {
      return @{
        ok = $false
        code = 'ELZAB_HARDWARE_NOT_FOUND'
        detail = "CommunicationInit failed on $port at $baudRate baud: $(Native-Error $r)"
        data = @{ errorNumber = $r; target = $port; baudRate = $baudRate }
      }
    }
    return @{ ok = $true; target = $port; baudRate = $baudRate; timeout = $timeout }
  }

  if ($address) {
    $hostName = $address
    $ipPort = 1001
    if ($address -match '^(.+):(\d{1,5})$') {
      $hostName = $Matches[1]
      $ipPort = [int]$Matches[2]
    }
    $r = [ElzabNative]::CommunicationInit2($hostName, $ipPort, $timeout)
    if ($r -ne 0) {
      return @{
        ok = $false
        code = 'ELZAB_HARDWARE_NOT_FOUND'
        detail = ("CommunicationInit2 failed on {0}:{1}: {2}" -f $hostName, $ipPort, (Native-Error $r))
        data = @{ errorNumber = $r; target = "$hostName`:$ipPort" }
      }
    }
    return @{ ok = $true; target = "$hostName`:$ipPort"; timeout = $timeout }
  }

  return @{ ok = $false; code = 'ELZAB_TARGET_MISSING'; detail = 'ELZAB_STX requires a COM port or IP address.' }
}

function Close-Elzab {
  try { [void][ElzabNative]::CommunicationEnd() } catch {}
}

function Read-VatRates {
  $ile = 0; $a = 0; $b = 0; $c = 0; $d = 0; $e = 0; $f = 0; $g = 0
  $r = [ElzabNative]::ReadVAT([ref]$ile, [ref]$a, [ref]$b, [ref]$c, [ref]$d, [ref]$e, [ref]$f, [ref]$g)
  if ($r -ne 0) {
    return @{ ok = $false; errorNumber = $r; detail = "ReadVAT failed: $(Native-Error $r)" }
  }
  $values = @($a, $b, $c, $d, $e, $f, $g)
  $rates = @()
  for ($i = 0; $i -lt 7; $i++) {
    $rates += @{ number = ($i + 1); symbol = [string][char](65 + $i); value = $values[$i] }
  }
  return @{ ok = $true; count = $ile; rates = $rates }
}

function Resolve-VatNumber {
  param($VatRates, $Rate)

  $numericRate = 23
  if ($null -ne $Rate) { $numericRate = [double]$Rate }
  $wanted = [int][Math]::Round($numericRate * 100)
  foreach ($rate in $VatRates.rates) {
    if ([int]$rate.value -eq $wanted) { return [int]$rate.number }
  }
  return $null
}

function Read-BasicStatus {
  $name = New-Object System.Text.StringBuilder 255
  $clock = New-Object System.Text.StringBuilder 255
  $s0 = 0; $s1 = 0; $s2 = 0; $s3 = 0

  $rn = [ElzabNative]::pDeviceName($name)
  $rt = [ElzabNative]::pReadClock($clock)
  $rs = [ElzabNative]::ReadStatus([ref]$s0, [ref]$s1, [ref]$s2, [ref]$s3)
  $vat = Read-VatRates

  return @{
    deviceName = if ($rn -eq 0) { $name.ToString() } else { $null }
    deviceNameResult = $rn
    clock = if ($rt -eq 0) { $clock.ToString() } else { $null }
    clockResult = $rt
    statusBytes = if ($rs -eq 0) { @($s0, $s1, $s2, $s3) } else { $null }
    statusResult = $rs
    vat = $vat
    dllVersion = Get-Dll-Version
  }
}

function Convert-Quantity {
  param($Value)
  $q = [double]$Value
  if ($q -le 0) { throw "Receipt item quantity must be positive." }
  for ($precision = 0; $precision -le 3; $precision++) {
    $scale = [Math]::Pow(10, $precision)
    $scaled = [Math]::Round($q * $scale)
    if ([Math]::Abs(($scaled / $scale) - $q) -lt 0.000001) {
      return @{ quantity = [int]$scaled; precision = $precision }
    }
  }
  return @{ quantity = [int][Math]::Round($q * 1000); precision = 3 }
}

function Clean-Text {
  param($Value, [int]$MaxLength)
  $text = [string]$Value
  $text = $text -replace '[\r\n\t]+', ' '
  $text = $text.Trim()
  if ($text.Length -gt $MaxLength) { return $text.Substring(0, $MaxLength) }
  return $text
}

function Payment-Kind {
  param([string]$Method)
  $m = $Method.ToUpperInvariant()
  if ($m -match 'CASH|GOT') { return @{ name = 'GOTOWKA'; kind = 1 } }
  if ($m -match 'CARD|KARTA') { return @{ name = 'KARTA'; kind = 2 } }
  if ($m -match 'BLIK|MOBILE') { return @{ name = 'BLIK'; kind = 9 } }
  if ($m -match 'TRANSFER|PRZELEW') { return @{ name = 'PRZELEW'; kind = 7 } }
  if ($m -match 'VOUCHER|BON') { return @{ name = 'VOUCHER'; kind = 8 } }
  return @{ name = 'INNA'; kind = 10 }
}

function Invoke-ConnectLike {
  param($Config, [bool]$IncludeStatus)
  $open = Open-Elzab $Config
  if (!$open.ok) {
    Write-Result $false $open.code $open.detail $open.data
    return
  }
  try {
    $data = @{ target = $open.target; dllVersion = Get-Dll-Version }
    if ($IncludeStatus) {
      $data.status = Read-BasicStatus
    }
    Write-Result $true $null "ELZAB connected on $($open.target)." $data
  } finally {
    Close-Elzab
  }
}

function Invoke-TestPrint {
  param($Config)
  $open = Open-Elzab $Config
  if (!$open.ok) {
    Write-Result $false $open.code $open.detail $open.data
    return
  }
  try {
    $r = [ElzabNative]::NonFiscalPrintoutBegin(99)
    if ($r -ne 0) { Write-Result $false 'ELZAB_COMMAND_FAILED' "NonFiscalPrintoutBegin failed: $(Native-Error $r)" @{ errorNumber = $r }; return }
    [void][ElzabNative]::addNonFiscalPrintoutLineSTX('Zira AI test', $null, 2, 1, 0, 0)
    [void][ElzabNative]::addNonFiscalPrintoutLineSTX((Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $null, 2, 1, 0, 0)
    [void][ElzabNative]::addNonFiscalPrintoutLineSTX("Target: $($open.target)", $null, 1, 1, 0, 0)
    $end = [ElzabNative]::NonFiscalPrintoutEnd()
    if ($end -ne 0) { Write-Result $false 'ELZAB_COMMAND_FAILED' "NonFiscalPrintoutEnd failed: $(Native-Error $end)" @{ errorNumber = $end }; return }
    Write-Result $true $null "ELZAB non-fiscal test print sent to $($open.target)." @{ target = $open.target }
  } finally {
    Close-Elzab
  }
}

function Invoke-Receipt {
  param($Config, $Data)

  if ($env:ALLOW_REAL_FISCAL_PRINT -ne 'true') {
    Write-Result $false 'REAL_FISCAL_PRINT_DISABLED' 'Real ELZAB fiscal receipt is disabled. Set ALLOW_REAL_FISCAL_PRINT=true only during controlled production go-live.' $null
    return
  }

  $items = @(Get-Property $Data 'items' @())
  if ($items.Count -lt 1) {
    Write-Result $false 'ELZAB_UNSUPPORTED_OPERATION' 'ELZAB fiscal receipt requires at least one sale item.' $null
    return
  }

  $open = Open-Elzab $Config
  if (!$open.ok) {
    Write-Result $false $open.code $open.detail $open.data
    return
  }

  $receiptOpen = $false
  try {
    $vat = Read-VatRates
    if (!$vat.ok) {
      Write-Result $false 'ELZAB_PROTOCOL_NOT_READY' $vat.detail $vat
      return
    }

    [void][ElzabNative]::ErasePayments()
    [void][ElzabNative]::EraseLines()

    $total = [int](Get-Property $Data 'total' 0)
    $tenders = @(Get-Property $Data 'tenders' $null)
    if ($tenders.Count -eq 0) { $tenders = @((Get-Property $Data 'payment' $null)) }
    $paidTotal = 0
    foreach ($tender in $tenders) { $paidTotal += [int](Get-Property $tender 'amount' $total) }
    $changeRemaining = [Math]::Max(0, $paidTotal - $total)
    $paymentNo = 1
    foreach ($tender in $tenders) {
      if ($null -eq $tender) { continue }
      $method = [string](Get-Property $tender 'method' 'CASH')
      $amount = [int](Get-Property $tender 'amount' $total)
      $payment = Payment-Kind $method
      $change = 0
      if ($changeRemaining -gt 0 -and $payment.kind -eq 1) {
        $change = $changeRemaining
        $changeRemaining = 0
      }
      $rPay = [ElzabNative]::FillPaymentSTX($paymentNo, $payment.name, $amount, $change, $payment.kind)
      if ($rPay -ne 0) {
        Write-Result $false 'ELZAB_COMMAND_FAILED' "FillPaymentSTX failed: $(Native-Error $rPay)" @{ errorNumber = $rPay; paymentNo = $paymentNo }
        return
      }
      $paymentNo += 1
    }

    $begin = [ElzabNative]::ReceiptBegin()
    if ($begin -ne 0) {
      $beginError = Native-Error $begin
      $beginCode = if (Is-LocalMenuError $beginError) { 'ELZAB_LOCAL_MENU_MODE' } else { 'ELZAB_COMMAND_FAILED' }
      Write-Result $false $beginCode "ReceiptBegin failed: $beginError" @{ errorNumber = $begin }
      return
    }
    $receiptOpen = $true

    foreach ($item in $items) {
      $name = Clean-Text (Get-Property $item 'name' 'Item') 64
      if (!$name) { $name = 'Item' }
      $unit = Clean-Text (Get-Property $item 'unit' 'szt.') 4
      if (!$unit) { $unit = 'szt.' }
      $qty = Convert-Quantity (Get-Property $item 'quantity' 1)
      $price = [int](Get-Property $item 'unitPrice' 0)
      if ($price -le 0) { throw "Receipt item '$name' unit price must be positive." }
      $vatNo = Resolve-VatNumber $vat (Get-Property $item 'vatRate' 23)
      if ($null -eq $vatNo) {
        Write-Result $false 'ELZAB_UNSUPPORTED_OPERATION' "No matching VAT rate on ELZAB for item '$name'." @{ item = $name; configuredVat = $vat.rates }
        return
      }
      $rItem = [ElzabNative]::pReceiptItemEx(1, $name, $vatNo, 0, $qty.quantity, $qty.precision, $unit, $price)
      if ($rItem -ne 0) {
        Write-Result $false 'ELZAB_COMMAND_FAILED' "pReceiptItemEx failed for '$name': $(Native-Error $rItem)" @{ errorNumber = $rItem; item = $name }
        return
      }
    }

    $customerNip = Clean-Text (Get-Property $Data 'customerNip' '') 32
    if ($customerNip) {
      $nipResult = [ElzabNative]::pReceiptPurchaserNIP($customerNip)
      if ($nipResult -ne 0) {
        Write-Result $false 'ELZAB_COMMAND_FAILED' "pReceiptPurchaserNIP failed: $(Native-Error $nipResult)" @{ errorNumber = $nipResult }
        return
      }
    }

    $discount = [int](Get-Property $Data 'discount' 0)
    if ($discount -gt 0) {
      $end = [ElzabNative]::ReceiptEndEx($discount, 1)
    } else {
      $end = [ElzabNative]::ReceiptEnd(0)
    }
    if ($end -ne 0) {
      Write-Result $false 'ELZAB_COMMAND_FAILED' "ReceiptEnd failed: $(Native-Error $end)" @{ errorNumber = $end }
      return
    }
    $receiptOpen = $false
    Write-Result $true $null "ELZAB fiscal receipt printed." @{ target = $open.target; orderId = (Get-Property $Data 'orderId' $null); orderNumber = (Get-Property $Data 'orderNumber' $null) }
  } catch {
    Write-Result $false 'ELZAB_COMMAND_FAILED' $_.Exception.Message $null
  } finally {
    if ($receiptOpen) {
      try { [void][ElzabNative]::ReceiptCancel() } catch {}
    }
    Close-Elzab
  }
}

try {
  if (!$Command) {
    Write-Result $false 'ELZAB_BRIDGE_BAD_RESPONSE' 'Missing sidecar command.' $null
    exit 0
  }

  $dllPath = Find-ElzabDll
  if (!$dllPath) {
    Write-Result $false 'ELZAB_BRIDGE_NOT_FOUND' 'ElzabDR.dll was not found. Install/extract official elzabdr.zip, or set ZIRA_ELZABDR_DIR / ZIRA_ELZABDR_DLL.' $null
    exit 0
  }

  $dllDir = Split-Path -Parent $dllPath
  $env:PATH = "$dllDir;$env:PATH"
  Set-Location -LiteralPath $dllDir

  $nativeCode = @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class ElzabNative {
  [DllImport("ElzabDR.dll", CallingConvention = CallingConvention.StdCall, CharSet = CharSet.Ansi)] public static extern int CommunicationInit(int PortNo, int Speed, int Timeout);
  [DllImport("ElzabDR.dll", CallingConvention = CallingConvention.StdCall, CharSet = CharSet.Ansi)] public static extern int CommunicationInit2(string IPAddr, int IPPort, int Timeout);
  [DllImport("ElzabDR.dll", CallingConvention = CallingConvention.StdCall, CharSet = CharSet.Ansi)] public static extern int CommunicationEnd();
  [DllImport("ElzabDR.dll", CallingConvention = CallingConvention.StdCall, CharSet = CharSet.Ansi)] public static extern int pDllVersion(StringBuilder Ver);
  [DllImport("ElzabDR.dll", CallingConvention = CallingConvention.StdCall, CharSet = CharSet.Ansi)] public static extern int pErrMessage(int ErrorNumber, StringBuilder Message);
  [DllImport("ElzabDR.dll", CallingConvention = CallingConvention.StdCall, CharSet = CharSet.Ansi)] public static extern int pDeviceName(StringBuilder Name);
  [DllImport("ElzabDR.dll", CallingConvention = CallingConvention.StdCall, CharSet = CharSet.Ansi)] public static extern int pReadClock(StringBuilder Time);
  [DllImport("ElzabDR.dll", CallingConvention = CallingConvention.StdCall, CharSet = CharSet.Ansi)] public static extern int ReadStatus(out int S0, out int S1, out int S2, out int S3);
  [DllImport("ElzabDR.dll", CallingConvention = CallingConvention.StdCall, CharSet = CharSet.Ansi)] public static extern int ReadVAT(out int Ile, out int A, out int B, out int C, out int D, out int E, out int F, out int G);
  [DllImport("ElzabDR.dll", CallingConvention = CallingConvention.StdCall, CharSet = CharSet.Ansi)] public static extern int ReceiptConditions();
  [DllImport("ElzabDR.dll", CallingConvention = CallingConvention.StdCall, CharSet = CharSet.Ansi)] public static extern int ReceiptBegin();
  [DllImport("ElzabDR.dll", CallingConvention = CallingConvention.StdCall, CharSet = CharSet.Ansi)] public static extern int ReceiptCancel();
  [DllImport("ElzabDR.dll", CallingConvention = CallingConvention.StdCall, CharSet = CharSet.Ansi)] public static extern int ReceiptEnd(int Rabat);
  [DllImport("ElzabDR.dll", CallingConvention = CallingConvention.StdCall, CharSet = CharSet.Ansi)] public static extern int ReceiptEndEx(int RabatNarzut, int TypRabatuNarzutu);
  [DllImport("ElzabDR.dll", CallingConvention = CallingConvention.StdCall, CharSet = CharSet.Ansi)] public static extern int pReceiptItemEx(int Sprzedaz, string Nazwa, int Stawka, int Komunikat, int Ilosc, int MP, string Jedn, int Cena);
  [DllImport("ElzabDR.dll", CallingConvention = CallingConvention.StdCall, CharSet = CharSet.Ansi)] public static extern int pReceiptPurchaserNIP(string NIP);
  [DllImport("ElzabDR.dll", CallingConvention = CallingConvention.StdCall, CharSet = CharSet.Ansi)] public static extern int FillPaymentSTX(int paymentNumber, string paymentName, int total, int change, int paymentKind);
  [DllImport("ElzabDR.dll", CallingConvention = CallingConvention.StdCall, CharSet = CharSet.Ansi)] public static extern int ErasePayments();
  [DllImport("ElzabDR.dll", CallingConvention = CallingConvention.StdCall, CharSet = CharSet.Ansi)] public static extern int EraseLines();
  [DllImport("ElzabDR.dll", CallingConvention = CallingConvention.StdCall, CharSet = CharSet.Ansi)] public static extern int NonFiscalPrintoutBegin(int Number);
  [DllImport("ElzabDR.dll", CallingConvention = CallingConvention.StdCall, CharSet = CharSet.Ansi)] public static extern int addNonFiscalPrintoutLineSTX(string text, string addText, int textAlignment, int generatorType, int textStyle, int addTextStyle);
  [DllImport("ElzabDR.dll", CallingConvention = CallingConvention.StdCall, CharSet = CharSet.Ansi)] public static extern int NonFiscalPrintoutEnd();
}
"@
  Add-Type -TypeDefinition $nativeCode

  $payload = Decode-Payload
  $config = Get-Property $payload 'config' $null

  switch ($Command) {
    'check' {
      Write-Result $true $null 'ELZAB sidecar available.' @{ dllPath = $dllPath; dllVersion = Get-Dll-Version; process64Bit = [Environment]::Is64BitProcess }
    }
    'connect' { Invoke-ConnectLike $config $true }
    'status' { Invoke-ConnectLike $config $true }
    'test' { Invoke-TestPrint $config }
    'receipt' { Invoke-Receipt $config (Get-Property $payload 'data' $null) }
    'report' {
      Write-Result $false 'ELZAB_UNSUPPORTED_OPERATION' 'ELZAB report printing is not enabled in this sidecar until service verifies the required report mode.' $null
    }
    default {
      Write-Result $false 'ELZAB_UNSUPPORTED_OPERATION' "Unsupported ELZAB sidecar command '$Command'." $null
    }
  }
} catch {
  Write-Result $false 'ELZAB_COMMAND_FAILED' $_.Exception.Message $null
}
