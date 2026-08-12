$ErrorActionPreference = 'Stop'

$pointer = Get-Content 'editor/out/electron-builder/latest-artifact.json' | ConvertFrom-Json
$setup = $pointer.artifacts | Where-Object { $_.fileName.EndsWith('.exe') } | Select-Object -First 1
if (!$setup) { throw 'Windows editor artifact manifest does not contain an installer.' }
$setupPath = Join-Path $pointer.outputRoot $setup.fileName
$installRoot = Join-Path $env:RUNNER_TEMP 'noveltea-editor-installed'

Remove-Item $installRoot -Recurse -Force -ErrorAction SilentlyContinue
$process = Start-Process -FilePath $setupPath -ArgumentList '/S', '/currentuser', "/D=$installRoot" -Wait -PassThru
if ($process.ExitCode -ne 0) { throw "Installer exited with $($process.ExitCode)." }

$cli = Join-Path $installRoot 'resources/bin/noveltea.exe'
if (!(Test-Path $cli -PathType Leaf)) { throw "Installed CLI is missing: $cli" }
$pathValue = [Environment]::GetEnvironmentVariable('Path', 'User')
$cliDirectory = Split-Path $cli
$components = @($pathValue -split ';' | Where-Object { $_ -eq $cliDirectory })
if ($components.Count -ne 1) { throw "User PATH does not contain exactly one installer-owned CLI entry: $cliDirectory" }

$version = & $cli --json --version | ConvertFrom-Json
if (!$version.success -or $version.exitCode -ne 0) { throw 'Installed CLI version check failed.' }

$uninstaller = Join-Path $installRoot 'Uninstall NovelTea Editor.exe'
if (!(Test-Path $uninstaller -PathType Leaf)) { throw "Uninstaller is missing: $uninstaller" }
$process = Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait -PassThru
if ($process.ExitCode -ne 0) { throw "Uninstaller exited with $($process.ExitCode)." }
$pathValue = [Environment]::GetEnvironmentVariable('Path', 'User')
if (@($pathValue -split ';' | Where-Object { $_ -eq $cliDirectory }).Count -ne 0) {
  throw 'Uninstaller left its CLI directory on PATH.'
}
