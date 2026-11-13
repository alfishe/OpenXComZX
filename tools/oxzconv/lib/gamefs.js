// Game folder with case-insensitive names (like FileMap in OpenXcom) and UFO/TFTD detection.
'use strict';
const fs = require('fs');
const path = require('path');
const { upInv, ordinal } = require('./text');

class GameFs {
	constructor(root) {
		this.root = root;
		this.index = new Map();
		this._scan(root, '');
	}

	_scan(dir, rel) {
		const ents = fs.readdirSync(dir, { withFileTypes: true });
		const join = n => (rel.length > 0 ? rel + '/' + n : n);
		// directories first, then files (Directory.GetDirectories / GetFiles); later keys win
		for (const e of ents) if (e.isDirectory()) this._scan(path.join(dir, e.name), join(e.name));
		for (const e of ents) if (e.isFile()) this.index.set(upInv(join(e.name)), path.join(dir, e.name));
	}

	has(rel) { return this.index.has(upInv(rel)); }

	pathOf(rel) {
		const p = this.index.get(upInv(rel));
		if (p === undefined) throw new Error('file not found in game dir: ' + rel);
		return p;
	}

	read(rel) { return fs.readFileSync(this.pathOf(rel)); }

	// Names in dir with extension ext, sorted ordinal (upper case, as indexed)
	list(dir, ext = null) {
		const pre = upInv(dir) + '/', suf = ext !== null ? '.' + upInv(ext) : '';
		const l = [];
		for (const k of this.index.keys())
			if (k.startsWith(pre) && k.indexOf('/', pre.length) < 0 && k.endsWith(suf)) l.push(k.slice(pre.length));
		return l.sort(ordinal);
	}

	detectGame() {
		if (!this.has('GEODATA/PALETTES.DAT')) throw new Error('not an X-COM game directory (no GEODATA/PALETTES.DAT)');
		const tftd = this.has('TERRAIN/LOFTEMPS.DAT') || this.list('UFOGRAPH', 'BDY').length > 0 || this.has('GEOGRAPH/UP001.BDY');
		const ufo = this.has('GEOGRAPH/UP001.SPK') || this.has('UNITS/SECTOID.PCK');
		if (tftd && !ufo) return 'TFTD';
		if (ufo && !tftd) return 'UFO';
		throw new Error('cannot tell UFO from TFTD');
	}
}

module.exports = { GameFs };
