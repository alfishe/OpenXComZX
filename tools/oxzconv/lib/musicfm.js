// Music for "2 x YM2203" mode (11_sound.md, option 4): the same track mixed from twelve ADLIB
// player FM voices down to six FM channels of two YM2203. The SSG parts stay for effects.
//
// The stream is per frame, same format as OPL3 (22 §2): "bank 0" — writes to chip 0, "bank 1"
// — to chip 1 (mus_out_ym in src/kernel/win0/music_s.s).
//
// Timbre transfer. An ADLIB patch is two OPL2 operators, OPN has four. Algorithm 4 (two
// parallel pairs S1->S2 and S3->S4) using only the first pair: S1 — modulator (with feedback,
// as in OPL), S2 — carrier; S3/S4 never get key-on. An additive patch (connection = 1) uses
// algorithm 7 so S1+S2 sound together. YM2203 lacks KSL, waveforms and LFO — dropped. The OPL
// percussive mode (EGT = 0) maps to the OPN second decay: SR = RR, sustained (EGT = 1) SR = 0.
'use strict';
const { VOICES } = require('./music');
const { idiv, pushPairs, flushIdle, header, END } = require('./musicutil');

// FM clock on TurboSound FM — twice the SSG one (02 §7)
const CLOCK = 3548800;
const CHIPS = 2, CHANS = 6, CHANS_PER_CHIP = 3, REGS = 256;
const MAX_FNUM = 2047, BLOCKS = 8;
const CHORUS_PENALTY = 48, DRUM_PENALTY = 32;
const UNISON = 0.03, VEL_MAX = 127, TL_MAX = 127;
const REL_AGE_INIT = 9999;
const R_TIMERS = 0x27, R_KEY = 0x28, KEY_ON_OPS = 0x30;

// RelAge — frames a channel has been silent after key-off. A new note goes to the channel
// silent the longest: a released OPL note still plays its release.
class Slot { constructor() { this.voice = -1; this.trig = -1; this.patch = -1; this.relAge = REL_AGE_INIT; this.on = false; } }

// OPN F-number: f = fnum * clock * 2^(block-1) / (72 * 2^20) (emul_2203.cpp:1446)
function fnum(hz100) {
	if (hz100 <= 0) return { fnum: 0, block: 0 };
	for (let block = 0; block < BLOCKS; block++) {
		const fn = idiv(hz100 * 72 * 2 ** 21, CLOCK * 100 * 2 ** block);
		if (fn <= MAX_FNUM) return { fnum: fn < 1 ? 1 : fn, block };
	}
	return { fnum: MAX_FNUM, block: BLOCKS - 1 };
}

const rate = r4 => (r4 >= 15 ? 31 : r4 * 2);      // 4-bit OPL -> 5-bit OPN

