// Globe views "as edges" (GVIEW.PAK, signature 'GVE2') — project_docs/globe.md §12.11, model —
// tools/globe_edges.js. Instead of ready row runs a view keeps pieces of the map borders: start
// X in the first row (pairs, 8.8), slope dX (pairs per row, 8.8), length in rows, texture on
// the right. Arc/row crossings are those of the exact path-A rasteriser (globeviews.js); a
// piece is fitted so that pair (X + 192) >> 8 in every row matches the path-A border pair, so
// the engine's picture is the same. Pieces are chained (continuation — an X correction), a
// chain head carries its slot in the ordered list of active pieces of the row: the engine
// never compares or sorts. The left-edge texture of a row — a list "from which row which".
//
// Container: sector 0 — header (u32 'GVE2', u8 nZoom, u8 0, u8 zFirst, u8 0, then 16 bytes
// per zoom: u16 nLon, u16 nTilt, u16 tiltStep (65536 = 360°), u16 R, u32 index offset, u32 0),
// then per zoom: u32 view offsets [nv + 1] and the views. View (little-endian):
//   u8 nSeed; nSeed x { u8 row, u8 texture } — left-edge texture from this row (until the
//     next); rows without the disc are not described
//   start groups: { u8 row step (the first from row 0), u8 number of starts; starts:
//     u16 X0 + 64·256, u8 slot in the active list, piece }; { 0, 0 } — end; step > 255 — { 255, 0 }
//   piece: u8 flags: bit 7 — has continuation, bit 6 — long record, bits 3..0 — texture right;
//     short: u8 (length − 1) << 4 | dX >> 8 & 15, u8 dX & 255 (dX — 12-bit signed, length ≤ 16)
//     long: u8 length − 1, i16 dX
//   continuation (after a piece with bit 7): i8 X correction (−128 — then i16), piece
// Engine per row: insert starts at their slots, walk the list (border pair — (X + 192) >> 8 − 64,
// clamp to the row disc, run up to it with the previous piece texture, texture — right of the
// piece), X += dX, at a piece end — continuation or removal.
'use strict';
const fs = require('fs');
const GV = require('./globeviews');
const { roundEven, toInt } = require('./vec3');

const ZR = GV.ZR, H = GV.H;
const SECTOR = 512, BIAS = 192, MAX_VIEW = 0x1C00, EV_MAX = 64;   // EV_MAX — the engine's EV_MAX
const SIG_GVE2 = 0x32455647;   // 'GVE2'
const HDR_ZOOM0 = 8, HDR_ZOOM_SIZE = 16;
const OCEAN = 13;
const SHORT_ROWS = 16, SHORT_DX = 2048, LONG_ROWS = 256;
const KEY_SCALE = 1e9;

const i16 = v => (v << 16) >> 16;
// C# double.ToString() of an integral double (keys only need to tell vertices apart, but
// -0 prints as "-0" in .NET, so it stays distinct like there)
const dstr = v => (v === 0 && 1 / v < 0 ? '-0' : String(v));
const key = (a, i, b) => (b
	? `${dstr(roundEven(a.bx[i] * KEY_SCALE))},${dstr(roundEven(a.by[i] * KEY_SCALE))},${dstr(roundEven(a.bz[i] * KEY_SCALE))}`
	: `${dstr(roundEven(a.ax[i] * KEY_SCALE))},${dstr(roundEven(a.ay[i] * KEY_SCALE))},${dstr(roundEven(a.az[i] * KEY_SCALE))}`);

