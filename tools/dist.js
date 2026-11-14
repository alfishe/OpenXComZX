// The card for real hardware: both games + the Wild Commander loader + the SD image.
//   node tools/dist.js            # build both games and the card
//   node tools/dist.js -NoBuild   # only lay out distr/ and write the image
//   node tools/dist.js -UfoDir <UFO folder> -TftdDir <TFTD folder>   # games not under Steam/
//
// What it does:
//   1. builds UFO and TFTD (each game is its own oxz.spg; RULES/PAL/LANG/GEO/MCD are inside);
//   2. lays out distr/ in the project root - exactly what goes to the root of the card:
//        OXZTFTD.SPG, OXZUFO.SPG        - the games, started from WC with ENTER;
//        OXZ/TFTD/*.PAK, OXZ/UFO/*.PAK  - data the game reads from the card as it goes;
//        boot.$C, WC/, Help.txt         - the Wild Commander loader (unreal/soft/WC/exe);
//        README.TXT                     - the instructions (tools/dist_readme.txt);
//   3. writes the card image oxz_card.img in the project root from distr/ (tools/fat32img.js) -
//      the same image the emulator uses (run.js -> ZC.SDCARD), so the tests run with the card
//      that goes to the hardware. The image is outside distr/ so it never copies itself.
// distr/ and the image are the only artifacts outside tmp/ (the user's request: the
// distribution at hand, not in tmp/); git ignores them (.gitignore).
// With -NoBuild the SPGs are whatever distr/ already has (maybe none - the test image does not
// care: the emulator gets the game from the tmp/build/oxz.spg snapshot). build.js runs this
// itself (CMake target "card") when the converted data is newer than the image.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseArgs, ROOT } = require('./args');
const fat32 = require('./fat32img');

const opt = parseArgs({ NoBuild: false, UfoDir: '', TftdDir: '' });
const dist = path.join(ROOT, 'distr');
const img = path.join(ROOT, 'oxz_card.img');
const sd = path.join(ROOT, 'tmp', 'sd', 'OXZ');
const wc = path.join(ROOT, 'unreal', 'soft', 'WC', 'exe');
// Packs the game reads from the card (sdres.c pack_name + music.c + globe_view.s)
const PACKS = ['BACK', 'UFOP', 'ITEMS', 'CUTS', 'BATUI', 'BATTLE', 'MAPS', 'TILES', 'UNITS',
    'MUSIC', 'MUSICAY', 'MUSICFM', 'GVIEW'];
const GAMES = ['TFTD', 'UFO'];
// Card image: 256 MB, one FAT32 partition from sector 2048 (1 MB), 2 KB clusters.
// FAT32 ONLY: TS-BIOS does not boot from FAT16 ("System Meditation: FAT32 NOT FOUND!");
// 256 MB with 2 KB clusters gives ~130000 clusters, well above the FAT32 minimum of 65525.
const IMG_MB = 256;
const PART_FIRST_SECTOR = 2048;
const CLUSTER_SECTORS = 4;
const LABEL = 'OXZ';

function buildGame(game, dir, to) {
    console.log(`build ${game} ...`);
    // -NoCard: no image per game - it is written once at the end
    const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'build.js'), '-Game', game, '-NoCard', '-GameDir', dir],
        { stdio: ['ignore', 'ignore', 'inherit'] });
    if (r.status !== 0) { console.error(`dist: build ${game} failed`); process.exit(1); }
    fs.copyFileSync(path.join(ROOT, 'tmp', 'build', 'oxz.spg'), to);
}

fs.mkdirSync(dist, { recursive: true });
if (!opt.NoBuild) {
    buildGame('UFO', opt.UfoDir, path.join(dist, 'OXZUFO.SPG'));
    buildGame('TFTD', opt.TftdDir, path.join(dist, 'OXZTFTD.SPG'));  // TFTD last: the tree stays on the default game
} else {
    for (const n of ['OXZTFTD.SPG', 'OXZUFO.SPG'])
        if (!fs.existsSync(path.join(dist, n))) console.log(`  no ${n} (run without -NoBuild)`);
}

// Data of both games (the game folder is emptied: no stale packs on the card)
for (const g of GAMES) {
    const to = path.join(dist, 'OXZ', g);
    fs.rmSync(to, { recursive: true, force: true });
    fs.mkdirSync(to, { recursive: true });
    for (const p of PACKS) {
        const f = path.join(sd, g, p + '.PAK');
        if (fs.existsSync(f)) fs.copyFileSync(f, path.join(to, p + '.PAK'));
        else console.log(`  no ${g}/${p}.PAK`);
    }
}

// The WC loader without demo (44 MB of other people's demos) and soft (a word processor in
// SCL): the card does not need them. unreal/ is a separate checkout: without it the card has
// no loader - fine for the emulator, which starts the game from the snapshot, but such a card
// does not boot on hardware.
if (fs.existsSync(wc)) {
    for (const n of ['boot.$C', 'Help.txt']) fs.copyFileSync(path.join(wc, n), path.join(dist, n));
    fs.cpSync(path.join(wc, 'WC'), path.join(dist, 'WC'), { recursive: true, force: true });
} else {
    console.log(`  no Wild Commander (${wc}): the card will not boot on hardware`);
}
fs.copyFileSync(path.join(ROOT, 'tools', 'dist_readme.txt'), path.join(dist, 'README.TXT'));

let bytes = 0;
const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p); else bytes += fs.statSync(p).size;
    }
};
walk(dist);
console.log(`distr: ${Math.round(bytes / (1024 * 1024))} MB`);

try {
    fat32.build(img, dist, { mb: IMG_MB, first: PART_FIRST_SECTOR, cluster: CLUSTER_SECTORS, label: LABEL });
} catch (e) {
    fs.rmSync(img, { force: true });
    console.error('dist: card image: ' + e.message);
    process.exit(1);
}
console.log(`card image: ${img}`);