function encode(voices, patches, loop) {
	const slots = Array.from({ length: CHANS }, () => new Slot());
	const last = [new Array(REGS).fill(-1), new Array(REGS).fill(-1)];
	let cur = [[], []];
	const o = [];
	let idle = 0, maxw = 0, loopOffset = -1;

	const reg = (chip, rg, val) => {
		if (last[chip][rg] === val) return;
		last[chip][rg] = val;
		cur[chip].push(rg & 0xFF, val & 0xFF);
	};
	// key on/off (#28) and the frequency are not deduplicated: #28 is an event, and the high
	// frequency byte (#A4) is a single latch applied on the #A0 write — write both or none.
	const keyOn = (chip, ch, on) => { cur[chip].push(R_KEY, on ? KEY_ON_OPS | ch : ch); };
	const freq = (chip, ch, hz100) => {
		const { fnum: fn, block: bl } = fnum(hz100);
		const hi = (bl << 3) | (fn >> 8), lo = fn & 0xFF;
		if (last[chip][0xA4 + ch] === hi && last[chip][0xA0 + ch] === lo) return;
		last[chip][0xA4 + ch] = hi; last[chip][0xA0 + ch] = lo;
		cur[chip].push(0xA4 + ch, hi & 0xFF, 0xA0 + ch, lo);
	};
	// OPL operator (patch bytes) -> four OPN registers. off: 0 — S1, 8 — S2
	// (OPN register order is S1, S3, S2, S4 with step 4).
	const oper = (chip, ch, off, ctl, adsr, slrr, tl) => {
		reg(chip, 0x30 + off + ch, ctl & 0x0F);                      // DT = 0, MULT as in OPL
		// TL one to one: the step is 0.75 dB on both OPL2 and OPN
		reg(chip, 0x40 + off + ch, tl > TL_MAX ? TL_MAX : tl);
		reg(chip, 0x50 + off + ch, ((ctl & 0x10) !== 0 ? 0x80 : 0) | rate(adsr >> 4));
		reg(chip, 0x60 + off + ch, rate(adsr & 0x0F));               // no AM (no LFO)
		reg(chip, 0x70 + off + ch, (ctl & 0x20) !== 0 ? 0 : rate(slrr & 0x0F));
		reg(chip, 0x80 + off + ch, slrr);                            // SL and RR mean the same
		reg(chip, 0x90 + off + ch, 0);                               // SSG-EG off
	};

	const flushFrame = () => {
		const n0 = cur[0].length / 2, n1 = cur[1].length / 2;
		maxw = Math.max(maxw, n0 + n1);
		if (n0 === 0 && n1 === 0) { idle++; return; }
		idle = flushIdle(o, idle);
		pushPairs(o, cur[0], cur[1]);
	};

	for (let f = 0; f < voices.length; f++) {
		// As with OPL3 (22 §2.3): frame 0 sets the chips up, the body starts at frame 1, where
		// the player returns; at the loop point the register state is forgotten (22 §10.11).
		if (f === 1 && loop) { idle = flushIdle(o, idle); loopOffset = o.length; for (let chip = 0; chip < CHIPS; chip++) last[chip].fill(-1); }
		cur = [[], []];
		if (f === 0)
			for (let chip = 0; chip < CHIPS; chip++) {
				reg(chip, R_TIMERS, 0x00);                           // timers and special mode off
				for (let ch = 0; ch < CHANS_PER_CHIP; ch++) keyOn(chip, ch, false);
			}

		const v = voices[f];
		// Chorus doubles last, no unison at all; MIDI drums last and only tonal ones (no noise
		// on YM2203: hat and snare come with zero frequency and drop out) (22 §10.6, §11.4).
		const cand = [];
		for (let k = 0; k < VOICES; k++)
			if (v.vol[k] > 0 && v.freq[k] > 0 && v.patch[k] >= 0)
				cand.push({ k, e: v.vol[k] - (v.chorus[k] ? CHORUS_PENALTY : 0) - (v.drum[k] ? DRUM_PENALTY : 0) });
		cand.sort((a, b) => b.e - a.e);   // stable, like OrderByDescending
		const order = [];
		for (const { k: i } of cand) {
			if (order.some(j => Math.abs(v.freq[j] / v.freq[i] - 1) < UNISON)) continue;
			order.push(i);
			if (order.length === CHANS) break;
		}
		const taken = new Array(VOICES).fill(false);
		for (const s of slots) {
			if (s.voice >= 0 && order.includes(s.voice)) { taken[s.voice] = true; continue; }
			s.voice = -1;
		}
		for (const s of slots) if (s.voice < 0) s.relAge++;
		const free = slots.filter(x => x.voice < 0).sort((a, b) => b.relAge - a.relAge);
		for (const s of free) {
			let pick = -1;
			for (const i of order) if (!taken[i]) { pick = i; break; }
			if (pick < 0) continue;
			s.voice = pick; taken[pick] = true;
		}

		for (let c = 0; c < CHANS; c++) {
			const s = slots[c];
			const chip = Math.trunc(c / CHANS_PER_CHIP), ch = c % CHANS_PER_CHIP;
			if (s.voice < 0) {
				if (s.on) { keyOn(chip, ch, false); s.on = false; s.trig = -1; s.relAge = 0; }
				continue;
			}
			const i = s.voice, pi = v.patch[i];
			const pt = pi < patches.length ? patches[pi] : null;
			if (pt === null) continue;
			const fresh = !s.on || s.trig !== v.trig[i] || s.patch !== pi;
			const con = (pt[10] ^ 0x01) & 1, fb = (pt[10] ^ 0x01) >> 1 & 7;
			const tlCar = 63 - ((127 * (v.vol[i] > VEL_MAX ? VEL_MAX : v.vol[i])) >> 8);
			if (s.patch !== pi) {
				reg(chip, 0xB0 + ch, (fb << 3) | (con !== 0 ? 7 : 4));
				oper(chip, ch, 0, pt[0], pt[4], pt[6], (~pt[2]) & 0x3F);   // S1 — modulator
				s.patch = pi;
			}
			oper(chip, ch, 8, pt[1], pt[5], pt[7], tlCar);                 // S2 — carrier
			freq(chip, ch, v.freq[i]);
			if (fresh) {
				if (s.on) keyOn(chip, ch, false);
				keyOn(chip, ch, true);
				s.on = true; s.trig = v.trig[i];
			}
		}
		flushFrame();
	}
	idle = flushIdle(o, idle);
	o.push(END);
	return { data: Buffer.concat([header(loopOffset, voices.length, maxw, 0), Buffer.from(o)]), maxWrites: maxw, loopOffset };
}

module.exports = { encode, fnum, CLOCK };
