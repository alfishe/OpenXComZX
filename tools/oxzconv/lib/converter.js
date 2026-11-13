// Converts a game folder (UFO or TFTD) to OpenXComZX data (folder OXZ/<game>).
// Steps and formats — project_docs/09_converter.md.
//
// Debug switches (environment), used to check one step at a time against the C# reference:
//   OXZ_CONV_STEPS=pal,geo,batui,battle,music,lang,cuts,rules — run only these steps
//     (palettes are always loaded: other steps and previews need them)
//   OXZ_CONV_SEED=<RESIDS.TXT> — preallocate dynamic resource ids in that order, so a step
//     run alone gets the same ids as in a full run
'use strict';
const fs = require('fs');
const path = require('path');
const Y = require('./yaml');
const { GameFs } = require('./gamefs');
const { PakWriter, ResType } = require('./pack');
const { ResIds, Registry } = require('./resids');
const { OxcomData } = require('./oxcom');
const { upInv, hex, fixed } = require('./text');
const F = require('./formats');
const Sprites = require('./sprites');
const Cram = require('./cram');
const Png = require('./png');

const MUS_BASE = 0x0300;
const DEFAULT_NORMALIZATION = 0.76, VOL_SCALE = 127, VOL_MAX = 255;
const CUT_TYPES = ['intro', 'winGame', 'loseGame', 'tleth'];
const MUS_GROUPS = ['GMGEO', 'GMINTER'];
const NO_TYPE = 0xFF, NO_STR = 0xFFFF;
const CUT_W = 320, CUT_H = 200, CUT_DEFAULT_SECONDS = 30;
const PAL_COLORS = 256, BACKPAL_BYTES = 48, BACKPAL_FIRST = 224;
const KB = 1024;

class Converter {
	constructor(gameDir, outRoot, previewRoot, ox, lang, log) {
		this.gfs = new GameFs(gameDir);
		this.game = this.gfs.detectGame();
		this.ruleFolder = this.game === 'TFTD' ? 'xcom2' : 'xcom1';
		this.outDir = path.join(outRoot, 'OXZ', this.game);
		this.prevDir = previewRoot ? path.join(previewRoot, this.game) : null;
		this.ox = ox; this.lang = lang; this.log = log;
		// AY and FM stream source: "adlib" — run of the ADLIB.CAT player (default), "midi" —
		// the original MIDI from SOUND/GM.CAT (22 §11). The OPL3 stream (MUSIC.PAK) always
		// comes from ADLIB.CAT: it plays the same chip as the original.
		this.musicSource = 'adlib';
		this.ids = new ResIds();
		this.report = [];
		this.pal6 = new Map();
		this.palOrder = [];
		this.strIndex = null;
		this.musGrpTable = null;
		this.cutTable = null;
		this.cutPals = [];
		const steps = process.env.OXZ_CONV_STEPS;
		this.steps = steps ? new Set(steps.split(',').map(s => s.trim())) : null;
		const seed = process.env.OXZ_CONV_SEED;
		if (seed) for (const line of fs.readFileSync(seed, 'latin1').split(/\r?\n/)) { const m = line.match(/^[0-9A-F]{4} (.+)$/); if (m) this.ids.id(m[1]); }
	}

	on(step) { return this.steps === null || this.steps.has(step); }

	run() {
		this.log(`oxzconv: game ${this.game} in ${this.gfs.root} (OpenXcom data: ${this.ox.source})`);
		fs.mkdirSync(this.outDir, { recursive: true });
		if (this.prevDir) fs.mkdirSync(this.prevDir, { recursive: true });
		this.palettes();
		this.bgScreen = this.backgroundScreens();
		if (this.on('geo')) this.geoImages();
		if (this.on('batui')) this.battleUi();
		if (this.on('battle')) this.battleMaps();
		if (this.on('music')) this.musicStep();
		if (this.on('lang')) this.langStep();
		if (this.on('cuts')) this.cutscenes();
		if (this.on('rules')) this.rules();
		fs.writeFileSync(path.join(this.outDir, 'RESIDS.TXT'), this.ids.dyn.map(([k, v]) => `${hex(v, 4)} ${k}\r\n`).join(''), 'latin1');
		for (const l of this.report) this.log('  ' + l);
		this.log(`oxzconv: done -> ${this.outDir}`);
	}

	kb(bytes) { return String(Math.trunc((bytes + 512) / KB)); }

	// ------------------------------------------------------------ palettes
	// Logical names as in OpenXcom (Mod::loadVanillaResources)
	addPal(name, p) { if (!this.pal6.has(name)) this.palOrder.push(name); this.pal6.set(name, p); }

