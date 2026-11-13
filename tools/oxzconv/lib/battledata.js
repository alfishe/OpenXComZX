// Data for the battlescape mission generator (16_battlescape_plan.md §3): MCD sets, map blocks
// and tilesets per set. Unlike battle.js, which tiled a ready field itself, everything here goes
// separately — the engine builds the map from mapScript, as OpenXcom does
// (BattlescapeGenerator::generateMap).
//
// Formats (u16 — low byte first):
//
// MCDSET_<set> (Blob, a = part count) — the set's part table, 12 bytes each:
//   u16 frame   first frame number in this set's tileset (MCD.Frame[0])
//   u8  yofs    P_Level: how many pixels the part is lowered when drawn
//   u8  flags   1 no floor, 2 blocks LOS, 4 UFO door, 8 door, 16 grav lift
//   u8  bigwall big wall type (0 — none)
//   u8  type    tile_type (MCD.TileType): 0 floor, 1 west wall, 2 north wall, 3 object
//   i8  tlevel  T_Level
//   u8  tu      MCD.TU_Walk: walk cost, 255 — impassable (walls too)
//   u8  alt     MCD.Alt_MCD: what an opened door turns into (part number in this set)
//   u16 frame7  MCD.Frame[7]: frame of an open UFO door (it slides instead of changing part)
//   u8  0       spare
//
// MAPBLK_<block> (Blob, a = sx, b = sy, c = sz) — map block as in the original, but bottom up:
//   u8 sx, sy, sz, 0; then sx*sy*sz cells of 4 bytes (floor, west wall, north wall, object).
//   A cell byte is the running part number across the sets of the terrain that owns the block
//   (0 — empty), exactly as in the original MAP: the engine turns it into the mission's part
//   number by subtracting the set sizes in order (RuleTerrain::getMapData).
//
// TILESET_<set> (Sprset) — the set's frames, 32x40.
'use strict';
const path = require('path');
const Y = require('./yaml');
const { PakWriter, ResType } = require('./pack');
const { upInv } = require('./text');
const F = require('./formats');
const Sprites = require('./sprites');
const { readMcd, readMap, mcdFlags, TILE_W, TILE_H } = require('./battle');

const DEFAULT_BLOCK = 10, DEFAULT_DEPLOY_SIZE = 50, DEFAULT_DEPLOY_HEIGHT = 4, CELLS_PER_MODULE = 10;
const MAX_DEPLOY_TERRAINS = 4;
const MCDSET_RECORD = 12;
const MAPBLK_HDR = 4;
const DEFAULT_CHANCES = 100;
const NONE16 = 0xFFFF, NONE8 = 0xFF;
const GROUP_BITS = 15;
const KB = 1024, HALF_KB = 512;
const KIND_TERRAIN = 0, KIND_CRAFT = 1, KIND_UFO = 2;
const REPL_OBJECT = 3;

// mapScript commands in MapScript.h:45 order — the engine decodes them by these numbers
const C_ADD_BLOCK = 0, C_ADD_LINE = 1, C_ADD_CRAFT = 2, C_ADD_UFO = 3,
	C_DIG_TUNNEL = 4, C_FILL_AREA = 5, C_CHECK_BLOCK = 6, C_REMOVE_BLOCK = 7, C_RESIZE = 8;

// Unit sheets (UNITS/*.PCK): poses "standing" and "kneeling" in eight directions
// (UnitSprite::drawRoutine0: larm 0, rarm 8, legsStand 16, legsKneel 24, torso 32 in UFO and
// 270 for TFTD ground units). Frame order in the sheet, 40 frames:
//   0-7 left arm, 8-15 right arm, 16-23 legs standing, 24-31 torso, 32-39 legs kneeling.
const UNIT_ARMS_LEGS = 24, UNIT_DIRS = 8, TORSO_UFO = 32, TORSO_TFTD = 270, TFTD_TORSO_MIN_FRAMES = 277;
const KNEEL_FIRST = 24, KNEEL_END = 32;
const ITEM_SHEETS = ['BIGOBS', 'FLOOROB', 'HANDOB'];   // these live in ITEMS.PAK

const u16 = (to, v) => { to.push(v & 0xFF, (v >> 8) & 0xFF); };

// groups: a number or a list of numbers. OpenXcom groups: 0 normal, 1 landing zone,
// 2 road crossing, 3 road V, 4 road H, 5 UFO, 6 craft (MapBlockType)
function groupMask(v) {
	if (v === null) return 1;                       // default group 0
	let m = 0;
	const l = Y.list(v);
	if (l) for (const x of l) m |= 1 << (Y.int(x) & GROUP_BITS);
	else m |= 1 << (Y.int(v) & GROUP_BITS);
	return m;
}

