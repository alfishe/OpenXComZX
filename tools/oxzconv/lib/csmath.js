// .NET numeric semantics the converter output depends on.
'use strict';

// Math.Round(x) — MidpointRounding.ToEven (the .NET default)
function roundEven(x) {
	const f = Math.floor(x), d = x - f;
	if (d < 0.5) return f;
	if (d > 0.5) return f + 1;
	return f % 2 === 0 ? f : f + 1;
}

// Math.Round(x, MidpointRounding.AwayFromZero)
function roundAway(x) {
	const f = Math.floor(x), d = x - f;
	if (d < 0.5) return f;
	if (d > 0.5) return f + 1;
	return x >= 0 ? f + 1 : f;
}

// Little-endian bytes of an integer value (two's complement for negatives), n bytes
const TWO32 = 4294967296;
function leBytes(v, n) {
	const out = [];
	let u = v < 0 ? (v % TWO32 + TWO32) % TWO32 : v % TWO32;   // values here fit in 32 bits
	for (let i = 0; i < n; i++) { out.push(u % 256); u = Math.floor(u / 256); }
	return out;
}

module.exports = { roundEven, roundAway, leBytes };
