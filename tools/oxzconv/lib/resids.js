// Resource id registry shared by UFO and TFTD.
// Static ids — resources the engine asks for by name (like getSurface/getSurfaceSet/getPalette
// in OpenXcom); res_ids.h is generated from them. Never renumber, only add. Dynamic ids (from
// DYN_BASE) — everything else; the engine reaches them only through the rule tables.
'use strict';
const { OxcomData } = require('./oxcom');
const { upInv, hex } = require('./text');

const STATIC = [];
const S = (name, id) => STATIC.push([name, id]);
// palettes
S('PAL_GEOSCAPE', 0x0001); S('PAL_BASESCAPE', 0x0002); S('PAL_GRAPHS', 0x0003);
S('PAL_UFOPAEDIA', 0x0004); S('PAL_BATTLEPEDIA', 0x0005);
S('PAL_BATTLESCAPE', 0x0006); S('PAL_BATTLESCAPE_1', 0x0007); S('PAL_BATTLESCAPE_2', 0x0008); S('PAL_BATTLESCAPE_3', 0x0009);
S('BACKPALS', 0x000A);
// fonts and strings (LANG.PAK)
S('FONT_BIG', 0x0010); S('FONT_SMALL', 0x0011); S('FONT_GEO_BIG', 0x0012); S('FONT_GEO_SMALL', 0x0013);
S('STRINGS', 0x0020); S('CHARSET', 0x0021); S('NAMES', 0x0022);
// rule tables (RULES.PAK)
S('UI', 0x0030);
S('CUTSCENES', 0x0031);   // cutscenes: slides (CUTS.PAK on SD), palettes and captions
S('GLOBEDET', 0x0032);    // globe details: lines, country labels, cities (globedetail.js)
S('MUSGRP', 0x0033);      // music: group contents (GMGEO, GMINTER) and screen roles (22 §1.3)
// full-screen geoscape and base pictures
for (let i = 1; i <= 17; i++) S('BACK' + String(i).padStart(2, '0') + '.SCR', 0x0100 + i);
S('GEOBORD.SCR', 0x0120); S('UP_BORD2.SCR', 0x0121); S('GRAPHS.SPK', 0x0122); S('GRAPH.BDY', 0x0123);
S('INTERWIN.DAT', 0x0124);
// geoscape and base sprite sets
S('BASEBITS.PCK', 0x0140); S('INTICON.PCK', 0x0141); S('TEXTURE.DAT', 0x0142); S('SCANG.DAT', 0x0143);
S('WORLDMAP', 0x0144);   // WORLD.DAT polygon mask (insideLand, landing site texture)
S('GLOBE', 0x0145);      // globe geometry: WORLD.DAT polygons in 30° cells (globe.js)
// battlescape interface
S('TAC00.SCR', 0x0180); S('TAC01.SCR', 0x0181); S('ICONS.PCK', 0x0182); S('DETBORD.PCK', 0x0183);
S('DETBORD2.PCK', 0x0184); S('MEDIBORD.PCK', 0x0185); S('SCANBORD.PCK', 0x0186); S('UNIBORD.PCK', 0x0187);
S('CURSOR.PCK', 0x01A0); S('SMOKE.PCK', 0x01A1); S('HIT.PCK', 0x01A2); S('X1.PCK', 0x01A3);
S('MEDIBITS.DAT', 0x01A4); S('DETBLOB.DAT', 0x01A5); S('SPICONS.DAT', 0x01A6);
S('BIGOBS.PCK', 0x01A7); S('FLOOROB.PCK', 0x01A8); S('HANDOB.PCK', 0x01A9); S('HANDOB2.PCK', 0x01AA);
S('BREATH-1.PCK', 0x01AB);
// battle maps (BATTLE.PAK): ready fields and their tilesets (battle.js)
S('BATMAP0', 0x01C0); S('BATMAP1', 0x01C1); S('BATMAP2', 0x01C2);
S('BATTILE0', 0x01C8); S('BATTILE1', 0x01C9); S('BATTILE2', 0x01CA);
// mission generator (16 §3): terrain and script tables; sets, blocks and tilesets get
// dynamic ids by the names MCDSET_/MAPBLK_/TILESET_
S('TERRAINS', 0x01D0); S('MAPSCRIPTS', 0x01D1); S('DEPLOYS', 0x01D2);
// X-COM armour sprite sheets: the engine loads these by name (the rest via the rules)
S('UNIT_XCOM_0', 0x01D8); S('UNIT_TDXCOM_0', 0x01D9);

const DYN_BASE = 0x1000;
const staticMap = new Map(STATIC.map(([k, v]) => [upInv(k), v]));

class ResIds {
	constructor() { this.next = DYN_BASE; this.dyn = []; this.dynMap = new Map(); }

	// Id of an already known resource or -1 (never allocates)
	find(name) {
		const key = upInv(name);
		if (staticMap.has(key)) return staticMap.get(key);
		return this.dynMap.has(key) ? this.dynMap.get(key) : -1;
	}

	id(name) {
		const key = upInv(name);
		if (staticMap.has(key)) return staticMap.get(key);
		let d = this.dynMap.get(key);
		if (d === undefined) {
			d = this.next++;
			this.dynMap.set(key, d);
			this.dyn.push([key, d]);
		}
		return d;
	}

	static staticHeader() {
		let sb = '// Сгенерировано OxzConv (tools/oxzconv/lib/resids.js) — не править вручную.\n';
		sb += '// Номера ресурсов, которые движок запрашивает по имени (общие для UFO и TFTD).\n';
		sb += '#ifndef RES_IDS_H\n#define RES_IDS_H\n\n';
		for (const [k, v] of STATIC) {
			let c = 'RES_';
			for (const ch of k) c += /[A-Za-z0-9]/.test(ch) || (ch.charCodeAt(0) < 128 && /\p{L}|\p{N}/u.test(ch)) ? upInv(ch) : '_';
			sb += `#define ${c.padEnd(28)} 0x${hex(v, 4)}  // ${k}\n`;
		}
		sb += `\n#define RES_DYN_BASE                 0x${hex(DYN_BASE, 1)}\n\n#endif\n`;
		return sb;
	}
}

// Name registries with fixed numbers (data/*.txt): number = line index without comments
const Registry = {
	load: file => OxcomData.readDataText(file).split('\n').map(s => s.trim()).filter(s => s.length > 0 && !s.startsWith('#')),
	index: list => { const d = new Map(); list.forEach((s, i) => d.set(s, i)); return d; },
};

module.exports = { ResIds, Registry, DYN_BASE, STATIC };
