// Music from the original MIDI (SOUND/GM.CAT) — the second source for the AY and FM mixes,
// an alternative to running the ADLIB player (music.js). Enabled by --music midi.
//
// ADLIB.CAT holds the score already spread over 12 OPL2 voices with its own allocator, detune
// and OpenXcom "chorus"; GM.CAT has the same music as MIDI: explicit channels, notes, velocity,
// controller 7, sustain pedal and drums on channel 9.
//
// GM.CAT format. Same container as ADLIB.CAT (music.catEntries), an entry is:
//   u8 len, name[len] (zero-terminated)
//   u8 tempo (BPM), u8 number of subsequences
//   subsequences: u16 length (from itself), u16 0, data (starting with a delay)
//   u8 number of tracks
//   tracks: u8 MIDI channel, u16 length (from itself), u16 0, data (starting with a delay)
// Data is MIDI with running status: a VLQ delay before every event, the track status always
// has channel 0 (the real channel is the track header byte). Service opcodes in place of the
// status: #FE n — call subsequence n, #FD — return (the delay is read at the return point),
// #FF — end of track. Program change to 126 (C0 7E) — track loop mark, as in ADLIB
// (adlplayer.cpp:683). 24 ticks per quarter (checked against GMGEO1.MID etc., 22 §11.1).
//
// .MID parsing (SMF formats 0 and 1) uses the same code — it verified the CAT parser.
'use strict';
const Music = require('./music');
const { roundEven } = require('./musicutil');

const DRUM_CH = 9;               // GM drum channel (zero-based)
const VOICES = 12;               // as many voices as the ADLIB player
const BEND_RANGE = 2;            // semitones per full wheel (GM default)
const BEND_CENTER = 8192;
const KIND_LOOP = 0xF0, KIND_TEMPO = 0xF1;
const DEFAULT_PPQN = 24, DEFAULT_BPM = 120, MIN_BPM = 20, SMF_DEFAULT_PPQN = 96;
const US_PER_MIN = 60000000, MIN_US_PER_Q = 1000;
const GUARD = 1000000;
const MAX_SECONDS = 1200;
const PATCH_BYTES = 24, DRUM_PATCH_KEY = 0x1000;
const CC_VOLUME = 7, CC_EXPRESSION = 11, CC_SUSTAIN = 64, CC_ALL_SOUND_OFF = 120, CC_ALL_NOTES_OFF = 123;
const GM_VOLUME = 100, GM_EXPRESSION = 127, VOL_MAX = 127, LOOP_PROGRAM = 0x7E;
const REL_AGE_INIT = 99999;
const A4_HZ100 = 44000, A4_NOTE = 69, C4_HZ100 = 26163.0;
const PEAK_PERCENTILE = 0.99;

class Ev { constructor(o) { this.tick = 0; this.ch = 0; this.kind = 0; this.a = 0; this.b = 0; this.val = 0; Object.assign(this, o); } }

class Song {
	constructor() {
		this.name = ''; this.ppqn = DEFAULT_PPQN; this.bpm = DEFAULT_BPM;
		this.events = [];
		this.loopTick = -1;          // tick of the loop mark; -1 — the track plays once
		this.endTick = 0;
		this.notes = 0;
	}
}

// ------------------------------------------------------------------ GM.CAT parsing

// -> value; pos is a one-element array (C# ref int)
function vlq(d, pos) {
	let v = 0, c;
	do { c = pos[0] < d.length ? d[pos[0]] : 0; pos[0]++; v = (v << 7) | (c & 0x7F); } while ((c & 0x80) !== 0 && pos[0] < d.length);
	return v;
}

