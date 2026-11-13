// Globe details (GLOBEDET resource, RULES.PAK) — Globe::drawDetail of OpenXcom (REF/OpenXcom/src/Geoscape/
// Globe.cpp): river and border lines (globe.polylines, zoom >= 1), country labels (countries.labelLon/Lat,
// zoom >= 2), cities — GlobeMarkers frame 8 and a label (point missionZones areas with a name,
// RuleRegion::getCities, zoom >= 3). Engine — src/geoscape/earth/globe.s detail (group culling and
// projection) and globe_det.c (drawing); project_docs/globe.md §12.12.
//
// Groups: the engine projects only group centres, culls them like map cells (_gl_cull: behind —
// z + sinρ/4 < −64, off the window — centre ± m) and projects the vertices of visible ones. A line is cut
// into pieces of up to GROUP_PTS points (neighbour pieces share the joint point); country labels and
// cities are gathered into groups of up to GROUP_PTS points within GROUP_DEG. Group order — lines,
// countries, cities (OpenXcom drawing order); inside a group — rule order.
//
// Layout (little-endian; offsets even — DMA copies the vertices):
//   +0  u8 lineColor, countryColor, cityColor, baseColor (globe.rul; defaults — Mod.cpp: 162, 239, 138, 133)
//   +4  u8 marker[9] — city icon 3x3 (0 — transparent), u8 0
//   +14 u16 nGroup, nVert, marker frames offset, 0, 0
//   +24 groups nGroup x 16 bytes (like a GLOBE cell record for _gl_cull): u16 first vertex,
//       u8 vertices, u8 kind (0 — line, 1 — country labels, 2 — cities), u16 1, u16 0, centre (6 bytes like
//       vertices), i16 sinρ (Q14)
//   m for zooms 0..5: 6 x nGroup x u16 — window margin of the group centre in pixels: v + (v >> 3) + 2 + label
//       margin, v = (R · sinρ) >> 14 (engine cm_fill formula; label margin 52 — 100 x 9 frame shifted by 2)
//   strings: nVert x u16 (label string number; #FFFF for line points)
//   vertices: nVert x 6 bytes — X, Y, Z (Q14, X = cosφ·cosλ, Y = cosφ·sinλ, Z = sinφ, negative latitude —
//     north), 2 bytes each: v & 127, v >> 7 (like the GLOBE resource)
//   marker frames: 9 x 9 bytes — GlobeMarkers set 3x3 by rows (0 — transparent; globe_det.c globe_marks)
'use strict';
const Y = require('./yaml');
const Png = require('./png');
const { roundEven } = require('./csmath');

const MAX_VERT = 340, MAX_GROUP = 96;      // globe.s detail: work page; globe_det.c — bank tail
const GROUP_PTS = 12;
const GROUP_DEG = 15;
const ZR = [90, 120, 180, 280, 450, 720];
const ZOOMS = ZR.length;
const Q14 = 16384, Q14_MAX = 16383;
const NO_STRING = 0xFFFF;
const HEADER_SIZE = 24, GROUP_SIZE = 16, ZOOM_ROW = 2 * ZOOMS, VERT_SIZE = 6;
const LABEL_MARGIN = 52;
const MARKER = 3, MARKER_FRAMES = 9, CITY_FRAME = 8, CITY_CENTRE_PEN = 11;
const TFTD_FOLDER = 'xcom2', TFTD_RIVER_COLOR = 92;
const DEF_LINE = 162, DEF_COUNTRY = 239, DEF_CITY = 138, DEF_BASE = 133;
const DEG = Math.PI / 180;

function vec(lonDeg, latDeg, str) {
	const lon = lonDeg * Math.PI / 180, lat = latDeg * Math.PI / 180;
	return { X: Math.cos(lat) * Math.cos(lon), Y: Math.cos(lat) * Math.sin(lon), Z: Math.sin(lat), Str: str };
}

// C# struct value equality (List.Remove / Contains)
const same = (a, b) => a.X === b.X && a.Y === b.Y && a.Z === b.Z && a.Str === b.Str;

