// OpenXcom fonts (common/Language/Font.dat + PNG) -> FONT resource.
// A glyph is a cell of the PNG grid; width — from the leftmost to the rightmost opaque column
// (Font::init). Pixels are levels 0..5; on output colour = text colour + level*mul
// (Text::draw, PaletteShift): 4 bits per pixel, high nibble — left.
// FONT: u8 cell_w, u8 cell_h, i8 spacing, u8 first=#20, u16 n; n x {u8 width, u16 offset};
// glyphs — cell_h rows of ceil(width/2) bytes.
'use strict';
const Y = require('./yaml');
const Png = require('./png');

const SPACE = 0x20, QUESTION = 0x3F, FIRST_CODE = 0x20;
const HDR_SIZE = 6, ENTRY_SIZE = 3;
const LEVEL_MASK = 0x0F;

function load(ox) {
	const doc = Y.load(ox.readText('common/Language/Font.dat'));
	const fonts = new Map();
	for (const fo of Y.list(Y.get(doc, 'fonts'))) {
		const f = { id: Y.str(Y.get(fo, 'id')), w: Y.int(Y.get(fo, 'width')), h: Y.int(Y.get(fo, 'height')), spacing: Y.int(Y.get(fo, 'spacing')), glyphs: new Map() };
		for (const im of Y.list(Y.get(fo, 'images'))) {
			const file = Y.str(Y.get(im, 'file'));
			if (!ox.exists('common/Language/' + file)) continue;       // CJK fonts are not shipped
			const w = Y.has(im, 'width') ? Y.int(Y.get(im, 'width')) : f.w, h = Y.has(im, 'height') ? Y.int(Y.get(im, 'height')) : f.h;
			const img = Png.decodeIndexed(ox.readBytes('common/Language/' + file));
			const cols = Math.trunc(img.w / w);
			const chars = Y.str(Y.get(im, 'chars')).split('\n').join('');
			let idx = 0;
			for (let ci = 0; ci < chars.length; ci++, idx++) {
				let cp = chars.charCodeAt(ci);
				if (cp >= 0xD800 && cp <= 0xDBFF && ci + 1 < chars.length) { cp = (cp - 0xD800) * 0x400 + (chars.charCodeAt(ci + 1) - 0xDC00) + 0x10000; ci++; }
				if (f.glyphs.has(cp)) continue;
				const sx = idx % cols * w, sy = Math.trunc(idx / cols) * h;
				let left = -1, right = -1;
				for (let x = sx; x < sx + w && left < 0; x++)
					for (let y = sy; y < sy + h; y++) if (img.px[y * img.w + x] !== 0) { left = x; break; }
				for (let x = sx + w - 1; x >= sx && right < 0; x--)
					for (let y = sy; y < sy + h; y++) if (img.px[y * img.w + x] !== 0) { right = x; break; }
				f.glyphs.set(cp, { img, x: left < 0 ? sx : left, y: sy, w: left < 0 ? 0 : right - left + 1, h, empty: false });
			}
		}
		fonts.set(f.id, f);
	}
	return fonts;
}

function encode(font, glyphList) {
	const n = glyphList.length;
	let missing = 0;
	const hdr = Buffer.alloc(HDR_SIZE + ENTRY_SIZE * n);
	hdr[0] = font.w & 0xFF; hdr[1] = font.h & 0xFF; hdr[2] = font.spacing & 0xFF; hdr[3] = FIRST_CODE; hdr[4] = n & 0xFF; hdr[5] = (n >> 8) & 0xFF;
	const data = [];
	let len = 0;
	for (let i = 0; i < n; i++) {
		const cp = glyphList[i].cp;
		let g;
		if (cp === SPACE) g = { w: Math.max(1, font.w >> 1), h: font.h, empty: true };
		else { g = font.glyphs.get(cp); if (g === undefined) { g = font.glyphs.get(QUESTION); missing++; } }
		const w = g.w, bpr = (w + 1) >> 1;
		const d = Buffer.alloc(bpr * font.h);
		if (!g.empty)
			for (let y = 0; y < g.h; y++)
				for (let x = 0; x < w; x++) {
					const v = g.img.px[(g.y + y) * g.img.w + g.x + x] & LEVEL_MASK;
					d[y * bpr + (x >> 1)] |= (x & 1) !== 0 ? v : v << 4;
				}
		const offs = len;
		hdr[HDR_SIZE + i * 3] = w & 0xFF; hdr[HDR_SIZE + 1 + i * 3] = offs & 0xFF; hdr[HDR_SIZE + 2 + i * 3] = (offs >> 8) & 0xFF;
		data.push(d); len += d.length;
	}
	return { data: Buffer.concat([hdr, ...data]), missing };
}

module.exports = { load, encode };
