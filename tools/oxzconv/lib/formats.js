// Decoders of the original X-COM formats (UFO and TFTD).
// Reference — OpenXcom loaders: src/Engine/Surface.cpp (SCR, SPK, BDY),
// src/Engine/SurfaceSet.cpp (PCK/TAB, DAT), src/Engine/Palette.cpp.
'use strict';

// 8 bpp picture, 0 is transparent
class Img {
	constructor(w, h) { this.w = w; this.h = h; this.px = Buffer.alloc(w * h); }
}

// Sequential writer wrapping to the next row (setPixelIterative)
class PixelWriter {
	constructor(img) { this.img = img; this.i = 0; }
	get row() { return Math.trunc(this.i / this.img.w); }
	put(v) { if (this.i < this.img.px.length) this.img.px[this.i] = v; this.i++; }
}

const SCR_W = 320, SCR_H = 200;

function decodeScr(buf, w = SCR_W, h = SCR_H) {
	const img = new Img(w, h);
	buf.copy(img.px, 0, 0, Math.min(buf.length, w * h));
	return img;
}

// SPK: u16 words: FFFF n — n*2 transparent, FFFE n — n*2 literals, FFFD — end
function decodeSpk(buf, w = SCR_W, h = SCR_H) {
	const img = new Img(w, h);
	const wr = new PixelWriter(img);
	let p = 0;
	while (p + 2 <= buf.length) {
		const flag = buf[p] | buf[p + 1] << 8; p += 2;
		if (flag === 0xFFFF) { const n = buf[p] | buf[p + 1] << 8; p += 2; for (let i = 0; i < n * 2; i++) wr.put(0); }
		else if (flag === 0xFFFE) { const n = buf[p] | buf[p + 1] << 8; p += 2; for (let i = 0; i < n * 2; i++) wr.put(buf[p++] | 0); }
		else if (flag === 0xFFFD) break;
	}
	return img;
}

// BDY (TFTD): byte >= 129 — the next byte repeated (257 - b) times, otherwise (b + 1)
// literals; a run never crosses into the next row
function decodeBdy(buf, w = SCR_W, h = SCR_H) {
	const img = new Img(w, h);
	const wr = new PixelWriter(img);
	let p = 0;
	while (p < buf.length) {
		const b = buf[p++];
		if (b >= 129) {
			const n = 257 - b, v = p < buf.length ? buf[p] : 0; p++;
			const row = wr.row;
			for (let i = 0; i < n; i++) { wr.put(v); if (wr.row !== row) break; }
		} else {
			const n = b + 1, row = wr.row;
			for (let i = 0; i < n; i++) { const v = p < buf.length ? buf[p] : 0; p++; if (wr.row === row) wr.put(v); }
		}
	}
	return img;
}

// Frame count from TAB (SurfaceSet::loadPck): first 4 bytes as int32 non-zero (the second
// 16-bit offset is already non-zero) => 16-bit offsets, otherwise 32-bit (TFTD battle)
function tabFrames(tab) {
	if (!tab || tab.length < 2) return 1;
	if (tab.length < 4) return tab.length >> 1;
	const off32 = tab[0] | tab[1] << 8 | tab[2] << 16 | tab[3] << 24;
	return off32 !== 0 ? tab.length >> 1 : tab.length >> 2;
}

// PCK: frames back to back; frame = "rows to skip" byte, then FE n — n transparent,
// FF — end of frame, anything else — a pixel
function decodePck(pck, tab, w = 32, h = 40) {
	const n = tabFrames(tab);
	const frames = [];
	let p = 0;
	for (let f = 0; f < n; f++) {
		const img = new Img(w, h);
		const wr = new PixelWriter(img);
		if (p >= pck.length) { frames.push(img); continue; }
		const skip = pck[p++];
		for (let i = 0; i < skip * w; i++) wr.put(0);
		while (p < pck.length) {
			const v = pck[p++];
			if (v === 255) break;
			if (v === 254) { const k = p < pck.length ? pck[p] : 0; p++; for (let i = 0; i < k; i++) wr.put(0); }
			else wr.put(v);
		}
		frames.push(img);
	}
	return frames;
}

