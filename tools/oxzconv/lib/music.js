// ADLIB.CAT music -> per-frame stream of OPL3 register writes (MUSIC resource) and VGM.
//
// The original player (OpenXcom src/Engine/Adlib/adlplayer.cpp, "X-COM Adlib Player by
// Volutar") runs offline at its native tick 44100/629 = 70.11 Hz; register writes are spread
// over TS-Config frames (3 500 000 / 71 680 = 48.83 Hz): the engine only has to output the
// ready "register, value" pairs once per frame.
// 12 player voices: 0-8 -> OPL3 bank 0, 9-11 -> bank 1 channels 0-2 (operators at offsets
// 24-29 -> 0-5 of bank 1). OPL3 mode (NEW=1), L+R bits in C0-C8.
//
// MUSIC: u32 loop_offset (from the stream start, #FFFFFFFF — no loop), u32 frames,
// u16 max writes per frame, u16 resync pairs; records: #00..#7F — n0 pairs (reg, value) of
// bank 0, byte n1 and n1 pairs of bank 1, end of frame; #81..#FE — pause (b - #80) frames;
// #FF — end.
'use strict';
const { pushPairs, flushIdle, header, END } = require('./musicutil');

const TICK_HZ = 44100.0 / 629;
const FRAME_HZ = 3500000.0 / 71680;
const VOICES = 12, INSTRUMENTS = 16, PATCH_BYTES = 24, NO_SAMPLE = 0xFF;
const MAX_SECONDS = 1200;
const LOOP_TAIL_TICKS = 10;            // ticks to keep running after the loop opcode
const OPL_REGS = 256, BANKS = 2;
const VGM_RATE = 44100, VGM_HDR = 0x100, VGM_VERSION = 0x151, VGM_RATE_HZ = 50, VGM_YMF262_CLOCK = 14318180;
const VGM_WAIT = 0x61, VGM_BANK0 = 0x5E, VGM_BANK1 = 0x5F, VGM_END = 0x66, VGM_MAX_WAIT = 65535;

const FREQ1 = [0x0B5, 0x0C0, 0x0CC, 0x0D8, 0x0E5, 0x0F2, 0x101, 0x110, 0x120, 0x131, 0x143, 0x157];
const FREQ2 = [0x16B, 0x181, 0x198, 0x1B0, 0x1CA, 0x1E5, 0x202, 0x220, 0x241, 0x263, 0x287, 0x2AE];
const FREQ_TABLE = FREQ1.concat(...Array(8).fill(FREQ2));
const OCTAVE_TABLE = Array(24).fill(0).concat(...[1, 2, 3, 4, 5, 6, 7].map(o => Array(12).fill(o)));
const DETUNE_TABLE = [].concat(...Array(9).fill([3, 3, 3, 3, 4, 4, 4, 4, 4, 5, 5, 5]));
const INSTR_ORDER = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 9];
const OPS1 = [0, 1, 2, 8, 9, 10, 16, 17, 18, 24, 25, 26];

function catEntries(buf) {
	const n = Math.trunc(buf.readInt32LE(0) / 8);
	const o = [];
	for (let i = 0; i < n; i++) o.push({ offset: buf.readInt32LE(i * 8), size: buf.readInt32LE(i * 8 + 4) });
	return o;
}

// Track data as AdlibMusic::load(adlibcat->load(track, true), size)
const NAME_MAX = 56;
function catTrack(buf, e) {
	let size = e.size;
	if (buf[e.offset] <= NAME_MAX) size += buf[e.offset] + 1;
	size = Math.min(size, buf.length - e.offset);
	return Buffer.from(buf.subarray(e.offset, e.offset + size));
}

