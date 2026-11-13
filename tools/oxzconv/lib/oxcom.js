// OpenXcom files (rules, strings, fonts) from its bin folder: REF/OpenXcom/bin by default,
// or --oxcom DIR. Project registries (data/*.txt, *.json) live next to the converter.
'use strict';
const fs = require('fs');
const path = require('path');
const { ordinal } = require('./text');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_BIN = path.join(ROOT, 'REF', 'OpenXcom', 'bin');
const DATA_DIR = path.join(__dirname, '..', 'data');

class OxcomData {
	constructor(binDir) { this.dir = binDir || DEFAULT_BIN; this.source = this.dir; }

	_p(rel) { return path.join(this.dir, ...rel.split('/')); }

	// rel — path under OpenXcom bin with '/', e.g. "standard/xcom2/items.rul"
	readBytes(rel) {
		const p = this._p(rel);
		if (!fs.existsSync(p)) throw new Error('OpenXcom file not found: ' + p);
		return fs.readFileSync(p);
	}

	readText(rel) { return stripBom(this.readBytes(rel)).toString('utf8'); }

	exists(rel) { return fs.existsSync(this._p(rel)); }

	// *.rul names of standard/<folder>, sorted ordinal
	ruleFiles(folder) { return this.files('standard/' + folder, '.rul'); }

	// Names in folder rel with extension ext (case-insensitive), sorted ordinal
	files(rel, ext) {
		const e = ext.toLowerCase();
		return fs.readdirSync(this._p(rel), { withFileTypes: true })
			.filter(d => d.isFile() && d.name.toLowerCase().endsWith(e)).map(d => d.name).sort(ordinal);
	}

	static readDataText(name) { return stripBom(fs.readFileSync(path.join(DATA_DIR, name))).toString('utf8'); }
}

function stripBom(b) { return b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF ? b.subarray(3) : b; }

module.exports = { OxcomData, ROOT };
