<#
  Updates data.js from Dotabuff on Windows.

  Starts a headless Microsoft Edge, opens dotabuff.com and runs scraper.js there through the
  DevTools protocol. Requests come from a real browser on your machine, so Cloudflare lets them
  through. data.js is overwritten only when the data was collected successfully.

  Run manually:      powershell -ExecutionPolicy Bypass -File update-data.ps1
  Dotabuff period:   ... -File update-data.ps1 -Date week
  Commit and push:   ... -File update-data.ps1 -Push     (keeps the GitHub Pages site up to date)
  Schedule it:       install-autoupdate.ps1
#>
param(
  [string]$Date = '',
  [int]$Port = 9333,
  [switch]$Push
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$logFile = Join-Path $root 'update.log'
$dataFile = Join-Path $root 'data.js'

function Log($msg) {
  $line = '{0:yyyy-MM-dd HH:mm:ss}  {1}' -f (Get-Date), $msg
  Write-Host $line
  Add-Content -Path $logFile -Value $line -Encoding UTF8
}

Add-Type -AssemblyName System.Web.Extensions
$json = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$json.MaxJsonLength = [int]::MaxValue

$edge = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { Log 'ERROR: Microsoft Edge not found'; exit 1 }

$profileDir = Join-Path $env:LOCALAPPDATA 'SkalsePicker\edge-profile'
New-Item -ItemType Directory -Force $profileDir | Out-Null

$ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0'
$edgeArgs = @('--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  "--remote-debugging-port=$Port", "--user-data-dir=`"$profileDir`"", "--user-agent=`"$ua`"", 'about:blank')

Log 'Updating Dotabuff data'
$proc = Start-Process $edge -ArgumentList $edgeArgs -PassThru -WindowStyle Hidden
$ws = $null
$cancel = [Threading.CancellationToken]::None
$script:msgId = 0

function Send-Cdp([string]$method, $params = @{}) {
  $script:msgId++
  $id = $script:msgId
  $payload = $json.Serialize(@{ id = $id; method = $method; params = $params })
  $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
  $ws.SendAsync((New-Object ArraySegment[byte] -ArgumentList (, $bytes)), 'Text', $true, $cancel).Wait()

  $buffer = New-Object byte[] 1048576
  while ($true) {
    $ms = New-Object IO.MemoryStream
    do {
      $res = $ws.ReceiveAsync((New-Object ArraySegment[byte] -ArgumentList (, $buffer)), $cancel).Result
      $ms.Write($buffer, 0, $res.Count)
    } while (-not $res.EndOfMessage)
    $text = [Text.Encoding]::UTF8.GetString($ms.ToArray())
    $msg = $json.DeserializeObject($text)
    if ($msg.ContainsKey('id') -and $msg['id'] -eq $id) {
      if ($msg.ContainsKey('error')) { throw "CDP $method : $($msg['error']['message'])" }
      return $msg['result']
    }
  }
}

function Eval-Js([string]$expr, [bool]$await = $false) {
  $r = Send-Cdp 'Runtime.evaluate' @{ expression = $expr; awaitPromise = $await; returnByValue = $true }
  if ($r.ContainsKey('exceptionDetails')) {
    $d = $r['exceptionDetails']
    $desc = if ($d.ContainsKey('exception') -and $d['exception'].ContainsKey('description')) { $d['exception']['description'] } else { $d['text'] }
    throw "JS: $desc"
  }
  return $r['result']['value']
}

$ok = $false
try {
  # wait for DevTools
  $page = $null
  for ($i = 0; $i -lt 40 -and -not $page; $i++) {
    Start-Sleep -Milliseconds 500
    try {
      $targets = Invoke-RestMethod "http://127.0.0.1:$Port/json/list" -TimeoutSec 2
      $page = $targets | ForEach-Object { $_ } | Where-Object { $_.type -eq 'page' } | Select-Object -First 1
    } catch { }
  }
  if (-not $page) { throw 'Edge did not open the DevTools port' }

  $ws = New-Object System.Net.WebSockets.ClientWebSocket
  $ws.ConnectAsync([Uri]$page.webSocketDebuggerUrl, $cancel).Wait()

  Send-Cdp 'Page.navigate' @{ url = 'https://www.dotabuff.com/heroes' } | Out-Null

  # wait for the page (and a possible Cloudflare check)
  $ready = $false
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 1
    $st = Eval-Js 'document.readyState + "|" + document.title'
    if ($st -like 'complete|*DOTABUFF*') { $ready = $true; break }
  }
  if (-not $ready) { throw "Dotabuff did not open (last state: $st)" }
  Log 'Dotabuff is open, collecting data...'

  $scraper = Get-Content (Join-Path $root 'scraper.js') -Raw -Encoding UTF8
  $dateJs = $json.Serialize($Date)
  $expr = "window.DBCP_NO_AUTORUN = true;`n$scraper`n;dbcpScrape({ download: false, date: $dateJs }).then(d => JSON.stringify(d))"

  # awaitPromise: Edge waits until the collection finishes
  $resultJson = Eval-Js $expr $true

  $data = $json.DeserializeObject($resultJson)
  $heroCount = $data['m'].Count
  if ($heroCount -lt 100) { throw "Too few heroes collected ($heroCount) - data.js left unchanged" }

  $tmp = "$dataFile.tmp"
  [IO.File]::WriteAllText($tmp, "window.DBCP_DATA = $resultJson;`n", (New-Object Text.UTF8Encoding $false))
  Move-Item $tmp $dataFile -Force

  $failed = @($data['failed'])
  $problems = if ($failed.Count) { ", problems: $($failed -join ', ')" } else { '' }
  Log ("Done: {0} heroes, {1}, {2}{3}" -f $heroCount, $data['period'], $data['updated'], $problems)
  $ok = $true
}
catch {
  Log "ERROR: $($_.Exception.Message)"
}
finally {
  if ($ws) { try { $ws.Dispose() } catch { } }
  if ($proc -and -not $proc.HasExited) {
    # close Edge together with its child processes
    & taskkill /PID $proc.Id /T /F | Out-Null
  }
}
if (-not $ok) { exit 1 }

# ---- optional: commit data.js and push it so the GitHub Pages site gets the fresh data ----
if ($Push) {
  $git = @("$env:LOCALAPPDATA\MinGit\cmd\git.exe", (Get-Command git -ErrorAction SilentlyContinue).Source) |
    Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  if (-not $git) { Log 'ERROR: git not found - cannot push'; exit 1 }
  Push-Location $root
  try {
    & $git pull --rebase --autostash -q 2>&1 | Out-Null
    & $git add data.js
    & $git diff --cached --quiet
    if ($LASTEXITCODE -ne 0) {
      & $git -c user.name=lavrishkovlad -c user.email=lavrishkovlad@gmail.com commit -q -m ("Update Dotabuff data {0:yyyy-MM-dd}" -f (Get-Date))
      & $git push -q 2>&1 | Out-Null
      if ($LASTEXITCODE -ne 0) { Log 'ERROR: git push failed'; exit 1 }
      Log 'Pushed data.js to GitHub'
    } else {
      Log 'data.js unchanged - nothing to push'
    }
  } finally { Pop-Location }
}
exit 0
