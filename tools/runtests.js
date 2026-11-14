// Runs the tests/*.oxs scenarios (all but ufopaedia_ufo - that one after a -Game UFO build).
//   node tools/runtests.js                  # all
//   node tools/runtests.js campaign craft   # chosen ones
// Summary: name=code(frames); exit code - the number of failures.
//
// The emulator's crash log (tmp/oxz_crash.log) is deleted before each scenario and read after
// it. Traps come in two kinds: fatal ones fail the scenario (DMA into kernel pages, PC lost,
// stack overflow, stale cache read, unbalanced interrupt stack), warnings are only printed
// (stack low, write above SP). Without this check the traps went to the log and the suite
// stayed green (review 2026-09-26).
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { ROOT } = require('./args');

const DEFAULT_TESTS = ['selftest', 'math', 'ui_geoscape', 'campaign', 'month', 'aliens', 'dogfight', 'dogfight2',
    'basedefense', 'ironman', 'lab', 'transfer', 'craft', 'inventory', 'ufopaedia', 'globe', 'intercept',
    'bat_render', 'bat_cursor', 'bat_doors', 'bat_levels', 'bat_kneel', 'sdinfo', 'sdinfo_dma', 'sdinfo_sdhc',
    'sdinfo_nocard', 'sdinfo_grub', 'sdinfo_nofat', 'intercept_live', 'ufopaedia+nodma', 'bat_render+nodma'];
const BAD = /OXZ: (DMA INTO KERNEL|PC LOST|STACK OVERFLOW|CACHE STALE|ISR STACK|KERNEL CODE WRITE|IX SLOT|GFX_MAP RANGE|MUSIC RING WRITE|TEXT DOUBLE YB)/;
const WARN = /OXZ: (STACK LOW|STACK WRITE|POP MISMATCH|POP PATH)/;
const TAIL_LINES = 15, SHOW_TRAPS = 5, SHOW_WARNS = 3;

const names = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_TESTS;
// Card image variants (a GRUB MBR and so on) - from oxz_card.img, when it is newer
if (names.some((n) => /^sdinfo_(grub|nofat)/.test(n)))
    spawnSync(process.execPath, [path.join(ROOT, 'tools', 'cardvariants.js')], { stdio: 'ignore' });
const log = path.join(ROOT, 'tmp', 'oxz_crash.log');
const uniq = (a) => [...new Set(a)];
let fail = 0;
const sum = [];
for (const n of names) {
    fs.rmSync(log, { force: true });
    // "name+nodma" - the same scenario on a machine without SPI DMA (ZC.FaultDmaSpi=1): the game
    // falls back to reading the card sector by sector (fat.c dma_check, 23 §5)
    let script = n, extra = [];
    const nd = /^(.+)\+nodma$/.exec(n);
    if (nd) { script = nd[1]; extra = ['-Set', 'ZC.FaultDmaSpi=1']; }
    const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'run.js'), '-Script', `tests/${script}.oxs`, '-Headless', ...extra],
        { encoding: 'utf8', maxBuffer: 1 << 28 });
    const o = ((r.stdout || '') + (r.stderr || '')).split(/\r?\n/);
    let code = r.status ?? 1;
    let fr = '?';
    for (const l of o) { const m = /exit code \S+ at frame (\d+)/.exec(l); if (m) fr = m[1]; }
    let traps = [], warns = [];
    if (fs.existsSync(log)) {
        const ll = fs.readFileSync(log, 'latin1').split(/\r?\n/);
        traps = uniq(ll.filter((l) => BAD.test(l)));
        warns = uniq(ll.filter((l) => WARN.test(l)));
    }
    if (code !== 0 || traps.length) {
        fail++;
        console.log(`--- ${n} (exit ${code}, traps ${traps.length}):`);
        if (code !== 0) o.filter((l) => l !== '').slice(-TAIL_LINES).forEach((l) => console.log('  ' + l));
        traps.slice(0, SHOW_TRAPS).forEach((l) => console.log('  ' + l));
        if (traps.length && code === 0) code = 'TRAP';
    } else if (warns.length) {
        console.log(`--- ${n} : warnings ${warns.length}`);
        warns.slice(0, SHOW_WARNS).forEach((l) => console.log('  ' + l));
    }
    sum.push(`${n}=${code}(${fr})`);
}
console.log(sum.join(' '));
process.exit(fail);
