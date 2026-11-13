// Music for chips without FM: the same track mixed from the twelve player voices down to three
// AY-3-8910 channels. The stream is per frame and in the same format as OPL3 (20 §4), so the
// interrupt player stays the same — only the port output routine differs.
//
// Mixing chooses which of twelve voices are heard, so it is done ahead of time. The channel
// volume comes from the computed note envelope (musicenv.js), not from velocity (22 §10.5).
// The lowest bass goes up an octave: below ~60 Hz an AY square wave is crackle, not a note.
'use strict';
const { FRAME_HZ, VOICES } = require('./music');
const { MusicEnv, SILENCE } = require('./musicenv');
const { roundEven, idiv, flushIdle, header, END, MAX_N0 } = require('./musicutil');

const CLOCK = 1774400;            // AY clock on TS-Config (02 §7)
const CHANS = 3;
// The AY scale is half as long as OPL's: compress the dynamics, or medium notes drop to -24 dB
const COMPRESS = 0.7;
const HYST = 4.0;                 // head start of a voice already on a channel, dB
const CHORUS = 18.0;              // penalty of a chorus double: taken only if nobody else
// Drums (GM channel 9, MIDI source only) play as AY noise with a large penalty: noise takes a
// channel only when the melody does not need it (22 §11.4).
const DRUM_PENALTY = 12.0;
const BASS_HZ100 = 6000;          // below — raised an octave
// Channel volume change speed, steps per frame (step 3 dB): no click on note entry
const RAMP_UP = 5, RAMP_DOWN = 4;
const NOTE_DIP = 3;               // channel dip on the frame of a note change
const UNISON = 0.03;              // relative frequency difference treated as unison
const RANGE_DB = 45.0, STEP_DB = 3.0, MAX_STEP = 15, MAX_PERIOD = 4095;
const VEL_MAX = 127, TL_DB = 0.75;
const AY_REGS = 16, R_NOISE = 6, R_MIXER = 7, R_VOL = 8, MIXER_OFF = 0x3F, NOISE_MASK = 0x1F;

class Slot { constructor() { this.voice = -1; this.vol = 0; this.period = 0; this.noise = 0; } }

// What a channel really plays: the bass goes up an octave
function play(hz100) {
	while (hz100 > 0 && hz100 < BASS_HZ100) hz100 *= 2;
	return hz100;
}

// Player voice with its own envelope: velocity is kept at key-on, then the volume follows the
// patch envelope, and after note-off the voice still plays its release.
class Voice {
	constructor() {
		this.env = new MusicEnv();
		this.patch = -1; this.trig = -1; this.freq = 0;
		this.vel = 0;                 // attenuation from velocity, dB
		this.chorus = false; this.drum = false; this.noise = 0;
		this.att = SILENCE;
	}
}

const isUnison = (a, b) => Math.abs(play(a) / play(b) - 1) < UNISON;

