// Globe render time by zoom (the emulator's profiler, 07 §6).
// For each zoom 0..5: new game -> base -> geoscape -> zoom -> trial rotation -> profile of one
// rotation. The profile window is "press -> mark": down / wait 1 / up / waitmark 32 (by the
// waitmark the work is already running, the window ends on the end-of-work mark). The old
// window key + wait 8 was a fixed 14 frames, with the render taking 4-13 (perf/pipeline.md §0).
// Functions are summed into groups by regex (the first match wins); the output is a table of
// frames (71 680 profile T-states = one frame). Build - the current one (tmp/build/oxz.spg).
//   node tools/globeprof.js [-Zooms 0,1,2] [-Hour 18] [-Out tmp/globeprof.md] [-From dir]
// -Hour - game hour before the measurement (terminator in the window: 18; default: time untouched).
// -From - no emulator: sum the profiles dir/prof_z<zoom>.txt of an earlier run.
'use strict';
const fs = require('fs');
const path = require('path');
const { parseArgs, runScenario, ROOT } = require('./args');

const opt = parseArgs({ Zooms: [], Hour: -1, Out: '', From: '' });
const zooms = opt.Zooms.length ? opt.Zooms.map(Number) : [0, 1, 2, 3, 4, 5];
const FRAME_T = 71680;
// Order matters: a function goes to the first group whose regex matches
const GROUPS = [
    ['raster: GVE2 pieces, runs -> DMA', /^(eg_|_gl_rows_edg|_gl_rows_vc|_gl_rows_cap|vc_row|cp_row|rp_|r_vc|_gl_rows_pre|_gl_rows$|_gl_edges|rw_|em_run_p|edge1|e_rows|e_fast|hclip|limb_l|lerp|xclip|div32|eslope|bord_ev|e_store|mul8e|mulu16|ael_|ai_cmp|fx_)/i],
    ['shadow (bank 25)', /^(_sh_|build$|iv_out|lvl_of|add32|globe_sh\$|em_run_s|blk_eval|set_num|row_rng|_globe_shadow|_globe_sunlon|_globe_rows_pl)/i],
    ['marks', /^(globe_det\$mk_|_globe_marks|_det_marks|_det_unmark|_globe_xy)/i],
    ['details: projection, tables', /^(_gl_project|vidx|globe\$project|_gl_ktab|kt_|_gl_ztab|globe\$tables)/i],
    ['details: lines, labels', /^(_memcmp|calc_th|_font_height|layout|copy_s|make_lut|map_font|add_line|dma_idle|tp_lut|tr_done|detail|dt_|_globe_det|_det_|det_|dg_|td_|ly_|char_adv|glyph|_glyph|_text_|text\$|_gl_cull|tables|kmul|kput|proj_v|cu_|line_|_str_copy|draw_glyph|lt_|ta_|globe_det\$)/i],
    ['view from SD', /^(\?3B|_sd_|_far_write|fat\$|_fat_|dma_sec|_gview_|gv_|div16|globe_view\$)/i],
    ['C render, math, far mem', /^(umul16|mul8$|udiv|ud16|ud32|wpass8|bpass16|bp16_big|neg32|ml_|sl_go|render$|r_shadow|_globe_draw|_globe_sin|scr_geo\$rotate|globe\$render|globe\$rows_init|globe\$bg_restore|___mul|___div|___mod|__mul|__div|__mod|_far_read|_far_fill|_far_copy|_far_byte|_memset|_memcpy)/i],
    ['blit: wait for frame', /^(blit|globe\$blit)$/i],
    ['DMA copy wait', /^(dma_wait|globe\$dma_wait)$/i],
    ['UI idle (wait_frames)', /^ui\$wait_frames$/i],
    ['UI: clock, input, ISR', /^(ui\$|_gfx_|gfx\$|gfx_|_ui_|_scr_|_geo_|_input|_cursor|_set_bank|set_bank|_get_bank|_globe_snap|scr_geo\$draw_globe|music\$|_res_game|r_bg|r_rows|___sdcc|_game|_end_event|_mus|mus_|_pg_|far_dma|dma_blk|dma_go|_res_find|_dbg_|input_isr|isr|_isr)/i],
];
const TOP_OTHER = 6;