class BattleData {
	constructor(gfs, ox, ruleFolder, game, ids, report) {
		this.gfs = gfs; this.ox = ox; this.ruleFolder = ruleFolder; this.game = game; this.ids = ids; this.report = report;
		this.terrains = [];
		this.scripts = [];
		this.deploys = [];
		this.setSize = new Map();
	}

	rul(file) { return Y.load(this.ox.readText(`standard/${this.ruleFolder}/${file}`)); }

	// ---------------------------------------------------------------- rules
	// Terrains come from terrains.rul and from battlescapeTerrainData of crafts and UFOs: they
	// have the same structure (sets + blocks), and the generator puts them over the field.
	loadRules() {
		const add = (o, nameField, kind = KIND_TERRAIN) => {
			const t = { name: Y.str(Y.get(o, nameField)), script: Y.str(Y.get(o, 'script')), kind, sets: [], blocks: [] };
			if (t.name === null) return;
			for (const s of Y.list(Y.get(o, 'mapDataSets')) || []) t.sets.push(Y.str(s));
			for (const b of Y.list(Y.get(o, 'mapBlocks')) || []) {
				const blk = {
					name: Y.str(Y.get(b, 'name')),
					w: Y.int(Y.get(b, 'width'), DEFAULT_BLOCK),
					l: Y.int(Y.get(b, 'length'), DEFAULT_BLOCK),
					sz: 0,
					groups: groupMask(Y.get(b, 'groups')),
				};
				if (blk.name !== null) t.blocks.push(blk);
			}
			if (t.sets.length !== 0 && t.blocks.length !== 0) this.terrains.push(t);
		};
		for (const o of Y.list(Y.get(this.rul('terrains.rul'), 'terrains')) || []) add(o, 'name');
		// crafts and UFOs: their map is in battlescapeTerrainData, terrain name = map name
		for (const file of ['crafts.rul', 'ufos.rul']) {
			const list = Y.list(Y.get(this.rul(file), file === 'crafts.rul' ? 'crafts' : 'ufos'));
			for (const o of list || []) {
				const d = Y.get(o, 'battlescapeTerrainData');
				if (d !== null) add(d, 'name', file === 'crafts.rul' ? KIND_CRAFT : KIND_UFO);
			}
		}
	}

	// Deployment fields (alienDeployments.rul): map size, script and terrains. Record order is
	// that of the alienDeployments rule table — the engine takes them by its number.
	loadDeployments() {
		for (const o of Y.list(Y.get(this.rul('alienDeployments.rul'), 'alienDeployments')) || []) {
			const d = {
				w: Math.trunc(Y.int(Y.get(o, 'width'), DEFAULT_DEPLOY_SIZE) / CELLS_PER_MODULE),
				l: Math.trunc(Y.int(Y.get(o, 'length'), DEFAULT_DEPLOY_SIZE) / CELLS_PER_MODULE),
				h: Y.int(Y.get(o, 'height'), DEFAULT_DEPLOY_HEIGHT),
				script: this.scriptIndex(Y.str(Y.get(o, 'script'))),
				terrains: [],
			};
			for (const t of Y.list(Y.get(o, 'terrains')) || []) {
				const i = this.terrainIndex(Y.str(t));
				if (i >= 0 && d.terrains.length < MAX_DEPLOY_TERRAINS) d.terrains.push(i);
			}
			this.deploys.push(d);
		}
	}

	// DEPLOYS (Blob, a = record count), 12 bytes each:
	//   u8 modules in X, u8 in Y, u8 floors, i16 script (-1 — from the terrain),
	//   u8 terrain count, u8 terr[4] — their numbers, u8 spare
	encodeDeploys() {
		const b = [];
		u16(b, this.deploys.length);
		for (const d of this.deploys) {
			b.push(d.w & 0xFF, d.l & 0xFF, d.h & 0xFF);
			b.push(d.script < 0 ? NONE8 : d.script & 0xFF, d.script < 0 ? NONE8 : (d.script >> 8) & 0xFF);
			b.push(d.terrains.length);
			for (let i = 0; i < MAX_DEPLOY_TERRAINS; i++) b.push(i < d.terrains.length ? d.terrains[i] & 0xFF : 0);
			b.push(0);
		}
		return Buffer.from(b);
	}