// One view: pieces, chains, slots, packing -> { data, nPieces }
function view(a, zoom, lonDeg, tiltDeg) {
	const { e, P } = GV.prepare(a, zoom, lonDeg, tiltDeg);
	const R = e.R;
	const n = a.n;
	const cross = new Array(n).fill(null);
	const seed = new Array(H).fill(-1);
	for (let y = 0; y < H; y++) {
		const dsc = GV.disc(R, y);
		if (!dsc) continue;
		const { pl, pr } = dsc;
		const v = (y + 0.5 - GV.SCREEN_CY) / R, c = Math.sqrt(Math.max(0, 1 - v * v));
		const row = GV.rowCrossings(a, e, P, y, v, c).map(q => {
			const pair = toInt(roundEven(q.x / 2));
			return {
				i: q.i, y, x: q.x, t: Math.atan2(q.sp, q.cp), down: q.down, vis: pair > pl && pair <= pr,
				right: q.down ? a.tl[q.i] : a.tr[q.i], left: q.down ? a.tr[q.i] : a.tl[q.i],
			};
		});
		// left-edge texture (as path A): left of the leftmost border, then right of every border
		// with pair <= pl — such borders (and those right of pr) give no runs and are not in the view
		row.sort((p, q) => p.x - q.x);
		let cur = row.length > 0 ? row[0].left : GV.probe(a, v * e.eyx + c * e.ezx, v * e.eyy + c * e.ezy, v * e.eyz + c * e.ezz);
		for (const q of row) {
			if (toInt(roundEven(q.x / 2)) <= pl) cur = q.right;
			(cross[q.i] || (cross[q.i] = [])).push(q);
		}
		seed[y] = cur;
	}
	// pieces: arc crossings by parameter t, split on a direction change or a skipped row
	const pieces = [];
	for (let i = 0; i < n; i++) {
		if (cross[i] === null) continue;
		const cs = cross[i].slice().sort((p, q) => p.t - q.t);
		let k0 = 0;
		while (k0 < cs.length) {
			if (!cs[k0].vis) { k0++; continue; }
			let k1 = k0 + 1;
			while (k1 < cs.length && cs[k1].vis && cs[k1].down === cs[k0].down && Math.abs(cs[k1].y - cs[k1 - 1].y) === 1) k1++;
			const seg = cs.slice(k0, k1);
			const down = seg[0].down;
			if (!down) seg.reverse();                             // rows top to bottom
			// vertices: the top is A when moving down (if the piece starts at the arc start), else B
			const fromStart = k0 === 0, toEnd = k1 === cs.length;
			const kTop = down ? (fromStart ? key(a, i, false) : null) : (toEnd ? key(a, i, true) : null);
			const kBot = down ? (toEnd ? key(a, i, true) : null) : (fromStart ? key(a, i, false) : null);
			fit(pieces, seg, kTop, kBot);
			k0 = k1;
		}
	}
	// chains between arcs: at a vertex and row — in order from left to right
	const ends = new Map(), starts = new Map();
	for (const p of pieces) {
		if (p.kBot !== null && p.next === null) { const k = p.kBot + ':' + (p.r0 + p.rows); let l = ends.get(k); if (!l) ends.set(k, l = []); l.push(p); }
		if (p.kTop !== null && p.prev === null) { const k = p.kTop + ':' + p.r0; let l = starts.get(k); if (!l) starts.set(k, l = []); l.push(p); }
	}
	for (const [k, el] of ends) {
		const fsl = starts.get(k);
		if (!fsl) continue;
		const es = el.slice().sort((p, q) => p.xs[p.rows - 1] - q.xs[q.rows - 1]);
		const fsr = fsl.slice().sort((p, q) => p.xs[0] - q.xs[0]);
		for (let i = 0; i < Math.min(es.length, fsr.length); i++) { es[i].next = fsr[i]; fsr[i].prev = es[i]; }
	}
	const heads = pieces.filter(p => p.prev === null);
	// insertion slots: walk the rows with the exact order
	const byRow = new Array(H).fill(null);
	for (const h of heads) (byRow[h.r0] || (byRow[h.r0] = [])).push(h);
	const active = [];
	for (let y = 0; y < H; y++) {
		if (byRow[y] !== null)
			for (const h of byRow[y].slice().sort((p, q) => p.xs[0] - q.xs[0])) {
				let k = 0;
				while (k < active.length && active[k].xs[y - active[k].r0] <= h.xs[0]) k++;
				h.pos = k;
				active.splice(k, 0, h);
				if (active.length > EV_MAX) throw new Error(`GVE2: active pieces > ${EV_MAX} in row ${y}`);
			}
		for (let k = 0; k < active.length; k++) {
			const p = active[k];
			if (y === p.r0 + p.rows - 1) { if (p.next !== null) active[k] = p.next; else { active.splice(k, 1); k--; } }
		}
	}
	return { data: pack(byRow, seed), nPieces: pieces.length };
}

