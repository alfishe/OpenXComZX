// Strings: OpenXcom YAML (common + xcom1/xcom2) -> single-byte table STR.
//
// Byte encoding: #01 {ALT}, #02 {SMALLLINE}, #03 {N}, #04 no-break space, #0A {NEWLINE},
// #10..#19 {0}..{9}, #20..#7E ASCII, #80..#FF other characters (code table CHARSET).
// Numbers: engine keys (data/engine_strings.txt), then the other game keys in ordinal order.
// Plurals — "STR_X_one", "STR_X_other" (like Language::getString(id, n) in OpenXcom; the
// engine picks the form with str_n). A string never crosses a 16 KB boundary (the engine reads
// it whole through Win3).
'use strict';
const Y = require('./yaml');
const { Registry } = require('./resids');
const { ordinal } = require('./text');

const PAGE = 16384;
const ASCII_FIRST = 0x20, ASCII_LAST = 0x7E, NBSP = 0xA0, CODE_NBSP = 0x04;
const EXTRA_BASE = 0x80, EXTRA_MAX = 128;
const CODE_ALT = 0x01, CODE_SMALLLINE = 0x02, CODE_N = 0x03, CODE_NEWLINE = 0x0A, CODE_ARG0 = 0x10;
const NO_STRING = 0xFFFFFF;
const OFFSET_BYTES = 3;

class Charset {
	constructor() { this.extra = []; this.map = new Map(); }

	code(cp) {
		if (cp >= ASCII_FIRST && cp <= ASCII_LAST) return cp;
		if (cp === NBSP) return CODE_NBSP;
		let c = this.map.get(cp);
		if (c === undefined) {
			if (this.extra.length >= EXTRA_MAX) throw new Error('charset overflow (more than 128 non-ASCII chars)');
			c = EXTRA_BASE + this.extra.length;
			this.map.set(cp, c);
			this.extra.push(cp);
		}
		return c;
	}

	// All printable characters by code: {code, cp}
	glyphs() {
		const g = [];
		for (let c = ASCII_FIRST; c <= ASCII_LAST; c++) g.push({ code: c, cp: c });
		this.extra.forEach((cp, i) => g.push({ code: EXTRA_BASE + i, cp }));
		return g;
	}
}

// Merge: common strings, then the game strings (override)
function load(ox, gameFolder, lang) {
	const o = new Map();
	const add = doc => {
		const m = Y.map(Y.get(doc, lang));
		if (m === null) return;
		for (const [key, val] of m) {
			const k = Y.str(key);
			if (val instanceof Map) for (const [fk, fv] of val) o.set(k + '_' + Y.str(fk), Y.jsString(fv));
			else o.set(k, Y.jsString(val));
		}
	};
	add(Y.load(ox.readText(`common/Language/${lang}.yml`)));
	add(Y.load(ox.readText(`standard/${gameFolder}/Language/${lang}.yml`)));
	return o;
}

const isHigh = c => c >= 0xD800 && c <= 0xDBFF;
const isLow = c => c >= 0xDC00 && c <= 0xDFFF;
// .NET Regex ^\{(N|\d)\}: \d is any Unicode decimal digit in one UTF-16 unit
const ARG_RE = /^\{(N|\p{Nd})\}/u;

function encode(text, cs) {
	const o = [];
	const s = text.split('{NEWLINE}').join('\n').split('{SMALLLINE}').join('\x02').split('{ALT}').join('\x01');
	for (let i = 0; i < s.length; i++) {
		const ch = s.charCodeAt(i);
		if (ch === 0x7B /* { */) {
			const m = ARG_RE.exec(s.slice(i));
			if (m && m[1].length === 1) {
				o.push((m[1] === 'N' ? CODE_N : CODE_ARG0 + (m[1].charCodeAt(0) - 0x30)) & 0xFF);
				i += m[0].length - 1;
				continue;
			}
		}
		if (ch === 0x0A) o.push(CODE_NEWLINE);
		else if (ch === CODE_ALT || ch === CODE_SMALLLINE) o.push(ch);
		else if (ch === 0x0D) continue;
		else {
			let cp = ch;
			if (isHigh(ch) && i + 1 < s.length && isLow(s.charCodeAt(i + 1))) { cp = s.codePointAt(i); i++; }
			o.push(cs.code(cp) & 0xFF);
		}
	}
	o.push(0);
	return Buffer.from(o);
}

// STR: u16 n, 3-byte offsets[n] from the end of the offset table (#FFFFFF — none), strings with 0
function build(strings, cs) {
	const keys = Registry.load('engine_strings.txt');
	const known = new Set(keys);
	const extra = [...strings.keys()].filter(k => !known.has(k)).sort(ordinal);
	const all = keys.concat(extra);
	const n = all.length, hdrLen = 2 + OFFSET_BYTES * n;
	const body = [];
	const offs = new Array(n);
	let pos = hdrLen;
	for (let i = 0; i < n; i++) {
		if (!strings.has(all[i])) { offs[i] = NO_STRING; continue; }
		const b = encode(strings.get(all[i]), cs);
		if (b.length > PAGE) throw new Error('string too long: ' + all[i]);
		if (Math.trunc(pos / PAGE) !== Math.trunc((pos + b.length - 1) / PAGE)) {
			const pad = PAGE - pos % PAGE;
			body.push(Buffer.alloc(pad));
			pos += pad;
		}
		offs[i] = pos - hdrLen;
		body.push(b);
		pos += b.length;
	}
	const head = Buffer.alloc(hdrLen);
	head.writeUInt16LE(n & 0xFFFF, 0);
	for (let i = 0; i < n; i++) { head[2 + i * 3] = offs[i] & 0xFF; head[3 + i * 3] = (offs[i] >> 8) & 0xFF; head[4 + i * 3] = (offs[i] >> 16) & 0xFF; }
	const index = new Map();
	all.forEach((k, i) => index.set(k, i));
	return { data: Buffer.concat([head, ...body]), count: n, engineCount: keys.length, index, missing: keys.filter(k => !strings.has(k)) };
}

module.exports = { Charset, load, encode, build };