function parseCat(d) {
	const s = new Song();
	let p = d[0] + 1;
	s.name = d.toString('latin1', 1, p).replace(/^[\0 ]+|[\0 ]+$/g, '');
	s.ppqn = DEFAULT_PPQN;
	s.bpm = d[p++];
	if (s.bpm < MIN_BPM) s.bpm = DEFAULT_BPM;
	const nsub = d[p++];
	const subs = new Array(nsub);
	for (let i = 0; i < nsub; i++) {
		const add = d[p] | d[p + 1] << 8;
		subs[i] = p + 4;
		p += add;
		if (add === 0 || p > d.length) throw new Error('GM.CAT: broken subsequence');
	}
	const ntrk = d[p++];
	const starts = [], chans = [];
	for (let i = 0; i < ntrk; i++) {
		const ch = d[p++], add = d[p] | d[p + 1] << 8;
		chans.push(ch); starts.push(p + 4);
		p += add;
		if (add === 0 || p > d.length) throw new Error('GM.CAT: broken track');
	}
	for (let i = 0; i < starts.length; i++) catTrack(d, subs, chans[i], starts[i], s);
	finish(s);
	return s;
}

// One GM.CAT track: delay before an event, running status, #FE/#FD/#FF
function catTrack(d, subs, ch, start, s) {
	const pos = [start];
	let tick = 0, ret = -1, st = 0, guard = 0;
	tick += vlq(d, pos);
	while (pos[0] < d.length) {
		if (guard++ > GUARD) break;
		let op = d[pos[0]++];
		if (op === 0xFF) break;
		if (op === 0xFE) {
			const a = d[pos[0]++];
			ret = pos[0];
			if (a >= subs.length) break;
			pos[0] = subs[a];
		} else if (op === 0xFD) {
			if (ret < 0) break;
			pos[0] = ret; ret = -1;
		} else {
			if (op >= 0x80) { st = op; op = d[pos[0]++]; }
			const hi = st & 0xF0;
			const a = op, b = (hi === 0xC0 || hi === 0xD0) ? 0 : d[pos[0]++];
			add(s, tick, ch, hi, a, b);
		}
		tick += vlq(d, pos);
	}
	if (tick > s.endTick) s.endTick = tick;
}

function add(s, tick, ch, hi, a, b) {
	if (hi === 0xC0 && a === LOOP_PROGRAM) { if (s.loopTick < 0 || tick < s.loopTick) s.loopTick = tick; return; }
	if (hi === 0xB0 && a === 0 && b !== 0)                     // controller 0 — tempo (adlplayer.cpp:672)
	{ s.events.push(new Ev({ tick, kind: KIND_TEMPO, val: Math.trunc(US_PER_MIN / Math.max(1, b * 2)) })); return; }
	if (hi === 0x90 && b > 0) s.notes++;
	s.events.push(new Ev({ tick, ch: ch & 0xFF, kind: hi & 0xFF, a: a & 0xFF, b: b & 0xFF }));
}

function finish(s) {
	// Sort by (tick, index), so the order within one tick (off before on) is fixed
	const idx = s.events.map((_, i) => i);
	idx.sort((x, y) => (s.events[x].tick !== s.events[y].tick ? s.events[x].tick - s.events[y].tick : x - y));
	s.events = idx.map(i => s.events[i]);
	if (s.loopTick < 0 && s.endTick === 0 && s.events.length > 0) s.endTick = s.events[s.events.length - 1].tick;
}

// ------------------------------------------------------------------ SMF (.MID) parsing