// exact piece fitting: integer X0, dX, pair (X + BIAS) >> 8 in the rows — as in path A
function fit(outp, seg, kTop, kBot) {
	const n = seg.length;
	const xs = seg.map(q => (q.x - 0.5) / 2 * 256);                     // X — without path A's +0.5
	const pair = seg.map(q => Math.trunc(2 * toInt(roundEven(q.x / 2)) / 2));   // path A border pair
	const L = pair.map(v => v * 256 - BIAS);
	const U = pair.map(v => v * 256 - BIAS + 255);
	let k0 = 0, prev = null;
	while (k0 < n) {
		let bk1 = k0 + 1, bX0 = Math.min(U[k0], Math.max(L[k0], toInt(roundEven(xs[k0])))), bdX = 0;
		for (let k1 = k0 + 2; k1 <= n; k1++) {
			const m = k1 - 1 - k0;
			const dlo = toInt(Math.ceil((L[k1 - 1] - U[k0]) / m)), dhi = toInt(Math.floor((U[k1 - 1] - L[k0]) / m));
			const dm = toInt(roundEven((xs[k1 - 1] - xs[k0]) / m));
			let found = false;
			for (let s = 0; s <= dhi - dlo && !found; s++)
				for (const d of [dm + s, dm - s]) {
					if (d < dlo || d > dhi) continue;
					let lo = -Infinity, hi = Infinity;
					for (let k = k0; k < k1; k++) { lo = Math.max(lo, L[k] - (k - k0) * d); hi = Math.min(hi, U[k] - (k - k0) * d); if (lo > hi) break; }
					if (lo <= hi) { found = true; bk1 = k1; bdX = d; bX0 = Math.min(hi, Math.max(lo, roundEven(xs[k0]))); break; }
				}
			if (!found) break;
		}
		const p = {
			r0: seg[k0].y, rows: bk1 - k0, x0: bX0, dx: bdX, tex: seg[0].right, pos: -1,
			xs: xs.slice(k0, bk1), pair: pair.slice(k0, bk1),
			kTop: k0 === 0 ? kTop : null, kBot: bk1 === n ? kBot : null,
			next: null, prev: null,
		};
		if (prev !== null) { prev.next = p; p.prev = prev; }
		outp.push(p);
		prev = p;
		k0 = bk1;
	}
}

function pack(byRow, seed) {
	const b = [];
	const sd = [];
	let last = -2;
	for (let y = 0; y < H; y++) if (seed[y] >= 0 && seed[y] !== last) { sd.push([y, seed[y]]); last = seed[y]; }
	if (sd.length > 255) throw new Error('GVE2: seeds > 255');
	b.push(sd.length);
	for (const [y, t] of sd) b.push(y, t);
	let prevRow = 0;
	for (let r = 0; r < H; r++) {
		if (byRow[r] === null) continue;
		const hs = byRow[r].slice().sort((p, q) => p.pos - q.pos);
		let d = r - prevRow; prevRow = r;
		while (d > 255) { b.push(255, 0); d -= 255; }
		if (hs.length > 255) throw new Error('GVE2: starts > 255');
		b.push(d, hs.length);
		for (const h of hs) {
			const xs = h.x0;
			if (xs < 0 || xs > 65535 || h.pos > 255) throw new Error('GVE2: X0/pos out of range');
			b.push(xs & 0xFF, (xs >> 8) & 0xFF, h.pos);
			for (let e = h; ; e = e.next) {
				const shortOk = e.rows <= SHORT_ROWS && e.dx >= -SHORT_DX && e.dx < SHORT_DX;
				if (e.rows > LONG_ROWS) throw new Error('GVE2: rows > 256');
				b.push((e.next !== null ? 0x80 : 0) | (shortOk ? 0 : 0x40) | e.tex);
				if (shortOk) b.push((((e.rows - 1) << 4) | ((e.dx >> 8) & 15)) & 0xFF, e.dx & 0xFF);
				else b.push((e.rows - 1) & 0xFF, e.dx & 0xFF, (e.dx >> 8) & 0xFF);
				if (e.next === null) break;
				const corr = i16(e.next.x0 - (e.x0 + e.rows * e.dx));          // modulo 2^16, as in the engine
				if (corr > -128 && corr < 128) b.push(corr & 0xFF);
				else b.push(0x80, corr & 0xFF, (corr >> 8) & 0xFF);
			}
		}
	}
	b.push(0, 0);
	return Buffer.from(b);
}

