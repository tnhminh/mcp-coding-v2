[CmdletBinding()]
param(
  [string]$Repository = 'openai/tunnel-client'
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

switch ($env:PROCESSOR_ARCHITECTURE) {
  'AMD64' { $Arch = 'amd64' }
  'ARM64' { $Arch = 'arm64' }
  default { throw "Unsupported Windows architecture: $($env:PROCESSOR_ARCHITECTURE)" }
}

$headers = @{ 'User-Agent' = 'mcp-coding-v2-tunnel-installer' }
$release = Invoke-RestMethod -UseBasicParsing -Headers $headers "https://api.github.com/repos/$Repository/releases/latest"
$tag = [string]$release.tag_name
if ($tag -notmatch '^v\d+\.\d+\.\d+(?:[-+][A-Za-z0-9._-]+)?$') {
  throw "Unexpected tunnel-client release tag: $tag"
}

$assetName = "tunnel-client-$tag-windows-$Arch.zip"
$asset = @($release.assets | Where-Object { $_.name -eq $assetName }) | Select-Object -First 1
if (-not $asset) { throw "Release asset not found: $assetName" }

$digest = [string]$asset.digest
if ($digest -notmatch '^sha256:([a-fA-F0-9]{64})$') {
  throw "Release does not provide a usable SHA-256 digest for $assetName"
}
$expectedSha256 = $Matches[1].ToLowerInvariant()
$downloadUrl = [string]$asset.browser_download_url
if ($downloadUrl -notmatch '^https://github\.com/openai/tunnel-client/releases/download/') {
  throw "Refusing unexpected tunnel-client download URL: $downloadUrl"
}

$installRoot = Join-Path $ProjectRoot ".runtime\tools\tunnel-client\$tag"
New-Item -ItemType Directory -Force -Path $installRoot | Out-Null
$zipPath = Join-Path $installRoot $assetName
$tempPath = "$zipPath.download"

try {
  Invoke-WebRequest -UseBasicParsing -Headers $headers -Uri $downloadUrl -OutFile $tempPath
  $actualSha256 = (Get-FileHash -Algorithm SHA256 $tempPath).Hash.ToLowerInvariant()
  if ($actualSha256 -ne $expectedSha256) {
    throw "SHA-256 mismatch for $assetName. Expected $expectedSha256, received $actualSha256"
  }
  Move-Item -Force $tempPath $zipPath
  Expand-Archive -Path $zipPath -DestinationPath $installRoot -Force
} finally {
  Remove-Item -Force $tempPath -ErrorAction SilentlyContinue
}

$exe = Get-ChildItem -Path $installRoot -Recurse -File -Filter 'tunnel-client.exe' | Select-Object -First 1
if (-not $exe) { throw 'tunnel-client.exe was not found after extracting the verified release.' }

$version = (& $exe.FullName --version 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Verified tunnel-client binary failed its version probe.' }

[pscustomobject]@{
  installed = $true
  tag = $tag
  architecture = $Arch
  sha256 = $expectedSha256
  executable = $exe.FullName
  version = $version
} | ConvertTo-Json -Depth 4
