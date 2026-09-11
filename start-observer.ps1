$ErrorActionPreference = 'Stop'
$observerRoot = $PSScriptRoot
$observerConfigPath = Join-Path $observerRoot 'config.local.json'
if (!(Test-Path -LiteralPath $observerConfigPath)) { throw 'Prepare config.local.json first.' }
$observerConfig = Get-Content -Raw -LiteralPath $observerConfigPath | ConvertFrom-Json
$observerState = if ([IO.Path]::IsPathRooted($observerConfig.stateDirectory)) {
    [IO.Path]::GetFullPath($observerConfig.stateDirectory)
} else { [IO.Path]::GetFullPath((Join-Path $observerRoot $observerConfig.stateDirectory)) }
$observerLogs = Join-Path $observerState 'observation-logs'
New-Item -ItemType Directory -Path $observerLogs -Force | Out-Null
$observerStamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$observerNode = (Get-Command node.exe).Source
$observerProcess = Start-Process -FilePath $observerNode -ArgumentList @('src/cli.mjs', 'observe', '--watch', '--interval', '60') -WorkingDirectory $observerRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $observerLogs "$observerStamp.stdout.log") -RedirectStandardError (Join-Path $observerLogs "$observerStamp.stderr.log")
Write-Output "Account observer launched: PID $($observerProcess.Id). Logs: $observerLogs"
Write-Output 'Stop gracefully with: node src/cli.mjs stop-observe'
