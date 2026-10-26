$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$coldRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Push-Location -LiteralPath $coldRoot
try {
$coldVersion = (Get-Content -LiteralPath 'package.json' -Raw | ConvertFrom-Json).version
New-Item -ItemType Directory -Path (Join-Path $coldRoot 'releases') -Force | Out-Null
$coldFirmware = @(rg --files esphome | Where-Object { $_ -notmatch '(^|[\\/])secrets\.yaml$|__pycache__|\.esphome|\.(bin|elf|pyc)$' })
$coldApp = @('README.md','DOCS.md','CHANGELOG.md','repository.yaml','package.json','Dockerfile','config.yaml','compose.yaml','.dockerignore','.gitignore') + @(rg --files server public test scripts) + $coldFirmware
function New-ColdRelease([string]$Name, [string[]]$Files, [bool]$Repository = $false) {
  $coldZipPath = Join-Path $coldRoot ('releases\' + $Name)
  $coldStream = [System.IO.File]::Open($coldZipPath, [System.IO.FileMode]::CreateNew)
  $coldZip = [System.IO.Compression.ZipArchive]::new($coldStream, [System.IO.Compression.ZipArchiveMode]::Create)
  try {
    if ($Repository) { [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($coldZip, (Join-Path $coldRoot 'repository.yaml'), 'repository.yaml', [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null }
    foreach ($coldFile in ($Files | Sort-Object -Unique)) {
      $coldAbsolute = (Resolve-Path -LiteralPath $coldFile).Path
      if (!$coldAbsolute.StartsWith($coldRoot + [System.IO.Path]::DirectorySeparatorChar)) { throw 'Release input escaped workspace' }
      $coldEntryName = 'cold-harbour/' + $coldFile.Replace([char]92,[char]47)
      [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($coldZip, $coldAbsolute, $coldEntryName, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
  } finally { $coldZip.Dispose(); $coldStream.Dispose() }
  $coldRead = [System.IO.Compression.ZipFile]::OpenRead($coldZipPath)
  try {
    $coldBad = @($coldRead.Entries | Where-Object { $_.FullName -match '(^|/)(data|\.qa|releases|__pycache__|\.esphome)/|(^|/)secrets\.yaml$|secrets\.key|\.(sqlite|bin|elf|exe|pyc)$' })
    if ($coldBad.Count) { throw "Unexpected release entries: $($coldBad.FullName)" }
    Write-Output "$Name : $($coldRead.Entries.Count) files, no local data, credentials or compiled binaries"
  } finally { $coldRead.Dispose() }
  Get-FileHash -Algorithm SHA256 -LiteralPath $coldZipPath | Select-Object Path,Hash
}
New-ColdRelease "Cold-Harbour-$coldVersion-home-assistant.zip" $coldApp $true
New-ColdRelease "Cold-Harbour-ESPHome-$coldVersion.zip" ($coldFirmware + 'test\control_core_test.cpp')

} finally { Pop-Location }