	// mapScripts.rul: list of scripts, each with a list of commands (MapScript::load)
	loadScripts() {
		const cmdName = new Map([
			['addBlock', C_ADD_BLOCK], ['addLine', C_ADD_LINE], ['addCraft', C_ADD_CRAFT],
			['addUFO', C_ADD_UFO], ['digTunnel', C_DIG_TUNNEL], ['fillArea', C_FILL_AREA],
			['checkBlock', C_CHECK_BLOCK], ['removeBlock', C_REMOVE_BLOCK], ['resize', C_RESIZE],
		]);
		// case-insensitive lookups (StringComparer.OrdinalIgnoreCase)
		const dirName = new Map([['VERTICAL', 1], ['HORIZONTAL', 2], ['BOTH', 3]]);
		// tunnel replacement type: 0 floor, 1 west wall, 2 north wall, 3 object
		const replName = new Map([['FLOOR', 0], ['WESTWALL', 1], ['NORTHWALL', 2], ['OBJECT', REPL_OBJECT]]);

		for (const o of Y.list(Y.get(this.rul('mapScripts.rul'), 'mapScripts')) || []) {
			const sc = { name: Y.str(Y.get(o, 'type')), commands: [] };
			if (sc.name === null) continue;
			for (const c of Y.list(Y.get(o, 'commands')) || []) {
				const ct = Y.str(Y.get(c, 'type'));
				if (ct === null || !cmdName.has(ct)) { this.report.push(`  battle: script ${sc.name}: unknown command ${ct ?? ''}`); continue; }
				const cm = {
					type: cmdName.get(ct), size: 1, direction: 0, chances: DEFAULT_CHANCES, executions: 1, label: 0, ufo: -1, tunnelLevel: -1,
					rects: [], groups: [], blocks: [], freqs: [], maxUses: [], conditionals: [], replacements: [],
				};
				cm.size = Y.int(Y.get(c, 'size'), 1);
				const dir = Y.str(Y.get(c, 'direction'));
				if (dir !== null && dirName.has(upInv(dir))) cm.direction = dirName.get(upInv(dir));
				cm.chances = Y.int(Y.get(c, 'executionChances'), DEFAULT_CHANCES);
				cm.executions = Y.int(Y.get(c, 'executions'), 1);
				cm.label = Y.int(Y.get(c, 'label'), 0);
				for (const r of Y.list(Y.get(c, 'rects')) || []) {
					const v = Y.list(r);
					for (let i = 0; i < 4; i++) cm.rects.push(v && i < v.length ? Y.int(v[i]) : 0);
				}
				const nums = (field, to) => {
					const v = Y.get(c, field);
					if (v === null) return;
					const l = Y.list(v);
					if (l) for (const x of l) to.push(Y.int(x));
					else to.push(Y.int(v));
				};
				nums('groups', cm.groups); nums('blocks', cm.blocks); nums('freqs', cm.freqs);
				nums('maxUses', cm.maxUses); nums('conditionals', cm.conditionals);
				const td = Y.get(c, 'tunnelData');
				if (td !== null) {
					cm.tunnelLevel = Y.int(Y.get(td, 'level'), 0);
					for (const r of Y.list(Y.get(td, 'MCDReplacements')) || []) {
						const rt = Y.str(Y.get(r, 'type'));
						cm.replacements.push(rt !== null && replName.has(upInv(rt)) ? replName.get(upInv(rt)) : REPL_OBJECT);
						cm.replacements.push(Y.int(Y.get(r, 'set'), -1));
						cm.replacements.push(Y.int(Y.get(r, 'entry'), -1));
					}
				}
				// UFOName refers to a terrain from ufos.rul — resolved to its number here
				cm.ufo = this.terrainIndex(Y.str(Y.get(c, 'UFOName')));
				sc.commands.push(cm);
			}
			this.scripts.push(sc);
		}
	}

	terrainIndex(name) { return name === null ? -1 : this.terrains.findIndex(t => t.name === name); }
	scriptIndex(name) { return name === null ? -1 : this.scripts.findIndex(s => s.name === name); }