	palettes() {
		const gfs = this.gfs;
		const names = ['PAL_GEOSCAPE', 'PAL_BASESCAPE', 'PAL_GRAPHS', 'PAL_UFOPAEDIA', 'PAL_BATTLEPEDIA'];
		const pals = F.decodePalettes(gfs.read('GEODATA/PALETTES.DAT'));
		for (let i = 0; i < pals.length && i < names.length; i++) this.addPal(names[i], pals[i]);
		this.addPal('BACKPALS', F.decodeBackpals(gfs.read('GEODATA/BACKPALS.DAT')));

		// battle palettes: UFO — palette 4 + grey ramp 240..255; TFTD — D0..D3.LBM
		const lbms = ['D0.LBM', 'D1.LBM', 'D2.LBM', 'D3.LBM'];
		const battle = ['PAL_BATTLESCAPE', 'PAL_BATTLESCAPE_1', 'PAL_BATTLESCAPE_2', 'PAL_BATTLESCAPE_3'];
		const backPal = [[0, 5, 4], [0, 10, 34], [2, 9, 24], [2, 0, 24]];
		if (gfs.has('UFOGRAPH/D0.LBM')) {
			for (let i = 0; i < lbms.length; i++) {
				if (!gfs.has('UFOGRAPH/' + lbms[i])) continue;
				const pal = F.decodeLbm(gfs.read('UFOGRAPH/' + lbms[i])).pal;
				for (let c = 0; c < 3; c++) pal[255 * 3 + c] = backPal[i][c];
				this.addPal(battle[i], Cram.pal8To6(pal));
			}
		} else if (this.pal6.has('PAL_BATTLEPEDIA')) {
			const p = Buffer.from(this.pal6.get('PAL_BATTLEPEDIA'));
			const grad = [[140, 152, 148], [132, 136, 140], [116, 124, 132], [108, 116, 124], [92, 104, 108], [84, 92, 100], [76, 80, 92], [56, 68, 84],
				[48, 56, 68], [40, 48, 56], [32, 36, 48], [24, 28, 32], [16, 20, 24], [8, 12, 16], [3, 4, 8], [3, 3, 6]];
			for (let i = 0; i < 16; i++) for (let c = 0; c < 3; c++) p[(240 + i) * 3 + c] = grad[i][c] >> 2;
			this.addPal('PAL_BATTLESCAPE', p);
		}
		if (!this.on('pal')) return;
		const pak = new PakWriter(this.game);
		for (const name of this.palOrder) pak.add(this.ids.id(name), ResType.Pal, Cram.pal6ToCram(this.pal6.get(name)), this.pal6.get(name).length / 3);
		const r = pak.write(path.join(this.outDir, 'PAL.PAK'));
		this.report.push(`PAL.PAK: ${r.count} palettes (${this.palOrder.join(', ')})`);
	}

	// ------------------------------------------------------------ preview
	backgroundScreens() {
		const list = Y.list(Y.load(OxcomData.readDataText('screen_backgrounds.json')));
		const count = new Map(), order = [];
		for (const x of list) {
			const k = Y.str(Y.get(x, 'background')) + '|' + Y.str(Y.get(x, 'interface'));
			if (!count.has(k)) { count.set(k, 0); order.push(k); }
			count.set(k, count.get(k) + 1);
		}
		const best = new Map();
		for (const k of order) {
			const parts = k.split('|');
			const b = best.get(parts[0]);
			if (b === undefined || count.get(k) > b.n) best.set(parts[0], { ui: parts[1], n: count.get(k) });
		}
		return new Map([...best].map(([k, v]) => [k, v.ui]));
	}

	palOfScreen(type) {
		if (!this.screenPal) this.screenPal = require('./interfaces').screenPalettes(this.ox, this.ruleFolder);
		const { pal, backpal } = this.screenPal(type);
		const p = Buffer.from(this.pal6.has(pal) ? this.pal6.get(pal) : this.pal6.get('PAL_GEOSCAPE'));
		if (backpal >= 0) this.pal6.get('BACKPALS').copy(p, BACKPAL_FIRST * 3, backpal * BACKPAL_BYTES, (backpal + 1) * BACKPAL_BYTES);
		return p;
	}

	preview(name, img, palName = null, screen = null) {
		if (!this.prevDir) return;
		const p = screen !== null ? this.palOfScreen(screen) : this.pal6.has(palName || '') ? this.pal6.get(palName) : this.pal6.get('PAL_GEOSCAPE');
		fs.writeFileSync(path.join(this.prevDir, name.replace(/[/\\]/g, '_') + '.png'), Png.encodeIndexed(img, Cram.pal6To8(p)));
	}

	palFor(name) {
		if (name.startsWith('UP') && name.length > 2 && /[0-9]/.test(name[2])) return this.pal6.has('PAL_UFOPAEDIA') ? 'PAL_UFOPAEDIA' : 'PAL_BASESCAPE';
		if (/^BACK0[1-3]|^GRAPH/.test(name)) return 'PAL_GRAPHS';
		if (/^TAC|BORD|ICONS|^MAN_/.test(name)) return 'PAL_BATTLESCAPE';
		return 'PAL_BASESCAPE';
	}