// Unpacks a view like the engine -> row runs in path-A format (u8 n, n × (len−1, tex))
function decode(v, zoom) {
	const R = ZR[zoom];
	let p = 0;
	const nSeed = v[p++];
	const seedRow = [], seedTex = [];
	for (let i = 0; i < nSeed; i++) { seedRow.push(v[p++]); seedTex.push(v[p++]); }
	const act = [];                          // [X, dX, rows, tex, more, ptr]
	const readPiece = (X, q) => {
		const f = v[q++];
		let rows, dX;
		if ((f & 0x40) !== 0) { rows = v[q++] + 1; dX = i16(v[q] | (v[q + 1] << 8)); q += 2; }
		else { const h = v[q++], l = v[q++]; rows = (h >> 4) + 1; dX = ((((h & 15) << 8) | l) << 20) >> 20; }
		return [X, dX, rows, f & 15, (f & 0x80) !== 0 ? 1 : 0, q];
	};
	const skip = (q, more) => {
		while (more) {
			if (v[q++] === 0x80) q += 2;
			const f = v[q++];
			more = (f & 0x80) !== 0;
			q += (f & 0x40) !== 0 ? 3 : 2;
		}
		return q;
	};
	const NONE = 999;
	let groupRow = v[p], groupN = v[p + 1];
	p += 2;
	if (groupRow === 0 && groupN === 0) groupRow = NONE;
	let seedI = 0, cur = OCEAN;
	const outb = [];
	for (let y = 0; y < H; y++) {
		while (groupRow === y) {
			for (let i = 0; i < groupN; i++) {
				const X = v[p] | (v[p + 1] << 8), pos = v[p + 2];
				const s = readPiece(X, p + 3);
				act.splice(pos, 0, s);
				p = skip(s[5], s[4] !== 0);
			}
			const d = v[p++], nn = v[p++];
			if (d === 0 && nn === 0) { groupRow = NONE; break; }
			groupRow += d; groupN = nn;
		}
		while (seedI < nSeed && seedRow[seedI] === y) cur = seedTex[seedI++];
		const dsc = GV.disc(R, y);
		const pl = dsc ? dsc.pl : 0, pr = dsc ? dsc.pr : 0;
		let t = cur, x0 = pl, cnt = 0;
		const nr = outb.length;
		outb.push(0);
		for (let k = 0; k < act.length; k++) {
			const s = act[k];
			if (dsc) {
				const bx = ((s[0] + BIAS) & 0xFFFF) >> 8;         // no clamping: the view holds only window borders
				if (bx > x0) { outb.push((bx - x0 - 1) & 0xFF, t); cnt++; x0 = bx; }
			}
			t = s[3];
			s[0] = (s[0] + s[1]) & 0xFFFF;
			if (--s[2] === 0) {
				if (s[4] !== 0) {
					let q = s[5];
					let c = (v[q++] << 24) >> 24;
					if (c === -128) { c = i16(v[q] | (v[q + 1] << 8)); q += 2; }
					act[k] = readPiece((s[0] + c) & 0xFFFF, q);
				} else { act.splice(k, 1); k--; }
			}
		}
		if (!dsc) { outb.pop(); outb.push(0); continue; }
		if (x0 <= pr) { outb.push((pr - x0) & 0xFF, t); cnt++; }
		outb[nr] = cnt & 0xFF;
	}
	return Buffer.from(outb);
}