// What a player voice plays in this frame: note (frequency in 1/100 Hz), volume, timbre
// (ADLIB sample) and a note-take counter — mixers for chips without OPL3 use it to see that the
// note was struck again and give a new key-on.
class VoiceFrame {
	constructor() {
		this.freq = new Array(VOICES).fill(0); this.vol = new Array(VOICES).fill(0);
		this.patch = new Array(VOICES).fill(0); this.trig = new Array(VOICES).fill(0);
		this.key = new Array(VOICES).fill(false);     // the note is still held (else the voice is releasing)
		this.chorus = new Array(VOICES).fill(false);  // detuned double (OpenXcom addition)
		// Drums exist only with the MIDI source (GM channel 9, musicmidi.js): the ADLIB player
		// has its drums spread over the same 12 voices with nothing to tell them apart.
		this.drum = new Array(VOICES).fill(false);
		this.noise = new Array(VOICES).fill(0);       // AY noise period (0 — play a tone)
	}
}

class Chan { constructor() { this.note = 0; this.instr = 0; this.sample = NO_SAMPLE; this.freq = 0; this.hiFreq = 0; this.volume = 0; this.duration = 0; } }
class Ins { constructor() { this.sample = 0; this.prev = 0; this.volume = 0; this.pitch = 0; this.delay = 0; this.addr = -1; this.start = -1; this.ret = -1; } }

const at = (t, i, def) => (i >= 0 && i < t.length ? t[i] : def);

class Player {
	constructor(data, reg) {
		this.d = data; this.reg = reg;
		this.ch = Array.from({ length: VOICES }, () => new Chan());
		this.ins = Array.from({ length: INSTRUMENTS }, () => new Ins());
		this.chorus = new Array(INSTRUMENTS).fill(0);
		this.subtracks = [];
		this.vol = 127; this.tempo = 120; this.tempoRun = 60; this.tempoInc = 70; this.samples = 0;
		this.playing = false; this.looped = false;
		this.trig = new Array(VOICES).fill(0);           // note takes per voice
		// Chorus (detuned double of a voice) is an OpenXcom addition, not the original (09 §7).
		// It stays in the OPL3 stream, but it only hurts the AY and FM mixes: two voices in
		// unison 1 Hz apart eat channels and beat (22 §10.6).
		this.chorusCh = new Array(VOICES).fill(false);
		this.inChorus = false;
		this.patches = [];                               // track timbres, 24 bytes each
	}

	D(p) { return p >= 0 && p < this.d.length ? this.d[p] : 0; }
	U16(p) { return this.D(p) | this.D(p + 1) << 8; }
	numSeq(I) { let v = 0, c; do { c = this.D(I.addr++); v = (v << 7) + (c & 0x7F); } while ((c & 0x80) !== 0); return v; }
	setAmp(c, value) { this.reg(0x43 + OPS1[c], ~(value >> 1) & 0x3F); }
	clearChannels() { for (const c of this.ch) { c.sample = NO_SAMPLE; c.note = 0; } }
	resetChannels() { this.clearChannels(); for (let i = 0; i < VOICES; i++) { this.reg(0xB0 + i, 0); this.setAmp(i, 0); } }

	pitchedFreq(note, instr) {
		const p = this.ins[instr].pitch, bas = at(FREQ_TABLE, note, 0);
		if (p === 0) return bas;
		if (p > 0) return bas + at(DETUNE_TABLE, note, 3) * p;
		return bas + (note > 0 ? at(DETUNE_TABLE, note - 1, 3) : 7) * p;
	}

	setPitch(instr, pitch) {
		this.ins[instr].pitch = pitch;
		for (let i = 0; i < VOICES; i++) {
			const c = this.ch[i];
			if (c.note !== 0 && c.instr === instr) {
				const f = this.pitchedFreq(c.note, instr);
				c.freq = f & 0xFF;
				this.reg(0xA0 + i, f & 0xFF);
				const hf = ((f >> 8) & 3 | at(OCTAVE_TABLE, c.note, 0) << 2) & 0xFF;
				c.hiFreq = hf;
				this.reg(0xB0 + i, hf | 0x20);
			}
		}
	}

	unusedChannel(sample) {
		const ch = this.ch;
		let maxchan = 0, maxdur = 0;
		for (const c of ch) c.duration++;
		for (let i = 0; i < VOICES; i++) {
			if (ch[i].duration > maxdur) { maxdur = ch[i].duration; maxchan = i; }
			if (ch[i].note === 0) { maxchan = i; break; }
		}
		let same = false;
		if (ch[maxchan].sample === sample) same = true; else ch[maxchan].sample = sample;
		ch[maxchan].duration = 0;
		return { c: maxchan, same };
	}

