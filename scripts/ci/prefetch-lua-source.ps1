# Download the byte-identical, checksum-pinned Lua 5.5.0 source into vcpkg's
# source archive cache before configuring Windows targets. The upstream
# lua.org HTTPS endpoint has intermittently failed Windows runners; NetBSD
# pkgsrc mirrors the original release tarball without modifying its bytes.
# vcpkg independently checks its pinned SHA512 before extracting.
$ErrorActionPreference = 'Stop'
if (-not $env:VCPKG_ROOT) { throw 'VCPKG_ROOT must be set.' }
$downloads = Join-Path $env:VCPKG_ROOT 'downloads'
New-Item -ItemType Directory -Force -Path $downloads | Out-Null
$archive = Join-Path $downloads 'lua-5.5.0.tar.gz'
$expected = '57ccc32bbbd005cab75bcc52444052535af691789dba2b9016d5c50640d68b3d'
function Test-Archive([string] $path) {
    (Test-Path -LiteralPath $path -PathType Leaf) -and
        ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -eq $expected)
}
if (Test-Archive $archive) {
    Write-Host 'Pinned Lua 5.5.0 archive already cached and verified.'
    exit 0
}
$mirrors = @(
    'https://ftp.netbsd.org/pub/pkgsrc/distfiles/lua-5.5.0.tar.gz',
    'https://www.lua.org/ftp/lua-5.5.0.tar.gz'
)
foreach ($url in $mirrors) {
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        $temporary = "$archive.part"
        try {
            Write-Host "Fetching Lua 5.5.0 source ($attempt/3): $url"
            if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
            Invoke-WebRequest -Uri $url -OutFile $temporary -TimeoutSec 90
            if (-not (Test-Archive $temporary)) {
                throw "Pinned Lua source SHA-256 mismatch: $url"
            }
            Move-Item -LiteralPath $temporary -Destination $archive -Force
            Write-Host 'Pinned Lua 5.5.0 archive verified and cached.'
            exit 0
        } catch {
            Write-Warning $_
            if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
            if ($attempt -lt 3) { Start-Sleep -Seconds 2 }
        }
    }
}
throw 'Could not download the checksum-pinned Lua 5.5.0 source from either mirror.'