function decodeDatSet(buf, w, h) {
	const n = Math.trunc(buf.length / (w * h));
	const frames = [];
	for (let f = 0; f < n; f++) {
		const img = new Img(w, h);
		buf.copy(img.px, 0, f * w * h, (f + 1) * w * h);
		frames.push(img);
	}
	return frames;
}

// PALETTES.DAT: 768 + 6 bytes per palette, 6-bit RGB (Palette::palOffset)
const PAL_SIZE = 768, PAL_STRIDE = 774;
function decodePalettes(buf) {
	const out = [];
	for (let off = 0; off + PAL_SIZE <= buf.length; off += PAL_STRIDE) out.push(Buffer.from(buf.subarray(off, off + PAL_SIZE)));
	return out;
}

const BACKPALS_SIZE = 384;
function decodeBackpals(buf) {
	const p = Buffer.alloc(BACKPALS_SIZE);
	buf.copy(p, 0, 0, Math.min(BACKPALS_SIZE, buf.length));
	return p;
}

// IFF ILBM / PBM (Deluxe Paint): BMHD, CMAP (8 bit), BODY (ByteRun1 or uncompressed)
function decodeLbm(buf) {
	if (buf.toString('latin1', 0, 4) !== 'FORM') throw new Error('LBM: no FORM');
	const kind = buf.toString('latin1', 8, 12);
	let p = 12, bw = 0, bh = 0, planes = 0, comp = 0, hasBmhd = false, cmap = null, body = null;
	while (p + 8 <= buf.length) {
		const id = buf.toString('latin1', p, p + 4);
		const len = buf.readInt32BE(p + 4);
		const dlen = Math.min(len, buf.length - p - 8);
		const data = Buffer.from(buf.subarray(p + 8, p + 8 + Math.max(0, dlen)));
		if (id === 'BMHD') { bw = data[0] << 8 | data[1]; bh = data[2] << 8 | data[3]; planes = data[8]; comp = data[10]; hasBmhd = true; }
		else if (id === 'CMAP') cmap = data;
		else if (id === 'BODY') body = data;
		p += 8 + len + (len & 1);
	}
	if (!hasBmhd) throw new Error('LBM: no BMHD');
	const pal = Buffer.alloc(PAL_SIZE);
	if (cmap) cmap.copy(pal, 0, 0, Math.min(PAL_SIZE, cmap.length));
	const img = new Img(bw, bh);
	if (!body) return { img, pal };

	const rowBytes = kind === 'PBM ' ? bw + (bw & 1) : ((bw + 15) >> 4) * 2 * planes;
	const raw = Buffer.alloc(rowBytes * bh);
	if (comp === 1) {
		let s = 0, d = 0;
		while (s < body.length && d < raw.length) {
			const c = body[s++];
			if (c < 128) { for (let i = 0; i <= c && d < raw.length; i++) raw[d++] = s < body.length ? body[s++] : 0; }
			else if (c > 128) { const v = s < body.length ? body[s++] : 0; for (let i = 0; i < 257 - c && d < raw.length; i++) raw[d++] = v; }
		}
	} else body.copy(raw, 0, 0, Math.min(body.length, raw.length));

	if (kind === 'PBM ') {
		for (let y = 0; y < bh; y++) raw.copy(img.px, y * bw, y * rowBytes, y * rowBytes + bw);
	} else {
		const planeBytes = ((bw + 15) >> 4) * 2;
		for (let y = 0; y < bh; y++)
			for (let x = 0; x < bw; x++) {
				let v = 0;
				for (let pl = 0; pl < planes; pl++) {
					const b = raw[y * rowBytes + pl * planeBytes + (x >> 3)];
					if ((b & (0x80 >> (x & 7))) !== 0) v |= 1 << pl;
				}
				img.px[y * bw + x] = v & 0xFF;
			}
	}
	return { img, pal };
}

module.exports = { Img, PixelWriter, decodeScr, decodeSpk, decodeBdy, tabFrames, decodePck, decodeDatSet, decodePalettes, decodeBackpals, decodeLbm };
