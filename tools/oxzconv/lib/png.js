// PNG without dependencies: writing indexed pictures (preview) and reading indexed ones
// (OpenXcom fonts, globe_*.png). zlib from Node (deflate output differs from .NET, so preview
// files match the C# ones by pixels and palette, not by bytes).
'use strict';
const zlib = require('zlib');
const { Img } = require('./formats');

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
	return t;
})();
function crc(b) { let c = 0xFFFFFFFF; for (const x of b) c = CRC_TABLE[(c ^ x) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

function chunk(type, data) {
	const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
	const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
	const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
	return Buffer.concat([len, td, c]);
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
const DEPTH8 = 8, CTYPE_INDEXED = 3;

// pal8 — 768 bytes, 8 bits per channel
function encodeIndexed(img, pal8) {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(img.w, 0); ihdr.writeUInt32BE(img.h, 4); ihdr[8] = DEPTH8; ihdr[9] = CTYPE_INDEXED;
	const raw = Buffer.alloc((img.w + 1) * img.h);
	for (let y = 0; y < img.h; y++) img.px.copy(raw, y * (img.w + 1) + 1, y * img.w, (y + 1) * img.w);
	return Buffer.concat([PNG_SIG, chunk('IHDR', ihdr), chunk('PLTE', Buffer.from(pal8)),
		chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// Reads an indexed PNG (1/2/4/8 bit, not interlaced)
function decodeIndexed(buf) {
	let p = 8, w = 0, h = 0, depth = 0, ctype = 0, inter = 0;
	const idat = [];
	while (p + 8 <= buf.length) {
		const len = buf.readUInt32BE(p);
		const type = buf.toString('latin1', p + 4, p + 8);
		if (type === 'IHDR') {
			w = buf.readUInt32BE(p + 8); h = buf.readUInt32BE(p + 12);
			depth = buf[p + 16]; ctype = buf[p + 17]; inter = buf[p + 20];
		} else if (type === 'IDAT') idat.push(buf.subarray(p + 8, p + 8 + len));
		p += 12 + len;
	}
	if (ctype !== CTYPE_INDEXED || inter !== 0) throw new Error('PNG: only non-interlaced indexed images supported');
	const stride = Math.trunc((w * depth + 7) / 8);
	const raw = zlib.inflateSync(Buffer.concat(idat));
	const img = new Img(w, h);
	let prev = Buffer.alloc(stride), line = Buffer.alloc(stride);
	for (let y = 0; y < h; y++) {
		const f = raw[y * (stride + 1)];
		raw.copy(line, 0, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
		for (let i = 0; i < stride; i++) {
			const a = i >= 1 ? line[i - 1] : 0, b = prev[i], c = i >= 1 ? prev[i - 1] : 0;
			let v = line[i];
			if (f === 1) v += a;
			else if (f === 2) v += b;
			else if (f === 3) v += (a + b) >> 1;
			else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
			line[i] = v & 0xFF;
		}
		for (let x = 0; x < w; x++) {
			const bit = x * depth;
			img.px[y * w + x] = (line[bit >> 3] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
		}
		const t = prev; prev = line; line = t;
	}
	return img;
}

// Pixels and palette of an indexed PNG (preview comparison)
function decodeWithPalette(buf) {
	let p = 8, pal = null;
	while (p + 8 <= buf.length) {
		const len = buf.readUInt32BE(p);
		if (buf.toString('latin1', p + 4, p + 8) === 'PLTE') pal = Buffer.from(buf.subarray(p + 8, p + 8 + len));
		p += 12 + len;
	}
	return { img: decodeIndexed(buf), pal };
}

module.exports = { encodeIndexed, decodeIndexed, decodeWithPalette };
