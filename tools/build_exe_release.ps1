param(
    [string]$Python = "C:\Users\LEE SANGGGON\AppData\Local\Programs\Python\Python310\python.exe",
    [string]$Version = "1.1.0"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Tag = "v$Version-exe"
$AssetName = "NAI_Image_Manager_${Tag}_windows.zip"
$UpdaterAssetName = "NAIM_Updater_${Tag}.exe"
$MainDist = Join-Path $Root "dist_exe"
$UpdaterDist = Join-Path $Root "dist_updater"
$WorkDir = Join-Path $Root "build\exe-release"
$AssetDir = Join-Path $Root "release_assets\$Tag"
$PortableDir = Join-Path $MainDist "NAI_Image_Manager"
$ManagedManifest = Join-Path $PortableDir ".naim-managed-files.json"

function Get-PortableRelativePath {
    param([string]$BasePath, [string]$FullPath)

    $baseWithSlash = $BasePath.TrimEnd("\") + "\"
    $baseUri = New-Object System.Uri($baseWithSlash)
    $fileUri = New-Object System.Uri($FullPath)
    return [Uri]::UnescapeDataString($baseUri.MakeRelativeUri($fileUri).ToString()).Replace("\", "/")
}

if (-not (Test-Path -LiteralPath $Python -PathType Leaf)) {
    throw "Python executable not found: $Python"
}

foreach ($path in @($MainDist, $UpdaterDist, $WorkDir, $AssetDir)) {
    if (Test-Path -LiteralPath $path) {
        Remove-Item -LiteralPath $path -Recurse -Force
    }
}
New-Item -ItemType Directory -Path $AssetDir -Force | Out-Null

Push-Location $Root
try {
    & $Python -m PyInstaller --noconfirm --clean --distpath $UpdaterDist --workpath (Join-Path $WorkDir "updater") "NAIM_Updater.spec"
    if ($LASTEXITCODE -ne 0) { throw "Updater PyInstaller build failed." }

    & $Python -m PyInstaller --noconfirm --clean --distpath $MainDist --workpath (Join-Path $WorkDir "main") "NAI_Image_Manager.spec"
    if ($LASTEXITCODE -ne 0) { throw "Main PyInstaller build failed." }
}
finally {
    Pop-Location
}

$UpdaterExe = Join-Path $UpdaterDist "NAIM_Updater.exe"
$MainExe = Join-Path $PortableDir "NAI_Image_Manager.exe"
if (-not (Test-Path -LiteralPath $UpdaterExe -PathType Leaf)) { throw "Updater EXE was not created." }
if (-not (Test-Path -LiteralPath $MainExe -PathType Leaf)) { throw "Main EXE was not created." }
Copy-Item -LiteralPath $UpdaterExe -Destination (Join-Path $PortableDir "NAIM_Updater.exe") -Force

$ProtectedFiles = @(
    "artists.json",
    "styles.json",
    "gallery_config.json",
    "gallery_image_tags.json",
    "lab_config.json",
    "quality_presets.json",
    "tag_dictionary_user_overrides.json",
    "canvas_saved_setups.json",
    "tag_categories_ko.json",
    ".env"
)
$ProtectedDirectories = @("TOTAL_CLASSIFIED", "output", "canvas_imports", "daki_generated_temp")
$PayloadFiles = Get-ChildItem -LiteralPath $PortableDir -Recurse -File
foreach ($file in $PayloadFiles) {
    $relative = Get-PortableRelativePath $PortableDir $file.FullName
    $parts = $relative.Split("/")
    if ($ProtectedFiles -contains $file.Name -or ($parts | Where-Object { $ProtectedDirectories -contains $_ })) {
        throw "Protected user data was included in the build: $relative"
    }
}

$ManagedFiles = @($PayloadFiles | ForEach-Object {
    Get-PortableRelativePath $PortableDir $_.FullName
} | Sort-Object)
$ManagedData = [ordered]@{ version = $Version; files = $ManagedFiles }
[IO.File]::WriteAllText(
    $ManagedManifest,
    ($ManagedData | ConvertTo-Json -Depth 4),
    [Text.UTF8Encoding]::new($false)
)

$ZipPath = Join-Path $AssetDir $AssetName
Compress-Archive -LiteralPath $PortableDir -DestinationPath $ZipPath -CompressionLevel Optimal
Copy-Item -LiteralPath $UpdaterExe -Destination (Join-Path $AssetDir $UpdaterAssetName) -Force

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($ZipPath)
try {
    foreach ($entry in $archive.Entries) {
        $entryParts = $entry.FullName.Replace("\", "/").Split("/")
        if ($ProtectedFiles -contains $entry.Name -or ($entryParts | Where-Object { $ProtectedDirectories -contains $_ })) {
            throw "Protected user data was included in the ZIP: $($entry.FullName)"
        }
    }
}
finally {
    $archive.Dispose()
}

$ZipItem = Get-Item -LiteralPath $ZipPath
$Hash = (Get-FileHash -LiteralPath $ZipPath -Algorithm SHA256).Hash.ToLowerInvariant()
$ChecksumPath = "$ZipPath.sha256"
[IO.File]::WriteAllText($ChecksumPath, "$Hash  $AssetName`n", [Text.UTF8Encoding]::new($false))

$Manifest = [ordered]@{
    schema_version = 1
    version = $Version
    tag = $Tag
    asset_url = "https://github.com/okawaritsuika/nai_image_manager/releases/download/$Tag/$AssetName"
    sha256 = $Hash
    size = $ZipItem.Length
    payload_root = "NAI_Image_Manager"
    summary = "Adds in-app EXE updates, legacy Lite migration, and user-data preservation."
}
[IO.File]::WriteAllText(
    (Join-Path $Root "release_manifest.json"),
    ($Manifest | ConvertTo-Json -Depth 4),
    [Text.UTF8Encoding]::new($false)
)

Write-Output "BUILD_OK"
Write-Output "ZIP=$ZipPath"
Write-Output "UPDATER=$(Join-Path $AssetDir $UpdaterAssetName)"
Write-Output "SHA256=$Hash"
Write-Output "SIZE=$($ZipItem.Length)"
Write-Output "PRIVACY_SCAN=PASS"