function parseSmf(d) {
	if (d.length < 14 || d.toString('latin1', 0, 4) !== 'MThd') throw new Error('not SMF');
	const U16 = o => d[o] << 8 | d[o + 1];
	const U32 = o => d[o] << 24 | d[o + 1] << 16 | d[o + 2] << 8 | d[o + 3];
	const s = new Song();
	const ntrk = U16(10), div = U16(12);
	s.ppqn = div > 0 ? div : SMF_DEFAULT_PPQN;
	let p = 14;
	for (let t = 0; t < ntrk && p + 8 <= d.length; t++) {
		if (d.toString('latin1', p, p + 4) !== 'MTrk') break;
		const len = U32(p + 4), end = Math.min(p + 8 + len, d.length);
		const q = [p + 8];
		p = p + 8 + len;
		let tick = 0, st = 0;
		while (q[0] < end) {
			tick += vlq(d, q);
			if (q[0] >= end) break;
			const op = d[q[0]++];
			if (op === 0xFF) {
				const ty = d[q[0]++], ln = vlq(d, q);
				if (ty === 0x51 && ln === 3) s.events.push(new Ev({ tick, kind: KIND_TEMPO, val: d[q[0]] << 16 | d[q[0] + 1] << 8 | d[q[0] + 2] }));
				q[0] += ln;
				if (ty === 0x2F) break;
				continue;
			}
			if (op === 0xF0 || op === 0xF7) { const ln = vlq(d, q); q[0] += ln; continue; }
			if (op >= 0x80) st = op; else q[0]--;
			const hi = st & 0xF0, ch = st & 0x0F;
			const a = d[q[0]++], b = (hi === 0xC0 || hi === 0xD0) ? 0 : d[q[0]++];
			add(s, tick, ch, hi, a, b);
		}
		if (tick > s.endTick) s.endTick = tick;
	}
	finish(s);
	// In .MID the tempo comes from meta 0x51; there is no header BPM
	const first = s.events.find(e => e.kind === KIND_TEMPO);
	s.bpm = first ? roundEven(US_PER_MIN / first.val) : DEFAULT_BPM;
	return s;
}

// ------------------------------------------------------------------ timbres

// Patch in ADLIB format (24 bytes, music.playNote): [0]/[1] — AM/VIB/EGT/KSR/MULT of modulator
// and carrier, [2] — KSL and modulator "level" (63 − TL), [4]/[5] — AR|DR, [6]/[7] — SL|RR,
// [8]/[9] — waveform, [10] — feedback and connection (goes to C0 with ^1).
function P(mCtl, mLvl, mAd, mSr, cCtl, cAd, cSr, fb, addv) {
	const b = Buffer.alloc(PATCH_BYTES);
	b[0] = mCtl; b[1] = cCtl; b[2] = mLvl;
	b[4] = mAd; b[5] = cAd; b[6] = mSr; b[7] = cSr;
	b[10] = ((fb << 1) | (addv ^ 1)) & 0xFF;
	return b;
}
const Ctl = (egt, mult) => (egt !== 0 ? 0x20 : 0) | (mult & 0x0F);
const Ad = (ar, dr) => ar << 4 | dr;

