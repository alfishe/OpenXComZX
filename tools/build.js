// OpenXComZX build: a wrapper over CMake + Ninja (CMakeLists.txt in the root holds the bank
// table, the memory layout and every build step). All output goes to tmp/build.
//   node tools/build.js [-Game TFTD|UFO] [-NoCard] [-GameDir <game folder>] [-Clean]
// -GameDir - the original game folder (with GEODATA), when it is not under Steam/.
// -NoCard - leave the card (distr/, oxz_card.img) alone: dist.js calls it so and makes the card once.
// -Clean - delete tmp/build and build from scratch.
// Compile jobs: OXZ_JOBS (default - all cores, as Ninja does).
// On macOS / Linux run tools/setup_unix.sh once first (SDCC 4.5.0, the OpenXcom rules).
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseArgs, ROOT } = require('./args');

const opt = parseArgs({ Game: 'TFTD', NoCard: false, GameDir: '', Clean: false });
const out = path.join(ROOT, 'tmp', 'build');
const onWindows = process.platform === 'win32';

// cmake and ninja: PATH first, then the copies Visual Studio ships (Windows).
function onPath(name) {
    const exts = onWindows ? (process.env.PATHEXT || '.EXE').split(';') : [''];
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
        for (const ext of exts) {
            const p = path.join(dir, name + ext.toLowerCase());
            if (dir && fs.existsSync(p) && fs.statSync(p).isFile()) return p;
        }
    }
    return null;
}
function findTool(name, vsSubdir) {
    const p = onPath(name);
    if (p) return p;
    if (onWindows) {
        const vswhere = path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft Visual Studio/Installer/vswhere.exe');
        if (fs.existsSync(vswhere)) {
            const r = spawnSync(vswhere, ['-all', '-prerelease', '-property', 'installationPath'], { encoding: 'utf8' });
            for (const vs of (r.stdout || '').split(/\r?\n/).filter(Boolean)) {
                const exe = path.join(vs, 'Common7/IDE/CommonExtensions/Microsoft/CMake', vsSubdir, name + '.exe');
                if (fs.existsSync(exe)) return exe;
            }
        }
    }
    console.error(`build: ${name} not found (PATH or Visual Studio CMake tools)`);
    process.exit(1);
}
const cmake = findTool('cmake', 'CMake/bin');
const ninja = findTool('ninja', 'Ninja');

if (opt.Clean) fs.rmSync(out, { recursive: true, force: true });

// Configure every time: cheap, and -Game / -GameDir / -NoCard always take effect.
const cfg = ['-S', ROOT, '-B', out, '-G', 'Ninja', `-DCMAKE_MAKE_PROGRAM=${ninja}`,
    `-DOXZ_GAME=${opt.Game}`, `-DOXZ_GAME_DIR=${opt.GameDir}`, `-DOXZ_CARD=${opt.NoCard ? 'OFF' : 'ON'}`];
let r = spawnSync(cmake, cfg, { encoding: 'utf8' });
if (r.status !== 0) {
    process.stdout.write(r.stdout || '');
    process.stderr.write(r.stderr || '');
    console.error('build: cmake configure failed');
    process.exit(1);
}

const bld = ['--build', out];
if (process.env.OXZ_JOBS) bld.push('-j', process.env.OXZ_JOBS);
r = spawnSync(cmake, bld, { stdio: 'inherit' });
if (r.status !== 0) {
    console.error('build: build failed');
    process.exit(1);
}
