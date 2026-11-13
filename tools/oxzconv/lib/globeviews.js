// Globe views as screen-row runs ("path A", project_docs/globe.md §12.5) — the exact
// rasteriser the edge views (globeedges.js) are fitted to and checked against. The old GVW1
// container is not written any more (GVIEW.PAK holds edge views, GVE2).
//
// Geometry. View axes: ex = (−sinλ0, cosλ0, 0), ey = (−sinC·cosλ0, −sinC·sinλ0, cosC),
// ez = (cosC·cosλ0, cosC·sinλ0, sinC); screen x = 128 + R·(ex·P), y = 100 + R·(ey·P), visible
// when ez·P > 0. A screen row is the circle ey·P = v = (y + 0.5 − 100)/R on the sphere, its
// points P = v·ey + c·(cosθ·ez + sinθ·ex), c = √(1 − v²); visible for |θ| < 90°,
// x = 128 + R·c·sinθ + 0.5, and x is monotonic in θ, so run order is x order.
//
// A map border is the arc P(t) = A·cos t + M·sin t (M = N × A, N = A × B, t from 0 to tAB).
// Its intersection with a row: N·P = 0, i.e. (N·ez)·cosθ + (N·ex)·sinθ = −v·(N·ey)/c — two
// roots θ = φ ± w, φ = atan2(N·ex, N·ez), cos w = d/|(N·ez, N·ex)|. No trigonometry needed:
// cosφ, sinφ are kept per arc, sin w = √(1 − cos²w), then the addition formulas. Inside the
// arc — via cos t = A·P and sin t = M·P: 0 < t < tAB ⟺ sin t > 0 and sin t·cos tAB < cos t·sin tAB.
// The texture on the larger-x side follows the arc direction: ey·(N × P) = (ey·M)·cos t − (ey·A)·sin t.
//
// Row culling: ey·P along the arc is a sinusoid (ey·A)·cos t + (ey·M)·sin t; its range is the
// ends plus the extremum ±√((ey·A)² + (ey·M)²) when the derivative changes sign between the
// ends (derivative at the ends — ey·M and ey·(N × B) = (ey·M)·cos tAB − (ey·A)·sin tAB).
//
// View (runs): for each of the 200 rows — u8 n, then n × (u8 len−1, u8 tex), len — run length
// in pixel pairs, tex 0..13 (13 — ocean). Runs cover exactly the disc pairs of the row.
'use strict';
const { roundEven, toInt } = require('./vec3');

const Z_FIRST = 0, N_ZOOM = 6;              // all zooms (edge views — globeedges.js)
const ZR = [90, 120, 180, 280, 450, 720];
const H = 200;
const SCREEN_CX = 128, SCREEN_CY = 100;
const GRID_LON = 72, GRID_LAT = 36, GRID_DEG = 5, MIXED = 0xFE;
// Tilt limit (globe.md §12.11): the pole must reach the window as it does at zoom 0 with 27° —
// within R·cos C <= 90·cos 27° (~80 points) of the centre; a view straight above the pole is
// not needed. The limit is the first grid step where this holds: z0 27°, z1 49.5°, z2 66°,
// z3 74.25°, z4 81°, z5 84°. Tilt step is native, 0.6 of the rotation step.
const TILT0 = 27;
const LON_STEP0 = 15.0, TILT_STEP_K = 0.6, VIEWS_LON0 = 24;

function grid(z) {
	const lonStep = LON_STEP0 / (z + 1), tiltStep = lonStep * TILT_STEP_K;
	const poleY = ZR[0] * Math.cos(TILT0 * Math.PI / 180);
	const tmax = Math.acos(Math.min(1, poleY / ZR[z])) * 180 / Math.PI;
	const k = toInt(Math.ceil(tmax / tiltStep - 1e-6));
	return { nLon: VIEWS_LON0 * (z + 1), nTilt: 2 * k + 1, k, lonStep, tiltStep };
}

