// Globe geometry (resource GLOBE, GEO.PAK) from GEODATA/WORLD.DAT — for the engine's globe
// renderer (src/geoscape/earth/globe.c, globe_s.s; plan — project_docs/globe.md §5.4 M4b).
//
// WORLD.DAT polygons overlap (TFTD — ~5% of sphere points in two or more, OpenXcom draws them
// in order, later on top) and meet in T-junctions (a vertex of one on an edge of another). The
// engine cannot afford this, so the converter builds a flat map up front:
//   1) vertices closer than TOL_T to a foreign edge (great-circle arc) are inserted into that
//      edge and its polygons (near-T-junctions: TFTD 67, UFO 1);
//   2) all edges are intersected with each other (intersections become new vertices) —
//      giving segments that meet only at their ends;
//   3) each segment gets the texture left and right of it by the OpenXcom rule at points next
//      to its middle (the last polygon in file order holding the point, even-odd in the
//      polygon's gnomonic projection; none — ocean 13);
//   4) segments with the same texture on both sides are dropped, chains of segments on one
//      arc with the same sides are merged (up to MAX_ARC).
// Only borders where the texture changes remain: the engine walks a row edge by edge from
// left to right — the texture between edges is known.
//
// Edges are split into 30° x 30° cells (12 by longitude x 6 by latitude) by their middle: the
// engine culls a whole cell if it is on the back side or outside the window. Each cell has its
// own vertices (shared ones repeat in neighbours) so only the needed ones are projected.
//
// Vertices are Q14 unit vectors: X = cosφ·cosλ, Y = cosφ·sinλ, Z = sinφ (latitude φ negative —
// north, as in OpenXcom and state.h), |v| <= 16383. The view projection (λ0, tilt C, radius R)
// is linear: x = R(Y cosλ0 − X sinλ0), y = R(cosC·Z − sinC·W), z = cosC·W + sinC·Z,
// W = X cosλ0 + Y sinλ0 (the engine multiplies with product tables, globe.md §6.2). This
// projection keeps orientation: the side N = A × B of a segment A -> B on screen (x right,
// y down) is to the right of A -> B. A coordinate is stored in two bytes: the low 7 bits
// (index T_lo) and v >> 7 (signed byte, index T_hi) — the engine never has to unpack them.
//
// 5° grid (72 by longitude x 36 by latitude, from λ = 0 and φ = −90°): the cell texture if
// no edge enters the cell, else #FE. Needed when the window has no edge at all (zooms 3–5 in
// the middle of an ocean or land): the circle inscribed in the window at zoom 5 is 8°, the
// cell with the view centre lies entirely within it.
//
// Format v6 (little-endian; globe.md §12.10):
//   u16 nCell (72), block size / 6, 0
//   cell[nCell]: u16 offset of the cell block (from the start of blocks), u16 block header size
//       (0 — no edges), u16 total edges, 0; centre vector (6 bytes like vertices); i16 sinRho
//       (cap radius, Q14; 16384 and more — never cull)                               16 bytes
//   cell block: header — u8 ns (15° sub-blocks with edges, 1..4), 0; sub-block records ns x 16
//       bytes (like a cell, but u16 offset of the sub-block data from the block start, vn, en,
//       0; centre; sinRho); m for zooms 3, 4, 5 — three arrays ns x u16 (m = v + (v >> 3) + 2,
//       v = (R · sinRho) >> 14 — the engine culls sub-blocks without multiplying); then the
//       sub-block data: vertices vn x 6 bytes — X, Y, Z 2 bytes each: v & 127, v >> 7; edges
//       en x 6 bytes — u16 va, vb (vertex number in the sub-block * 6 — the engine projection
//       record: x, y, z), u8 texL, texR (left / right of va -> vb on screen; 13 — ocean). All
//       offsets even (DMA ignores address bit 0).
//   grid[36][72]: u8
'use strict';
const { V, roundEven, toInt } = require('./vec3');

