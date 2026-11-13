// interfaces.rul (colours, palettes and element geometry of screens) -> UI resource.
// UI: u16 n (= size of the ui_screens.txt registry); u16 offs[n] (0 — no screen);
// screen block: u16 palette (resource id, 0 — none), u8 parent (#FF), u8 music (#FF, not filled
// yet), u8 element count; 14-byte elements: u8 id, u8 flags (b0 color, b1 color2, b2 border,
// b3 pos, b4 size, b5 TFTDMode), u8 color, u8 color2, u8 border, u8 0, i16 x, i16 y, u16 w, u16 h.
// Parent elements the screen does not override are copied (RuleInterface::getElement).
'use strict';
const Y = require('./yaml');
const { Registry } = require('./resids');

const SCREEN_HDR = 5, ELEMENT_SIZE = 14, NONE = 0xFF, MAX_PARENT_DEPTH = 8;
const FL_COLOR = 1, FL_COLOR2 = 2, FL_BORDER = 4, FL_POS = 8, FL_SIZE = 16, FL_TFTD = 32;

function loadScreens(ox, folder) {
	const doc = Y.load(ox.readText(`standard/${folder}/interfaces.rul`));
	const order = [];
	const byType = new Map();
	for (const s of Y.list(Y.get(doc, 'interfaces')) || []) {
		const t = Y.str(Y.get(s, 'type'));
		if (!byType.has(t)) order.push({ type: t, node: null });
		byType.set(t, s);
	}
	for (const sc of order) sc.node = byType.get(sc.type);
	return { order, byType };
}

// -> [[id, element]] own elements first (later duplicates replace in place), then the parent's
function allElements(s, byType, depth = 0) {
	const own = [];
	const seen = new Set();
	for (const e of Y.list(Y.get(s, 'elements')) || []) {
		const id = Y.str(Y.get(e, 'id'));
		const at = own.findIndex(kv => kv[0] === id);
		if (at >= 0) own[at] = [id, e]; else own.push([id, e]);
		seen.add(id);
	}
	const parent = Y.str(Y.get(s, 'parent'));
	if (parent !== null && byType.has(parent) && depth < MAX_PARENT_DEPTH)
		for (const kv of allElements(byType.get(parent), byType, depth + 1))
			if (!seen.has(kv[0])) { own.push(kv); seen.add(kv[0]); }
	return own;
}

function build(ox, folder, ids) {
	const screens = Registry.load('ui_screens.txt');
	const elements = Registry.load('ui_elements.txt');
	const sIdx = Registry.index(screens);
	const eIdx = Registry.index(elements);
	const { order, byType } = loadScreens(ox, folder);
	const unknown = [];
	const n = screens.length;
	const head = Buffer.alloc(2 + 2 * n);
	head.writeUInt16LE(n & 0xFFFF, 0);
	const blocks = [];
	let pos = head.length;
	for (const sc of order) {
		if (!sIdx.has(sc.type)) { unknown.push('screen ' + sc.type); continue; }
		const els = allElements(sc.node, byType).filter(kv => { if (eIdx.has(kv[0])) return true; unknown.push('element ' + kv[0]); return false; });
		const b = Buffer.alloc(SCREEN_HDR + els.length * ELEMENT_SIZE);
		const pal = Y.str(Y.get(sc.node, 'palette'));
		const palId = pal !== null ? ids.id(pal) : 0;
		b[0] = palId & 0xFF; b[1] = (palId >> 8) & 0xFF;
		const parent = Y.str(Y.get(sc.node, 'parent'));
		b[2] = parent !== null && sIdx.has(parent) ? sIdx.get(parent) & 0xFF : NONE;
		b[3] = NONE;
		b[4] = els.length & 0xFF;
		els.forEach(([id, e], i) => {
			const o = SCREEN_HDR + i * ELEMENT_SIZE;
			let f = 0;
			if (Y.has(e, 'color')) f |= FL_COLOR;
			if (Y.has(e, 'color2')) f |= FL_COLOR2;
			if (Y.has(e, 'border')) f |= FL_BORDER;
			const posL = Y.list(Y.get(e, 'pos')), sizeL = Y.list(Y.get(e, 'size'));
			if (posL !== null) f |= FL_POS;
			if (sizeL !== null) f |= FL_SIZE;
			if (Y.bool(Y.get(e, 'TFTDMode'))) f |= FL_TFTD;
			b[o] = eIdx.get(id) & 0xFF; b[o + 1] = f;
			b[o + 2] = Y.int(Y.get(e, 'color')) & 0xFF; b[o + 3] = Y.int(Y.get(e, 'color2')) & 0xFF; b[o + 4] = Y.int(Y.get(e, 'border')) & 0xFF;
			const i16 = (at, v) => { b[at] = v & 0xFF; b[at + 1] = (v >> 8) & 0xFF; };
			i16(o + 6, posL !== null ? Y.int(posL[0]) : 0); i16(o + 8, posL !== null ? Y.int(posL[1]) : 0);
			i16(o + 10, sizeL !== null ? Y.int(sizeL[0]) : 0); i16(o + 12, sizeL !== null ? Y.int(sizeL[1]) : 0);
		});
		const idx = sIdx.get(sc.type);
		head[2 + 2 * idx] = pos & 0xFF; head[3 + 2 * idx] = (pos >> 8) & 0xFF;
		blocks.push(b);
		pos += b.length;
	}
	return { data: Buffer.concat([head, ...blocks]), screens: order.length, unknown };
}

// Screen palette (State::setInterface/setPalette): the screen's or the parent's palette
// (default PAL_GEOSCAPE) and the BACKPALS block from the "palette" element (-1 — none)
function screenPalettes(ox, folder) {
	const { byType } = loadScreens(ox, folder);
	const paletteEl = node => (Y.list(Y.get(node, 'elements')) || []).find(e => Y.str(Y.get(e, 'id')) === 'palette') ?? null;
	return type => {
		if (type === null || type === undefined || !byType.has(type)) return { pal: 'PAL_GEOSCAPE', backpal: -1 };
		const s = byType.get(type);
		const ps = Y.str(Y.get(s, 'parent'));
		const parent = ps !== null && byType.has(ps) ? byType.get(ps) : null;
		const pal = Y.str(Y.get(s, 'palette')) ?? (parent !== null ? Y.str(Y.get(parent, 'palette')) : null) ?? 'PAL_GEOSCAPE';
		let el = paletteEl(s);
		if (el === null && parent !== null) el = paletteEl(parent);
		return { pal, backpal: el !== null && Y.has(el, 'color') ? Y.int(Y.get(el, 'color')) : -1 };
	};
}

module.exports = { build, screenPalettes };
