param(
    [ValidateSet('full', 'off')][string]$PageHeap = 'full',
    [string]$OutputRoot = 'build/cli-diagnostics'
)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($OutputRoot)
New-Item -ItemType Directory -Force "$root/setup", "$root/invocations" | Out-Null
$tools = "${env:ProgramFiles(x86)}\Windows Kits\10\Debuggers\x64"
if (!(Test-Path "$tools/cdb.exe") -or !(Test-Path "$tools/gflags.exe")) {
    # Windows SDK 10.0.26100.7705, pinned to Microsoft's winget installer manifest.
    $installer = "$root/setup/winsdksetup.exe"
    Invoke-WebRequest 'https://download.microsoft.com/download/f4b30f2a-4fc3-430e-9b03-c842b5f5f9f1/KIT_BUNDLE_WINDOWSSDK_MEDIACREATION/winsdksetup.exe' -OutFile $installer
    if ((Get-FileHash $installer -Algorithm SHA256).Hash -ne '6FA0FA27DB77A909F5ECB35183CB26A969A6775936780936FE239E4F9C66B458') {
        throw 'Windows SDK installer checksum mismatch.'
    }
    $install = Start-Process $installer -ArgumentList "/features OptionId.WindowsDesktopDebuggers /quiet /norestart /log `"$root/setup/sdk-install.log`"" -PassThru -Wait
    if ($install.ExitCode -notin @(0, 3010)) { throw "Windows SDK install failed: $($install.ExitCode)" }
    Remove-Item $installer
}
foreach ($tool in @('cdb.exe', 'gflags.exe')) {
    if (!(Test-Path "$tools/$tool")) { throw "Missing Windows debugger tool: $tool" }
    (Get-Item "$tools/$tool").VersionInfo | Format-List | Out-File "$root/setup/$tool-version.txt"
}
$env:NT_DIAGNOSTIC_CDB = "$tools/cdb.exe"
$env:NT_DIAGNOSTIC_GFLAGS = "$tools/gflags.exe"
$env:NT_DIAGNOSTIC_EVIDENCE = "$root/invocations"
$env:NT_DIAGNOSTIC_REAL_RUNNER = [IO.Path]::GetFullPath('build/cli/windows/noveltea-ui-test-runner.exe')
$env:NOVELTEA_UI_TEST_RUNNER = "$root/diagnostic-ui-runner.exe"
$env:NOVELTEA_UI_TEST_SYSTEM_ASSET_ROOT = [IO.Path]::GetFullPath('build/cli/windows/assets/system')
$env:_NT_SYMBOL_PATH = "srv*$env:RUNNER_TEMP/nt-symbol-cache*https://msdl.microsoft.com/download/symbols"

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$proxySource = Join-Path (Get-Location) 'scripts\diagnostics\windows-ui-runner-proxy.cs'
$probeSource = Join-Path (Get-Location) 'scripts\diagnostics\windows-debugger-probe.cpp'
foreach ($required in @($csc, $proxySource, $probeSource)) {
    if (!(Test-Path $required)) { throw "Diagnostic input is missing: $required" }
}
@("csc: $csc", "proxy source: $proxySource", "probe source: $probeSource", "proxy output: $env:NOVELTEA_UI_TEST_RUNNER") |
    Set-Content "$root/setup/proxy-build.log"
& $csc /nologo /target:exe /platform:x64 /reference:System.Web.Extensions.dll "/out:$env:NOVELTEA_UI_TEST_RUNNER" "$proxySource" >> "$root/setup/proxy-build.log" 2>&1
if ($LASTEXITCODE -ne 0) {
    Get-Content "$root/setup/proxy-build.log" | Write-Output
    throw 'Diagnostic proxy compilation failed; see proxy-build.log.'
}
& g++ -g -O0 "$probeSource" -o "$root/nt-debugger-probe.exe" *> "$root/setup/probe-build.log"
if ($LASTEXITCODE -ne 0) {
    Get-Content "$root/setup/probe-build.log" | Write-Output
    throw 'Debugger probe compilation failed; see probe-build.log.'
}

# Validate the complete capture path before spending time on the CLI build.
& $env:NT_DIAGNOSTIC_GFLAGS /p /enable nt-debugger-probe.exe /full *> "$root/setup/probe-pageheap.log"
if ($LASTEXITCODE -ne 0) { throw 'Could not enable probe page heap.' }
$realRunner = $env:NT_DIAGNOSTIC_REAL_RUNNER
$evidence = $env:NT_DIAGNOSTIC_EVIDENCE
try {
    $env:NT_DIAGNOSTIC_REAL_RUNNER = "$root/nt-debugger-probe.exe"
    $env:NT_DIAGNOSTIC_EVIDENCE = "$root/proxy-self-test"
    New-Item -ItemType Directory -Force $env:NT_DIAGNOSTIC_EVIDENCE | Out-Null
    Set-Content "$root/setup/probe-request.json" '{}' -Encoding utf8NoBOM
    & $env:NOVELTEA_UI_TEST_RUNNER "$root/setup/probe-request.json" "$root/setup/probe-response.json"
    if ($LASTEXITCODE -ne 0 -or !(Test-Path "$root/setup/probe-response.json")) {
        throw 'Debugger self-test failed on successful child process.'
    }
    Remove-Item "$root/setup/probe-response.json"
    $env:NT_DIAGNOSTIC_PROBE_CRASH = '1'
    & $env:NOVELTEA_UI_TEST_RUNNER "$root/setup/probe-request.json" "$root/setup/probe-response.json"
    if ($LASTEXITCODE -eq 0 -or (Test-Path "$root/setup/probe-response.json")) {
        throw 'Debugger self-test incorrectly admitted a response from a crashing child.'
    }
    if (!(Get-ChildItem "$root/proxy-self-test" -Recurse -Filter crash.dmp)) {
        Get-ChildItem "$root/proxy-self-test" -Recurse -Filter debugger.log | ForEach-Object {
            Write-Output "--- $($_.FullName)"
            Get-Content $_.FullName -Tail 25 | Write-Output
        }
        throw 'Debugger self-test did not capture a page-heap crash dump.'
    }
    if (!(Test-Path "$root/proxy-self-test/fault-detected.txt")) {
        throw 'Debugger self-test did not record the crash marker.'
    }
    Write-Output 'Debugger self-test: successful response and page-heap crash capture PASS.'
} finally {
    Remove-Item Env:NT_DIAGNOSTIC_PROBE_CRASH -ErrorAction SilentlyContinue
    $env:NT_DIAGNOSTIC_REAL_RUNNER = $realRunner
    $env:NT_DIAGNOSTIC_EVIDENCE = $evidence
    & $env:NT_DIAGNOSTIC_GFLAGS /p /disable nt-debugger-probe.exe *> "$root/setup/probe-pageheap-cleanup.log"
}

if ($PageHeap -eq 'full') {
    & $env:NT_DIAGNOSTIC_GFLAGS /p /enable noveltea-ui-test-runner.exe /full *> "$root/setup/pageheap.log"
} else {
    & $env:NT_DIAGNOSTIC_GFLAGS /p /disable noveltea-ui-test-runner.exe *> "$root/setup/pageheap.log"
}
if ($LASTEXITCODE -ne 0) { throw 'Could not configure runner page heap.' }
& $env:NT_DIAGNOSTIC_GFLAGS /p >> "$root/setup/pageheap.log"
Set-Content "$root/setup/pageheap-mode.txt" $PageHeap
foreach ($name in @('NT_DIAGNOSTIC_CDB', 'NT_DIAGNOSTIC_GFLAGS', 'NT_DIAGNOSTIC_EVIDENCE',
    'NT_DIAGNOSTIC_REAL_RUNNER', 'NOVELTEA_UI_TEST_RUNNER', 'NOVELTEA_UI_TEST_SYSTEM_ASSET_ROOT', '_NT_SYMBOL_PATH')) {
    Add-Content $env:GITHUB_ENV "$name=$([Environment]::GetEnvironmentVariable($name))"
}
