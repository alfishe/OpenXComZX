// Pictures for TS-Config: 8 bpp, even width (DMA moves words), cropped to the opaque
// pixels (0 is transparent, DMA BLT1).
'use strict';
const { Img } = require('./formats');

// Bounding box of opaque pixels; x and width aligned to 2. null — empty frame
function opaqueBox(img) {
	let x0 = img.w, y0 = img.h, x1 = -1, y1 = -1;
	for (let y = 0; y < img.h; y++)
		for (let x = 0; x < img.w; x++)
			if (img.px[y * img.w + x] !== 0) {
				if (x < x0) x0 = x;
				if (x > x1) x1 = x;
				if (y < y0) y0 = y;
				if (y > y1) y1 = y;
			}
	if (x1 < 0) return null;
	x0 &= ~1;
	let w = x1 - x0 + 1;
	if ((w & 1) !== 0) w++;
	if (x0 + w > img.w) x0 = img.w - w;
	return [x0, y0, w, y1 - y0 + 1];
}

function crop(img, box) {
	const o = Buffer.alloc(box[2] * box[3]);
	for (let y = 0; y < box[3]; y++) {
		const s = (box[1] + y) * img.w + box[0];
		img.px.copy(o, y * box[2], s, s + box[2]);
	}
	return o;
}

function encodeImg8(img) {
	if ((img.w & 1) !== 0) throw new Error('IMG8 width must be even');
	return Buffer.from(img.px);
}

// SPRSET: u16 n, u8 cell_w, u8 cell_h; n x { u8 x, u8 y, u8 w, u8 h, u16 offs/2 };
// then frame data (w*h bytes, w even). Empty frame — w = 0
const SPRSET_HDR = 4, SPRSET_ENTRY = 6, U8_MAX = 255, U16_MAX = 0xFFFF;
function encodeSprset(frames) {
	const n = frames.length, cw = frames[0].w, ch = frames[0].h;
	if (cw > U8_MAX || ch > U8_MAX) throw new Error('SPRSET cell too big');
	const hdr = Buffer.alloc(SPRSET_HDR + n * SPRSET_ENTRY);
	hdr[0] = n & 0xFF; hdr[1] = (n >> 8) & 0xFF; hdr[2] = cw; hdr[3] = ch;
	const data = [];
	let len = 0;
	for (let i = 0; i < n; i++) {
		const box = opaqueBox(frames[i]);
		const e = SPRSET_HDR + i * SPRSET_ENTRY;
		if (box === null) continue;
		const d = crop(frames[i], box);
		const offs = len;
		if (Math.trunc(offs / 2) > U16_MAX) throw new Error('SPRSET too large');
		hdr[e] = box[0] & 0xFF; hdr[e + 1] = box[1] & 0xFF; hdr[e + 2] = box[2] & 0xFF; hdr[e + 3] = box[3] & 0xFF;
		hdr[e + 4] = (offs >> 1) & 0xFF; hdr[e + 5] = (offs >> 9) & 0xFF;
		data.push(d); len += d.length;
	}
	return Buffer.concat([hdr, ...data]);
}

// All frames in one sheet picture (preview)
function sheet(frames, cols = 16) {
	const cw = frames[0].w, ch = frames[0].h, rows = Math.ceil(frames.length / cols);
	const img = new Img(cw * Math.min(cols, frames.length), ch * rows);
	frames.forEach((f, i) => {
		const ox = i % cols * cw, oy = Math.trunc(i / cols) * ch;
		for (let y = 0; y < ch; y++) f.px.copy(img.px, (oy + y) * img.w + ox, y * cw, y * cw + cw);
	});
	return img;
}

module.exports = { opaqueBox, crop, encodeImg8, encodeSprset, sheet };