// Disc pairs of a row (like globe.c rows_init): a pixel is inside when
// (2i + 1 − 256)² + (2j + 1 − 200)² < 4R²; a pair — when any of its pixels is. null — no disc
function disc(R, y) {
	const dy = 2 * y + 1 - 200, rr = 4 * R * R - dy * dy;
	if (rr <= 0) return null;
	let s = 0;                                   // like tools/gen_globe_tab.js: s² < rr
	while ((s + 1) * (s + 1) < rr) s++;
	const lo = Math.max(0, (256 - s) >> 1), hi = Math.min(255, (255 + s) >> 1);
	if (hi < lo) return null;
	return { pl: lo >> 1, pr: hi >> 1 };
}

// Point texture: the 5° grid (#FE — a border enters the cell), otherwise the exact probe
function probe(a, x, y, z) {
	const l = Math.atan2(y, x) * 180 / Math.PI, b = Math.asin(Math.max(-1, Math.min(1, z))) * 180 / Math.PI;
	const gx = toInt(Math.floor(((l % 360) + 360) % 360 / GRID_DEG)) % GRID_LON;
	const gy = Math.min(GRID_LAT - 1, Math.max(0, toInt(Math.floor((b + 90) / GRID_DEG))));
	const t = a.grid[gy * GRID_LON + gx];
	return t === MIXED ? a.texAt(x, y, z) : t;
}

// View axes and the per-arc data both rasterisers share; calls onCross(i, y, x, sp, cp, down)
// for each visible crossing of row y in arc order; onRow(y, d, v, c) brackets every disc row.
function prepare(a, zoom, lonDeg, tiltDeg) {
	const R = ZR[zoom];
	const l0 = lonDeg * Math.PI / 180, C = tiltDeg * Math.PI / 180;
	const cl = Math.cos(l0), sl = Math.sin(l0), cc = Math.cos(C), sc = Math.sin(C);
	const e = {
		R, exx: -sl, exy: cl, exz: 0,
		eyx: -sc * cl, eyy: -sc * sl, eyz: cc,
		ezx: cc * cl, ezy: cc * sl, ezz: sc,
	};
	const n = a.n;
	const P = {
		vA: new Float64Array(n), dA: new Float64Array(n), m2: new Float64Array(n),
		cph: new Float64Array(n), sph: new Float64Array(n), ny: new Float64Array(n),
		aex: new Float64Array(n), aez: new Float64Array(n), mex: new Float64Array(n), mez: new Float64Array(n),
		rows: new Array(H).fill(null),
	};
	const { exx, exy, exz, eyx, eyy, eyz, ezx, ezy, ezz } = e;
	for (let i = 0; i < n; i++) {
		const va = eyx * a.ax[i] + eyy * a.ay[i] + eyz * a.az[i];
		const vb = eyx * a.bx[i] + eyy * a.by[i] + eyz * a.bz[i];
		const da = eyx * a.mx[i] + eyy * a.my[i] + eyz * a.mz[i];
		const db = da * a.ct[i] - va * a.st[i];          // ey·(N × B)
		let lo = Math.min(va, vb), hi = Math.max(va, vb);
		const m = Math.sqrt(va * va + da * da);
		if (da > 0 && db < 0) hi = m;
		else if (da < 0 && db > 0) lo = -m;
		let y0 = toInt(Math.ceil(99.5 + R * lo)), y1 = toInt(Math.floor(99.5 + R * hi));
		if (y0 < 0) y0 = 0;
		if (y1 > H - 1) y1 = H - 1;
		if (y1 < y0) continue;
		const nxi = a.nx[i] * exx + a.ny[i] * exy + a.nz[i] * exz;
		const nyi = a.nx[i] * eyx + a.ny[i] * eyy + a.nz[i] * eyz;
		const nzi = a.nx[i] * ezx + a.ny[i] * ezy + a.nz[i] * ezz;
		const mm = Math.sqrt(nzi * nzi + nxi * nxi);
		if (mm < 1e-12) continue;
		P.vA[i] = va; P.dA[i] = da; P.ny[i] = nyi; P.m2[i] = mm;
		P.cph[i] = nzi / mm; P.sph[i] = nxi / mm;
		P.aex[i] = a.ax[i] * exx + a.ay[i] * exy + a.az[i] * exz;
		P.aez[i] = a.ax[i] * ezx + a.ay[i] * ezy + a.az[i] * ezz;
		P.mex[i] = a.mx[i] * exx + a.my[i] * exy + a.mz[i] * exz;
		P.mez[i] = a.mx[i] * ezx + a.my[i] * ezy + a.mz[i] * ezz;
		for (let y = y0; y <= y1; y++) (P.rows[y] || (P.rows[y] = [])).push(i);
	}
	return { e, P };
}

