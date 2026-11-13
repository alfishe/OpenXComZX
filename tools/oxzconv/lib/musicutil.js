// Number helpers with .NET semantics for the music converters.
'use strict';
// Math.Round(x) default (MidpointRounding.ToEven)
function roundEven(x) {
	const f = Math.floor(x), d = x - f;
	if (d > 0.5) return f + 1;
	if (d < 0.5) return f;
	return f % 2 === 0 ? f : f + 1;
}
// Integer division truncating toward zero, exact for |a|, |b| < 2^53 (C# long / long)
function idiv(a, b) {
	const neg = (a < 0) !== (b < 0);
	const x = Math.abs(a), y = Math.abs(b);
	let q = Math.floor(x / y);
	while (q * y > x) q--;                 // x / y in doubles can round up across an integer
	while ((q + 1) * y <= x) q++;
	return neg ? -q : q;
}
// Pack writer stream framing shared by the OPL3, AY and FM streams: n0 pairs of bank 0, n1
// pairs of bank 1 per record; idle frames as #81..#FE.
const MAX_N0 = 127, MAX_N1 = 255, MAX_IDLE = 126, IDLE_BASE = 0x80, END = 0xFF;
function pushPairs(o, b0, b1) {
	const n0 = b0.length / 2, n1 = b1.length / 2;
	for (let i = 0, j = 0; i < n0 || j < n1;) {
		const k0 = Math.min(MAX_N0, n0 - i), k1 = Math.min(MAX_N1, n1 - j);
		o.push(k0); for (let x = i * 2; x < (i + k0) * 2; x++) o.push(b0[x]);
		o.push(k1); for (let x = j * 2; x < (j + k1) * 2; x++) o.push(b1[x]);
		i += k0; j += k1;
	}
}
function flushIdle(o, idle) { while (idle > 0) { const k = Math.min(idle, MAX_IDLE); o.push(IDLE_BASE + k); idle -= k; } return 0; }
// 12-byte stream header: u32 loop offset (#FFFFFFFF — none), u32 frames, u16 a, u16 b
const NO_LOOP = 0xFFFFFFFF, HDR_SIZE = 12;
function header(loopOffset, frames, a, b) {
	const h = Buffer.alloc(HDR_SIZE);
	h.writeUInt32LE(loopOffset >= 0 ? loopOffset : NO_LOOP, 0);
	h.writeInt32LE(frames, 4);
	h[8] = a & 0xFF; h[9] = (a >> 8) & 0xFF; h[10] = b & 0xFF; h[11] = (b >> 8) & 0xFF;
	return h;
}

module.exports = { roundEven, idiv, pushPairs, flushIdle, header, END, MAX_N0 };