// Sixteen GM families (program / 8): two operators, envelope by family character
const FAMILY = [
	P(Ctl(0, 1), 45, Ad(15, 4), Ad(2, 6), Ctl(0, 1), Ad(15, 4), Ad(0, 6), 6, 0),   // 0 piano
	P(Ctl(0, 4), 49, Ad(15, 7), Ad(1, 7), Ctl(0, 1), Ad(15, 7), Ad(0, 7), 4, 0),   // 1 chromatic percussion
	P(Ctl(1, 1), 39, Ad(15, 0), Ad(0, 7), Ctl(1, 1), Ad(15, 0), Ad(0, 7), 0, 0),   // 2 organ
	P(Ctl(0, 1), 47, Ad(15, 6), Ad(1, 7), Ctl(0, 1), Ad(15, 5), Ad(0, 7), 5, 0),   // 3 guitar
	P(Ctl(1, 1), 43, Ad(15, 3), Ad(3, 8), Ctl(1, 1), Ad(15, 3), Ad(2, 8), 6, 0),   // 4 bass
	P(Ctl(1, 1), 41, Ad(10, 4), Ad(2, 4), Ctl(1, 1), Ad(11, 3), Ad(1, 4), 4, 0),   // 5 strings
	P(Ctl(1, 1), 41, Ad(10, 3), Ad(1, 3), Ctl(1, 1), Ad(11, 2), Ad(1, 3), 3, 0),   // 6 ensemble
	P(Ctl(1, 1), 49, Ad(12, 4), Ad(2, 6), Ctl(1, 1), Ad(13, 4), Ad(1, 6), 5, 0),   // 7 brass
	P(Ctl(1, 1), 45, Ad(13, 3), Ad(1, 6), Ctl(1, 1), Ad(14, 3), Ad(1, 6), 4, 0),   // 8 reed
	P(Ctl(1, 1), 33, Ad(13, 2), Ad(0, 5), Ctl(1, 1), Ad(13, 2), Ad(0, 5), 0, 0),   // 9 pipe
	P(Ctl(1, 1), 51, Ad(15, 3), Ad(1, 5), Ctl(1, 1), Ad(15, 3), Ad(1, 5), 6, 0),   // 10 synth lead
	P(Ctl(1, 1), 39, Ad(9, 3), Ad(2, 2), Ctl(1, 1), Ad(10, 2), Ad(1, 2), 3, 0),    // 11 synth pad
	P(Ctl(1, 1), 43, Ad(11, 4), Ad(2, 4), Ctl(1, 1), Ad(12, 3), Ad(2, 4), 4, 0),   // 12 synth effects
	P(Ctl(0, 1), 45, Ad(15, 7), Ad(1, 7), Ctl(0, 1), Ad(15, 6), Ad(0, 7), 5, 0),   // 13 ethnic
	P(Ctl(0, 1), 47, Ad(15, 9), Ad(0, 9), Ctl(0, 1), Ad(15, 9), Ad(0, 9), 6, 0),   // 14 percussive
	P(Ctl(0, 1), 43, Ad(15, 5), Ad(1, 5), Ctl(0, 1), Ad(15, 5), Ad(0, 5), 4, 0),   // 15 sound effects
];

// Drums: four envelope characters (kick, snare, hat, cymbal/tom)
const DRUMS = [
	P(Ctl(0, 1), 47, Ad(15, 10), Ad(0, 10), Ctl(0, 1), Ad(15, 10), Ad(0, 10), 7, 0), // 0 kick
	P(Ctl(0, 1), 45, Ad(15, 9), Ad(0, 9), Ctl(0, 1), Ad(15, 9), Ad(0, 9), 7, 0),     // 1 snare
	P(Ctl(0, 1), 43, Ad(15, 12), Ad(0, 12), Ctl(0, 1), Ad(15, 12), Ad(0, 12), 7, 0), // 2 hat
	P(Ctl(0, 1), 45, Ad(15, 6), Ad(0, 6), Ctl(0, 1), Ad(15, 6), Ad(0, 6), 7, 0),     // 3 cymbal
];

// GM percussion note -> {kind, hz100 (tone), noise (AY noise period 1..31)}
function drumMap(note) {
	switch (note) {
	case 35: case 36: return { kind: 0, hz100: 5500, noise: 0 };               // kick — tone
	case 41: case 43: return { kind: 3, hz100: 9000, noise: 0 };               // low toms
	case 45: case 47: return { kind: 3, hz100: 12000, noise: 0 };
	case 48: case 50: return { kind: 3, hz100: 16000, noise: 0 };              // high toms
	case 42: case 44: return { kind: 2, hz100: 0, noise: 2 };                  // closed hat
	case 46: return { kind: 2, hz100: 0, noise: 4 };                           // open hat
	case 49: case 52: case 55: case 57: return { kind: 3, hz100: 0, noise: 1 }; // crash/splash
	case 51: case 53: case 59: return { kind: 3, hz100: 0, noise: 2 };         // ride
	case 37: case 39: return { kind: 1, hz100: 0, noise: 10 };                 // rimshot, clap
	case 38: case 40: return { kind: 1, hz100: 0, noise: 8 };                  // snare
	default: return { kind: 1, hz100: 0, noise: 6 };                           // other percussion
	}
}