const rows = [];
for (const z of zooms) {
    const lines = ['waitmark 1 600', 'poke _alien_off 1', 'pokew _cursor_x 110', 'pokew _cursor_y 100', 'click L', 'waitmark 2 300',
        'pokew _cursor_x 119', 'pokew _cursor_y 172', 'click L', 'waitmark 43 3000', 'pokew _cursor_x 120', 'pokew _cursor_y 110',
        'click L', 'waitmark 42 3000', 'type prof', 'key ENTER', 'waitmark 32 3000', 'poke _gl_dbg 1'];
    for (let i = 0; i < z; i++) lines.push('key SS+K', 'wait 8', 'waitmark 32 3000');
    if (opt.Hour >= 0) lines.push(`poke 06:0038 ${opt.Hour}`, 'wait 300');   // ST->hour; a new sun epoch - redraw
    // Time stands still (ST->months = -1, as before the first base; gtime.c game_advance): else
    // every ~34 frames at "5 Secs" the sun moves an epoch, the shadow is redrawn, the press in
    // the window waits for it, and waitmark 32 fires on the old mark - the window closes early
    lines.push('pokew 06:0030 0xFFFF', 'wait 20', 'key RIGHT', 'wait 8', 'waitmark 32 3000', 'wait 30');   // trial rotation
    lines.push('profile on', 'down RIGHT', 'wait 1', 'up RIGHT', 'waitmark 32 3000', 'profile off 200 ops', 'exit 0');
    let outp;
    if (opt.From) outp = fs.readFileSync(path.join(ROOT, opt.From, `prof_z${z}.txt`), 'utf8');
    else {
        const scr = `tmp/globeprof_z${z}.oxs`;           // run.js takes the path from the project root
        fs.writeFileSync(path.join(ROOT, scr), lines.join('\n') + '\n');
        outp = runScenario(scr).out;
        fs.writeFileSync(path.join(ROOT, 'tmp', `prof_z${z}.txt`), outp);   // for tools/globeprof_sum.js
    }
    let tot = 0, other = 0;
    const sum = new Map(GROUPS.map(([g]) => [g, 0]));
    const oth = new Map();
    for (const l of outp.split('\n')) {
        let m = /OXZ: profile (\d+) T/.exec(l);
        if (m) { tot = +m[1]; continue; }
        m = /OXZ: prof\s+[\d.]+%\s+(\d+)\s+(\S+)/.exec(l);
        if (!m) continue;
        const t = +m[1], n = m[2];
        const g = GROUPS.find(([, re]) => re.test(n));
        if (g) sum.set(g[0], sum.get(g[0]) + t); else { other += t; oth.set(n, t); }
    }
    const g0 = outp.split('\n').filter((l) => /^globe: /.test(l)).pop() || '';
    const top = [...oth.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_OTHER).map((e) => e[0]).join(' ');
    rows.push({ z, total: tot, sum, other, info: g0.trim(), top });
}
const f = (t) => (t / FRAME_T).toFixed(2);
const md = ['| group |' + rows.map((r) => ` zoom ${r.z} |`).join(''), '|---|' + rows.map(() => '---:|').join('')];
for (const [g] of GROUPS) md.push(`| ${g} |` + rows.map((r) => ` ${f(r.sum.get(g))} |`).join(''));
md.push('| other |' + rows.map((r) => ` ${f(r.other)} |`).join(''));
md.push('| **TOTAL (press -> mark), frames** |' + rows.map((r) => ` **${f(r.total)}** |`).join(''));
md.push('| work (TOTAL - idle - waits) |' + rows.map((r) =>
    ` ${f(r.total - r.sum.get('UI idle (wait_frames)') - r.sum.get('blit: wait for frame') - r.sum.get('DMA copy wait'))} |`).join(''));
md.push('');
for (const r of rows) { md.push(`- zoom ${r.z}: ${r.info}`); if (r.top) md.push(`  other: ${r.top}`); }
const text = md.join('\n');
console.log(text);
if (opt.Out) fs.writeFileSync(path.join(ROOT, opt.Out), text + '\n');