// Mixes voice frames into a stream of AY register writes.
// voices[f] — state of the 12 player voices per frame (music.VoiceFrame).
function encode(voices, patches, loop) {
	const slots = Array.from({ length: CHANS }, () => new Slot());
	const vs = Array.from({ length: VOICES }, () => new Voice());
	const last = new Array(AY_REGS).fill(-1);
	const o = [];
	let idle = 0, maxw = 0, loopOffset = -1;
	let cur = [];

	const reg = (r, v) => {
		if (last[r] === v) return;
		last[r] = v;
		cur.push(r & 0xFF, v & 0xFF);
	};

	for (let f = 0; f < voices.length; f++) {
		// Loop as in the OPL3 stream (22 §2.3): frame 0 sets the chip up, the track body starts
		// at frame 1, where the player returns. At the loop point the register state is
		// forgotten, so frame 1 writes everything needed (22 §10.11).
		if (f === 1 && loop) {
			idle = flushIdle(o, idle); loopOffset = o.length;
			for (let r0 = 0; r0 < AY_REGS; r0++) last[r0] = -1;
			// Volumes count as zero already: frame 1 does not write zeros, and at the loop seam
			// the closing notes play out instead of being cut (as in the OPL3 stream)
			last[R_VOL] = last[R_VOL + 1] = last[R_VOL + 2] = 0;
			last[R_MIXER] = MIXER_OFF;   // and the mixer, or frame 1 turns the tones off
		}
		const vf = voices[f];

		// Envelopes: a new note restarts, a released one goes to release; one step per frame
		for (let i = 0; i < VOICES; i++) {
			const v = vs[i];
			const pi = vf.patch[i];
			if (vf.key[i]) {
				if (pi >= 0 && pi < patches.length && (pi !== v.patch || vf.trig[i] !== v.trig)) {
					v.env.setPatch(patches[pi], FRAME_HZ);
					v.env.keyOn();
					v.patch = pi; v.trig = vf.trig[i];
					const vel = vf.vol[i] > VEL_MAX ? VEL_MAX : vf.vol[i];
					v.vel = (63 - ((127 * vel) >> 8)) * TL_DB;   // velocity -> carrier TL, 0.75 dB
					v.chorus = vf.chorus[i];
					v.drum = vf.drum[i]; v.noise = vf.noise[i];
				}
				v.freq = vf.freq[i];
			} else if (v.trig >= 0) { v.env.keyOff(); v.trig = -1; }
			v.att = v.env.step() + v.vel;
			if (vf.freq[i] > 0) v.freq = vf.freq[i];
		}

		// Who is heard: the three loudest by envelope, with a head start for voices already on
		// a channel, so two almost equal voices do not swap channels every frame.
		const eff = i => vs[i].att - (slots.some(x => x.voice === i) ? HYST : 0)
			+ (vs[i].chorus ? CHORUS : 0) + (vs[i].drum ? DRUM_PENALTY : 0);
		const sounds = k => vs[k].att < SILENCE && (vs[k].freq > 0 || vs[k].noise > 0);
		const cand = [];
		for (let i = 0; i < VOICES; i++) if (sounds(i)) cand.push({ i, e: eff(i) });
		cand.sort((a, b) => (a.e < b.e ? -1 : a.e > b.e ? 1 : 0));   // stable, like OrderBy
		const order = [];
		for (const { i } of cand) {
			if (vs[i].noise > 0) { order.push(i); if (order.length === CHANS) break; continue; }
			// No unison: two tones a percent apart beat, and steal a channel from a real
			// second note. Compare raised frequencies: after raising, bass and its octave merge.
			if (order.some(j => vs[j].noise === 0 && isUnison(vs[j].freq, vs[i].freq))) continue;
			order.push(i);
			if (order.length === CHANS) break;
		}
		// The melody is a must: by loudness alone the channels got almost only bass, so the
		// highest audible voice takes the place of the quietest.
		let hi = -1;
		for (let i = 0; i < VOICES; i++)
			if (vs[i].att < SILENCE && vs[i].freq > 0 && !vs[i].chorus && !vs[i].drum &&
				(hi < 0 || vs[i].freq > vs[hi].freq)) hi = i;
		if (hi >= 0 && order.length === CHANS && !order.includes(hi) &&
			!order.some(j => vs[j].noise === 0 && isUnison(vs[j].freq, vs[hi].freq)))
			order[CHANS - 1] = hi;
		const taken = new Array(VOICES).fill(false);
		for (const s of slots) {
			if (s.voice >= 0 && order.includes(s.voice)) { taken[s.voice] = true; continue; }
			s.voice = -1;
		}
		for (const s of slots) {
			if (s.voice >= 0) continue;
			let pick = -1;
			for (const i of order) if (!taken[i]) { pick = i; break; }
			if (pick < 0) continue;
			s.voice = pick; taken[pick] = true;
		}
		cur = [];
		let mixer = MIXER_OFF;                  // everything off, enable below
		for (let c = 0; c < CHANS; c++) {
			const s = slots[c];
			// AY has only 15 steps of 3 dB — 45 dB of range per channel
			let step = s.voice < 0 ? 0 : roundEven((RANGE_DB - vs[s.voice].att * COMPRESS) / STEP_DB);
			if (step > MAX_STEP) step = MAX_STEP;
			if (s.voice < 0 || step < 1) {
				s.vol = s.vol > RAMP_DOWN ? s.vol - RAMP_DOWN : 0;   // fade, not cut
				reg(R_VOL + c, s.vol);
				// The source is switched off only once the volume reaches zero
				if (s.vol > 0) mixer &= ~(s.noise > 0 ? 8 << c : 1 << c);
				continue;
			}
			if (vs[s.voice].noise > 0) {
				// Drum voice: noise instead of tone. One noise period per chip — with two hits in
				// a frame the last one wins, which is rare.
				reg(R_NOISE, vs[s.voice].noise & NOISE_MASK);
				mixer &= ~(8 << c);
				s.noise = vs[s.voice].noise; s.period = 0;
				if (step < 1) step = 1;
				if (step > s.vol + RAMP_UP) step = s.vol + RAMP_UP;
				else if (step < s.vol - RAMP_DOWN) step = s.vol - RAMP_DOWN;
				s.vol = step;
				reg(R_VOL + c, step);
				continue;
			}
			s.noise = 0;
			mixer &= ~(1 << c);
			const hz100 = play(vs[s.voice].freq);
			let period = hz100 > 0 ? idiv(100 * CLOCK, 16 * hz100) : 0;
			if (period < 1) period = 1;
			if (period > MAX_PERIOD) period = MAX_PERIOD;
			// A tone change at full volume clicks: dip the channel on the note change frame
			if (s.period > 0 && Math.abs(period / s.period - 1) > UNISON) step -= NOTE_DIP;
			s.period = period;
			reg(c * 2, period & 0xFF);
			reg(c * 2 + 1, period >> 8);
			if (step < 1) step = 1;
			if (step > s.vol + RAMP_UP) step = s.vol + RAMP_UP;
			else if (step < s.vol - RAMP_DOWN) step = s.vol - RAMP_DOWN;
			s.vol = step;
			reg(R_VOL + c, step);
		}
		reg(R_MIXER, mixer);                    // tones and noise by mask (1 — off)
		const n = cur.length / 2;
		maxw = Math.max(maxw, n);
		if (n === 0) { idle++; continue; }
		idle = flushIdle(o, idle);
		for (let i = 0; i < n;) {
			const k = Math.min(MAX_N0, n - i);
			o.push(k); for (let x = i * 2; x < (i + k) * 2; x++) o.push(cur[x]);
			o.push(0);                          // second bank unused
			i += k;
		}
	}
	idle = flushIdle(o, idle);
	o.push(END);
	return { data: Buffer.concat([header(loopOffset, voices.length, maxw, 0), Buffer.from(o)]), maxWrites: maxw, loopOffset };
}

module.exports = { encode, CLOCK };
