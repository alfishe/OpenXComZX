// PNG in and out for the screenshot tools (zoom, shotdiff, shotsheet, readme_shots) with Node
// alone: decode any non-interlaced PNG (gray, RGB, indexed, with alpha; 1-16 bits) to RGBA,
// encode RGBA as an 8-bit RGB PNG, nearest-neighbour scaling and a small text font.
'use strict';
const fs = require('fs');
const zlib = require('zlib');

const SIG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
const CT_GRAY = 0, CT_RGB = 2, CT_INDEXED = 3, CT_GRAY_A = 4, CT_RGBA = 6;
const CHANNELS = { [CT_GRAY]: 1, [CT_RGB]: 3, [CT_INDEXED]: 1, [CT_GRAY_A]: 2, [CT_RGBA]: 4 };
const FILTER_NONE = 0, FILTER_SUB = 1, FILTER_UP = 2, FILTER_AVG = 3, FILTER_PAETH = 4;
const OPAQUE = 255;

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
})();
const crc32 = (b) => { let c = 0xFFFFFFFF; for (const x of b) c = CRC_TABLE[(c ^ x) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };

// { w, h, px: Uint8Array RGBA }
function image(w, h, rgba = [0, 0, 0, OPAQUE]) {
    const px = new Uint8Array(w * h * 4);
    for (let i = 0; i < px.length; i += 4) px.set(rgba, i);
    return { w, h, px };
}

function decode(buf) {
    if (!buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG');
    let o = 8, w = 0, h = 0, depth = 0, ct = 0, interlace = 0, plte = null, trns = null;
    const idat = [];
    while (o < buf.length) {
        const len = buf.readUInt32BE(o), type = buf.toString('latin1', o + 4, o + 8), d = buf.subarray(o + 8, o + 8 + len);
        if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; ct = d[9]; interlace = d[12]; }
        else if (type === 'PLTE') plte = d;
        else if (type === 'tRNS') trns = d;
        else if (type === 'IDAT') idat.push(d);
        else if (type === 'IEND') break;
        o += 12 + len;
    }
    if (interlace) throw new Error('interlaced PNG is not supported');
    const ch = CHANNELS[ct];
    if (!ch) throw new Error(`PNG colour type ${ct}`);
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const bpp = Math.max(1, (ch * depth) >> 3);            // filter step in bytes
    const stride = Math.ceil(w * ch * depth / 8);
    const cur = Buffer.alloc(stride), prev = Buffer.alloc(stride);
    const img = image(w, h);
    const max = (1 << depth) - 1;
    for (let y = 0; y < h; y++) {
        const f = raw[y * (stride + 1)];
        raw.copy(cur, 0, y * (stride + 1) + 1, (y + 1) * (stride + 1));
        for (let i = 0; i < stride; i++) {
            const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
            let p;
            switch (f) {
                case FILTER_NONE: p = 0; break;
                case FILTER_SUB: p = a; break;
                case FILTER_UP: p = b; break;
                case FILTER_AVG: p = (a + b) >> 1; break;
                case FILTER_PAETH: {
                    const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c);
                    p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; break;
                }
                default: throw new Error(`PNG filter ${f}`);
            }
            cur[i] = (cur[i] + p) & 0xFF;
        }
        const sample = (x, k) => {
            if (depth === 8) return cur[x * ch + k];
            if (depth === 16) return cur[(x * ch + k) * 2];  // high byte
            const bit = (x * ch + k) * depth;
            return (cur[bit >> 3] >> (8 - depth - (bit & 7))) & max;
        };
        const scale = depth < 8 && ct !== CT_INDEXED ? 255 / max : 1;
        for (let x = 0; x < w; x++) {
            const at = (y * w + x) * 4;
            let r, g, bl, al = OPAQUE;
            if (ct === CT_INDEXED) {
                const i = sample(x, 0);
                r = plte[i * 3]; g = plte[i * 3 + 1]; bl = plte[i * 3 + 2];
                if (trns && i < trns.length) al = trns[i];
            } else if (ct === CT_GRAY || ct === CT_GRAY_A) {
                r = g = bl = Math.round(sample(x, 0) * scale);
                if (ct === CT_GRAY_A) al = sample(x, 1);
            } else {
                r = sample(x, 0); g = sample(x, 1); bl = sample(x, 2);
                if (ct === CT_RGBA) al = sample(x, 3);
            }
            img.px[at] = r; img.px[at + 1] = g; img.px[at + 2] = bl; img.px[at + 3] = al;
        }
        cur.copy(prev);
    }
    return img;
}

function chunk(type, data) {
    const t = Buffer.from(type, 'latin1');
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
}