	playNote(note, volume, instr) {
		const reg = this.reg, D = p => this.D(p);
		const sample = this.ins[instr].sample, s = this.samples + sample * PATCH_BYTES;
		note = (note - 1) & 0xFF;
		if (volume === 0) {
			for (let i = 0; i < VOICES; i++)
				if (this.ch[i].note === note && this.ch[i].instr === instr) { this.ch[i].note = 0; reg(0xB0 + i, this.ch[i].hiFreq); }
			return;
		}
		if (volume > 127) volume = 127;
		const { c, same } = this.unusedChannel(sample);
		const cc = this.ch[c], op1 = OPS1[c];
		cc.volume = volume; cc.note = note; cc.instr = instr;
		this.trig[c]++;
		this.chorusCh[c] = this.inChorus;
		if (!same) {
			reg(0x20 + op1, D(s)); reg(0x23 + op1, D(s + 1));
			const ampl = D(s + 2);
			reg(0x40 + op1, (~ampl & 0x3F) | (ampl & 0xC0));
		}
		reg(0xB0 + c, cc.hiFreq);
		reg(0x43 + op1, ~((this.vol * volume) >> 8) & 0x3F);
		if (!same) {
			reg(0x60 + op1, D(s + 4)); reg(0x63 + op1, D(s + 5));
			reg(0x80 + op1, D(s + 6)); reg(0x83 + op1, D(s + 7));
			reg(0xE0 + op1, D(s + 8)); reg(0xE3 + op1, D(s + 9));
			reg(0xC0 + c, D(s + 10) ^ 0x01);
		}
		const f = this.pitchedFreq(note, instr);
		cc.freq = f & 0xFF;
		reg(0xA0 + c, f & 0xFF);
		const hf = (f >> 8 | at(OCTAVE_TABLE, note, 0) << 2) & 0xFF;
		cc.hiFreq = hf;
		reg(0xB0 + c, hf | 0x20);
	}

	freeChannel() { return this.ch.some(c => c.note === 0); }

	noteOff(note, i) {
		this.playNote(note, 0, i);
		if (this.chorus[i] !== 0 && this.chorus[i] < INSTRUMENTS) this.playNote(note, 0, this.chorus[i]);
	}

	// -> { delay, loop }
	decode(i, loopIn) {
		const I = this.ins[i], ins = this.ins, chorus = this.chorus;
		let delay = 0, loop = loopIn;
		do {
			let op = this.D(I.addr++);
			if (op === 0xFE) { const a = this.D(I.addr++); I.ret = I.addr; I.addr = a < this.subtracks.length ? this.subtracks[a] : this.d.length; }
			else if (op === 0xFD) { if (I.ret >= 0) { I.addr = I.ret; I.ret = -1; } }
			else if (op === 0xFF) { this.playing = false; delay = 0; break; }
			else if (op >= 0x80) { I.prev = op; op = this.D(I.addr++); }
			if (op < 0x80) {
				const a1 = op;
				switch (I.prev & 0xF0) {
				case 0x80: I.addr++; this.noteOff(a1, i); break;
				case 0x90: {
					const a2 = this.D(I.addr++);
					if (a2 === 0) this.noteOff(a1, i);
					else {
						const v = (a2 * I.volume) >> 7, ci = chorus[i];
						if (ci !== 0 && ci < INSTRUMENTS && this.freeChannel()) {
							ins[ci].sample = I.sample;
							ins[ci].pitch = I.pitch - 1;
							this.inChorus = true;
							this.playNote(a1, v, ci);
							this.inChorus = false;
						}
						this.playNote(a1, v, i);
					}
					break;
				}
				case 0xB0: {
					const a2 = this.D(I.addr++);
					if (a1 === 0 && a2 !== 0) this.tempo = Math.trunc(a2 * 0.8);
					else if (a1 === 7) I.volume = a2;
					else if (a1 === 0x7E) chorus[i] = (a2 - 1) & 0xFF;
					else if (a1 === 0x7F) chorus[i] = 0;
					break;
				}
				case 0xC0:
					if (a1 === 0x7E) loop = true; else I.sample = a1;
					break;
				case 0xE0:
					I.pitch = a1 - 16;
					this.setPitch(i, a1 - 16);
					if (chorus[i] !== 0 && chorus[i] < INSTRUMENTS) this.setPitch(chorus[i], a1 - 17);
					break;
				}
			}
			if (!this.playing) break;
			let vv = 0, c;
			do { c = this.D(I.addr++); vv = (vv << 7) + (c & 0x7F); } while ((c & 0x80) !== 0);
			delay = vv;
		} while (delay === 0);
		return { delay, loop };
	}

