$ErrorActionPreference = 'Stop'
$dashboardRoot = $PSScriptRoot
$dashboardConfigPath = Join-Path $dashboardRoot 'config.local.json'
if (!(Test-Path -LiteralPath $dashboardConfigPath)) { throw 'Prepare config.local.json first.' }
if (!(Test-Path -LiteralPath (Join-Path $dashboardRoot 'dashboard/dist/index.html'))) { throw 'Build first: npm run dashboard:build' }
$dashboardConfig = Get-Content -Raw -LiteralPath $dashboardConfigPath | ConvertFrom-Json
$dashboardState = if ([IO.Path]::IsPathRooted($dashboardConfig.stateDirectory)) {
    [IO.Path]::GetFullPath($dashboardConfig.stateDirectory)
} else { [IO.Path]::GetFullPath((Join-Path $dashboardRoot $dashboardConfig.stateDirectory)) }
$dashboardLogs = Join-Path $dashboardState 'dashboard-logs'
New-Item -ItemType Directory -Path $dashboardLogs -Force | Out-Null
$dashboardStamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$dashboardNode = (Get-Command node.exe).Source
$dashboardProcess = Start-Process -FilePath $dashboardNode -ArgumentList @('src/cli.mjs','dashboard') -WorkingDirectory $dashboardRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $dashboardLogs "$dashboardStamp.stdout.log") -RedirectStandardError (Join-Path $dashboardLogs "$dashboardStamp.stderr.log")
Write-Output "Dashboard launched: PID $($dashboardProcess.Id). http://127.0.0.1:4173/"
Write-Output 'Stop gracefully with: node src/cli.mjs stop-dashboard'
