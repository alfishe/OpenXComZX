// Runs tmp/build/oxz.spg in the emulator unreal/build/oxz/Unreal.exe (the project's Unreal copy).
//   node tools/run.js                                   # interactive
//   node tools/run.js -Frames 200 -Shot tmp/shot.png    # N frames, screenshot, exit
//   node tools/run.js -Script tests/ui_geoscape.oxs -Headless   # scenario without a window
//   node tools/run.js -Script tests/ui_geoscape.oxs     # scenario in a window, then by hand
//   node tools/run.js -Boot                             # as on hardware: no snapshot,
//       TS-BIOS boots from the card oxz_card.img (boot.$C -> Wild Commander -> ENTER on OXZTFTD.SPG)
//   node tools/run.js -Cmd tmp/oxz_cmd.txt              # window + control channel: lines
//       appended to this file are executed on the fly and the emulator does not exit after
//       them - a live game driven from outside: mouse, keys, shots, state save/load (07)
// The emulator runs from the project root: relative paths in scenarios are from there.
// Exit code in test mode: the program's code (#FAAF) / the scenario's (exit),
// #FD - an expect failed, #FE - waitmark timed out, #EE - crash (RST 0).
// -Set ZC.SDHC=1,ZC.SDCARD= - own emulator ini keys over the standard ones; a scenario can
// declare them itself with lines "#@set ZC.SDHC=1" (runtests.js sees them too).
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseArgs, ROOT } = require('./args');

const opt = parseArgs({ Frames: 0, Shot: '', Script: '', Wav: '', Cmd: '', Headless: false, Boot: false, Set: [] });
const out = path.join(ROOT, 'tmp', 'build');
const emu = path.join(ROOT, 'unreal', 'build', 'oxz');
const ini = path.join(out, 'oxz.ini');
const full = (p) => path.resolve(ROOT, p);
fs.mkdirSync(path.join(ROOT, 'tmp', 'shots'), { recursive: true });

// Just the window (no scenario/frames/shot): the emulator console is hidden
// (MISC.HideConsole) - Win+G (Game Bar) recording sees the game window only.
const interactive = !(opt.Frames > 0 || opt.Shot || opt.Script || opt.Cmd || opt.Headless);
let sets = [...opt.Set];
if (opt.Script) {
    for (const l of fs.readFileSync(full(opt.Script), 'utf8').split(/\r?\n/)) {
        const m = /^#@set\s+(\S+=\S*)/.exec(l);
        if (m) sets.push(m[1]);
    }
}
// A relative card image (#@set ZC.SDCARD=tmp/sdtest/...) is from the project root:
// the emulator would prefix its own folder
sets = sets.map((s) => {
    const m = /^ZC\.SDCARD=(.+)$/.exec(s);
    return m && !path.isAbsolute(m[1]) ? 'ZC.SDCARD=' + full(m[1]) : s;
});
// -Boot: no snapshot - the machine starts from the card through TS-BIOS, as the real one
// (the card must be FAT32, or TS-BIOS says "System Meditation: FAT32 NOT FOUND!")
let r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'mkini.js'), path.join(emu, 'Unreal.ini'), ini,
    'AUTOLOAD.diskA=',
    'AUTOLOAD.snapshot=' + (opt.Boot ? '' : path.join(out, 'oxz.spg')),
    'ZC.SDCARD=' + path.join(ROOT, 'oxz_card.img'),
    'INPUT.Wheel=KEMPSTON',
    'MISC.HideConsole=' + (interactive ? 1 : 0),
    ...sets], { stdio: 'inherit' });
if (r.status !== 0) { console.error('run: mkini failed'); process.exit(1); }

const argv = ['-c', ini, '-l', path.join(out, 'oxz.labels')];
if (opt.Frames > 0) argv.push('-t', String(opt.Frames));
if (opt.Shot) argv.push('-o', full(opt.Shot));
if (opt.Script) argv.push('-s', full(opt.Script));
// -Wav: the emulator's mixed sound to a WAV (music analysis, 07)
if (opt.Wav) argv.push('-a', full(opt.Wav));
// Control channel: the command file is created up front, the emulator reads it as it grows
if (opt.Cmd) {
    const cmd = full(opt.Cmd);
    fs.mkdirSync(path.dirname(cmd), { recursive: true });
    if (!fs.existsSync(cmd)) fs.writeFileSync(cmd, '');
    argv.push('-p', cmd);
}
if (opt.Headless) argv.push('-H');

const exe = path.join(emu, 'Unreal.exe');
if (!fs.existsSync(exe)) { console.error(`run: no emulator ${exe} (unreal/ is the project's Unreal copy, Windows)`); process.exit(1); }
r = spawnSync(exe, argv, { cwd: ROOT, stdio: 'inherit' });
process.exit(r.status ?? 1);