function v6(o, x, y, z) {
	for (const c of [x, y, z]) {
		const v = Math.max(-Q14_MAX, Math.min(Q14_MAX, roundEven(c * Q14)));
		o.push(v & 127, (v >> 7) & 0xFF);
	}
}

const u16 = (o, v) => o.push(v & 0xFF, (v >> 8) & 0xFF);

// Centre (normalised sum) and sinρ — sine of the largest angle to the points
function cap(ps) {
	let x = 0, y = 0, z = 0;
	for (const p of ps) x += p.X;
	for (const p of ps) y += p.Y;
	for (const p of ps) z += p.Z;
	const l = Math.sqrt(x * x + y * y + z * z);
	x /= l; y /= l; z /= l;
	let minCos = Infinity;
	for (const p of ps) minCos = Math.min(minCos, p.X * x + p.Y * y + p.Z * z);
	const rho = Math.acos(Math.max(-1, Math.min(1, minCos)));
	return { x, y, z, sinRho: rho >= Math.PI / 2 ? 1.0 : Math.sin(rho) };
}

// Label points -> groups by proximity (greedy: first free one and its nearest within GROUP_DEG)
function cluster(pts) {
	const left = pts.slice();
	const res = [];
	const cmin = Math.cos(GROUP_DEG * DEG);
	while (left.length > 0) {
		const a = left[0];
		const dot = p => p.X * a.X + p.Y * a.Y + p.Z * a.Z;
		const g = left.filter(p => dot(p) >= cmin)
			.map((p, i) => ({ p, i, d: dot(p) }))
			.sort((u, v) => (u.d > v.d ? -1 : u.d < v.d ? 1 : u.i - v.i))   // OrderByDescending, stable
			.slice(0, GROUP_PTS).map(e => e.p);
		for (const p of g) { const i = left.findIndex(q => same(q, p)); if (i >= 0) left.splice(i, 1); }
		// rule order inside the group
		res.push(pts.filter(p => g.some(q => same(q, p))));
	}
	return res;
}

