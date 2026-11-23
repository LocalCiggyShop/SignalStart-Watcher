param(
    [ValidatePattern('^[a-p]{32}$')][string]$ExtensionId,
    [switch]$BuildOnly
)
$ErrorActionPreference = 'Stop'
$bridgeRoot = $PSScriptRoot
$bridgeExe = Join-Path $bridgeRoot 'SignalStartNativeHost.exe'
$bridgeSource = Join-Path $bridgeRoot 'NativeHost.cs'
if (!(Test-Path -LiteralPath $bridgeExe) -or
    (Get-Item -LiteralPath $bridgeSource).LastWriteTimeUtc -gt (Get-Item -LiteralPath $bridgeExe).LastWriteTimeUtc) {
    $bridgeBuild = Join-Path $bridgeRoot ('build-' + [Guid]::NewGuid().ToString('N') + '.exe')
    Add-Type -Path $bridgeSource -ReferencedAssemblies 'System.dll','System.Web.Extensions.dll' -OutputAssembly $bridgeBuild -OutputType ConsoleApplication
    Move-Item -LiteralPath $bridgeBuild -Destination $bridgeExe -Force
}
$setupSource = Join-Path $bridgeRoot 'SetupBridge.cs'
$setupExe = Join-Path $bridgeRoot 'SetupBridge.exe'
$eaFile = Join-Path $bridgeRoot 'SignalStartBridge.ex5'
if ((Test-Path -LiteralPath $setupSource) -and (Test-Path -LiteralPath $eaFile)) {
    $setupBuild = Join-Path $bridgeRoot ('setup-build-' + [Guid]::NewGuid().ToString('N') + '.exe')
    $csharpCompiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    & $csharpCompiler /nologo /target:winexe "/out:$setupBuild" /reference:System.dll /reference:System.Drawing.dll /reference:System.Windows.Forms.dll /reference:System.Web.Extensions.dll "/resource:$bridgeExe,SignalStartNativeHost" "/resource:$eaFile,SignalStartBridgeEA" $setupSource
    if ($LASTEXITCODE -ne 0) { throw 'Could not compile SetupBridge.exe.' }
    Move-Item -LiteralPath $setupBuild -Destination $setupExe -Force
}
if ($BuildOnly) { Write-Output $bridgeExe; Write-Output $setupExe; return }
if (!$ExtensionId) { throw 'Supply -ExtensionId with the 32-character ID shown in the extension popup.' }
$bridgeManifest = Join-Path $bridgeRoot 'com.signalstart.mt5_bridge.json'
$bridgeConfig = @{
    name = 'com.signalstart.mt5_bridge'
    description = 'SignalStart to MT5 local file bridge'
    path = $bridgeExe
    type = 'stdio'
    allowed_origins = @('chrome-extension://' + $ExtensionId + '/')
} | ConvertTo-Json
[IO.File]::WriteAllText($bridgeManifest, $bridgeConfig, [Text.UTF8Encoding]::new($false))
foreach ($bridgeBrowserKey in @(
    'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.signalstart.mt5_bridge',
    'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.signalstart.mt5_bridge',
    'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.signalstart.mt5_bridge'
)) {
    New-Item -Path $bridgeBrowserKey -Force | Out-Null
    Set-Item -LiteralPath $bridgeBrowserKey -Value $bridgeManifest
}
Write-Output 'Local helper registered for this Windows user. Reload the extension and choose a signal in MT5 connection.'
Write-Output 'The installer does not attach the EA, enable trading, or change an MT5 account.'
