// C headers for the engine from the converter registries (no game data needed):
// res_ids.h, str_ids.h, ui_ids.h, mus_ids.h, rules.h. Called by the build:
//   node tools/oxzconv/oxzconv.js headers <dir>
'use strict';
const fs = require('fs');
const path = require('path');
const { ResIds, Registry } = require('./resids');
const { RuleSet } = require('./rules');
const RulesSchema = require('./rulesschema');

const STR_PAD = 40, SCR_PAD = 32, EL_PAD = 33, MUS_PAD = 20;
const MUS_BASE = '0x0300';

// ASCII letter or digit -> upper case, anything else -> '_'
function cname(s) {
	let r = '';
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		r += /[A-Za-z0-9]/.test(ch) ? ch.toUpperCase() : '_';
	}
	return r;
}

function header(guard, comment, defs) {
	let sb = '// Сгенерировано OxzConv (tools/oxzconv/lib/headers.js) — не править вручную.\n';
	sb += `// ${comment}\n`;
	sb += `#ifndef ${guard}\n#define ${guard}\n\n`;
	for (const d of defs) sb += d + '\n';
	sb += '\n#endif\n';
	return sb;
}

// UTF-8 without BOM
const write = (p, text) => fs.writeFileSync(p, Buffer.from(text, 'utf8'));

function generate(dir, log) {
	fs.mkdirSync(dir, { recursive: true });
	write(path.join(dir, 'res_ids.h'), ResIds.staticHeader());

	const strs = Registry.load('engine_strings.txt');
	write(path.join(dir, 'str_ids.h'), header('STR_IDS_H', 'Номера строк, которые использует движок (LANG.PAK, ресурс STRINGS).',
		[...strs.map((k, i) => `#define ${k.padEnd(STR_PAD)} ${i}`), `#define STR_ENGINE_COUNT ${strs.length}`]));

	const scr = Registry.load('ui_screens.txt'), el = Registry.load('ui_elements.txt');
	write(path.join(dir, 'ui_ids.h'), header('UI_IDS_H', 'Экраны и элементы interfaces.rul (ресурс UI).', [
		...scr.map((k, i) => `#define UI_SCR_${cname(k).padEnd(SCR_PAD)} ${i}`),
		`#define UI_SCR_COUNT ${scr.length}`, '',
		...el.map((k, i) => `#define UI_EL_${cname(k).padEnd(EL_PAD)} ${i}`),
		`#define UI_EL_COUNT ${el.length}`,
	]));

	const mus = Registry.load('music_types.txt');
	write(path.join(dir, 'mus_ids.h'), header('MUS_IDS_H', 'Типы музыки (MUSIC.PAK): номер ресурса = MUS_BASE + номер.', [
		`#define MUS_BASE ${MUS_BASE}`,
		...mus.map((k, i) => `#define MUS_${cname(k).padEnd(MUS_PAD)} ${i}`),
		`#define MUS_COUNT ${mus.length}`,
	]));

	const schema = RulesSchema.tables();
	write(path.join(dir, 'rules.h'), RuleSet.header(schema, RulesSchema.RES_BASE));

	log(`headers: ${dir}: res_ids.h, str_ids.h (${strs.length}), ui_ids.h (${scr.length} screens, ${el.length} elements), mus_ids.h (${mus.length}), rules.h (${schema.length} tables)`);
}

module.exports = { generate, cname };
