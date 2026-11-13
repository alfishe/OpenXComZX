// OPL2 note envelope computed offline (22 §10.5).
//
// Why. An AY channel volume is one number that holds until changed: the chip fades nothing by
// itself (the AY envelope is shared by all channels and useless for music). Taking the volume
// straight from the player velocity gives a flat shelf until note-off — no dynamics. On OPL the
// note volume follows the carrier envelope (AR/DR/SL/RR of the ADLIB patch), and that is what
// tells an organ from a pluck.
//
// What is computed. Carrier attenuation in dB per frame (48.83 Hz): attack from silence to zero,
// decay to the sustain level, hold (EGT = 1) or further decay (EGT = 0 — percussive patch), and
// after note-off a release with RR. Times follow the YM3812 description (96 dB decay at rate 1
// takes tens of seconds, each rate step is twice as fast) and are tuned by ear.
'use strict';

const SILENCE = 96.0;            // dB of attenuation, nothing audible beyond
// Tuned by ear (2026-09-19): AY has three channels, and long tails of released notes keep them
// busy longer than needed, while the sustain level sits too close to the attack.
const RELEASE_FAST = 2.0;        // a released note fades this many times faster
const SUSTAIN_DROP = 4.0;        // the held note sits this many dB lower
const SL_STEP_DB = 3.0;          // one sustain level step
const MIN_TIME = 1e-6;
const RATES = 16;

// Time of a 96 dB decay and of the attack for rates 1..15, seconds
function buildT(t1) {
	const t = new Array(RATES);
	t[0] = Infinity;                // rate 0 — the envelope stands still
	for (let r = 1; r < RATES; r++) t[r] = t1 / Math.pow(2, r - 1);
	return t;
}
const T_DECAY = buildT(60.0), T_ATTACK = buildT(6.0);

const Ph = { Off: 0, Attack: 1, Decay: 2, Sustain: 3, Release: 4 };

class MusicEnv {
	constructor() {
		this.ph = Ph.Off;
		this.att = SILENCE;              // current attenuation, dB
		this.ar = 0; this.dr = 0; this.sl = 0; this.rr = 0;   // dB per frame and sustain level
		this.hold = false;               // EGT: 1 — hold at the sustain level
	}

	// ADLIB patch (24 bytes): carrier — bytes 1 (AM/VIB/EGT/KSR/MULT), 5 (AR/DR), 7 (SL/RR)
	setPatch(p, frameHz) {
		this.hold = (p[1] & 0x20) !== 0;
		this.ar = SILENCE / Math.max(T_ATTACK[p[5] >> 4], MIN_TIME) / frameHz;
		this.dr = SILENCE / Math.max(T_DECAY[p[5] & 0x0F], MIN_TIME) / frameHz;
		this.rr = SILENCE / Math.max(T_DECAY[p[7] & 0x0F], MIN_TIME) / frameHz * RELEASE_FAST;
		this.sl = (p[7] >> 4) * SL_STEP_DB + SUSTAIN_DROP;
	}

	keyOn() { this.ph = Ph.Attack; }
	keyOff() { if (this.ph !== Ph.Off) this.ph = Ph.Release; }

	// One frame step; returns the attenuation in dB (0 — full volume)
	step() {
		switch (this.ph) {
		case Ph.Attack:
			this.att -= this.ar;
			if (this.att <= 0) { this.att = 0; this.ph = Ph.Decay; }
			break;
		case Ph.Decay:
			this.att += this.dr;
			if (this.att >= this.sl) { this.att = this.sl; this.ph = this.hold ? Ph.Sustain : Ph.Release; }
			break;
		case Ph.Sustain:
			break;
		case Ph.Release:
			this.att += this.rr;
			if (this.att >= SILENCE) { this.att = SILENCE; this.ph = Ph.Off; }
			break;
		}
		return this.att;
	}

	get off() { return this.ph === Ph.Off; }
}

module.exports = { MusicEnv, SILENCE };