	// ---------------------------------------------------------------- engine tables
	// TERRAINS (Blob, a = terrain count): u16 n, n x u16 record offset; record:
	//   i16 script (-1 none), u8 nSets, u8 nBlocks, u8 kind (0 terrain, 1 craft, 2 UFO),
	//   nSets x { u16 MCDSET, u16 TILESET },
	//   nBlocks x { u16 MAPBLK resource, u8 w, u8 l, u8 sz, u8 groups } — sizes in cells,
	//   groups — the block's group mask (bit 0 — normal, 1 — landing zone, …).
	encodeTerrains() {
		const { ids } = this;
		const head = [], body = [];
		u16(head, this.terrains.length);
		const tableEnd = 2 + this.terrains.length * 2;
		for (const t of this.terrains) {
			u16(head, tableEnd + body.length);
			const si = t.script === null ? -1 : this.scriptIndex(t.script);
			u16(body, si < 0 ? NONE16 : si);
			body.push(t.sets.length & 0xFF, t.blocks.length & 0xFF, t.kind);
			for (const s of t.sets) { u16(body, ids.id(`MCDSET_${s}`)); u16(body, ids.id(`TILESET_${s}`)); }
			for (const b of t.blocks) {
				u16(body, ids.id(`MAPBLK_${b.name}`));
				body.push(b.w & 0xFF, b.l & 0xFF, b.sz & 0xFF, b.groups & 0xFF);
			}
		}
		return Buffer.from(head.concat(body));
	}

	// MAPSCRIPTS (Blob, a = script count): u16 n, n x u16 offset; script: u16 commands, then
	// the commands. Command (all fields i16, length in words first):
	//   len, type, size, direction, chances, executions, label, ufo (terrain number), tunnelLevel,
	//   nRects, nGroups, nBlocks, nFreqs, nMaxUses, nCond, nRepl, then the lists in this order.
	encodeScripts() {
		const head = [], body = [];
		u16(head, this.scripts.length);
		const tableEnd = 2 + this.scripts.length * 2;
		for (const sc of this.scripts) {
			u16(head, tableEnd + body.length);
			u16(body, sc.commands.length);
			for (const c of sc.commands) {
				const w = [0, c.type, c.size, c.direction, c.chances, c.executions, c.label, c.ufo, c.tunnelLevel,
					Math.trunc(c.rects.length / 4), c.groups.length, c.blocks.length, c.freqs.length, c.maxUses.length,
					c.conditionals.length, Math.trunc(c.replacements.length / 3),
					...c.rects, ...c.groups, ...c.blocks, ...c.freqs, ...c.maxUses, ...c.conditionals, ...c.replacements];
				w[0] = w.length;
				for (const v of w) u16(body, v & 0xFFFF);
			}
		}
		return Buffer.from(head.concat(body));
	}

