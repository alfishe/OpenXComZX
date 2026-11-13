// String helpers with .NET semantics the converter output depends on.
'use strict';
// ToUpperInvariant: per UTF-16 unit, never changes the length (JS 'ß'.toUpperCase() is "SS")
function upInv(s) {
	let r = '';
	for (const ch of s) { const u = ch.toUpperCase(); r += u.length === ch.length ? u : ch; }
	return r;
}
function lowInv(s) {
	let r = '';
	for (const ch of s) { const u = ch.toLowerCase(); r += u.length === ch.length ? u : ch; }
	return r;
}
// string.CompareOrdinal as a sort comparator (UTF-16 code units, like Array.prototype.sort)
const ordinal = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// "X4"-style hex
const hex = (v, w) => (v >>> 0).toString(16).toUpperCase().padStart(w, '0');
// C# "0.0"-style fixed format (report text only)
const fixed = (v, d) => v.toFixed(d);

module.exports = { upInv, lowInv, ordinal, hex, fixed };