const CELL_LON = 12, CELL_LAT = 6, N_CELL = CELL_LON * CELL_LAT, N_SUB = 4;
const MAX_SUB = 150;                       // vertices / edges in a sub-block (engine MAXCV)
const ZOOM_R = [90, 120, 180, 280, 450, 720];
const FIRST_CULL_ZOOM = 3, CULL_ZOOMS = 3;
const V_REC = 6;                           // engine vertex projection record: x, y, z (2 bytes each)
const GRID_LON = 72, GRID_LAT = 36, GRID_DEG = 5;
const TOL_T = 3e-4;                        // vertex attraction to an edge (rad)
const TOL_V = 1e-9;                        // vertices coincide
const EPS = 2e-6;                          // texture probe offset from a segment
const MAX_ARC = 12 * Math.PI / 180;        // merged edge length
const OCEAN = 13, MIXED = 0xFE;            // ocean — the 14th "texture" (engine pattern block)
const Q14_ONE = 16384, Q14_MAX = 16383;
const REC_SIZE = 20, REC_WORDS = 10;
const LON8_FULL = 2880, LAT8_POLE = 720;   // 1/8° units
const SUB_DEG = 15;
const CAP_MARGIN = 0.5 * Math.PI / 180;    // headroom for projection rounding
const GRID_STEP = 0.05 * Math.PI / 180;    // edge sampling step for the grid
const SUB_REC = 16, CULL_M_BYTES = 6;
const BLOCK_ALIGN = 6;

const vec = (lon, lat) => new V(Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat));
const rad = v8 => v8 * 0.125 * Math.PI / 180.0;
const q14 = v => Math.max(-Q14_MAX, Math.min(Q14_MAX, toInt(roundEven(v * Q14_ONE))));
const ang = (a, b) => Math.atan2(V.cross(a, b).len, V.dot(a, b));

// Polygon for texture probes: vertices in the gnomonic projection on the plane tangent at
// the centre (great-circle arcs are lines), a cap for quick rejection
class Poly {
	constructor(tex, vi) { this.tex = tex; this.vi = vi; }
	prepare(vs) {
		let s = new V();
		for (const i of this.vi) s = s.add(vs[i]);
		this.c = s.norm();
		this.cosR = 1;
		for (const i of this.vi) this.cosR = Math.min(this.cosR, V.dot(vs[i], this.c));
		this.cosR -= 1e-7;
		const t = Math.abs(this.c.z) < 0.9 ? new V(0, 0, 1) : new V(1, 0, 0);
		this.u = V.cross(t, this.c).norm(); this.w = V.cross(this.c, this.u);
		this.px = new Array(this.vi.length); this.py = new Array(this.vi.length);
		for (let k = 0; k < this.vi.length; k++) {
			const q = vs[this.vi[k]], d = V.dot(q, this.c);
			this.px[k] = V.dot(q, this.u) / d; this.py[k] = V.dot(q, this.w) / d;
		}
	}
	inside(p) {
		const d = V.dot(p, this.c);
		if (d < this.cosR) return false;
		const x = V.dot(p, this.u) / d, y = V.dot(p, this.w) / d;
		const px = this.px, py = this.py;
		let inside = false;
		for (let i = 0, j = px.length - 1; i < px.length; j = i++)
			if ((py[i] > y) !== (py[j] > y) && x < (px[j] - px[i]) * (y - py[i]) / (py[j] - py[i]) + px[i]) inside = !inside;
		return inside;
	}
}

function lonDeg(p) { return Math.atan2(p.y, p.x) * 180 / Math.PI; }
function latDeg(p) { return Math.asin(Math.max(-1, Math.min(1, p.z))) * 180 / Math.PI; }