	// ---------------------------------------------------------------- data
	build(outDir, prevDir, pal) {
		const { gfs, ids, report } = this;
		const mcdPak = new PakWriter(this.game), mapPak = new PakWriter(this.game), tilePak = new PakWriter(this.game);
		const doneSets = new Set(), doneBlocks = new Set();
		let nSets = 0, nBlocks = 0, mcdBytes = 0, tileBytes = 0, mapBytes = 0;

		for (const t of this.terrains) {
			for (const s of t.sets) {
				if (doneSets.has(s)) continue;
				doneSets.add(s);
				if (!gfs.has(`TERRAIN/${s}.MCD`)) { report.push(`  battle: no TERRAIN/${s}.MCD`); continue; }
				const parts = readMcd(gfs.read(`TERRAIN/${s}.MCD`));
				this.setSize.set(s, parts.length);
				const data = Buffer.alloc(parts.length * MCDSET_RECORD);
				parts.forEach((r, i) => {
					const o = i * MCDSET_RECORD;
					data[o] = r.frame[0]; data[o + 1] = 0;          // the set's frames go in a row
					data[o + 2] = r.pLevel & 0xFF;
					data[o + 3] = mcdFlags(r);
					data[o + 4] = r.bigWall & 0xFF;
					data[o + 5] = r.tileType & 0xFF;
					data[o + 6] = r.tLevel & 0xFF;
					data[o + 7] = r.tuWalk & 0xFF;
					data[o + 8] = r.alt & 0xFF;
					data[o + 9] = r.frame[7]; data[o + 10] = 0;
				});
				mcdPak.add(ids.id(`MCDSET_${s}`), ResType.Blob, data, parts.length);
				mcdBytes += data.length;
				nSets++;

				if (!gfs.has(`TERRAIN/${s}.PCK`) || !gfs.has(`TERRAIN/${s}.TAB`)) continue;
				const frames = F.decodePck(gfs.read(`TERRAIN/${s}.PCK`), gfs.read(`TERRAIN/${s}.TAB`), TILE_W, TILE_H);
				const sprset = Sprites.encodeSprset(frames);
				tilePak.add(ids.id(`TILESET_${s}`), ResType.Sprset, sprset, frames.length, TILE_W, TILE_H);
				tileBytes += sprset.length;
			}

			for (const b of t.blocks) {
				if (doneBlocks.has(b.name)) continue;
				doneBlocks.add(b.name);
				if (!gfs.has(`MAPS/${b.name}.MAP`)) { report.push(`  battle: no MAPS/${b.name}.MAP`); continue; }
				const m = readMap(gfs.read(`MAPS/${b.name}.MAP`));
				b.sz = m.sz;
				const data = Buffer.alloc(MAPBLK_HDR + m.cells.length);
				data[0] = m.sx; data[1] = m.sy; data[2] = m.sz;
				m.cells.copy(data, MAPBLK_HDR);
				mapPak.add(ids.id(`MAPBLK_${b.name}`), ResType.Blob, data, m.sx, m.sy, m.sz);
				mapBytes += data.length;
				nBlocks++;
			}
		}
		// block sizes from the rules may differ from the file — the engine needs the real ones
		for (const t of this.terrains)
			for (const b of t.blocks)
				if (b.sz === 0 && gfs.has(`MAPS/${b.name}.MAP`)) b.sz = gfs.read(`MAPS/${b.name}.MAP`)[2];

		// Unit sprites (UNITS/*.PCK): 32x40 frames, UnitSprite builds a soldier from them —
		// legs, torso and arms by direction. Whole sheets don't fit a SPRSET and aren't needed:
		// only the standing and kneeling poses (other poses — when animation comes).
		const unitPak = new PakWriter(this.game);
		let nUnits = 0;
		for (const file of gfs.list('UNITS', 'PCK')) {
			const name = file.slice(0, file.length - 4);
			if (ITEM_SHEETS.includes(name)) continue;
			if (!gfs.has(`UNITS/${name}.TAB`)) continue;
			const all = F.decodePck(gfs.read(`UNITS/${name}.PCK`), gfs.read(`UNITS/${name}.TAB`), TILE_W, TILE_H);
			if (all.length === 0) continue;
			const torso = this.game === 'TFTD' && all.length > TFTD_TORSO_MIN_FRAMES ? TORSO_TFTD : TORSO_UFO;
			const idx = [];
			for (let i = 0; i < UNIT_ARMS_LEGS; i++) idx.push(i);
			for (let i = 0; i < UNIT_DIRS; i++) idx.push(torso + i);
			for (let i = KNEEL_FIRST; i < KNEEL_END; i++) idx.push(i);   // legs kneeling
			const frames = idx.map(i => (i < all.length ? all[i] : all[0]));
			const sprset = Sprites.encodeSprset(frames);
			unitPak.add(ids.id(`UNIT_${name}`), ResType.Sprset, sprset, frames.length, TILE_W, TILE_H);
			nUnits++;
		}
		const ru = unitPak.write(path.join(outDir, 'UNITS.PAK'));
		report.push(`UNITS.PAK: ${nUnits} sheets, ${Math.trunc((ru.bytes + HALF_KB) / KB)} KB`);

		mcdPak.add(ids.id('TERRAINS'), ResType.Blob, this.encodeTerrains(), this.terrains.length);
		mcdPak.add(ids.id('MAPSCRIPTS'), ResType.Blob, this.encodeScripts(), this.scripts.length);
		mcdPak.add(ids.id('DEPLOYS'), ResType.Blob, this.encodeDeploys(), this.deploys.length);
		const rm = mcdPak.write(path.join(outDir, 'MCD.PAK'));
		const rb = mapPak.write(path.join(outDir, 'MAPS.PAK'));
		const rt = tilePak.write(path.join(outDir, 'TILES.PAK'));
		report.push(`MCD.PAK: ${nSets} sets, ${Math.trunc((rm.bytes + HALF_KB) / KB)} KB`);
		report.push(`MAPS.PAK: ${nBlocks} blocks, ${Math.trunc((rb.bytes + HALF_KB) / KB)} KB`);
		report.push(`TILES.PAK: ${Math.trunc((rt.bytes + HALF_KB) / KB)} KB`);
		return { sets: nSets, blocks: nBlocks, mcdBytes, mapBytes, tileBytes };
	}
}

module.exports = { BattleData, C_ADD_BLOCK, C_ADD_LINE, C_ADD_CRAFT, C_ADD_UFO, C_DIG_TUNNEL, C_FILL_AREA, C_CHECK_BLOCK, C_REMOVE_BLOCK, C_RESIZE };
