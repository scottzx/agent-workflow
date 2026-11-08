$ErrorActionPreference = 'Stop'
$name = 'wx-outbox-worker'
$home_ = 'C:\Users\Administrator\wx-baseline'
if (Test-Path "$home_\outbox.stop") { Remove-Item "$home_\outbox.stop" -Force }
$pythonw = Join-Path (Split-Path (Get-Command python).Source) 'pythonw.exe'
$action = New-ScheduledTaskAction -Execute $pythonw -Argument "-X utf8 `"$home_\wx_outbox.py`" worker" -WorkingDirectory $home_
$principal = New-ScheduledTaskPrincipal -UserId 'Administrator' -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $name -Action $action -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $name
Start-Sleep -Seconds 2
Write-Output ("task-state=" + (Get-ScheduledTask -TaskName $name).State)
if (Test-Path "$home_\outbox.log") { Get-Content "$home_\outbox.log" -Tail 3 -Encoding UTF8 }