function build(dat) {
	// ---- file polygons, vertices by key (1/8°)
	const verts = [];
	const keyOf = new Map();
	const vkey = (lo, la) => {
		lo = ((lo % LON8_FULL) + LON8_FULL) % LON8_FULL;
		if (Math.abs(la) >= LAT8_POLE) lo = 0;
		const key = lo + ',' + la;
		let i = keyOf.get(key);
		if (i === undefined) { i = verts.length; keyOf.set(key, i); verts.push(vec(rad(lo), rad(la))); }
		return i;
	};
	const polys = [];
	let nDegenerate = 0;
	for (let o = 0; o + REC_SIZE <= dat.length; o += REC_SIZE) {
		const v = [];
		for (let i = 0; i < REC_WORDS; i++) v.push(dat.readInt16LE(o + i * 2));
		const n = v[6] !== -1 ? 4 : 3;
		const vi = [];
		for (let i = 0; i < n; i++) {
			const k = vkey(v[i * 2], v[i * 2 + 1]);
			if (vi.length === 0 || vi[vi.length - 1] !== k) vi.push(k);
		}
		if (vi.length > 1 && vi[0] === vi[vi.length - 1]) vi.pop();
		if (vi.length < 3) { nDegenerate++; continue; }
		polys.push(new Poly(v[8] & 0x0F, vi));
	}
	const nOrig = verts.length;

	// ---- 1. near-T-junctions: original vertices on foreign edges are inserted into the
	// polygon edges (ordered from the edge start)
	let nTj = 0;
	for (const p of polys) {
		const list = [];
		for (let e = 0; e < p.vi.length; e++) {
			const a = p.vi[e], b = p.vi[(e + 1) % p.vi.length];
			list.push(a);
			const A = verts[a], B = verts[b];
			let N = V.cross(A, B);
			if (N.len < 1e-12) continue;
			N = N.norm();
			const ab = V.dot(A, B);
			const on = [];
			for (let k = 0; k < nOrig; k++) {
				if (k === a || k === b) continue;
				const Q = verts[k];
				if (Math.abs(V.dot(Q, N)) >= TOL_T) continue;
				if (V.dot(Q, A) <= ab || V.dot(Q, B) <= ab) continue;
				on.push({ t: ang(A, Q), i: k });
			}
			on.sort((x, y) => x.t - y.t);
			for (const q of on) { list.push(q.i); nTj++; }
		}
		p.vi = list;
	}

	// ---- 2. segments (unordered vertex pairs) and their intersections
	const segKeys = new Set(), segs = [];
	for (const p of polys)
		for (let e = 0; e < p.vi.length; e++) {
			const a = p.vi[e], b = p.vi[(e + 1) % p.vi.length];
			if (a === b) continue;
			const s = a < b ? [a, b] : [b, a], k = s[0] + ',' + s[1];
			if (!segKeys.has(k)) { segKeys.add(k); segs.push(s); }
		}
	const ns = segs.length;
	const sN = new Array(ns), sC = new Array(ns), sR = new Array(ns);
	for (let s = 0; s < ns; s++) {
		const A = verts[segs[s][0]], B = verts[segs[s][1]];
		sN[s] = V.cross(A, B).norm();
		sC[s] = A.add(B).norm();
		sR[s] = ang(A, sC[s]);
	}
	// points on a segment: vertices (ends included) with the angle from the start as parameter
	const onSeg = new Array(ns);
	for (let s = 0; s < ns; s++) onSeg[s] = [{ t: 0, v: segs[s][0] }, { t: ang(verts[segs[s][0]], verts[segs[s][1]]), v: segs[s][1] }];
	let nCross = 0;
	const newVert = p => {
		for (let k = nOrig; k < verts.length; k++) if (verts[k].sub(p).len < TOL_V) return k;
		verts.push(p);
		return verts.length - 1;
	};
	for (let s = 0; s < ns; s++) {
		const a = segs[s][0], b = segs[s][1];
		const A = verts[a], B = verts[b];
		for (let u = s + 1; u < ns; u++) {
			const c = segs[u][0], d = segs[u][1];
			if (c === a || c === b || d === a || d === b) continue;
			const rr = sR[s] + sR[u] + 1e-9;
			if (rr < Math.PI && V.dot(sC[s], sC[u]) < Math.cos(rr)) continue;
			const L = V.cross(sN[s], sN[u]);
			if (L.len < 1e-12) continue;          // one arc: shared parts go through T-junctions
			let P = L.norm();
			if (V.dot(P, sC[s]) < 0) P = P.neg();
			// P strictly inside both segments
			if (V.dot(V.cross(A, P), sN[s]) <= 1e-13 || V.dot(V.cross(P, B), sN[s]) <= 1e-13) continue;
			const Cc = verts[c], D = verts[d];
			if (V.dot(V.cross(Cc, P), sN[u]) <= 1e-13 || V.dot(V.cross(P, D), sN[u]) <= 1e-13) continue;
			const k = newVert(P);
			onSeg[s].push({ t: ang(A, P), v: k });
			onSeg[u].push({ t: ang(Cc, P), v: k });
			nCross++;
		}
	}
	// segment pieces between neighbouring points (insertion order kept, like HashSet)
	const pieceKeys = new Set(), pieces = [];
	for (let s = 0; s < ns; s++) {
		const l = onSeg[s].slice().sort((x, y) => x.t - y.t).map(q => q.v);
		for (let i = 0; i + 1 < l.length; i++) {
			if (l[i] === l[i + 1]) continue;
			const pc = l[i] < l[i + 1] ? [l[i], l[i + 1]] : [l[i + 1], l[i]], k = pc[0] + ',' + pc[1];
			if (!pieceKeys.has(k)) { pieceKeys.add(k); pieces.push(pc); }
		}
	}

	// ---- 3. textures of the piece sides
	for (const p of polys) p.prepare(verts);
	const texAt = q => {
		for (let i = polys.length - 1; i >= 0; i--) if (polys[i].inside(q)) return polys[i].tex;
		return OCEAN;
	};
	const kept = [];
	const nPieces = pieces.length;
	for (const [a, b] of pieces) {
		const A = verts[a], B = verts[b];
		const M = A.add(B).norm(), N = V.cross(A, B).norm();
		const tr = texAt(M.add(N.mul(EPS)).norm()), tl = texAt(M.sub(N.mul(EPS)).norm());
		if (tl !== tr) kept.push({ a, b, tl, tr });
	}

	// ---- 4. chain merging: a vertex with two edges on one arc and the same sides
	const inc = new Map();
	for (let i = 0; i < kept.length; i++)
		for (const v of [kept[i].a, kept[i].b]) {
			let l = inc.get(v);
			if (!l) inc.set(v, l = []);
			l.push(i);
		}
	const alive = new Array(kept.length).fill(true);
	const arr = kept.slice();
	let nMerged = 0;
	for (const [v, lst] of inc) {
		const l = lst.filter(i => alive[i]);
		if (l.length !== 2) continue;
		let e1 = arr[l[0]], e2 = arr[l[1]];
		// e1 pointing into v, e2 — out of v
		if (e1.b !== v) e1 = { a: e1.b, b: e1.a, tl: e1.tr, tr: e1.tl };
		if (e2.a !== v) e2 = { a: e2.b, b: e2.a, tl: e2.tr, tr: e2.tl };
		if (e1.a === e2.b || e1.tl !== e2.tl || e1.tr !== e2.tr) continue;
		const A = verts[e1.a], M = verts[v], B = verts[e2.b];
		const N = V.cross(A, B);
		if (N.len < 1e-9 || Math.abs(V.dot(M, N.norm())) > 1e-9) continue;
		if (V.dot(V.cross(A, M), N) <= 0 || V.dot(V.cross(M, B), N) <= 0) continue;
		if (ang(A, B) > MAX_ARC) continue;
		alive[l[1]] = false;
		arr[l[0]] = { a: e1.a, b: e2.b, tl: e1.tl, tr: e1.tr };
		// at the far end of e2 edge l[1] is replaced by l[0]
		const lb = inc.get(e2.b);
		const ri = lb.indexOf(l[1]); if (ri >= 0) lb.splice(ri, 1);
		lb.push(l[0]);
		lst.length = 0;
		nMerged++;
	}
	const edgesAll = [];
	for (let i = 0; i < arr.length; i++) if (alive[i]) edgesAll.push(arr[i]);

	// ---- 5. 30° cells by edge middle, inside — 15° sub-blocks (2 x 2); sub-block vertices, caps
	const cell15 = p => {
		const lon = lonDeg(p), lat = latDeg(p);
		const l15 = toInt(Math.floor(((lon % 360) + 360) % 360 / SUB_DEG)) % (CELL_LON * 2);
		const b15 = Math.min(CELL_LAT * 2 - 1, Math.max(0, toInt(Math.floor((lat + 90) / SUB_DEG))));
		return { cell: (b15 >> 1) * CELL_LON + (l15 >> 1), sub: (b15 % 2) * 2 + l15 % 2 };
	};
	const cellEdges = [];
	for (let c = 0; c < N_CELL; c++) { const r = []; for (let k = 0; k < N_SUB; k++) r.push([]); cellEdges.push(r); }
	for (const e of edgesAll) { const { cell, sub } = cell15(verts[e.a].add(verts[e.b]).norm()); cellEdges[cell][sub].push(e); }
	const bOut = [], cOut = [];
	const w16 = (o, x) => { o.push(x & 0xFF, (x >> 8) & 0xFF); };
	const wVec = (o, q) => { for (const c of [q.x, q.y, q.z]) { const v = q14(c); o.push(v & 127, (v >> 7) & 0xFF); } };
	// cap: centre (normalised sum of ends), sinρ (Q14, 16384 — never cull)
	const cap = es => {
		let sum = new V();
		for (const e of es) sum = sum.add(verts[e.a]).add(verts[e.b]);
		if (es.length === 0 || sum.len <= 1e-9) return { cc: new V(1, 0, 0), sinRho: Q14_ONE, rho: 0 };
		const cc = sum.norm();
		let rho = 0;
		for (const e of es) rho = Math.max(rho, Math.max(ang(cc, verts[e.a]), ang(cc, verts[e.b])));
		rho += CAP_MARGIN;
		return { cc, sinRho: rho >= Math.PI / 2 ? Q14_ONE : toInt(Math.ceil(Math.sin(rho) * Q14_ONE)), rho };
	};
	let nVert = 0, nEdge = 0, maxSubVerts = 0, maxSubEdges = 0, nDrop = 0, maxHdr = 0, nSubs = 0;
	let maxRho = 0, maxSubRho = 0;
	for (let c = 0; c < N_CELL; c++) {
		const all = [];
		const subRec = [], subM = [], subData = [];
		for (let z = 0; z < CULL_ZOOMS; z++) subM.push([]);
		let nsb = 0, cellEn = 0;
		for (let k = 0; k < N_SUB; k++) if (cellEdges[c][k].length > 0) nsb++;
		const hdr = 2 + nsb * (SUB_REC + CULL_M_BYTES);     // u8 count, u8 0; records; m of zooms 3–5
		for (let k = 0; k < N_SUB; k++) {
			const es = cellEdges[c][k];
			if (es.length === 0) continue;
			const vOut = [], eOut = [];
			const qmap = new Map();   // vertices that coincide after Q14
			let vn = 0;
			const loc = g => {
				const q = verts[g];
				const key = q14(q.x) + ',' + q14(q.y) + ',' + q14(q.z);
				let i = qmap.get(key);
				if (i === undefined) { i = vn++; qmap.set(key, i); wVec(vOut, q); }
				return i;
			};
			const keptE = [];
			for (const e of es) {
				const la = loc(e.a), lb = loc(e.b);
				if (la === lb) { nDrop++; continue; }
				w16(eOut, la * V_REC); w16(eOut, lb * V_REC); eOut.push(e.tl, e.tr);
				keptE.push(e);
			}
			const en = keptE.length;
			if (vn > MAX_SUB || en > MAX_SUB) throw new Error(`globe: sub-block ${c}/${k}: ${vn} vertices, ${en} edges > ${MAX_SUB}`);
			nVert += vn; nEdge += en; cellEn += en; nSubs++;
			maxSubVerts = Math.max(maxSubVerts, vn); maxSubEdges = Math.max(maxSubEdges, en);
			all.push(...keptE);
			const cp = cap(keptE);
			maxSubRho = Math.max(maxSubRho, cp.rho);
			w16(subRec, hdr + subData.length); w16(subRec, vn); w16(subRec, en); w16(subRec, 0);
			wVec(subRec, cp.cc); w16(subRec, cp.sinRho);
			// m = v + (v >> 3) + 2, v = (R · sinρ) >> 14 — like the engine's cm_fill (sinρ >= 16384: v = 0)
			for (let z = 0; z < CULL_ZOOMS; z++) {
				const v = cp.sinRho >= Q14_ONE ? 0 : (ZOOM_R[FIRST_CULL_ZOOM + z] * cp.sinRho) >> 14;
				w16(subM[z], v + (v >> 3) + 2);
			}
			subData.push(...vOut, ...eOut);
		}
		const cp = cap(all);
		maxRho = Math.max(maxRho, cp.rho);
		maxHdr = Math.max(maxHdr, hdr);
		// cell record: block offset, header size, total edges, 0; centre; sinρ
		w16(cOut, bOut.length); w16(cOut, nsb > 0 ? hdr : 0); w16(cOut, cellEn); w16(cOut, 0);
		wVec(cOut, cp.cc); w16(cOut, cp.sinRho);
		if (nsb === 0) continue;
		bOut.push(nsb, 0, ...subRec);
		for (const m of subM) bOut.push(...m);
		for (const x of subData) bOut.push(x);
	}
	while (bOut.length % BLOCK_ALIGN !== 0) bOut.push(0);   // blocks are a multiple of 6: the engine reads the size as h1 · 6

	// ---- 6. 5° grid: cells an edge enters — #FE; the rest — texture of the centre
	const grid = Buffer.alloc(GRID_LAT * GRID_LON);
	const touched = new Array(GRID_LAT * GRID_LON).fill(false);
	const gridOf = p => {
		const lon = lonDeg(p), lat = latDeg(p);
		const gx = toInt(Math.floor(((lon % 360) + 360) % 360 / GRID_DEG)) % GRID_LON;
		const gy = Math.min(GRID_LAT - 1, Math.max(0, toInt(Math.floor((lat + 90) / GRID_DEG))));
		return gy * GRID_LON + gx;
	};
	for (const e of edgesAll) {
		const A = verts[e.a], B = verts[e.b];
		const steps = Math.max(2, toInt(Math.ceil(ang(A, B) / GRID_STEP)));
		for (let i = 0; i <= steps; i++) touched[gridOf(A.mul(1 - i / steps).add(B.mul(i / steps)).norm())] = true;
	}
	let nMixed = 0;
	for (let gy = 0; gy < GRID_LAT; gy++)
		for (let gx = 0; gx < GRID_LON; gx++) {
			const g = gy * GRID_LON + gx;
			if (touched[g]) { grid[g] = MIXED; nMixed++; continue; }
			grid[g] = texAt(vec((gx * GRID_DEG + 2.5) * Math.PI / 180, (gy * GRID_DEG - 90 + 2.5) * Math.PI / 180));
		}

	// ---- 7. arcs for the view rasteriser (globeviews.js): exact vectors, no Q14
	const n = edgesAll.length;
	const F64 = () => new Float64Array(n);
	const arcs = {
		n,
		ax: F64(), ay: F64(), az: F64(), bx: F64(), by: F64(), bz: F64(),
		nx: F64(), ny: F64(), nz: F64(), mx: F64(), my: F64(), mz: F64(),
		ct: F64(), st: F64(),
		tl: Buffer.alloc(n), tr: Buffer.alloc(n),
		grid,
		texAt: (x, y, z) => texAt(new V(x, y, z)),
	};
	for (let i = 0; i < n; i++) {
		const e = edgesAll[i];
		const A = verts[e.a], B = verts[e.b], N = V.cross(A, B).norm(), M = V.cross(N, A);
		const t = ang(A, B);
		arcs.ax[i] = A.x; arcs.ay[i] = A.y; arcs.az[i] = A.z;
		arcs.bx[i] = B.x; arcs.by[i] = B.y; arcs.bz[i] = B.z;
		arcs.nx[i] = N.x; arcs.ny[i] = N.y; arcs.nz[i] = N.z;
		arcs.mx[i] = M.x; arcs.my[i] = M.y; arcs.mz[i] = M.z;
		arcs.ct[i] = Math.cos(t); arcs.st[i] = Math.sin(t);
		arcs.tl[i] = e.tl; arcs.tr[i] = e.tr;
	}

	const head = [];
	w16(head, N_CELL); w16(head, bOut.length / BLOCK_ALIGN); w16(head, 0);
	const data = Buffer.concat([Buffer.from(head), Buffer.from(cOut), Buffer.from(bOut), grid]);
	const info = `${polys.length} polygons (${nDegenerate} degenerate), ${nTj} near-T-junctions, ${nCross} crossings, ` +
		`${nPieces} pieces -> ${kept.length} texture boundaries -> ${nEdge} edges (${nMerged} merged, ${nDrop} dropped), ` +
		`${nVert} vertices in ${nSubs} sub-blocks (${maxSubVerts} / ${maxSubEdges} max in a sub-block, cell header ${maxHdr} max), grid ${nMixed} mixed, ` +
		`max radius cell ${(maxRho * 180 / Math.PI).toFixed(0)}° / sub-block ${(maxSubRho * 180 / Math.PI).toFixed(0)}°, blocks ${bOut.length} B`;
	return { data, info, arcs };
}

module.exports = { build };