// Check against path A: differing pairs (length x texture per row)
function compare(runsA, runsB, zoom) {
	const R = ZR[zoom];
	let pa = 0, pb = 0, diff = 0;
	const PAIRS = 128;
	for (let y = 0; y < H; y++) {
		const na = runsA[pa++], nb = runsB[pb++];
		const dsc = GV.disc(R, y);
		if (!dsc) { pa += 2 * na; pb += 2 * nb; continue; }
		const ra = new Array(PAIRS).fill(0), rb = new Array(PAIRS).fill(0);
		let x = dsc.pl;
		for (let i = 0; i < na; i++) { const len = runsA[pa++] + 1, t = runsA[pa++]; for (let k = 0; k < len && x < PAIRS; k++) ra[x++] = t; }
		x = dsc.pl;
		for (let i = 0; i < nb; i++) { const len = runsB[pb++] + 1, t = runsB[pb++]; for (let k = 0; k < len && x < PAIRS; k++) rb[x++] = t; }
		for (let k = dsc.pl; k <= dsc.pr; k++) if (ra[k] !== rb[k]) diff++;
	}
	return diff;
}

function build(arcs, path) {
	const N_ZOOM = GV.N_ZOOM, Z_FIRST = GV.Z_FIRST;
	const hdr = Buffer.alloc(SECTOR);
	hdr.writeUInt32LE(SIG_GVE2, 0);
	hdr[4] = N_ZOOM; hdr[6] = Z_FIRST;
	const stats = [];
	let pos = SECTOR;
	const parts = [hdr];
	for (let zi = 0; zi < N_ZOOM; zi++) {
		const z = Z_FIRST + zi;
		const g = GV.grid(z);
		const nv = g.nLon * g.nTilt;
		const views = new Array(nv), diffs = new Array(nv), np = new Array(nv);
		for (let j = 0; j < g.nTilt; j++)
			for (let i = 0; i < g.nLon; i++) {
				const lon = i * g.lonStep, tilt = (j - g.k) * g.tiltStep;
				const vi = j * g.nLon + i;
				const r = view(arcs, z, lon, tilt);
				views[vi] = r.data; np[vi] = r.nPieces;
				diffs[vi] = compare(GV.viewRuns(arcs, z, lon, tilt), decode(r.data, z), z);
			}
		const idxPos = pos;
		const tab = Buffer.alloc((nv + 1) * 4);
		pos += tab.length;
		let tot = 0, max = 0, dsum = 0, dmax = 0, psum = 0;
		for (let k = 0; k < nv; k++) {
			if (views[k].length > MAX_VIEW) throw new Error(`GVE2: z${z} view ${k} ${views[k].length} bytes > ${MAX_VIEW}`);
			tab.writeUInt32LE(pos >>> 0, k * 4);
			pos += views[k].length;
			tot += views[k].length; max = Math.max(max, views[k].length);
			dsum += diffs[k]; dmax = Math.max(dmax, diffs[k]); psum += np[k];
		}
		tab.writeUInt32LE(pos >>> 0, nv * 4);
		parts.push(tab, ...views);
		const ho = HDR_ZOOM0 + zi * HDR_ZOOM_SIZE;
		hdr.writeUInt16LE(g.nLon & 0xFFFF, ho);
		hdr.writeUInt16LE(g.nTilt & 0xFFFF, ho + 2);
		hdr.writeUInt16LE(roundEven(g.tiltStep * 65536 / 360) & 0xFFFF, ho + 4);
		hdr.writeUInt16LE(ZR[z] & 0xFFFF, ho + 6);
		hdr.writeUInt32LE(idxPos >>> 0, ho + 8);
		stats.push(`z${z} ${g.nLon}x${g.nTilt}=${nv} views, ${(psum / nv).toFixed(0)} pieces, ${(tot / nv).toFixed(0)} B avg, ${max} B max, ` +
			`${((tot + tab.length) / 1048576).toFixed(2)} MB, pairs differing from runs ${dsum} (max ${dmax} in a view)`);
	}
	const data = Buffer.concat(parts);
	fs.writeFileSync(path, data);
	return { info: stats.join('; '), bytes: data.length };
}

module.exports = { build, view, decode };
