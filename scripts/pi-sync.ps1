# pi-sync 的 PowerShell 入口（Windows 下方便从 CMD/PowerShell 直接调用）
# 实际逻辑都在同目录的 pi-sync（bash）脚本里。
$ErrorActionPreference = 'Stop'

$gitBash = 'C:\Program Files\Git\bin\bash.exe'
if (Test-Path $gitBash) {
    $bash = $gitBash
} else {
    $bash = (Get-Command bash -ErrorAction Stop).Source
}

$script = Join-Path $PSScriptRoot 'pi-sync'
& $bash $script @args
exit $LASTEXITCODE
