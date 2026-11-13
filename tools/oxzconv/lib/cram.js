// Palettes: 6-bit VGA (original) -> TS-Config CRAM words and 8 bit (preview).
// CRAM: 0RRRRRGG GGGBBBBB, 5 bits per channel: round(v6 * 31 / 63). The rescale for the
// stock ZX-Evo PWM DAC (levels 0..24) is done by the engine at load time (02 §4).
'use strict';
const to5 = v6 => Math.round((v6 & 63) * 31 / 63);   // positive: same as MidpointRounding.AwayFromZero

function pal6ToCram(pal6) {
	const o = Buffer.alloc(512);
	for (let i = 0; i < 256 && i * 3 + 2 < pal6.length; i++) {
		const w = to5(pal6[i * 3]) << 10 | to5(pal6[i * 3 + 1]) << 5 | to5(pal6[i * 3 + 2]);
		o[i * 2] = w & 0xFF; o[i * 2 + 1] = w >> 8;
	}
	return o;
}

function pal6To8(pal6) {
	const o = Buffer.alloc(768);
	for (let i = 0; i < 768 && i < pal6.length; i++) o[i] = Math.round((pal6[i] & 63) * 255 / 63);
	return o;
}

function pal8To6(pal8) {
	const o = Buffer.alloc(768);
	for (let i = 0; i < 768 && i < pal8.length; i++) o[i] = pal8[i] >> 2;
	return o;
}

module.exports = { pal6ToCram, pal6To8, pal8To6 };
