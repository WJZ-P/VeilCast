<#
.SYNOPSIS
    Downloads the FFmpeg "essentials" release build from gyan.dev into tools/ffmpeg/.

.DESCRIPTION
    The binaries are not committed to git (see .gitignore). Run this script once per
    clone. It verifies the SHA256 published alongside the archive, then copies only
    ffmpeg.exe, ffprobe.exe and the license/readme files into tools/ffmpeg/.

    The essentials build includes libx264, libx265, libvpx and libvmaf, which is all
    the scramble pipeline needs. It is a GPL build; keep LICENSE next to the binaries.

.PARAMETER Force
    Re-download even if tools/ffmpeg/ffmpeg.exe already exists.
#>
[CmdletBinding()]
param(
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
# Invoke-WebRequest is dramatically slower with the progress bar enabled.
$ProgressPreference = 'SilentlyContinue'

$ArchiveUrl = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
$ChecksumUrl = "$ArchiveUrl.sha256"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$TargetDir = Join-Path $RepoRoot 'tools\ffmpeg'
$TargetExe = Join-Path $TargetDir 'ffmpeg.exe'

if ((Test-Path $TargetExe) -and -not $Force) {
    Write-Host "ffmpeg.exe already present at $TargetExe (use -Force to re-download)."
    & $TargetExe -version | Select-Object -First 1
    exit 0
}

$WorkDir = Join-Path ([System.IO.Path]::GetTempPath()) ('veilcast-ffmpeg-' + [System.Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $WorkDir | Out-Null

try {
    $ArchivePath = Join-Path $WorkDir 'ffmpeg-release-essentials.zip'

    Write-Host "Downloading $ArchiveUrl ..."
    Invoke-WebRequest -Uri $ArchiveUrl -OutFile $ArchivePath -UseBasicParsing

    Write-Host "Verifying SHA256 ..."
    $Expected = (Invoke-WebRequest -Uri $ChecksumUrl -UseBasicParsing).Content.Trim().Split(' ')[0].ToLowerInvariant()
    $Actual = (Get-FileHash -Path $ArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($Expected -ne $Actual) {
        throw "SHA256 mismatch: expected $Expected, got $Actual"
    }

    Write-Host "Extracting ..."
    $ExtractDir = Join-Path $WorkDir 'extract'
    Expand-Archive -Path $ArchivePath -DestinationPath $ExtractDir

    # The archive contains a single versioned top-level folder, e.g. ffmpeg-9.0.1-essentials_build/.
    $BuildRoot = Get-ChildItem -Path $ExtractDir -Directory | Select-Object -First 1
    if ($null -eq $BuildRoot) {
        throw "Unexpected archive layout: no top-level directory in $ExtractDir"
    }

    New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null
    foreach ($Name in @('bin\ffmpeg.exe', 'bin\ffprobe.exe', 'LICENSE', 'README.txt')) {
        $Source = Join-Path $BuildRoot.FullName $Name
        if (-not (Test-Path $Source)) {
            throw "Missing $Name in archive"
        }
        Copy-Item -Path $Source -Destination $TargetDir -Force
    }

    # Record which build was fetched so it can be cross-checked later.
    $Version = (& $TargetExe -version | Select-Object -First 1)
    Set-Content -Path (Join-Path $TargetDir 'VERSION.txt') -Encoding utf8 -Value @(
        $Version,
        "source: $ArchiveUrl",
        "sha256: $Actual",
        "fetched: $(Get-Date -Format 'yyyy-MM-dd')"
    )

    Write-Host "Done: $Version"
}
finally {
    Remove-Item -Path $WorkDir -Recurse -Force -ErrorAction SilentlyContinue
}