	initData() {
		const d = this.d, len = d.length;
		let p = 0;
		for (const I of this.ins) I.start = -1;
		const fmt = d[0] > NAME_MAX ? 0 : 1;
		if (fmt === 1) p += d[0] + 1;
		this.tempo = this.D(p++);
		this.samples = p + 1;
		this.patches.length = 0;
		for (let i = 0; i < this.D(p); i++) {
			const s = Buffer.alloc(PATCH_BYTES);
			for (let j = 0; j < PATCH_BYTES; j++) s[j] = this.D(this.samples + i * PATCH_BYTES + j);
			this.patches.push(s);
		}
		p += this.D(p) * PATCH_BYTES + 1;
		const nsub = this.D(p++);
		for (let i = 0; i < nsub; i++) { const add = this.U16(p); this.subtracks.push(p + 4); p += add; }
		const nins = this.D(p++);
		for (let i = 0; i < nins; i++) {
			const add = this.U16(p);
			if (fmt === 1) { let j = this.D(p + 4); if (j > 15) j = 15; this.ins[j].start = p + 5; }
			else if (i < INSTRUMENTS) this.ins[i].start = p + 4;
			p += add;
			if (p >= len) break;
		}
	}

	initMusic() {
		for (let i = 0; i < INSTRUMENTS; i++) {
			const I = this.ins[i];
			I.pitch = 0; this.chorus[i] = 0;
			if (I.start >= 0) { I.addr = I.start; I.delay = this.numSeq(I); }
			else { I.addr = -1; I.delay = 0; }
		}
	}

	adlibInit() {
		const reg = this.reg;
		for (let i = 1; i < 0xF5; i++) reg(i, 0);
		reg(0x04, 0x60); reg(0x04, 0x80); reg(0x01, 0x20);
		reg(0xA8, 0x01); reg(0x08, 0x40); reg(0xBD, 0xC0);
	}

	setup() {
		this.playing = false;
		this.initData();
		this.initMusic();
		this.adlibInit();
		this.resetChannels();
		this.tempo = Math.trunc(this.tempo * 0.4);
		this.tempoRun = this.tempo;
		this.playing = true;
		for (let i = 0; i < VOICES; i++) this.setAmp(i, (this.ch[i].volume * this.vol) >> 7);
	}

	tick() {
		if (!this.playing) return;
		this.tempoRun -= this.tempo;
		if (this.tempoRun > 0) return;
		this.tempoRun += this.tempoInc;
		let loop;
		do {
			loop = false;
			for (let k = 0; k < INSTRUMENTS; k++) {
				const i = INSTR_ORDER[k], I = this.ins[i];
				if (I.addr < 0) continue;
				if (I.delay === 0) { const r = this.decode(i, loop); I.delay = r.delay; loop = r.loop; if (!this.playing) break; }
				I.delay--;
			}
			if (!loop && this.playing) break;
			this.looped = true;
			this.initMusic();
			this.clearChannels();
		} while (loop);
	}

	// What sounds right now: per channel — frequency in 1/100 Hz, volume 0..127, timbre and
	// take counter. Non-OPL3 chips (AY, YM2203 FM part) need the notes, not the OPL writes:
	// the mixer deals them out to its own channels again.
	voices() {
		const v = new VoiceFrame();
		for (let i = 0; i < VOICES; i++) {
			const c = this.ch[i];
			v.trig[i] = this.trig[i];
			v.patch[i] = c.sample === NO_SAMPLE ? -1 : c.sample;
			v.key[i] = c.note !== 0;
			v.chorus[i] = this.chorusCh[i];
			// The frequency is given after note-off too: on OPL it still plays the release
			// (registers stay, the envelope fades), and the mix needs that as well.
			const fnum = c.freq | ((c.hiFreq & 3) << 8), block = (c.hiFreq >> 2) & 7;
			// OPL: f = fnum * 49716 / 2^(20 - block)
			v.freq[i] = Math.floor(fnum * 4971600 / 2 ** (20 - block));
			v.vol[i] = c.note !== 0 ? c.volume : 0;
		}
		return v;
	}
}