	// ------------------------------------------------------------ geoscape, bases, Ufopaedia
	loadGeographImage(file) {
		const ext = upInv(file.slice(-3));
		const buf = this.gfs.read('GEOGRAPH/' + file);
		if (ext === 'SCR') return F.decodeScr(buf);
		if (ext === 'SPK') return F.decodeSpk(buf);
		if (ext === 'BDY') return F.decodeBdy(buf);
		return null;
	}

	geoImages() {
		// GEO.PAK goes into the SPG; window backgrounds BACKnn.SCR (64 KB each) — BACK.PAK on SD,
		// Ufopaedia pictures — UFOP.PAK on SD (src/kernel/sdres.c)
		const { gfs, ids } = this;
		const geo = new PakWriter(this.game), ufop = new PakWriter(this.game), back = new PakWriter(this.game);
		let nGeo = 0, nUfop = 0, nBack = 0;
		for (const file of gfs.list('GEOGRAPH')) {
			const img = this.loadGeographImage(file);
			if (img === null) continue;
			const isUfop = /^UP\d{3}\./.test(file) || file.startsWith('UP_BORD');
			const isBack = /^BACK\d\d\.SCR$/.test(upInv(file));
			(isUfop ? ufop : isBack ? back : geo).add(ids.id(file), ResType.Img8, Sprites.encodeImg8(img), img.w, img.h);
			if (isUfop) nUfop++; else if (isBack) nBack++; else nGeo++;
			const scr = this.bgScreen.get(upInv(file));
			if (scr !== undefined) this.preview(file, img, null, scr);
			else this.preview(file, img, this.palFor(file));
		}
		{
			const img = F.decodeScr(gfs.read('GEODATA/INTERWIN.DAT'), 160, 600);
			geo.add(ids.id('INTERWIN.DAT'), ResType.Img8, Sprites.encodeImg8(img), img.w, img.h);
			this.preview('INTERWIN.DAT', img, 'PAL_GEOSCAPE');
			nGeo++;
		}
		const sets = [
			['BASEBITS.PCK', () => F.decodePck(gfs.read('GEOGRAPH/BASEBITS.PCK'), gfs.read('GEOGRAPH/BASEBITS.TAB'), 32, 40), 'PAL_BASESCAPE'],
			['INTICON.PCK', () => F.decodePck(gfs.read('GEOGRAPH/INTICON.PCK'), gfs.read('GEOGRAPH/INTICON.TAB'), 32, 40), 'PAL_BASESCAPE'],
			['SCANG.DAT', () => F.decodeDatSet(gfs.read('GEODATA/SCANG.DAT'), 4, 4), 'PAL_GEOSCAPE'],
		];
		for (const [name, load, pal] of sets) {
			const frames = load();
			geo.add(ids.id(name), ResType.Sprset, Sprites.encodeSprset(frames), frames.length, frames[0].w, frames[0].h);
			this.preview(name, Sprites.sheet(frames), pal);
			nGeo++;
		}
		{
			const WorldMap = require('./worldmap'), Globe = require('./globe'), GlobeEdges = require('./globeedges');
			const { data: map, mixed } = WorldMap.build(gfs.read('GEODATA/WORLD.DAT'));
			geo.add(ids.id('WORLDMAP'), ResType.Blob, map, mixed);
			this.report.push(`WORLDMAP: ${mixed} coastal cells, ${this.kb(map.length)} KB`);
			nGeo++;
			const { data: globe, info, arcs } = Globe.build(gfs.read('GEODATA/WORLD.DAT'));
			geo.add(ids.id('GLOBE'), ResType.Blob, globe);
			this.report.push(`GLOBE: ${info}, ${this.kb(globe.length)} KB`);
			nGeo++;
			// precomputed globe views (zooms 0–2) as edges — globe.md §12.11
			const gv = GlobeEdges.build(arcs, path.join(this.outDir, 'GVIEW.PAK'));
			this.report.push(`GVIEW.PAK: ${gv.info}; ${fixed(gv.bytes / 1048576, 1)} MB`);
			// globe patterns: 39 frames 32x32 as is (3 sets of 13, zooms 4–5, 2–3, 0–1)
			const tex = gfs.read('GEOGRAPH/TEXTURE.DAT');
			geo.add(ids.id('TEXTURE.DAT'), ResType.Blob, tex, Math.trunc(tex.length / 1024));
			this.preview('TEXTURE.DAT', Sprites.sheet(F.decodeDatSet(tex, 32, 32)), 'PAL_GEOSCAPE');
			nGeo++;
		}
		const r1 = geo.write(path.join(this.outDir, 'GEO.PAK'));
		const r2 = ufop.write(path.join(this.outDir, 'UFOP.PAK'));
		const r3 = back.write(path.join(this.outDir, 'BACK.PAK'));
		this.report.push(`GEO.PAK: ${nGeo} resources, ${this.kb(r1.bytes)} KB`);
		this.report.push(`UFOP.PAK: ${nUfop} images, ${this.kb(r2.bytes)} KB`);
		this.report.push(`BACK.PAK: ${nBack} backgrounds, ${this.kb(r3.bytes)} KB`);
	}

