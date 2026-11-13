// Globe polygon mask (resource WORLDMAP, GEO.PAK) from GEODATA/WORLD.DAT — for insideLand and
// the landing-site texture without trigonometry on the Z80 (14_todo §3.17, §4).
//
// The point test is an exact port of OpenXcom Globe::getPolygonFromLonLat (first polygon that
// holds the point; polygons with a vertex further than ~41° are skipped). In UFO polygons are
// land, in TFTD water (the disc background is land), so "inside a polygon" = OpenXcom
// insideLand, whatever it means in the game.
//
// Format (little-endian):
//   u16 nMixed
//   u8  cells[180 * 180]: 1° raster — 180 latitude rows (row 0 from -90°, north, like the
//       OpenXcom latitude sign), 360 longitude columns from 0°; a nibble per cell (even
//       column — low): 0..13 — polygon texture over the whole cell, 14 — border cell,
//       15 — outside all polygons;
//   u16 rowStart[180]: border cells before the row;
//   {u8 texture; u8 bits[8]} x nMixed: 1/8° subraster of each border cell in order
//       (1/8° rows from the north, bit i — column i from the west; 1 — inside a polygon),
//       texture — the most frequent texture inside.
'use strict';

const REC_SIZE = 20, REC_WORDS = 10;
const ROWS = 180, COLS = 360, SUB = 8;
const CELL_OUTSIDE = 15, CELL_MIXED = 14, TEX_MAX = 13;
const Z_DISCARD = 0.75;
const POLE_LAT = 80, MAX_LON_SPAN = 180;

const xcom2Rad = v => v * 0.125 * Math.PI / 180.0;
// C# % on doubles is fmod (sign of the dividend), same as JS %

function load(dat) {
	const list = [];
	for (let o = 0; o + REC_SIZE <= dat.length; o += REC_SIZE) {
		const v = [];
		for (let i = 0; i < REC_WORDS; i++) v.push(dat.readInt16LE(o + i * 2));
		const n = v[6] !== -1 ? 4 : 3;
		const p = { n, lon: new Array(n), lat: new Array(n), texture: v[8] };
		for (let i = 0; i < n; i++) { p.lon[i] = xcom2Rad(v[i * 2]); p.lat[i] = xcom2Rad(v[i * 2 + 1]); }
		// frame in degrees: longitudes relative to the first vertex (0/360 seam)
		const l0 = p.lon[0] * 180 / Math.PI;
		let rmin = 0, rmax = 0;
		for (let i = 0; i < n; i++) {
			const r = ((p.lon[i] * 180 / Math.PI - l0) % 360 + 540) % 360 - 180;
			rmin = Math.min(rmin, r); rmax = Math.max(rmax, r);
		}
		p.lonMin = l0 + rmin; p.lonMax = l0 + rmax;
		p.latMin = Math.min(...p.lat) * 180 / Math.PI; p.latMax = Math.max(...p.lat) * 180 / Math.PI;
		list.push(p);
	}
	return list;
}

// Globe::getPolygonFromLonLat: polygon texture or -1
function polyAt(polys, lon, lat) {
	const coslat = Math.cos(lat), sinlat = Math.sin(lat);
	for (const p of polys) {
		let z = 0;
		for (let j = 0; j < p.n; ++j) {
			z = coslat * Math.cos(p.lat[j]) * Math.cos(p.lon[j] - lon) + sinlat * Math.sin(p.lat[j]);
			if (z < Z_DISCARD) break;
		}
		if (z < Z_DISCARD) continue;
		let odd = false;
		let clat = p.lat[0], clon = p.lon[0];
		let x = Math.cos(clat) * Math.sin(clon - lon);
		let y = coslat * Math.sin(clat) - sinlat * Math.cos(clat) * Math.cos(clon - lon);
		for (let j = 0; j < p.n; ++j) {
			const k = (j + 1) % p.n;
			clat = p.lat[k]; clon = p.lon[k];
			const x2 = Math.cos(clat) * Math.sin(clon - lon);
			const y2 = coslat * Math.sin(clat) - sinlat * Math.cos(clat) * Math.cos(clon - lon);
			if (((y > 0) !== (y2 > 0)) && (0 < (x2 - x) * (0 - y) / (y2 - y) + x)) odd = !odd;
			x = x2; y = y2;
		}
		if (odd) return p.texture;
	}
	return -1;
}

function build(dat) {
	const polys = load(dat);
	// cell candidates: polygons whose frame (+1°) touches the cell; file order
	const cand = new Array(ROWS * COLS).fill(null);
	polys.forEach((p, pi) => {
		const r0 = Math.max(0, Math.floor(p.latMin + 90) - 1), r1 = Math.min(ROWS - 1, Math.floor(p.latMax + 90) + 1);
		let c0 = Math.floor(p.lonMin) - 1, c1 = Math.floor(p.lonMax) + 1;
		if (p.latMin < -POLE_LAT || p.latMax > POLE_LAT || c1 - c0 > MAX_LON_SPAN) { c0 = 0; c1 = COLS - 1; }   // near a pole — the whole band
		for (let r = r0; r <= r1; r++)
			for (let c = c0; c <= c1; c++) {
				const cc = ((c % COLS) + COLS) % COLS;
				const k = r * COLS + cc;
				(cand[k] || (cand[k] = [])).push(pi);
			}
	});
	const cells = Buffer.alloc(ROWS * ROWS);
	const rowStart = new Array(ROWS).fill(0);
	const recs = [];
	let mixed = 0;
	for (let r = 0; r < ROWS; r++) {
		rowStart[r] = mixed;
		for (let c = 0; c < COLS; c++) {
			let val = CELL_OUTSIDE;
			const cl = cand[r * COLS + c];
			if (cl) {
				const sub = [...new Set(cl)].sort((a, b) => a - b).map(i => polys[i]);
				const tex = new Array(SUB * SUB);
				for (let j = 0; j < SUB; j++)
					for (let i = 0; i < SUB; i++) {
						const lon = (c + (i + 0.5) / 8.0) * Math.PI / 180, lat = (r - 90 + (j + 0.5) / 8.0) * Math.PI / 180;
						tex[j * SUB + i] = polyAt(sub, lon, lat);
					}
				if (tex.every(t => t === tex[0])) val = tex[0] < 0 ? CELL_OUTSIDE : Math.min(tex[0], TEX_MAX);
				else {
					val = CELL_MIXED;
					mixed++;
					// most frequent texture inside, ties — the smallest
					const cnt = new Map();
					for (const t of tex) if (t >= 0) cnt.set(t, (cnt.get(t) || 0) + 1);
					let inside = -1, best = -1;
					for (const [t, n] of cnt) if (n > best || (n === best && t < inside)) { inside = t; best = n; }
					recs.push(inside & 0xFF);
					for (let j = 0; j < SUB; j++) {
						let b = 0;
						for (let i = 0; i < SUB; i++) if (tex[j * SUB + i] >= 0) b |= 1 << i;
						recs.push(b);
					}
				}
			}
			const idx = r * ROWS + (c >> 1);
			cells[idx] |= (c & 1) !== 0 ? val << 4 : val;
		}
	}
	const head = Buffer.alloc(2); head.writeUInt16LE(mixed & 0xFFFF);
	const rs = Buffer.alloc(ROWS * 2);
	rowStart.forEach((s, i) => rs.writeUInt16LE(s & 0xFFFF, i * 2));
	return { data: Buffer.concat([head, cells, rs, Buffer.from(recs)]), mixed };
}

module.exports = { build };