// Register of the 12-voice "OPL2" player -> {bank, reg} of OPL3 or null
function mapReg(r) {
	if (r === 0xBD || r < 0x20) return { bank: 0, reg: r };
	const hi = r & 0xF0;
	if (hi === 0xA0 || hi === 0xB0 || hi === 0xC0) {
		const c = r & 0x0F;
		if (c < 9) return { bank: 0, reg: r };
		if (c < 12) return { bank: 1, reg: hi | (c - 9) };
		return null;
	}
	if (r >= 0x20 && r < 0xA0 || r >= 0xE0 && r < 0x100) {
		const bas = r & 0xE0, off = r & 0x1F;
		if (off <= 0x15) return { bank: 0, reg: r };
		if (off >= 0x18 && off <= 0x1D) return { bank: 1, reg: bas | (off - 0x18) };
		return null;
	}
	return null;
}

// frames — one per 1/50 s ("register, value" pairs for bank 0 and 1 apart).
// init/end — register state after the first frame and at the end of the stream: their
// difference is the resync block, without which the second round sounds unlike the first (22 §2.4).
class Render {
	constructor() {
		this.frames = [];
		this.loop = false;
		this.init = null; this.end = null;
		this.loopFrame = -1;
		// Voices per frame (note, volume, timbre for each of the 12 player voices) — musicay.js
		// mixes them down to three AY channels, musicfm.js to six FM channels of YM2203.
		this.voices = [];
		this.patches = [];   // track timbres (24 ADLIB bytes)
	}
	// The MIDI source (musicmidi.js) has no OPL3 stream — the voice list gives the length
	get seconds() { return Math.max(this.frames.length, this.voices.length) / FRAME_HZ; }
}

const newFrame = () => [[], []];
const regCopy = last => [last[0].slice(), last[1].slice()];

function renderTrack(data, maxSeconds = MAX_SECONDS) {
	const r = new Render();
	let firstLoopFrame = -1;
	const last = [new Array(OPL_REGS).fill(-1), new Array(OPL_REGS).fill(-1)];
	let cur = null;
	const emit = (bank, rg, val) => {
		if (bank === 0 && (rg & 0xF0) === 0xC0 && (rg & 0x0F) < 9 || bank === 1 && (rg & 0xF0) === 0xC0) val |= 0x30;
		if (last[bank][rg] === val) return;
		last[bank][rg] = val;
		cur[bank].push(rg & 0xFF, val & 0xFF);
	};
	const p = new Player(data, (rg, v) => { const m = mapReg(rg & 0xFF); if (m) emit(m.bank, m.reg, v & 0xFF); });
	cur = newFrame();
	r.frames.push(cur);
	emit(1, 0x05, 0x01);
	emit(1, 0x04, 0x00);
	p.setup();
	const maxTicks = Math.floor(maxSeconds * TICK_HZ);
	let loopTick = -1, init = null, end = null;
	for (let k = 1; k <= maxTicks && p.playing; k++) {
		const f = Math.floor(k * FRAME_HZ / TICK_HZ);
		while (r.frames.length <= f) r.frames.push(newFrame());
		if (init === null && f > 0) init = regCopy(last);
		cur = r.frames[f];
		const before = regCopy(last);
		p.tick();
		while (r.voices.length < r.frames.length) r.voices.push(p.voices());   // one per frame
		// The loop opcode does not mean the track loops yet: in nine original tracks the
		// decoder hits the end a couple of ticks later and the track plays once (22 §2.2).
		if (p.looped && firstLoopFrame < 0) { firstLoopFrame = f; loopTick = k; end = before; }
		if (loopTick > 0 && k >= loopTick + LOOP_TAIL_TICKS) break;
	}
	r.loopFrame = firstLoopFrame;
	r.loop = firstLoopFrame >= 0 && p.playing;
	if (r.loop && firstLoopFrame < r.frames.length) {
		r.frames.length = firstLoopFrame;   // 22 §2.3
		if (firstLoopFrame < r.voices.length) r.voices.length = firstLoopFrame;
	}
	r.patches = p.patches;
	r.init = init || regCopy(last);
	r.end = end || regCopy(last);
	return r;
}