	// ------------------------------------------------------------ battle interface and items
	// Names as in OpenXcom (Mod::loadBattlescapeResources): UFO panels and TAC01 are SPK
	// under .PCK/.SCR extensions, TFTD — BDY.
	battleUi() {
		const { gfs, ids } = this;
		const bat = new PakWriter(this.game), items = new PakWriter(this.game);
		let nBat = 0, nItems = 0;
		const addImg = (pak, name, img, pal) => { pak.add(ids.id(name), ResType.Img8, Sprites.encodeImg8(img), img.w, img.h); this.preview(name, img, pal); };
		if (gfs.has('UFOGRAPH/TAC00.SCR')) { addImg(bat, 'TAC00.SCR', F.decodeScr(gfs.read('UFOGRAPH/TAC00.SCR')), 'PAL_BATTLESCAPE'); nBat++; }
		for (const name of ['TAC01.SCR', 'DETBORD.PCK', 'DETBORD2.PCK', 'ICONS.PCK', 'MEDIBORD.PCK', 'SCANBORD.PCK', 'UNIBORD.PCK']) {
			if (!gfs.has('UFOGRAPH/' + name)) continue;
			addImg(bat, name, F.decodeSpk(gfs.read('UFOGRAPH/' + name)), 'PAL_BATTLESCAPE'); nBat++;
		}
		for (const file of gfs.list('UFOGRAPH', 'BDY')) {
			const bas = file.slice(0, file.length - 3);
			const name = bas.startsWith('MAN') ? bas + 'SPK' : bas === 'TAC01.' ? bas + 'SCR' : bas + 'PCK';
			const img = F.decodeBdy(gfs.read('UFOGRAPH/' + file));
			if (name.startsWith('MAN')) { addImg(items, name, img, 'PAL_BATTLESCAPE'); nItems++; }
			else { addImg(bat, name, img, 'PAL_BATTLESCAPE'); nBat++; }
		}
		for (const file of gfs.list('UFOGRAPH', 'SPK')) {
			addImg(items, file, F.decodeSpk(gfs.read('UFOGRAPH/' + file)), 'PAL_BATTLESCAPE'); nItems++;
		}
		const setDefs = [
			[bat, 'CURSOR.PCK', 'UFOGRAPH', 32, 40], [bat, 'SMOKE.PCK', 'UFOGRAPH', 32, 40],
			[bat, 'HIT.PCK', 'UFOGRAPH', 32, 40], [bat, 'X1.PCK', 'UFOGRAPH', 128, 64],
			[bat, 'MEDIBITS.DAT', 'UFOGRAPH', 52, 58], [bat, 'DETBLOB.DAT', 'UFOGRAPH', 16, 16],
			[bat, 'SPICONS.DAT', 'UFOGRAPH', 32, 24],
			[items, 'BIGOBS.PCK', 'UNITS', 32, 48], [items, 'FLOOROB.PCK', 'UNITS', 32, 40], [items, 'HANDOB.PCK', 'UNITS', 32, 40],
		];
		for (const [pak, name, dir, w, h] of setDefs) {
			if (!gfs.has(`${dir}/${name}`)) continue;
			const frames = name.endsWith('.DAT')
				? F.decodeDatSet(gfs.read(`${dir}/${name}`), w, h)
				: F.decodePck(gfs.read(`${dir}/${name}`), gfs.read(`${dir}/${name.replace('.PCK', '.TAB')}`), w, h);
			pak.add(ids.id(name), ResType.Sprset, Sprites.encodeSprset(frames), frames.length, w, h);
			this.preview(name, Sprites.sheet(frames, w > 64 ? 4 : 16), 'PAL_BATTLESCAPE');
			if (pak === bat) nBat++; else nItems++;
		}
		const rb = bat.write(path.join(this.outDir, 'BATUI.PAK'));
		const ri = items.write(path.join(this.outDir, 'ITEMS.PAK'));
		this.report.push(`BATUI.PAK: ${nBat} resources, ${this.kb(rb.bytes)} KB`);
		this.report.push(`ITEMS.PAK: ${nItems} resources, ${this.kb(ri.bytes)} KB`);
	}

	// ------------------------------------------------------------ battle maps (BATTLE.PAK)
	// Ready fields from terrain blocks and their tilesets (battle.js, 16_battlescape_plan.md §2.5)
	battleMaps() {
		const { Battle } = require('./battle'), { BattleData } = require('./battledata');
		const pal = this.pal6.has('PAL_BATTLESCAPE') ? this.pal6.get('PAL_BATTLESCAPE') : this.pal6.get('PAL_GEOSCAPE');
		const { info } = new Battle(this.gfs, this.ox, this.ruleFolder, this.game, this.ids, this.report).build(this.outDir, this.prevDir, pal);
		this.report.push('BATTLE.PAK: ' + info);
		// Mission generator data: MCD sets, blocks and tilesets apart (16 §3)
		const battle = new BattleData(this.gfs, this.ox, this.ruleFolder, this.game, this.ids, this.report);
		battle.loadRules();
		battle.loadScripts();
		battle.loadDeployments();
		battle.build(this.outDir, this.prevDir, pal);
	}

