# Сборка OpenXComZX — обёртка над CMake + Ninja (CMakeLists.txt в корне: таблица банков,
# раскладка памяти и все шаги сборки описаны там).
# Все выходные файлы — в tmp/build (правило проекта: артефакты только в tmp/).
#   powershell -File tools\build.ps1 [-Game TFTD|UFO] [-NoCard] [-GameDir <game folder>]
#   pwsh tools/build.ps1 ...                 (macOS/Linux: tools/setup_unix.sh first)
# -GameDir — the original game folder (with GEODATA), when it is not under Steam/.
# -NoCard — не трогать карту (oxz_card.img): так зовёт dist.ps1, он соберёт её сам.
# -Clean — удалить tmp/build и собрать заново.
# Compile jobs: OXZ_JOBS (default - all cores, as Ninja does).
param([string]$Game = 'TFTD', [switch]$NoCard, [string]$GameDir = '', [switch]$Clean)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$out  = Join-Path $root 'tmp/build'

$onWindows = ($PSVersionTable.PSEdition -eq 'Desktop') -or $IsWindows

# cmake and ninja: PATH first, then the copies Visual Studio ships (Windows).
function Find-Tool([string]$name, [string]$vsSubdir) {
    $c = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c) { return $c.Source }
    if ($onWindows) {
        $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
        if (Test-Path $vswhere) {
            foreach ($vs in & $vswhere -all -prerelease -property installationPath) {
                $p = Join-Path $vs "Common7/IDE/CommonExtensions/Microsoft/CMake/$vsSubdir/$name.exe"
                if (Test-Path $p) { return $p }
            }
        }
    }
    throw "$name not found (PATH or Visual Studio CMake tools)"
}
$cmake = Find-Tool 'cmake' 'CMake/bin'
$ninja = Find-Tool 'ninja' 'Ninja'

if ($Clean -and (Test-Path $out)) { Remove-Item -Recurse -Force $out }

# Configure every time: cheap, and -Game / -GameDir / -NoCard always take effect.
$card = if ($NoCard) { 'OFF' } else { 'ON' }
$cfg = @('-S', $root, '-B', $out, '-G', 'Ninja', "-DCMAKE_MAKE_PROGRAM=$ninja",
         "-DOXZ_GAME=$Game", "-DOXZ_GAME_DIR=$GameDir", "-DOXZ_CARD=$card")
& $cmake @cfg | Out-Null
if ($LASTEXITCODE -ne 0) { & $cmake @cfg; throw 'cmake configure failed' }

$bld = @('--build', $out)
if ($env:OXZ_JOBS) { $bld += @('-j', $env:OXZ_JOBS) }
& $cmake @bld
if ($LASTEXITCODE -ne 0) { throw 'build failed' }
