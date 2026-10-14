<#
  Ставит автообновление данных Dotabuff в Планировщик задач Windows:
  каждый день в 06:00 и при входе в систему (если компьютер был выключен — запустится при первой возможности).

  Установить:  powershell -ExecutionPolicy Bypass -File install-autoupdate.ps1
  Удалить:     powershell -ExecutionPolicy Bypass -File install-autoupdate.ps1 -Remove
#>
param([switch]$Remove)

$name = 'DotaBuffCP data update'

if ($Remove) {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Задача «$name» удалена."
  return
}

$script = Join-Path $PSScriptRoot 'update-data.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`"" `
  -WorkingDirectory $PSScriptRoot
$triggers = @(
  (New-ScheduledTaskTrigger -Daily -At '06:00'),
  (New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME")
)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RunOnlyIfNetworkAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 20) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName $name -Action $action -Trigger $triggers -Settings $settings `
  -Description 'Обновляет data.js для DotaBuffCP с dotabuff.com' -Force | Out-Null

Write-Host "Готово: задача «$name» обновляет данные ежедневно в 06:00 и при входе в систему."
Write-Host "Лог: $(Join-Path $PSScriptRoot 'update.log')"