	// ------------------------------------------------------------ music (MUSIC.PAK)
	// ADLIB.CAT (+ UFO's AINTRO.CAT past its end) -> per-frame OPL3 stream.
	// Resource id = #0300 + type number in data/music_types.txt.
	musicStep() {
		const { gfs, ox } = this;
		if (!gfs.has('SOUND/ADLIB.CAT')) return;
		const Music = require('./music'), MusicMidi = require('./musicmidi'), MusicAy = require('./musicay'), MusicFm = require('./musicfm');
		const types = Registry.index(Registry.load('music_types.txt'));
		const rules = Y.list(Y.get(Y.load(ox.readText(`standard/${this.ruleFolder}/music.rul`)), 'musics')) || [];
		const adlib = gfs.read('SOUND/ADLIB.CAT'), aEnt = Music.catEntries(adlib);
		const intro = gfs.has('SOUND/AINTRO.CAT') ? gfs.read('SOUND/AINTRO.CAT') : null;
		const iEnt = intro ? Music.catEntries(intro) : [];
		// Second source: the original MIDI (SOUND/GM.CAT, same container as ADLIB.CAT).
		// Same catPos: the catalogues are parallel (22 entries in both games).
		const useMidi = this.musicSource === 'midi' && gfs.has('SOUND/GM.CAT');
		const gm = useMidi ? gfs.read('SOUND/GM.CAT') : null;
		const gEnt = gm ? Music.catEntries(gm) : [];
		const midiCache = new Map();
		let midiNotes = 0;
		const pak = new PakWriter(this.game);
		const payk = new PakWriter(this.game);   // the same track on three AY channels
		const pfm = new PakWriter(this.game);    // and on the FM parts of two YM2203
		const cache = new Map();
		let n = 0, maxw = 0, nloop = 0, nonce = 0, ayMax = 0, fmMax = 0, bytes = 0, ayBytes = 0, fmBytes = 0, secs = 0;
		if (this.prevDir) fs.mkdirSync(path.join(this.prevDir, 'music'), { recursive: true });
		for (const m of rules) {
			const type = Y.str(Y.get(m, 'type'));
			if (!Y.has(m, 'catPos') || type === null || !types.has(type)) continue;
			const catPos = Y.int(Y.get(m, 'catPos'));
			let data;
			if (catPos < aEnt.length) data = Music.catTrack(adlib, aEnt[catPos]);
			else if (intro && catPos - aEnt.length < iEnt.length) data = Music.catTrack(intro, iEnt[catPos - aEnt.length]);
			else continue;
			if (!cache.has(catPos)) {
				const r = Music.renderTrack(data);
				cache.set(catPos, { r, s: Music.encodeStream(r) });
				if (this.prevDir) fs.writeFileSync(path.join(this.prevDir, 'music', `${String(catPos).padStart(2, '0')}_${type}.vgm`), Music.toVgm(r));
				secs += r.seconds;
			}
			const { r: rr, s: ss } = cache.get(catPos);
			// normalization from music.rul (default 0.76) — track volume relative to the others;
			// the stream stays full scale, the player applies the factor with the volume (22 §3.3)
			let vol = Y.toInt(VOL_SCALE * Y.num(Y.get(m, 'normalization'), DEFAULT_NORMALIZATION));
			if (vol > VOL_MAX) vol = VOL_MAX;
			const id = MUS_BASE + types.get(type);
			pak.add(id, ResType.Music, ss.data, rr.frames.length, ss.maxWrites, (vol << 8) | (rr.loop ? 1 : 0));
			// AY and FM voices come from the chosen source: the ADLIB run or MIDI
			let vr = rr;
			if (useMidi && catPos < gEnt.length) {
				if (!midiCache.has(catPos)) {
					const song = MusicMidi.parseCat(Music.catTrack(gm, gEnt[catPos]));
					midiCache.set(catPos, MusicMidi.render(song));
					midiNotes += song.notes;
				}
				vr = midiCache.get(catPos);
			}
			const ay = MusicAy.encode(vr.voices, vr.patches, vr.loop);
			payk.add(id, ResType.Music, ay.data, vr.voices.length, ay.maxWrites, (vol << 8) | (vr.loop ? 1 : 0));
			ayBytes += ay.data.length; ayMax = Math.max(ayMax, ay.maxWrites);
			const fm = MusicFm.encode(vr.voices, vr.patches, vr.loop);
			pfm.add(id, ResType.Music, fm.data, vr.voices.length, fm.maxWrites, (vol << 8) | (vr.loop ? 1 : 0));
			fmBytes += fm.data.length; fmMax = Math.max(fmMax, fm.maxWrites);
			if (rr.loop) nloop++; else nonce++;
			n++; bytes += ss.data.length; maxw = Math.max(maxw, ss.maxWrites);
		}
		const have = new Set();
		for (const m of rules) { const t = Y.str(Y.get(m, 'type')); if (Y.has(m, 'catPos') && t !== null && types.has(t)) have.add(types.get(t)); }
		this.buildMusGroups(types, have);
		const res = pak.write(path.join(this.outDir, 'MUSIC.PAK'));
		const resAy = payk.write(path.join(this.outDir, 'MUSICAY.PAK'));
		const resFm = pfm.write(path.join(this.outDir, 'MUSICFM.PAK'));
		const src = useMidi ? `source MIDI (GM.CAT, ${midiCache.size} tracks, ${midiNotes} notes)` : 'source ADLIB';
		this.report.push(`MUSICAY.PAK: mixed to 3 AY channels, ${src}, ${this.kb(ayBytes)} KB of streams, max ${ayMax} writes/frame (${this.kb(resAy.bytes)} KB)`);
		this.report.push(`MUSICFM.PAK: mixed to 6 FM channels 2 x YM2203, ${src}, ${this.kb(fmBytes)} KB of streams, max ${fmMax} writes/frame (${this.kb(resFm.bytes)} KB)`);
		this.report.push(`MUSIC.PAK: ${n} music types (${nloop} looped, ${nonce} one-shot), ${cache.size} tracks, ${fixed(secs / 60, 1)} min, streams ${this.kb(bytes)} KB, max ${maxw} writes/frame (${this.kb(res.bytes)} KB)`);
	}