function encodeStream(r) {
	const o = [];
	let idle = 0, maxw = 0, loopOffset = -1;
	for (let idx = 0; idx < r.frames.length; idx++) {
		if (idx === 1) { idle = flushIdle(o, idle); loopOffset = o.length; }
		const [b0, b1] = r.frames[idx];
		const n0 = b0.length / 2, n1 = b1.length / 2;
		maxw = Math.max(maxw, n0 + n1);
		if (n0 === 0 && n1 === 0) { idle++; continue; }
		idle = flushIdle(o, idle);
		pushPairs(o, b0, b1);
	}
	idle = flushIdle(o, idle);
	o.push(END);
	// Resync block (22 §2.4): by the loop point the chip state differs from the start by dozens
	// of registers, hanging notes included. After #FF this difference goes in frame format,
	// the player plays it before jumping to loop_offset.
	let resync = 0;
	if (r.loop && r.init && r.end) {
		const diff = newFrame();
		for (let bank = 0; bank < BANKS; bank++)
			for (let rg = 0; rg < OPL_REGS; rg++) {
				const want = r.init[bank][rg], have = r.end[bank][rg];
				if (want < 0 || want === have) continue;
				diff[bank].push(rg, want & 0xFF);
			}
		resync = (diff[0].length + diff[1].length) / 2;
		pushPairs(o, diff[0], diff[1]);
	}
	const hdr = header(r.loop && loopOffset >= 0 ? loopOffset : -1, r.frames.length, maxw, resync);
	return { data: Buffer.concat([hdr, Buffer.from(o)]), maxWrites: maxw };
}

// VGM 1.51 (YMF262) for listening on a PC
function toVgm(r) {
	const cmds = [];
	let acc = 0, samplesTotal = 0, loopByte = -1, loopSamples = 0;
	const wait = n => { while (n > 0) { const k = Math.min(n, VGM_MAX_WAIT); cmds.push(VGM_WAIT, k & 0xFF, (k >> 8) & 0xFF); n -= k; } };
	for (let idx = 0; idx < r.frames.length; idx++) {
		if (idx === 1 && r.loop) { loopByte = cmds.length; loopSamples = samplesTotal; }
		const f = r.frames[idx];
		for (let i = 0; i < f[0].length; i += 2) cmds.push(VGM_BANK0, f[0][i], f[0][i + 1]);
		for (let i = 0; i < f[1].length; i += 2) cmds.push(VGM_BANK1, f[1][i], f[1][i + 1]);
		acc += VGM_RATE / FRAME_HZ;
		const n = Math.floor(acc); acc -= n; samplesTotal += n; wait(n);
	}
	cmds.push(VGM_END);
	const hdr = Buffer.alloc(VGM_HDR);
	hdr.write('Vgm ', 0, 'latin1');
	const u32 = (o, v) => hdr.writeInt32LE(v | 0, o);
	u32(0x04, VGM_HDR + cmds.length - 4);
	u32(0x08, VGM_VERSION);
	u32(0x18, samplesTotal);
	if (loopByte >= 0) { u32(0x1C, VGM_HDR + loopByte - 0x1C); u32(0x20, samplesTotal - loopSamples); }
	u32(0x24, VGM_RATE_HZ);
	u32(0x34, VGM_HDR - 0x34);
	u32(0x5C, VGM_YMF262_CLOCK);
	return Buffer.concat([hdr, Buffer.from(cmds)]);
}

module.exports = { TICK_HZ, FRAME_HZ, VOICES, VoiceFrame, Render, catEntries, catTrack, renderTrack, encodeStream, toVgm };
