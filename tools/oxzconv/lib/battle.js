// Battlescape resources: tilesets (TERRAIN/*.MCD + *.PCK) and ready maps (16_battlescape_plan.md §2.5).
// First stage — drawing only: the converter tiles a field from blocks itself and puts the ready
// map into BATTLE.PAK (read from SD).
//
// BATMAP<i> (Blob, a = sx, b = sy, c = sz): u8 sx, sy, sz, ntiles; u16 tileset (SPRSET);
// u8 level (camera floor), u8 0; then ntiles records of 4 bytes (u8 yofs = MCD.P_Level,
// u8 flags, u8 bigwall, u8 tile_type); then sx*sy*sz cells of 4 bytes — tile numbers + 1
// (floor, west wall, north wall, object), 0 — empty. Cell order: X fastest, then Y, then Z
// bottom up (the original stores Z top down — the converter flips it).
// Tile number = frame number in the map's tileset.
'use strict';
const fs = require('fs');
const path = require('path');
const Y = require('./yaml');
const { PakWriter, ResType } = require('./pack');
const F = require('./formats');
const Sprites = require('./sprites');
const Cram = require('./cram');
const Png = require('./png');

const TILE_W = 32, TILE_H = 40, VIEW_W = 320, VIEW_H = 144;
const MAP_COUNT = 3;          // how many maps to prepare (the engine takes them in turn)
const BLOCK_CELLS = 10;       // only 10x10 blocks are used for tiling
const MAX_SMALL_BLOCKS = 16;
const FIELD_BLOCKS = 4;       // 4x4 blocks = 40x40 cells
const MAX_TILES = 255;
const MCD_RECORD = 62;
const CELL_BYTES = 4;
const KB = 1024, HALF_KB = 512;
// isometric projection of the preview
const ISO_DX = 16, ISO_DY = 8, LEVEL_DY = 24;

// Which terrains to tile the maps with: the first available ones (names — terrains.rul)
const TFTD_TERRAINS = ['SEABED', 'CORAL', 'VOLC', 'PIPES', 'ISLAND'];
const UFO_TERRAINS = ['CULTA', 'DESERT', 'FOREST', 'MOUNT', 'JUNGLE'];

// MCD flag bits shared with battledata.js
const MCD_NO_FLOOR = 1, MCD_STOP_LOS = 2, MCD_UFO_DOOR = 4, MCD_DOOR = 8, MCD_GRAV_LIFT = 16;
const mcdFlags = r => (r.noFloor ? MCD_NO_FLOOR : 0) | (r.stopLOS ? MCD_STOP_LOS : 0) | (r.ufoDoor ? MCD_UFO_DOOR : 0)
	| (r.door ? MCD_DOOR : 0) | (r.gravLift ? MCD_GRAV_LIFT : 0);

// MCD: 62 bytes per record (Mod/MapDataSet.cpp:107-153)
function readMcd(buf) {
	const l = [];
	for (let p = 0; p + MCD_RECORD <= buf.length; p += MCD_RECORD) {
		l.push({
			frame: Buffer.from(buf.subarray(p, p + 8)),
			scanG: buf[p + 20] | (buf[p + 21] << 8),
			ufoDoor: buf[p + 30] !== 0, stopLOS: buf[p + 31] !== 0, noFloor: buf[p + 32] !== 0,
			bigWall: buf[p + 33], gravLift: buf[p + 34] !== 0, door: buf[p + 35] !== 0,
			tuWalk: buf[p + 39], alt: buf[p + 46],          // walk cost (255 — impassable) and the door's replacement part
			tLevel: buf.readInt8(p + 48), pLevel: buf[p + 49],
			tileType: buf[p + 53],
			frameBase: 0,
		});
	}
	return l;
}

class MapBlock {
	constructor(sx, sy, sz) { this.sx = sx; this.sy = sy; this.sz = sz; this.cells = Buffer.alloc(sx * sy * sz * CELL_BYTES); }   // Z bottom up
	cell(x, y, z, k) { return this.cells[(((z * this.sy + y) * this.sx + x) * CELL_BYTES) + k]; }
}

// MAP: u8 sizeY, sizeX, sizeZ, then 4 bytes per cell; Z top down (BattlescapeGenerator.cpp:1577)
function readMap(buf) {
	const sy = buf[0], sx = buf[1], sz = buf[2];
	const m = new MapBlock(sx, sy, sz);
	let p = 3;
	for (let z = sz - 1; z >= 0; z--)
		for (let y = 0; y < sy; y++)
			for (let x = 0; x < sx; x++) {
				const o = ((z * sy + y) * sx + x) * CELL_BYTES;
				for (let k = 0; k < CELL_BYTES; k++) m.cells[o + k] = p < buf.length ? buf[p++] : 0;
			}
	return m;
}