	// Music group contents and screen roles (22 §1.3). Groups follow the original rule (the
	// type name contains the group name, Mod.cpp:504), roles come from the rules, not from the
	// engine. Format: u8 n_grp, n_grp x {first, count}, u8 n_kind, n_kind x type, then the pool
	// of type numbers; #FF — "no theme, keep the current one playing".
	buildMusGroups(types, have) {
		const { ox, ruleFolder } = this;
		const iface = screen => {
			const list = Y.list(Y.get(Y.load(ox.readText(`standard/${ruleFolder}/interfaces.rul`)), 'interfaces')) || [];
			for (const o of list) if (Y.str(Y.get(o, 'type')) === screen) return Y.str(Y.get(o, 'music'));
			return null;
		};
		const vars = key => {
			if (!ox.exists(`standard/${ruleFolder}/vars.rul`)) return null;
			return Y.str(Y.get(Y.get(Y.load(ox.readText(`standard/${ruleFolder}/vars.rul`)), 'constants'), key));   // keys live under constants
		};
		const cutscene = type => {
			const list = Y.list(Y.get(Y.load(ox.readText(`standard/${ruleFolder}/cutscenes.rul`)), 'cutscenes')) || [];
			for (const o of list) if (Y.str(Y.get(o, 'type')) === type) return Y.str(Y.get(Y.get(o, 'slideshow'), 'musicId'));
			return null;
		};
		const typeNo = name => (name === null || !types.has(name) || !have.has(types.get(name)) ? NO_TYPE : types.get(name) & 0xFF);
		const pool = [], wins = [];
		for (const grp of MUS_GROUPS) {
			const first = pool.length;
			for (const [k, v] of types) if (k.includes(grp) && have.has(v)) pool.push(v & 0xFF);
			wins.push([first & 0xFF, (pool.length - first) & 0xFF]);
		}
		const kinds = [
			typeNo(iface('mainMenu')), typeNo(iface('soldierMemorial')),
			typeNo(vars('goodDebriefingMusic') ?? 'GMMARS'), typeNo(vars('badDebriefingMusic') ?? 'GMMARS'),
			typeNo('GMTACTIC'), typeNo('GMDEFEND'),
			typeNo(cutscene('loseGame')), typeNo(cutscene('winGame')),
		];
		const o = [wins.length];
		for (const w of wins) o.push(...w);
		o.push(kinds.length, ...kinds, ...pool);
		this.musGrpTable = Buffer.from(o);
		const names = MUS_GROUPS.map((g, i) => `${g} ${wins[i][1]}`);
		this.report.push(`  music groups: ${names.join(', ')}; roles ` + kinds.map(k => (k === NO_TYPE ? '-' : String(k))).join(','));
	}

