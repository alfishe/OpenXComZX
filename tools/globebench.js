// Globe benchmark: frames per redraw in three scenarios on every zoom (07 §6, globe.md).
//   1. rotation by longitude (X) and latitude (Y) - 8 steps each, median and spread printed;
//   2. redraw by time (the sun "epoch" changed, the view is the same) - 4 samples;
//   3. zoom change both ways (0->1 ... 4->5 and 5->4 ... 1->0).
// The view is set by poking ctx.globe_lon/lat, the time by poking minutes (the hour stays, or
// on far zooms the terminator leaves the window and the shadow degenerates). The first render
// of each zoom is discarded.
//   node tools/globebench.js [-Hour 18] [-View med|high|worst] [-Steps 8] [-Out file] [-NoPre]
'use strict';
const fs = require('fs');
const path = require('path');
const { parseArgs, runScenario, ROOT } = require('./args');

const opt = parseArgs({ Hour: 18, View: 'med', Steps: 8, Out: '', NoPre: false });
// views: median and worst by the model (tmp/globe_review2/measure) - lon 16 bits, lat 16384 = 90°
const VIEWS = { med: [32768, 4369], high: [32768, 14564], worst: [60074, 50972] };
const ZOOMS = 6;
const SUN_MINUTES = [12, 24, 36, 48];
if (!VIEWS[opt.View]) { console.error('globebench: -View med | high | worst'); process.exit(2); }
const [vl, vt] = VIEWS[opt.View];

const lines = ['waitmark 1 600', 'poke _alien_off 1', 'pokew _cursor_x 110', 'pokew _cursor_y 100', 'click L', 'waitmark 2 300',
    'pokew _cursor_x 119', 'pokew _cursor_y 172', 'click L', 'waitmark 43 3000', 'pokew _cursor_x 120', 'pokew _cursor_y 110',
    'click L', 'waitmark 42 3000', 'type bench', 'key ENTER', 'waitmark 32 3000', 'poke _gl_dbg 1', `poke _gv_off ${opt.NoPre ? 1 : 0}`, 'wait 200',
    `poke 06:0038 ${opt.Hour}`, 'poke 06:0037 0', 'poke 06:0036 0', 'wait 250'];
const setView = (l, t, m) => [`pokew _ctx+6 ${l}`, `pokew _ctx+8 ${t}`, `poke 06:0037 ${m}`, 'wait 60'];
for (let z = 0; z < ZOOMS; z++) {
    lines.push(...setView(vl, vt, 0));                  // set the view: the minutes poke changes the sun epoch -> redraw
    for (let i = 0; i < opt.Steps; i++) lines.push('key RIGHT', 'wait 60');
    lines.push(...setView(vl, vt, 6));
    for (let i = 0; i < opt.Steps; i++) lines.push('key UP', 'wait 60');
    for (const m of SUN_MINUTES) lines.push(`poke 06:0037 ${m}`, 'wait 250');   // sun epoch
    if (z < ZOOMS - 1) lines.push('key SS+K', 'wait 60');
}
for (let z = 1; z < ZOOMS; z++) lines.push('key SS+J', 'wait 60');
lines.push('exit 0');
const scr = 'tmp/globebench.oxs';
fs.writeFileSync(path.join(ROOT, scr), lines.join('\n') + '\n');
const { out: outp } = runScenario(scr);
fs.writeFileSync(path.join(ROOT, 'tmp', 'globebench_log.txt'), outp);

const rot = {}, tim = {}, zin = {}, zout = {};
const push = (o, k, v) => { (o[k] = o[k] || []).push(v); };
let pz = -1, plon = -1, plat = -1;
for (const l of outp.split('\n')) {
    let m = /globe: sun only, zoom (\d+), frames (\d+)/.exec(l);
    if (m) { push(tim, +m[1], +m[2]); continue; }
    m = /globe: zoom (\d+), cells \d+, edges \d+, frames (\d+), view (\d+) (\d+)/.exec(l);
    if (!m) continue;
    const [z, f, lon, lat] = [+m[1], +m[2], +m[3], +m[4]];
    if (pz >= 0 && z !== pz) push(z > pz ? zin : zout, z, f);
    else if (pz >= 0) {
        // the first render after setting the view (both coordinates changed) is not a rotation
        const k = lon !== plon && lat === plat ? `x${z}` : lat !== plat && lon === plon ? `y${z}` : null;
        if (k) push(rot, k, f);
    }
    pz = z; plon = lon; plat = lat;
}
const stat = (a) => {
    if (!a || !a.length) return '-';
    const s = [...a].sort((x, y) => x - y);
    const med = s[Math.floor(s.length / 2)];
    return s[0] === s[s.length - 1] ? `${med}` : `${med} (${s[0]}-${s[s.length - 1]})`;
};
const md = ['| zoom | rotate X | rotate Y | shadow (time) | zoom in -> | zoom out <- |', '|---|---:|---:|---:|---:|---:|'];
for (let z = 0; z < ZOOMS; z++) md.push(`| ${z} | ${stat(rot[`x${z}`])} | ${stat(rot[`y${z}`])} | ${stat(tim[z])} | ${stat(zin[z])} | ${stat(zout[z])} |`);
md.push('', `frames of 50 Hz per render; median (min-max) of ${opt.Steps} steps; view '${opt.View}', hour ${opt.Hour}; log: tmp/globebench_log.txt`);
const text = md.join('\n');
console.log(text);
if (opt.Out) fs.writeFileSync(path.join(ROOT, opt.Out), text + '\n');