// Crossings of row y: [{ i, x, sp, cp, down }] in arc order (the order C# added them)
function rowCrossings(a, e, P, y, v, c) {
	const out = [];
	const R = e.R;
	if (!(c > 1e-9) || P.rows[y] === null) return out;
	for (const i of P.rows[y]) {
		const d = -v * P.ny[i] / c;
		if (Math.abs(d) > P.m2[i]) continue;
		const cw = d / P.m2[i], sw = Math.sqrt(Math.max(0, 1 - cw * cw));
		for (let s = 0; s < 2; s++) {
			const sgn = s === 0 ? 1 : -1;
			const cth = P.cph[i] * cw - sgn * P.sph[i] * sw;
			const sth = P.sph[i] * cw + sgn * P.cph[i] * sw;
			if (cth <= 0) continue;                                      // back side
			const cp = v * P.vA[i] + c * (cth * P.aez[i] + sth * P.aex[i]);   // cos t
			const sp = v * P.dA[i] + c * (cth * P.mez[i] + sth * P.mex[i]);   // sin t
			if (sp <= 0 || sp * a.ct[i] - cp * a.st[i] >= 0) continue;        // outside the arc
			const down = P.dA[i] * cp - P.vA[i] * sp > 0;                    // the arc goes down the screen
			out.push({ i, x: SCREEN_CX + R * c * sth + 0.5, sp, cp, down });
		}
	}
	return out;
}

// One view -> bytes (200 rows: u8 n, n × (len−1, tex))
function viewRuns(a, zoom, lonDeg, tiltDeg) {
	const { e, P } = prepare(a, zoom, lonDeg, tiltDeg);
	const R = e.R;
	const outb = [];
	for (let y = 0; y < H; y++) {
		const dsc = disc(R, y);
		if (!dsc) { outb.push(0); continue; }
		const v = (y + 0.5 - SCREEN_CY) / R, c = Math.sqrt(Math.max(0, 1 - v * v));
		const list = rowCrossings(a, e, P, y, v, c).map(q => ({
			x: q.x, right: q.down ? a.tl[q.i] : a.tr[q.i], left: q.down ? a.tr[q.i] : a.tl[q.i],
		}));
		list.sort((p, q) => p.x - q.x);
		let cur = list.length > 0 ? list[0].left : probe(a, v * e.eyx + c * e.ezx, v * e.eyy + c * e.ezy, v * e.eyz + c * e.ezz);
		let x0 = dsc.pl * 2;
		const xEnd = dsc.pr * 2 + 2, nr = outb.length;
		outb.push(0);
		let cnt = 0;
		for (const b of list) {
			const x = 2 * toInt(roundEven(b.x / 2));
			if (x > x0) {
				const xe = Math.min(x, xEnd);
				if (xe > x0) { outb.push(((xe - x0) / 2 - 1) & 0xFF, cur); cnt++; x0 = xe; }
			}
			cur = b.right;
		}
		if (x0 < xEnd) { outb.push(((xEnd - x0) / 2 - 1) & 0xFF, cur); cnt++; }
		outb[nr] = cnt & 0xFF;
	}
	return Buffer.from(outb);
}

module.exports = { Z_FIRST, N_ZOOM, ZR, H, SCREEN_CY, grid, disc, probe, prepare, rowCrossings, viewRuns };