// Field of n x n blocks (as mapScript tiles it: blocks in order, repeating)
function tile(blocks, n) {
	const bw = blocks[0].sx, bh = blocks[0].sy, sz = Math.max(...blocks.map(b => b.sz));
	const m = new MapBlock(bw * n, bh * n, sz);
	for (let by = 0; by < n; by++)
		for (let bx = 0; bx < n; bx++) {
			const b = blocks[(by * n + bx) % blocks.length];
			for (let z = 0; z < b.sz; z++)
				for (let y = 0; y < b.sy && by * bh + y < m.sy; y++)
					for (let x = 0; x < b.sx && bx * bw + x < m.sx; x++) {
						const from = ((z * b.sy + y) * b.sx + x) * CELL_BYTES;
						const to = ((z * m.sy + by * bh + y) * m.sx + bx * bw + x) * CELL_BYTES;
						for (let k = 0; k < CELL_BYTES; k++) m.cells[to + k] = b.cells[from + k];
					}
		}
	return m;
}

// Math.Round(double) — banker's rounding
function roundEven(v) {
	const f = Math.floor(v), d = v - f;
	if (d > 0.5) return f + 1;
	if (d < 0.5) return f;
	return f % 2 === 0 ? f : f + 1;
}

function draw(dst, src, x0, y0) {
	for (let y = 0; y < src.h; y++) {
		const py = y0 + y;
		if (py < 0 || py >= dst.h) continue;
		for (let x = 0; x < src.w; x++) {
			const v = src.px[y * src.w + x];
			const px = x0 + x;
			if (v === 0 || px < 0 || px >= dst.w) continue;
			dst.px[py * dst.w + px] = v;
		}
	}
}

// Reference view to compare with the emulator: painter's algorithm, camera at the map centre
function renderPreview(map, parts, frames, level) {
	const img = new F.Img(VIEW_W, VIEW_H);
	const cx = map.sx / 2, cy = map.sy / 2;
	const ox = roundEven(VIEW_W / 2 - (cx - cy) * ISO_DX);
	const oy = roundEven(VIEW_H / 2 - ((cx + cy) * ISO_DY - level * LEVEL_DY));
	for (let z = 0; z <= level && z < map.sz; z++)
		for (let x = 0; x < map.sx; x++)
			for (let y = 0; y < map.sy; y++) {
				const sx = (x - y) * ISO_DX + ox, sy = (x + y) * ISO_DY - z * LEVEL_DY + oy;
				if (sx <= -TILE_W || sx >= VIEW_W || sy <= -TILE_H || sy >= VIEW_H) continue;
				for (let k = 0; k < CELL_BYTES; k++) {
					const v = map.cell(x, y, z, k);
					if (v === 0 || v - 1 >= parts.length) continue;
					const rec = parts[v - 1];
					const f = rec.frameBase + rec.frame[0];
					if (f >= frames.length) continue;
					draw(img, frames[f], sx, sy - rec.pLevel);
				}
			}
	return img;
}

class Battle {
	constructor(gfs, ox, ruleFolder, game, ids, report) {
		this.gfs = gfs; this.ox = ox; this.ruleFolder = ruleFolder; this.game = game; this.ids = ids; this.report = report;
	}

	loadTerrains() {
		const d = new Map();
		const list = Y.list(Y.get(Y.load(this.ox.readText(`standard/${this.ruleFolder}/terrains.rul`)), 'terrains')) || [];
		for (const o of list) {
			const t = { name: Y.str(Y.get(o, 'name')), sets: [], blocks: [] };
			if (t.name === null) continue;
			for (const s of Y.list(Y.get(o, 'mapDataSets')) || []) t.sets.push(Y.str(s));
			for (const b of Y.list(Y.get(o, 'mapBlocks')) || [])
				t.blocks.push({ name: Y.str(Y.get(b, 'name')), w: Y.int(Y.get(b, 'width'), BLOCK_CELLS), l: Y.int(Y.get(b, 'length'), BLOCK_CELLS) });
			d.set(t.name, t);
		}
		return d;
	}