	// ------------------------------------------------------------ cutscenes (CUTS.PAK)
	// cutscenes.rul (CutsceneState / SlideshowState): slideshows intro, winGame, loseGame, tleth.
	// LBM pictures (IMG8 320x200) — CUTS.PAK on SD; slide palettes and the CUTSCENES table —
	// RULES.PAK (rules()). Table: 4 x u16 record offset (0 — none) in CUT_TYPES order; record:
	// u8 slides, u8 music (music_types number or FF), u8 default seconds, u8 0, then 20-byte
	// slides: u16 picture, u16 palette, u16 caption string (FFFF — none), i16 x, y, w, h,
	// u8 colour, u8 alignment (0 left, 1 centre, 2 right), u8 seconds (0 — default), u8 0.
	// Video (FLI/VID) is not ported.
	cutscenes() {
		const { gfs, ids } = this;
		const doc = Y.list(Y.get(Y.load(this.ox.readText(`standard/${this.ruleFolder}/cutscenes.rul`)), 'cutscenes')) || [];
		const mus = Registry.index(Registry.load('music_types.txt'));
		const pak = new PakWriter(this.game);
		const tab = new Array(CUT_TYPES.length * 2).fill(0);
		const strIndex = this.strIndex || new Map();
		let nImg = 0;
		for (const m of doc) {
			const ti = CUT_TYPES.indexOf(Y.str(Y.get(m, 'type')));
			const show = Y.map(Y.get(m, 'slideshow'));
			if (ti < 0 || show === null) continue;
			const slides = Y.list(Y.get(show, 'slides')) || [];
			const rec = [];
			const music = Y.str(Y.get(show, 'musicId'));
			rec.push(0);
			rec.push(music !== null && mus.has(music) ? mus.get(music) & 0xFF : NO_TYPE);
			rec.push(Y.int(Y.get(show, 'transitionSeconds'), CUT_DEFAULT_SECONDS) & 0xFF);
			rec.push(0);
			let n = 0;
			const w16 = v => { rec.push(v & 0xFF, (v >> 8) & 0xFF); };
			for (const s of slides) {
				const p = Y.str(Y.get(s, 'imagePath'));
				if (p === null || !gfs.has(p)) continue;
				const { img, pal } = F.decodeLbm(gfs.read(p));
				if (img.w !== CUT_W || img.h !== CUT_H) continue;
				const key = 'CUT:' + upInv(p);
				const imgId = ids.id(key), palId = ids.id(key + ':PAL');
				if (!this.cutPals.some(q => q.id === palId)) {
					pak.add(imgId, ResType.Img8, Sprites.encodeImg8(img), img.w, img.h);
					this.cutPals.push({ id: palId, cram: Cram.pal6ToCram(Cram.pal8To6(pal)) });
					nImg++;
					if (this.prevDir) fs.writeFileSync(path.join(this.prevDir, 'CUT_' + path.basename(p, path.extname(p)) + '.png'), Png.encodeIndexed(img, pal));
				}
				const cap = Y.str(Y.get(s, 'caption'));
				const str = cap !== null && strIndex.has(cap) ? strIndex.get(cap) : NO_STR;
				const pos = Y.list(Y.get(s, 'captionPos')), size = Y.list(Y.get(s, 'captionSize'));
				const x = pos ? Y.int(pos[0], 0) : 0, y = pos ? Y.int(pos[1], 0) : 0;
				const w = size ? Y.int(size[0], CUT_W) : CUT_W, h = size ? Y.int(size[1], CUT_H) : CUT_H;
				w16(imgId); w16(palId); w16(str); w16(x); w16(y); w16(w); w16(h);
				rec.push(Y.int(Y.get(s, 'captionColor'), 0) & 0xFF);
				rec.push(Y.int(Y.get(s, 'captionAlign'), 0) & 0xFF);
				rec.push(Y.int(Y.get(s, 'transitionSeconds'), 0) & 0xFF);
				rec.push(0);
				n++;
			}
			if (n === 0) continue;
			rec[0] = n & 0xFF;
			const off = tab.length;
			tab[ti * 2] = off & 0xFF; tab[ti * 2 + 1] = (off >> 8) & 0xFF;
			tab.push(...rec);
		}
		this.cutTable = Buffer.from(tab);
		const r = pak.write(path.join(this.outDir, 'CUTS.PAK'));
		this.report.push(`CUTS.PAK: ${nImg} slides, ${this.kb(r.bytes)} KB; palettes and CUTSCENES table (${this.cutTable.length} B) -> RULES.PAK`);
	}

	// ------------------------------------------------------------ strings and fonts (LANG.PAK)
	langStep() {
		const Strings = require('./strings'), Names = require('./names'), Fonts = require('./fonts');
		const strings = Strings.load(this.ox, this.ruleFolder, this.lang);
		const cs = new Strings.Charset();
		const table = Strings.build(strings, cs);
		const nameWarn = [];
		const names = Names.build(this.ox, cs, nameWarn);   // before cs.glyphs(): name letters go into the fonts
		const glyphs = cs.glyphs();
		const fonts = Fonts.load(this.ox);
		const pak = new PakWriter(this.game);
		const ids = this.ids;
		pak.add(ids.id('STRINGS'), ResType.Str, table.data, table.count, table.engineCount);
		const csBuf = Buffer.alloc(cs.extra.length * 2);
		cs.extra.forEach((c, i) => csBuf.writeUInt16LE(c & 0xFFFF, i * 2));
		pak.add(ids.id('CHARSET'), ResType.Blob, csBuf, cs.extra.length);
		pak.add(ids.id('NAMES'), ResType.Blob, names.data, names.pools, names.names);
		const fr = [];
		for (const id of ['FONT_BIG', 'FONT_SMALL', 'FONT_GEO_BIG', 'FONT_GEO_SMALL']) {
			const f = fonts.get(id);
			const { data, missing } = Fonts.encode(f, glyphs);
			pak.add(ids.id(id), ResType.Font, data, glyphs.length, f.w, f.h);
			fr.push(`${id} ${f.w}x${f.h} ${fixed(data.length / 1024, 1)} KB` + (missing > 0 ? `, no glyph: ${missing}` : ''));
			if (this.prevDir) this.previewText(f, `${id}: X-COM TERROR FROM THE DEEP 0123456789 abc xyz !?.,:`);
		}
		const r = pak.write(path.join(this.outDir, 'LANG.PAK'));
		this.report.push(`LANG.PAK (${this.lang}): ${table.count} strings (${table.engineCount} engine, ${table.missing.length} of them absent), ${cs.extra.length} non-ASCII chars, ${this.kb(r.bytes)} KB`);
		for (const s of fr) this.report.push('  ' + s);
		this.report.push(`  NAMES: ${names.pools} pools, ${names.names} names, ${this.kb(names.data.length)} KB`);
		for (const w of nameWarn) this.report.push('  ' + w);
		this.strIndex = table.index;
	}

