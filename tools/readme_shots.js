// README screenshots: tests/*.oxs scenarios with the cursor hidden by "poke _cursor_off 1" (it
// only switches the sprite off - the behaviour is the same), 320x200 frames -> 640x400 without
// smoothing into project_docs/scr.
//   node tools/readme_shots.js             # TFTD: build, scenarios, shots
//   node tools/readme_shots.js -Game UFO   # UFO (names ufo_*); rebuild TFTD afterwards
//   ... -NoBuild                           # the build is already the right one
// Which frames are taken - the PICK table: scenario, shot (path under tmp/shots), name in
// project_docs/scr. The scenarios run as copies (tmp/readme/<game>/*.oxs), shots go to tmp/readme/<game>/.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseArgs, runScenario, ROOT } = require('./args');
const png = require('./pngimg');

const opt = parseArgs({ Game: 'TFTD', NoBuild: false });
const game = opt.Game.toUpperCase();
const SRC_W = 320, SRC_H = 200, SCALE = 2;
const PICK = {
    TFTD: [
        ['showcase', 'showcase/02_globe_z0', 'geo_globe'],
        ['showcase', 'showcase/05_globe_z3', 'geo_cities'],
        ['ui_geoscape', 'ui/11_ufo_detected', 'geo_ufo'],
        ['dogfight', 'dogfight/08_fire', 'geo_dogfight'],
        ['showcase', 'showcase/06_base', 'base_view'],
        ['campaign', 'campaign/06a_place_frame', 'base_build'],
        ['lab', 'lab/04_research_info_alloc', 'base_research'],
        ['lab', 'lab/16_manuf_info_alloc', 'base_manufacture'],
        ['campaign', 'campaign/11_soldier_info', 'crew_soldier'],
        ['craft', 'craft/05_equipment', 'crew_equipment'],
        ['inventory', 'inv/04_loaded', 'crew_inventory'],
        ['bat_render', 'bat/00_map0', 'crew_battle'],
        ['showcase', 'showcase/08_article', 'info_craft'],
        ['ui_geoscape', 'ui/22_ufop_article', 'info_weapon'],
        ['campaign', 'campaign/18_monthly_report', 'info_report'],
        ['campaign', 'campaign/18b_graphs_income', 'info_graphs'],
    ],
    UFO: [
        ['showcase', 'showcase/02_globe_z0', 'ufo_globe'],
        ['showcase', 'showcase/06_base', 'ufo_base'],
        ['showcase', 'showcase/08_article', 'ufo_article'],
        ['inventory', 'inv/01', 'ufo_inventory'],
    ],
};
const list = PICK[game];
if (!list) { console.error(`readme_shots: unknown game ${game}`); process.exit(2); }
if (!opt.NoBuild) {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'build.js'), '-Game', game], { stdio: ['ignore', 'ignore', 'inherit'] });
    if (r.status !== 0) { console.error(`readme_shots: build failed (${r.status})`); process.exit(1); }
}
const rel = `tmp/readme/${game.toLowerCase()}/`;
const work = path.join(ROOT, rel);
fs.mkdirSync(work, { recursive: true });
for (const t of [...new Set(list.map((p) => p[0]))]) {
    const out = [];
    for (let l of fs.readFileSync(path.join(ROOT, 'tests', `${t}.oxs`), 'utf8').split(/\r?\n/)) {
        const m = /^shot tmp\/shots\/(.+)$/.exec(l);
        if (m) {
            l = 'shot ' + rel + m[1];
            fs.mkdirSync(path.dirname(path.join(work, m[1])), { recursive: true });
        }
        out.push(l);
        if (/^waitmark 1 /.test(l)) out.push('poke _cursor_off 1');   // and after returning to the menu
    }
    fs.writeFileSync(path.join(work, `${t}.oxs`), out.join('\n'));
    const { code } = runScenario(rel + `${t}.oxs`);   // the path is from the root
    if (code !== 0) { console.error(`readme_shots: scenario ${t} failed (${code})`); process.exit(1); }
    console.log(`${t} ok`);
}
const dst = path.join(ROOT, 'project_docs', 'scr');
fs.mkdirSync(dst, { recursive: true });
for (const [, shot, name] of list) {
    const src = png.read(path.join(work, shot + '.png'));
    const big = png.image(SRC_W * SCALE, SRC_H * SCALE);
    png.blit(big, 0, 0, big.w, big.h, src, 0, 0, SRC_W, SRC_H);
    png.write(path.join(dst, name + '.png'), big);
    console.log(`${name} <- ${shot}`);
}