	// MCD records and frames of all the terrain's sets back to back — MAP numbers them the same way
	loadSets(t) {
		const { gfs } = this;
		const parts = [], frames = [];
		for (const s of t.sets) {
			if (!gfs.has(`TERRAIN/${s}.MCD`)) { this.report.push(`  battle: no TERRAIN/${s}.MCD`); continue; }
			const mcd = readMcd(gfs.read(`TERRAIN/${s}.MCD`));
			const pck = F.decodePck(gfs.read(`TERRAIN/${s}.PCK`), gfs.read(`TERRAIN/${s}.TAB`), TILE_W, TILE_H);
			const b = frames.length;
			for (const r of mcd) { r.frameBase = b; parts.push(r); }
			frames.push(...pck);
		}
		return { parts, frames };
	}

	build(outDir, prevDir, pal) {
		const { gfs, ids } = this;
		const terrains = this.loadTerrains();
		const want = (this.game === 'TFTD' ? TFTD_TERRAINS : UFO_TERRAINS).filter(n => terrains.has(n)).slice(0, MAP_COUNT);
		const pak = new PakWriter(this.game);
		const info = [];
		let n = 0;
		for (const name of want) {
			const t = terrains.get(name);
			const { parts, frames } = this.loadSets(t);
			// 10x10 blocks of this terrain (bigger ones are skipped — the field is tiled uniformly)
			const small = t.blocks.filter(b => b.w === BLOCK_CELLS && b.l === BLOCK_CELLS && gfs.has(`MAPS/${b.name}.MAP`)).slice(0, MAX_SMALL_BLOCKS);
			if (small.length === 0 || parts.length === 0) { this.report.push(`  battle: terrain ${name} skipped`); continue; }
			const blocks = small.map(b => readMap(gfs.read(`MAPS/${b.name}.MAP`)));
			const map = tile(blocks, FIELD_BLOCKS);
			const enc = this.encode(map, parts, frames, name);
			if (enc === null) continue;
			const { data, tiles, frames: tileFrames } = enc;
			const mapId = ids.id(`BATMAP${n}`), setId = ids.id(`BATTILE${n}`);
			data[4] = setId & 0xFF; data[5] = (setId >> 8) & 0xFF;
			const sprset = Sprites.encodeSprset(tileFrames);
			pak.add(mapId, ResType.Blob, data, map.sx, map.sy, map.sz);
			pak.add(setId, ResType.Sprset, sprset, tileFrames.length, TILE_W, TILE_H);
			info.push(`${name} ${map.sx}x${map.sy}x${map.sz}, ${tiles} tiles, map ${Math.trunc(data.length / KB)}K + tiles ${Math.trunc(sprset.length / KB)}K`);
			if (prevDir) {
				const img = renderPreview(map, parts, frames, Math.min(map.sz - 1, 1));
				fs.writeFileSync(path.join(prevDir, `BATMAP${n}_${name}.png`), Png.encodeIndexed(img, Cram.pal6To8(pal)));
			}
			n++;
		}
		const r = pak.write(path.join(outDir, 'BATTLE.PAK'));
		return { maps: n, info: `${n} maps, ${Math.trunc((r.bytes + HALF_KB) / KB)} KB; ` + info.join('; ') };
	}

	// Map to our format: MCD numbers are reindexed to tileset frame numbers (used ones only),
	// frames go in the same order
	encode(map, parts, frames, name) {
		const remap = new Map(), order = [];
		for (let i = 0; i < map.cells.length; i++) {
			const v = map.cells[i];
			if (v === 0 || remap.has(v)) continue;
			if (v - 1 >= parts.length) { map.cells[i] = 0; continue; }
			remap.set(v, order.length + 1);
			order.push(v);
		}
		if (order.length > MAX_TILES) {
			this.report.push(`  battle: terrain ${name} has ${order.length} tiles (>255) — skipped`);
			return null;
		}
		const tiles = [];
		const hdr = [map.sx & 0xFF, map.sy & 0xFF, map.sz & 0xFF, order.length & 0xFF, 0, 0, 0, 0];
		for (const v of order) {
			const rec = parts[v - 1];
			const f = rec.frameBase + rec.frame[0];
			tiles.push(f < frames.length ? frames[f] : new F.Img(TILE_W, TILE_H));
			hdr.push(rec.pLevel & 0xFF, mcdFlags(rec), rec.bigWall & 0xFF, rec.tileType & 0xFF);
		}
		const cells = Buffer.alloc(map.cells.length);
		for (let i = 0; i < cells.length; i++) {
			const v = map.cells[i];
			cells[i] = v !== 0 && remap.has(v) ? remap.get(v) : 0;
		}
		return { data: Buffer.concat([Buffer.from(hdr), cells]), tiles: order.length, frames: tiles };
	}
}

module.exports = { Battle, readMcd, readMap, MapBlock, renderPreview, mcdFlags, TILE_W, TILE_H };