	previewText(font, text) {
		const glyph = ch => font.glyphs.get(ch.charCodeAt(0)) || null;
		let w = 0;
		for (const ch of text) { const g = glyph(ch); w += (ch === ' ' ? font.w >> 1 : g ? g.w : font.w) + font.spacing + 1; }
		const img = new F.Img(w + 4, font.h + 4);
		let x = 2;
		for (const ch of text) {
			const g = glyph(ch);
			if (ch === ' ' || !g) { x += (font.w >> 1) + font.spacing + 1; continue; }
			for (let y = 0; y < g.h; y++)
				for (let xx = 0; xx < g.w; xx++) {
					const v = g.img.px[(g.y + y) * g.img.w + g.x + xx];
					if (v !== 0) img.px[(y + 2) * img.w + x + xx] = v;
				}
			x += g.w + font.spacing + 1;
		}
		const pal = Buffer.alloc(768);
		const cols = [[0, 0, 32], [255, 255, 255], [200, 200, 200], [150, 150, 150], [100, 100, 255], [60, 60, 180]];
		cols.forEach((c, i) => { for (let k = 0; k < 3; k++) pal[i * 3 + k] = c[k]; });
		fs.writeFileSync(path.join(this.prevDir, `text_${font.id}.png`), Png.encodeIndexed(img, pal));
	}

	// ------------------------------------------------------------ rules (RULES.PAK)
	rules() {
		const Interfaces = require('./interfaces'), { RuleSet } = require('./rules'), RulesSchema = require('./rulesschema'), GlobeDetail = require('./globedetail');
		const ids = this.ids;
		const pak = new PakWriter(this.game);
		const ui = Interfaces.build(this.ox, this.ruleFolder, ids);
		pak.add(ids.id('UI'), ResType.Table, ui.data, ui.screens);
		const sections = RuleSet.loadSections(this.ox, this.ruleFolder);
		const schema = RulesSchema.tables();
		const rs = new RuleSet(sections, schema, this.strIndex || new Map(), n => ids.id(n));
		rs.resFind = n => ids.find(n);
		const parts = [];
		schema.forEach((t, i) => {
			const b = rs.build(t);
			pak.add(RulesSchema.RES_BASE + i, ResType.Table, b.data, b.count, b.recSize);
			parts.push(`${t.name} ${b.count}x${b.recSize}`);
		});
		if (this.musGrpTable) pak.add(ids.id('MUSGRP'), ResType.Table, this.musGrpTable, MUS_GROUPS.length);
		const det = GlobeDetail.build(rs, sections, this.ox, this.ruleFolder);   // globe details: lines, labels, cities
		pak.add(ids.id('GLOBEDET'), ResType.Blob, det.data);
		parts.push('GLOBEDET: ' + det.info);
		const vars = RulesSchema.vars(sections, rs);
		pak.add(RulesSchema.RES_BASE - 1, ResType.Table, vars, vars.length);
		if (this.cutTable) {                         // cutscenes: table and slide palettes (cutscenes())
			pak.add(ids.id('CUTSCENES'), ResType.Blob, this.cutTable, CUT_TYPES.length);
			for (const { id, cram } of this.cutPals) pak.add(id, ResType.Pal, cram, PAL_COLORS);
		}
		const r = pak.write(path.join(this.outDir, 'RULES.PAK'));
		this.report.push(`RULES.PAK: UI ${ui.screens} screens` + (ui.unknown.length > 0 ? ', not in registry: ' + ui.unknown.join(', ') : '') + `; ${this.kb(r.bytes)} KB`);
		this.report.push('  ' + parts.join(', '));
		if (rs.warnings.length > 0) {
			fs.writeFileSync(path.join(this.outDir, 'RULEWARN.TXT'), rs.warnings.join('\r\n') + '\r\n', 'utf8');
			this.report.push(`  ${rs.warnings.length} warnings -> RULEWARN.TXT`);
		}
	}
}

module.exports = { Converter };