// ------------------------------------------------------------------ run into frames

class Vc {
	constructor() {
		this.ch = -1; this.note = -1; this.vel = 0; this.trig = 0; this.patch = -1; this.relAge = REL_AGE_INIT; this.hz100 = 0; this.noise = 0;
		this.on = false; this.sust = false; this.drum = false;
	}
}

const noteHz100 = note => roundEven(A4_HZ100 * Math.pow(2.0, (note - A4_NOTE) / 12.0));

// From a parsed track — per-frame state of 12 voices, exactly as the ADLIB player gives it
// (music.VoiceFrame): the AY and FM mixes do not change.
function render(s, maxSeconds = MAX_SECONDS) {
	const r = new Music.Render();
	const patches = [];
	const patchKey = new Map();
	const patch = (key, data) => {
		if (patchKey.has(key)) return patchKey.get(key);
		const i = patches.length; patchKey.set(key, i); patches.push(data);
		return i;
	};

	const vs = Array.from({ length: VOICES }, () => new Vc());
	const chVol = new Array(16).fill(GM_VOLUME);       // controller 7 default in GM
	const chExp = new Array(16).fill(GM_EXPRESSION);   // controller 11
	const chProg = new Array(16).fill(0);
	const chBend = new Array(16).fill(0);
	const chSust = new Array(16).fill(false);
	let trig = 0;

	const keyOff = v => { v.on = false; v.sust = false; v.relAge = 0; };

	const noteOff = (ch, note) => {
		for (const v of vs)
			if (v.on && v.ch === ch && v.note === note) {
				if (chSust[ch]) v.sust = true; else keyOff(v);
			}
	};

	const noteOn = (ch, note, vel) => {
		let kind, hz100, noise, pi;
		const drum = ch === DRUM_CH;
		if (drum) {
			({ kind, hz100, noise } = drumMap(note));
			pi = patch(DRUM_PATCH_KEY + kind, DRUMS[kind]);
		} else {
			kind = 0; noise = 0; hz100 = 0;
			pi = patch(chProg[ch] >> 3, FAMILY[(chProg[ch] >> 3) & 15]);
		}
		// The same voice if this note already sounds on this channel (retrigger)
		let t = vs.find(v => v.on && v.ch === ch && v.note === note) || null;
		if (t === null) {
			// Free voice — silent the longest (first one on ties, like OrderByDescending.First);
			// if all are busy, take the quietest
			for (const v of vs) if (!v.on && (t === null || v.relAge > t.relAge)) t = v;
			if (t === null) for (const v of vs) if (t === null || v.vel < t.vel) t = v;
		}
		t.ch = ch; t.note = note; t.vel = vel; t.patch = pi; t.on = true; t.sust = false;
		t.drum = drum; t.noise = noise; t.hz100 = hz100;
		t.trig = ++trig;
	};

	const endTick = s.loopTick >= 0 ? s.loopTick : s.endTick;
	let usPerQ = Math.trunc(US_PER_MIN / Math.max(MIN_BPM, s.bpm));
	let tick = 0;
	let ei = 0;
	const maxFrames = Math.trunc(maxSeconds * Music.FRAME_HZ);

	// Frame 0 is empty (the setup frame of the AY/FM stream), the music starts at frame 1:
	// both mixes loop to frame 1 (22 §10.2)
	r.voices.push(new Music.VoiceFrame());

	while (r.voices.length < maxFrames) {
		const now = Math.floor(tick);
		while (ei < s.events.length && s.events[ei].tick <= now) {
			const e = s.events[ei++];
			switch (e.kind) {
			case KIND_TEMPO: usPerQ = Math.max(MIN_US_PER_Q, e.val); break;
			case 0x90: if (e.b > 0) noteOn(e.ch, e.a, e.b); else noteOff(e.ch, e.a); break;
			case 0x80: noteOff(e.ch, e.a); break;
			case 0xB0:
				if (e.a === CC_VOLUME) chVol[e.ch] = e.b;
				else if (e.a === CC_EXPRESSION) chExp[e.ch] = e.b;
				else if (e.a === CC_SUSTAIN) {
					chSust[e.ch] = e.b >= 64;
					if (!chSust[e.ch]) for (const v of vs) if (v.sust && v.ch === e.ch) keyOff(v);
				} else if (e.a === CC_ALL_SOUND_OFF || e.a === CC_ALL_NOTES_OFF)
					for (const v of vs) if (v.ch === e.ch) keyOff(v);
				break;
			case 0xC0: chProg[e.ch] = e.a; break;
			case 0xE0: chBend[e.ch] = (e.a | e.b << 7) - BEND_CENTER; break;
			}
		}

		const vf = new Music.VoiceFrame();
		for (let i = 0; i < VOICES; i++) {
			const v = vs[i];
			if (!v.on) v.relAge++;
			vf.trig[i] = v.trig;
			vf.patch[i] = v.patch;
			vf.key[i] = v.on;
			vf.drum[i] = v.drum;
			vf.noise[i] = v.noise;
			if (v.note >= 0) {
				const n = v.note + (v.drum ? 0 : chBend[v.ch] * BEND_RANGE / 8192.0);
				vf.freq[i] = v.drum ? v.hz100 : noteHz100(n);
			}
			// Volume — velocity scaled by controllers 7 and 11 as in the original player
			// (adlplayer.cpp:635), corrected for pitch (tilt)
			vf.vol[i] = v.on ? tilt(Math.min(VOL_MAX, Math.trunc(v.vel * chVol[v.ch] * chExp[v.ch] / (127 * 127))), vf.freq[i]) : 0;
		}
		r.voices.push(vf);

		if (tick >= endTick && ei >= s.events.length) break;
		if (tick >= endTick) break;
		tick += s.ppqn * 1000000.0 / usPerQ / Music.FRAME_HZ;
	}

	normalize(r);
	r.patches = patches;
	r.loop = s.loopTick >= 0;
	r.loopFrame = r.loop ? r.voices.length : -1;
	return r;
}