// RGB, 8 bits (alpha dropped: the screenshots are opaque)
function encode(img) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(img.w, 0); ihdr.writeUInt32BE(img.h, 4);
    ihdr[8] = 8; ihdr[9] = CT_RGB;
    const stride = img.w * 3;
    const raw = Buffer.alloc((stride + 1) * img.h);
    for (let y = 0; y < img.h; y++) {
        raw[y * (stride + 1)] = FILTER_NONE;
        for (let x = 0; x < img.w; x++) {
            const s = (y * img.w + x) * 4, d = y * (stride + 1) + 1 + x * 3;
            raw[d] = img.px[s]; raw[d + 1] = img.px[s + 1]; raw[d + 2] = img.px[s + 2];
        }
    }
    return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const read = (file) => decode(fs.readFileSync(file));
const write = (file, img) => fs.writeFileSync(file, encode(img));

// Nearest-neighbour copy of the source rectangle sx,sy,sw,sh into dst at dx,dy scaled to dw x dh
// (pixel centres, as GDI+ NearestNeighbor with PixelOffsetMode.Half).
function blit(dst, dx, dy, dw, dh, src, sx = 0, sy = 0, sw = src.w, sh = src.h) {
    for (let y = 0; y < dh; y++) {
        const ty = dy + y;
        if (ty < 0 || ty >= dst.h) continue;
        const syy = sy + Math.floor((y + 0.5) * sh / dh);
        for (let x = 0; x < dw; x++) {
            const tx = dx + x;
            if (tx < 0 || tx >= dst.w) continue;
            const sxx = sx + Math.floor((x + 0.5) * sw / dw);
            const s = (syy * src.w + sxx) * 4, d = (ty * dst.w + tx) * 4;
            if (sxx < 0 || syy < 0 || sxx >= src.w || syy >= src.h) continue;
            dst.px[d] = src.px[s]; dst.px[d + 1] = src.px[s + 1]; dst.px[d + 2] = src.px[s + 2]; dst.px[d + 3] = OPAQUE;
        }
    }
}

// 5x7 font, printable ASCII 0x20-0x7E, five column bytes per glyph (bit 0 = top row)
const FONT_FIRST = 0x20;
const FONT_W = 5, FONT_H = 7, FONT_ADVANCE = 6;
const FONT = Buffer.from(
    '0000000000' + '00005f0000' + '0007000700' + '147f147f14' + '242a7f2a12' + '2313086462' + '3649552250' + '0005030000' +
    '001c224100' + '0041221c00' + '082a1c2a08' + '08083e0808' + '0050300000' + '0808080808' + '0060600000' + '2010080402' +
    '3e5149453e' + '00427f4000' + '4261514946' + '2141454b31' + '1814127f10' + '2745454539' + '3c4a494930' + '0171090503' +
    '3649494936' + '064949291e' + '0036360000' + '0056360000' + '0814224100' + '1414141414' + '0041221408' + '0201510906' +
    '324979413e' + '7e1111117e' + '7f49494936' + '3e41414122' + '7f4141221c' + '7f49494941' + '7f09090901' + '3e4149497a' +
    '7f0808087f' + '00417f4100' + '2040413f01' + '7f08142241' + '7f40404040' + '7f020c027f' + '7f0408107f' + '3e4141413e' +
    '7f09090906' + '3e4151215e' + '7f09192946' + '4649494931' + '01017f0101' + '3f4040403f' + '1f2040201f' + '3f4038403f' +
    '6314081463' + '0708700807' + '6151494543' + '007f414100' + '0204081020' + '0041417f00' + '0402010204' + '4040404040' +
    '0001020400' + '2054545478' + '7f48444438' + '3844444420' + '384444487f' + '3854545418' + '087e090102' + '0c5252523e' +
    '7f08040478' + '00447d4000' + '2040443d00' + '7f10284400' + '00417f4000' + '7c04180478' + '7c08040478' + '3844444438' +
    '7c14141408' + '081414187c' + '7c08040408' + '4854545420' + '043f444020' + '3c4040207c' + '1c2040201c' + '3c4030403c' +
    '4428102844' + '0c5050503c' + '4464544c44' + '0008364100' + '00007f0000' + '0041360800' + '0201020402', 'hex');

function text(img, x, y, s, rgb = [255, 255, 255]) {
    for (const chr of s) {
        let c = chr.charCodeAt(0) - FONT_FIRST;
        if (c < 0 || c * FONT_W >= FONT.length) c = '?'.charCodeAt(0) - FONT_FIRST;
        for (let col = 0; col < FONT_W; col++) {
            const bits = FONT[c * FONT_W + col];
            for (let row = 0; row < FONT_H; row++) {
                if (!(bits >> row & 1)) continue;
                const px = x + col, py = y + row;
                if (px < 0 || py < 0 || px >= img.w || py >= img.h) continue;
                const d = (py * img.w + px) * 4;
                img.px[d] = rgb[0]; img.px[d + 1] = rgb[1]; img.px[d + 2] = rgb[2]; img.px[d + 3] = OPAQUE;
            }
        }
        x += FONT_ADVANCE;
    }
}

module.exports = { image, decode, encode, read, write, blit, text, FONT_H };