function build(rs, sections, ox, folder) {
	const g = sections.has('globe') ? sections.get('globe') : null;
	const col = (k, def) => { const v = Y.get(g, k); return v === null ? def : Math.trunc(Y.num(v)); };
	// TFTD: lines are rivers, blue (92: 52, 124, 208) instead of black lineColor 111 — user request;
	// UFO — country borders, original colour
	const line = folder === TFTD_FOLDER ? TFTD_RIVER_COLOR : col('lineColor', DEF_LINE);
	const head = [line & 0xFF, col('countryColor', DEF_COUNTRY) & 0xFF, col('cityColor', DEF_CITY) & 0xFF, col('baseColor', DEF_BASE) & 0xFF];

	// city icon — frame 8 of GlobeMarkers (extraSprites.rul: 3x3, file UI/globe_*.png)
	let png = null;
	if (sections.has('extraSprites'))
		for (const e of Y.list(sections.get('extraSprites')) || [])
			if (Y.str(Y.get(e, 'type')) === 'GlobeMarkers')
				for (const [, v] of Y.map(Y.get(e, 'files')) || new Map()) png = Y.str(v);
	if (png === null) throw new Error('GLOBEDET: GlobeMarkers not found in extraSprites');
	// the city icon (frame 8) is red in both games; recoloured to the city label colour at the user's
	// request: outline cityColor + 1, middle + 3 (shades of the same group, like glyphs)
	const img = Png.decodeIndexed(ox.readBytes(`standard/${folder}/${png}`));
	const city = col('cityColor', DEF_CITY);
	const recol = (v, fr) => (fr !== CITY_FRAME || v === 0 ? v : (city + (v === CITY_CENTRE_PEN ? 3 : 1)) & 0xFF);
	for (let y = 0; y < MARKER; y++) for (let x = 0; x < MARKER; x++) head.push(recol(img.px[y * img.w + CITY_FRAME * MARKER + x], CITY_FRAME));
	head.push(0);
	const frames = [];
	for (let fr = 0; fr < MARKER_FRAMES; fr++) for (let y = 0; y < MARKER; y++) for (let x = 0; x < MARKER; x++) frames.push(recol(img.px[y * img.w + fr * MARKER + x], fr));

	const groups = [];
	let nLines = 0;
	for (const pl of Y.list(Y.get(g, 'polylines')) || []) {
		const v = Y.list(pl);
		const n = Math.trunc(v.length / 2);
		if (n < 2) continue;
		nLines++;
		const pts = [];
		for (let i = 0; i < n; i++) pts.push(vec(Y.num(v[2 * i]), Y.num(v[2 * i + 1]), NO_STRING));
		for (let s = 0; s < n - 1; s += GROUP_PTS - 1) groups.push({ pts: pts.slice(s, s + GROUP_PTS), kind: 0 });
	}
	const countries = rs.entries.get('countries').map(([k, c]) => vec(Y.num(Y.get(c, 'labelLon')), Y.num(Y.get(c, 'labelLat')),
		rs.str(Y.get(c, 'type') ?? k)));
	for (const c of cluster(countries)) groups.push({ pts: c, kind: 1 });
	const cities = [];
	for (const [, reg] of rs.entries.get('regions'))
		for (const zone of Y.list(Y.get(reg, 'missionZones')) || [])
			for (const a of Y.list(zone) || []) {
				const v = Y.list(a);
				if (v === null || v.length < 6) continue;
				const nm = Y.str(v[5]);
				if (nm === null || nm.length === 0) continue;
				if (Y.num(v[0]) !== Y.num(v[1]) || Y.num(v[2]) !== Y.num(v[3])) continue;   // MissionArea::isPoint
				cities.push(vec(Y.num(v[0]), Y.num(v[2]), rs.str(v[5])));
			}
	for (const c of cluster(cities)) groups.push({ pts: c, kind: 2 });

	const nVert = groups.reduce((s, x) => s + x.pts.length, 0);
	if (nVert > MAX_VERT) throw new Error(`GLOBEDET: ${nVert} vertices > ${MAX_VERT}`);
	if (groups.length > MAX_GROUP) throw new Error(`GLOBEDET: ${groups.length} groups > ${MAX_GROUP}`);
	const fOff = HEADER_SIZE + groups.length * (GROUP_SIZE + ZOOM_ROW) + nVert * (2 + VERT_SIZE);
	u16(head, groups.length); u16(head, nVert); u16(head, fOff); u16(head, 0); u16(head, 0);
	const recs = [], ms = [], strs = [], verts = [];
	const caps = groups.map(x => cap(x.pts));
	let first = 0;
	for (let i = 0; i < groups.length; i++) {
		const { pts, kind } = groups[i];
		u16(recs, first); recs.push(pts.length & 0xFF, kind); u16(recs, 1); u16(recs, 0);
		v6(recs, caps[i].x, caps[i].y, caps[i].z);
		u16(recs, roundEven(caps[i].sinRho * Q14));
		for (const p of pts) { u16(strs, p.Str); v6(verts, p.X, p.Y, p.Z); }
		first += pts.length;
	}
	for (let z = 0; z < ZOOMS; z++)
		for (let i = 0; i < groups.length; i++) {
			const sr = roundEven(caps[i].sinRho * Q14);
			const v = (ZR[z] * sr) >> 14;
			u16(ms, v + (v >> 3) + 2 + (groups[i].kind === 0 ? 0 : LABEL_MARGIN));
		}
	const o = [...head, ...recs, ...ms, ...strs, ...verts];
	if (o.length !== fOff) throw new Error('GLOBEDET: layout');
	o.push(...frames);
	return { data: Buffer.from(o), info: `${nLines} lines, ${countries.length} country labels, ${cities.length} cities -> ${groups.length} groups, ${nVert} points, ${o.length} B` };
}

module.exports = { build, MAX_VERT, MAX_GROUP };
