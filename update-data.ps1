<#
  Автоматическое обновление data.js с Dotabuff.

  Запускает невидимый (headless) Microsoft Edge, открывает dotabuff.com и выполняет там
  scraper.js через DevTools-протокол. Запросы идут из настоящего браузера, поэтому
  Cloudflare их пропускает. data.js перезаписывается только если данные собраны успешно.

  Запуск вручную:   powershell -ExecutionPolicy Bypass -File update-data.ps1
  Период Dotabuff:  ... -File update-data.ps1 -Date week
  Автозапуск:       install-autoupdate.ps1
#>
param(
  [string]$Date = '',
  [int]$Port = 9333,
  [int]$TimeoutSec = 900
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
if (-not $edge) { Log 'ОШИБКА: Microsoft Edge не найден'; exit 1 }

$profileDir = Join-Path $env:LOCALAPPDATA 'DotaBuffCP\edge-profile'
New-Item -ItemType Directory -Force $profileDir | Out-Null

$ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0'
$edgeArgs = @('--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  "--remote-debugging-port=$Port", "--user-data-dir=`"$profileDir`"", "--user-agent=`"$ua`"", 'about:blank')

Log 'Запуск обновления данных Dotabuff'
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

try {
  # ждём DevTools
  $page = $null
  for ($i = 0; $i -lt 40 -and -not $page; $i++) {
    Start-Sleep -Milliseconds 500
    try {
      $targets = Invoke-RestMethod "http://127.0.0.1:$Port/json/list" -TimeoutSec 2
      $page = $targets | ForEach-Object { $_ } | Where-Object { $_.type -eq 'page' } | Select-Object -First 1
    } catch { }
  }
  if (-not $page) { throw 'Edge не открыл DevTools-порт' }

  $ws = New-Object System.Net.WebSockets.ClientWebSocket
  $ws.ConnectAsync([Uri]$page.webSocketDebuggerUrl, $cancel).Wait()

  Send-Cdp 'Page.navigate' @{ url = 'https://www.dotabuff.com/heroes' } | Out-Null

  # ждём загрузку страницы (и возможную проверку Cloudflare)
  $ready = $false
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 1
    $st = Eval-Js 'document.readyState + "|" + document.title'
    if ($st -like 'complete|*DOTABUFF*') { $ready = $true; break }
  }
  if (-not $ready) { throw "Dotabuff не открылся (последнее состояние: $st)" }
  Log 'Dotabuff открыт, собираю контрпики…'

  $scraper = Get-Content (Join-Path $root 'scraper.js') -Raw -Encoding UTF8
  $dateJs = $json.Serialize($Date)
  $expr = "window.DBCP_NO_AUTORUN = true;`n$scraper`n;dbcpScrape({ download: false, date: $dateJs }).then(d => JSON.stringify(d))"

  # awaitPromise: Edge сам дождётся окончания сбора
  $resultJson = Eval-Js $expr $true

  $data = $json.DeserializeObject($resultJson)
  $heroCount = $data['m'].Count
  if ($heroCount -lt 100) { throw "Собрано слишком мало героев ($heroCount) — data.js не изменён" }

  $tmp = "$dataFile.tmp"
  [IO.File]::WriteAllText($tmp, "window.DBCP_DATA = $resultJson;`n", (New-Object Text.UTF8Encoding $false))
  Move-Item $tmp $dataFile -Force

  $failed = @($data['failed'])
  Log ("Готово: {0} героев, дата {1}{2}" -f $heroCount, $data['updated'],
    $(if ($failed.Count) { ", проблемы: $($failed -join ', ')" } else { '' }))
  exit 0
}
catch {
  Log "ОШИБКА: $($_.Exception.Message)"
  exit 1
}
finally {
  if ($ws) { try { $ws.Dispose() } catch { } }
  if ($proc -and -not $proc.HasExited) {
    # закрываем Edge вместе с дочерними процессами
    & taskkill /PID $proc.Id /T /F | Out-Null
  }
}
