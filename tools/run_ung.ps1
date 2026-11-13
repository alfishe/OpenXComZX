# Run tmp/build/oxz.spg on unreal-ng (TS-Conf model TSL) through its WebAPI: a fresh
# instance, the SD card in the Z-Controller slot, the SPG, N frames, a screenshot.
# unreal-ng is a separate emulator (not unreal/, the project's own copy of Unreal):
# no .oxs scenarios here - this is the cross-check on a second TS-Conf implementation.
#   pwsh tools/run_ung.ps1                                    # 500 frames, tmp/shots/ung/oxz.png
#   pwsh tools/run_ung.ps1 -Frames 1500 -Shot tmp/shots/ung/geo.png -Area screen
#   pwsh tools/run_ung.ps1 -Launch <unreal-qt binary>         # start the emulator too (offscreen)
#   pwsh tools/run_ung.ps1 -Card distr                        # a host folder as the card
#   pwsh tools/run_ung.ps1 -Keep                              # leave the instance for the GUI/MCP
# The emulator must be running already (or -Launch). Its WebAPI port: -Url, otherwise
# UNREAL_WEBAPI_PORT, otherwise 8090. With -Launch the emulator gets private ports
# (WebAPI 18190 and neighbours) so it does not collide with other unreal-ng instances,
# and it is stopped at the end unless -Keep.
# Exit code: 0 - the SPG ran the frames and the screenshot is saved.
param(
    [int]$Frames = 500,
    [string]$Shot = 'tmp/shots/ung/oxz.png',
    [ValidateSet('full', 'screen')][string]$Area = 'full',
    [string]$Spg = 'tmp/build/oxz.spg',
    [string]$Card = 'oxz_card.img',
    [string]$Url = '',
    [string]$Launch = '',
    [switch]$Keep
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$LAUNCH_PORT_BASE = 18190                 # WebAPI; MCP +2, CLI/GDB/DeZog/ZRCP +10..+13
$STARTUP_POLL_MS = 500
$STARTUP_POLLS = 60                       # 30 s for the emulator to open its WebAPI
$CLIENT = 'OpenXComZX run_ung.ps1'

function Resolve-Rooted([string]$p) {
    if ([IO.Path]::IsPathRooted($p)) { return $p }
    return [IO.Path]::GetFullPath((Join-Path $root $p))
}
$spgPath = Resolve-Rooted $Spg
$cardPath = Resolve-Rooted $Card
$shotPath = Resolve-Rooted $Shot
foreach ($f in @($spgPath, $cardPath)) { if (-not (Test-Path $f)) { throw "not found: $f" } }
New-Item -ItemType Directory -Force (Split-Path $shotPath) | Out-Null

$proc = $null
if ($Launch) {
    $p = $LAUNCH_PORT_BASE
    $env:UNREAL_WEBAPI_PORT = "$p"; $env:UNREAL_MCP_PORT = "$($p + 2)"
    $env:UNREAL_CLI_PORT = "$($p + 10)"; $env:UNREAL_GDB_PORT = "$($p + 11)"
    $env:UNREAL_DEZOG_PORT = "$($p + 12)"; $env:UNREAL_ZRCP_PORT = "$($p + 13)"
    $log = Join-Path $root 'tmp/ung_emulator.log'
    # working directory - the binary's folder: unreal-ng finds rom/ and configs/ beside it
    $bin = (Resolve-Path $Launch).Path
    $wd = Split-Path $bin
    if ($wd -match '\.app/Contents/MacOS$') { $wd = Split-Path (Split-Path (Split-Path $wd)) }
    $proc = Start-Process -FilePath $bin -ArgumentList @('-platform', 'offscreen') -WorkingDirectory $wd `
        -RedirectStandardOutput $log -RedirectStandardError "$log.err" -PassThru
    if (-not $Url) { $Url = "http://localhost:$p" }
}
if (-not $Url) { $Url = "http://localhost:$(if ($env:UNREAL_WEBAPI_PORT) { $env:UNREAL_WEBAPI_PORT } else { 8090 })" }
$B = "$Url/api/v1"

$up = $false
for ($i = 0; $i -lt $STARTUP_POLLS; $i++) {
    try { Invoke-RestMethod "$B/emulator" -TimeoutSec 2 | Out-Null; $up = $true; break }
    catch { if (-not $proc) { break }; Start-Sleep -Milliseconds $STARTUP_POLL_MS }
}
if (-not $up) { throw "no unreal-ng WebAPI at $Url (start unreal-qt or pass -Launch)" }

$hdr = @{}
function Api([string]$method, [string]$path, $body = $null) {
    $a = @{ Method = $method; Uri = "$B$path"; Headers = $hdr; ContentType = 'application/json' }
    if ($null -ne $body) { $a.Body = ($body | ConvertTo-Json -Compress) }
    return Invoke-RestMethod @a
}

$id = $null
$code = 1
try {
    $id = (Api POST '/emulator/start' @{ model = 'TSL' }).id
    $s = Api POST "/emulator/$id/control/session" @{ client = $CLIENT }
    $sid = if ($s.session) { $s.session } elseif ($s.id) { $s.id } else { $null }
    if ($sid -is [psobject] -and $sid.id) { $sid = $sid.id }
    if ($sid) { $hdr['X-Unreal-Session'] = "$sid" }
    Api POST "/emulator/$id/pause" | Out-Null

    $ins = Api POST "/emulator/$id/media/sd.zc/insert" @{ path = $cardPath }
    if (-not $ins.ok) { throw "SD card insert failed: $($ins | ConvertTo-Json -Compress)" }
    $ld = Api POST "/emulator/$id/snapshot/load" @{ path = $spgPath }
    if ($ld.emulator_id) { $id = $ld.emulator_id }
    Write-Host "unreal-ng $Url, TSL ${id}: $([IO.Path]::GetFileName($spgPath)), card $cardPath"

    $r = Api POST "/emulator/$id/run_frames" @{ count = $Frames }
    if ($r.status -ne 'success') { throw "run_frames: $($r | ConvertTo-Json -Compress)" }
    Write-Host ("ran {0} frames, PC #{1:X4} SP #{2:X4}" -f $Frames, [int]$r.pc, [int]$r.sp)

    $q = "area=$Area&format=png&path=$([uri]::EscapeDataString($shotPath))"
    $c = Api GET "/emulator/$id/capture/screen?$q"
    if (-not $c.saved) { throw "screenshot failed: $($c | ConvertTo-Json -Compress)" }
    Write-Host "screenshot: $shotPath ($($c.frame.mode) $($c.width)x$($c.height))"
    $code = 0
}
finally {
    if ($id -and -not $Keep) {
        try { Api DELETE "/emulator/$id" | Out-Null } catch { Write-Host "destroy failed: $_" }
    } elseif ($id) {
        try { Api DELETE "/emulator/$id/control/session" | Out-Null } catch { }
        Write-Host "instance kept: $id"
    }
    if ($proc -and -not $Keep) { Stop-Process -Id $proc.Id -ErrorAction SilentlyContinue }
}
exit $code
