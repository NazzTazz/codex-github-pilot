$ErrorActionPreference = 'Stop'
$pilotRoot = $PSScriptRoot
if (!(Test-Path -LiteralPath (Join-Path $pilotRoot 'config.local.json'))) {
    throw 'Prepare config.local.json and run the doctor first.'
}
$pilotLogs = Join-Path $pilotRoot 'state/service-logs'
New-Item -ItemType Directory -Path $pilotLogs -Force | Out-Null
$pilotStamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$pilotNode = (Get-Command node.exe).Source
$pilotProcess = Start-Process -FilePath $pilotNode -ArgumentList @('src/cli.mjs', 'run') -WorkingDirectory $pilotRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $pilotLogs "$pilotStamp.stdout.log") -RedirectStandardError (Join-Path $pilotLogs "$pilotStamp.stderr.log")
Write-Output "Pilot launched: PID $($pilotProcess.Id). Logs: $pilotLogs"
Write-Output 'Stop gracefully with: node src/cli.mjs stop'