// Volume tilt by pitch: GM balancing assumes sampled instruments where deep bass is weak; an
// AY square wave and an OPN sine at 37 Hz play at full power (22 §11.3). 2 dB per octave from
// middle C, limited to -5…+7 dB.
const TILT_PER_OCT = 2.0, TILT_MIN = -5.0, TILT_MAX = 7.0;

function tilt(vol, hz100) {
	if (vol <= 0 || hz100 <= 0) return vol;
	let db = TILT_PER_OCT * (Math.log(hz100 / C4_HZ100) / Math.log(2));
	if (db > TILT_MAX) db = TILT_MAX;
	if (db < TILT_MIN) db = TILT_MIN;
	const v = vol + roundEven(db * 8.0 / 3.0);
	return v < 1 ? 1 : v > VOL_MAX ? VOL_MAX : v;
}

// Scales track volumes so the 99th percentile of per-frame peaks lands on 127 (22 §11.3)
function normalize(r) {
	const peaks = [];
	for (const vf of r.voices) {
		let m = 0;
		for (let i = 0; i < VOICES; i++) if (vf.vol[i] > m) m = vf.vol[i];
		if (m > 0) peaks.push(m);
	}
	if (peaks.length === 0) return;
	peaks.sort((a, b) => a - b);
	const top = peaks[Math.trunc(peaks.length * PEAK_PERCENTILE)];
	if (top <= 0 || top >= VOL_MAX) return;
	for (const vf of r.voices)
		for (let i = 0; i < VOICES; i++)
			if (vf.vol[i] > 0) vf.vol[i] = Math.min(VOL_MAX, Math.trunc(vf.vol[i] * 127 / top));
}

module.exports = { DRUM_CH, Song, Ev, parseCat, parseSmf, render };
