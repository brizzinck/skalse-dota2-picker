<#
  Schedules automatic Dotabuff data updates in Windows Task Scheduler:
  every 6 hours and at log on (if the computer was off, it runs at the first opportunity).
  The task runs update-data.ps1 -Push, so the GitHub Pages site always gets fresh data.

  Install:  powershell -ExecutionPolicy Bypass -File install-autoupdate.ps1
  Remove:   powershell -ExecutionPolicy Bypass -File install-autoupdate.ps1 -Remove
  No push:  powershell -ExecutionPolicy Bypass -File install-autoupdate.ps1 -NoPush
#>
param([switch]$Remove, [switch]$NoPush)

$name = 'Skalse Picker data update'

if ($Remove) {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Task '$name' removed."
  return
}

$script = Join-Path $PSScriptRoot 'update-data.ps1'
$pushArg = if ($NoPush) { '' } else { ' -Push' }
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`"$pushArg" `
  -WorkingDirectory $PSScriptRoot
$every6h = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddHours(6) -RepetitionInterval (New-TimeSpan -Hours 6)
$triggers = @(
  $every6h,
  (New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME")
)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RunOnlyIfNetworkAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName $name -Action $action -Trigger $triggers -Settings $settings `
  -Description 'Updates data.js for Skalse Picker from dotabuff.com' -Force | Out-Null

Write-Host "Done: task '$name' updates the data every 6 hours and at log on$(if (-not $NoPush) { ', and pushes it to GitHub' })."
Write-Host "Log: $(Join-Path $PSScriptRoot 'update.log')"
