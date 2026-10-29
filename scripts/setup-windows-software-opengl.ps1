# The GitHub-hosted Windows runner exposes only a legacy WGL implementation.
# The shipped player requires OpenGL 3.3; install a pinned software WGL
# implementation for the *launch smoke* without modifying the release template.
$ErrorActionPreference = 'Stop'

$version = '26.2.4'
$archiveName = "mesa3d-$version-release-msvc.7z"
$expectedSha256 = '351fc8c8b695878ffb3eaa044b3ead08672a48b1a045e3c3e3975811df0f6695'
$url = "https://github.com/pal1000/mesa-dist-win/releases/download/$version/$archiveName"
$root = Join-Path $env:RUNNER_TEMP 'noveltea-ci-mesa3d'
New-Item -ItemType Directory -Force -Path $root | Out-Null
$archive = Join-Path $root $archiveName

for ($attempt = 1; $attempt -le 3; $attempt++) {
    try {
        Invoke-WebRequest -Uri $url -OutFile $archive
        break
    } catch {
        if ($attempt -eq 3) { throw }
        Start-Sleep -Seconds (5 * $attempt)
    }
}
if ((Get-FileHash -Path $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedSha256) {
    throw "Mesa3D CI download failed its pinned SHA-256 check: $archive"
}

$sevenZip = (Get-Command '7z.exe' -ErrorAction SilentlyContinue).Source
if (-not $sevenZip) {
    $sevenZip = 'C:\Program Files\7-Zip\7z.exe'
    if (-not (Test-Path -LiteralPath $sevenZip)) {
        throw '7-Zip is required to unpack the verified Mesa3D CI runtime.'
    }
}
& $sevenZip x -y "-o$root" $archive | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Mesa3D extraction failed: $LASTEXITCODE" }

$runtime = Join-Path $root 'x64'
foreach ($name in @('opengl32.dll', 'libgallium_wgl.dll')) {
    if (-not (Test-Path -LiteralPath (Join-Path $runtime $name) -PathType Leaf)) {
        throw "Pinned Mesa3D runtime is missing $name"
    }
}
Add-Content -Path $env:GITHUB_ENV -Value "NOVELTEA_WINDOWS_SOFTWARE_OPENGL_DIR=$runtime"
Write-Host "Verified Mesa3D $version (llvmpipe) for the Windows player launch smoke."
