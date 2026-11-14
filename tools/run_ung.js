// Run tmp/build/oxz.spg on unreal-ng (TS-Conf model TSL) through its WebAPI: a fresh
// instance, the SD card in the Z-Controller slot, the SPG, N frames, a screenshot.
// unreal-ng is a separate emulator (not unreal/, the project's own copy of Unreal):
// no .oxs scenarios here - this is the cross-check on a second TS-Conf implementation.
//   node tools/run_ung.js                                    # 500 frames, tmp/shots/ung/oxz.png
//   node tools/run_ung.js -Frames 1500 -Shot tmp/shots/ung/geo.png -Area screen
//   node tools/run_ung.js -Launch <unreal-qt binary>         # start the emulator too (offscreen)
//   node tools/run_ung.js -Card distr                        # a host folder as the card
//   node tools/run_ung.js -Keep                              # leave the instance for the GUI/MCP
// The emulator must be running already (or -Launch). Its WebAPI port: -Url, otherwise
// UNREAL_WEBAPI_PORT, otherwise 8090. With -Launch the emulator gets private ports
// (WebAPI -Port, default 18190, and neighbours) so it does not collide with other unreal-ng instances,
// and it is stopped at the end unless -Keep.
// Exit code: 0 - the SPG ran the frames and the screenshot is saved.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { parseArgs, ROOT } = require('./args');

const opt = parseArgs({ Frames: 500, Shot: 'tmp/shots/ung/oxz.png', Area: 'full', Spg: 'tmp/build/oxz.spg',
    Card: 'oxz_card.img', Url: '', Launch: '', Port: 18190, Keep: false });
// -Launch ports: WebAPI -Port (default 18190); MCP +2, CLI/GDB/DeZog/ZRCP +10..+13
const PORT_MCP = 2, PORT_CLI = 10, PORT_GDB = 11, PORT_DEZOG = 12, PORT_ZRCP = 13;
const STARTUP_POLL_MS = 500;
const STARTUP_POLLS = 60;                 // 30 s for the emulator to open its WebAPI
const DEFAULT_PORT = 8090;
const CLIENT = 'OpenXComZX run_ung.js';
const hex4 = (v) => '#' + (Number(v) || 0).toString(16).toUpperCase().padStart(4, '0');

if (!['full', 'screen'].includes(opt.Area)) { console.error('run_ung: -Area full|screen'); process.exit(2); }
const full = (p) => path.resolve(ROOT, p);
const spgPath = full(opt.Spg), cardPath = full(opt.Card), shotPath = full(opt.Shot);
for (const f of [spgPath, cardPath]) if (!fs.existsSync(f)) { console.error(`run_ung: not found: ${f}`); process.exit(1); }
fs.mkdirSync(path.dirname(shotPath), { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    let proc = null;
    let url = opt.Url;
    if (opt.Launch) {
        const p = opt.Port;
        const env = { ...process.env, UNREAL_WEBAPI_PORT: String(p), UNREAL_MCP_PORT: String(p + PORT_MCP),
            UNREAL_CLI_PORT: String(p + PORT_CLI), UNREAL_GDB_PORT: String(p + PORT_GDB),
            UNREAL_DEZOG_PORT: String(p + PORT_DEZOG), UNREAL_ZRCP_PORT: String(p + PORT_ZRCP) };
        const log = path.join(ROOT, 'tmp', 'ung_emulator.log');
        // working directory - the binary's folder: unreal-ng finds rom/ and configs/ beside it
        const bin = path.resolve(opt.Launch);
        let wd = path.dirname(bin);
        if (/\.app[\\/]Contents[\\/]MacOS$/.test(wd)) wd = path.dirname(path.dirname(path.dirname(wd)));
        const fd = fs.openSync(log, 'w');
        // -Keep: detached, so the emulator outlives this script
        proc = spawn(bin, ['-platform', 'offscreen'], { cwd: wd, env, stdio: ['ignore', fd, fd], detached: opt.Keep });
        if (opt.Keep) proc.unref();
        if (!url) url = `http://localhost:${p}`;
    }
    if (!url) url = `http://localhost:${process.env.UNREAL_WEBAPI_PORT || DEFAULT_PORT}`;
    const B = `${url}/api/v1`;

    let up = false;
    for (let i = 0; i < STARTUP_POLLS; i++) {
        try { const r = await fetch(`${B}/emulator`, { signal: AbortSignal.timeout(2000) }); if (r.ok) { up = true; break; } } catch { /* not yet */ }
        if (!proc) break;
        await sleep(STARTUP_POLL_MS);
    }
    if (!up) { console.error(`run_ung: no unreal-ng WebAPI at ${url} (start unreal-qt or pass -Launch)`); if (proc) proc.kill(); process.exit(1); }

    const hdr = {};
    const api = async (method, p, body) => {
        const r = await fetch(B + p, { method, headers: { 'Content-Type': 'application/json', ...hdr },
            body: body === undefined ? undefined : JSON.stringify(body) });
        const t = await r.text();
        try { return t ? JSON.parse(t) : {}; } catch { return { raw: t }; }
    };

    let id = null, code = 1;
    try {
        id = (await api('POST', '/emulator/start', { model: 'TSL' })).id;
        const s = await api('POST', `/emulator/${id}/control/session`, { client: CLIENT });
        let sid = s.session ?? s.id ?? null;
        if (sid && typeof sid === 'object') sid = sid.id;
        if (sid) hdr['X-Unreal-Session'] = String(sid);
        await api('POST', `/emulator/${id}/pause`);

        const ins = await api('POST', `/emulator/${id}/media/sd.zc/insert`, { path: cardPath });
        if (!ins.ok) throw new Error(`SD card insert failed: ${JSON.stringify(ins)}`);
        const ld = await api('POST', `/emulator/${id}/snapshot/load`, { path: spgPath });
        if (ld.emulator_id) id = ld.emulator_id;
        console.log(`unreal-ng ${url}, TSL ${id}: ${path.basename(spgPath)}, card ${cardPath}`);

        const r = await api('POST', `/emulator/${id}/run_frames`, { count: opt.Frames });
        if (r.status !== 'success') throw new Error(`run_frames: ${JSON.stringify(r)}`);
        console.log(`ran ${opt.Frames} frames, PC ${hex4(r.pc)} SP ${hex4(r.sp)}`);

        const q = `area=${opt.Area}&format=png&path=${encodeURIComponent(shotPath)}`;
        const c = await api('GET', `/emulator/${id}/capture/screen?${q}`);
        if (!c.saved) throw new Error(`screenshot failed: ${JSON.stringify(c)}`);
        console.log(`screenshot: ${shotPath} (${c.frame?.mode} ${c.width}x${c.height})`);
        code = 0;
    } catch (e) {
        console.error('run_ung: ' + e.message);
    } finally {
        if (id && !opt.Keep) {
            try { await api('DELETE', `/emulator/${id}`); } catch (e) { console.log(`destroy failed: ${e.message}`); }
        } else if (id) {
            try { await api('DELETE', `/emulator/${id}/control/session`); } catch { /* ignore */ }
            console.log(`instance kept: ${id}`);
        }
        if (proc && !opt.Keep) proc.kill();
    }
    process.exit(code);
})();
