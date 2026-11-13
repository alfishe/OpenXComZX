#!/usr/bin/env node
// Lays the game data packs out over SPG pages and writes:
//   - packs.s: the _pack_page table for src/kernel/win0/res.s (first page of every pack,
//     in the order of the arguments) and _pack_count;
//   - a --data-list file for tools/mkspg.js ("page:file" per line).
// Pages go one after another from <first>; a pack takes ceil(size / 16 KB) pages; all of
// them must fit up to <last> (memmap.h RES_PAGE..RES_LAST).
//   node tools/mkpacks.js <packs.s> <data-list> <first page> <last page> <pack.PAK>...
'use strict';
const fs = require('fs');
const path = require('path');

const PAGE_BYTES = 16384;
const hex2 = v => '0x' + v.toString(16).toUpperCase().padStart(2, '0');
const die = m => { console.error('mkpacks: ' + m); process.exit(1); };

const [asmOut, listOut, firstArg, lastArg, ...packs] = process.argv.slice(2);
if (!packs.length) die('usage: mkpacks.js packs.s data-list first last pack...');
const first = Number(firstArg), last = Number(lastArg);
if (!Number.isInteger(first) || !Number.isInteger(last)) die('bad page range');

const asm = ['\t.module packs', '\t.area _CODE', '_pack_page::'];
const list = [];
let page = first;
for (const f of packs) {
	if (!fs.existsSync(f)) die('no data pack ' + f);
	const pages = Math.ceil(fs.statSync(f).size / PAGE_BYTES);
	if (page + pages - 1 > last) die(`packs do not fit into #${hex2(first).slice(2)}-#${hex2(last).slice(2)}`);
	list.push(`${hex2(page)}:${f}`);
	asm.push(`\t.db ${hex2(page)}\t; ${path.basename(f)}, ${pages} pages`);
	page += pages;
}
asm.push('_pack_count::', `\t.db ${packs.length}`);

// written only on change: the .rel and the link are not redone for nothing
function writeIfChanged(file, text) {
	if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) return;
	fs.writeFileSync(file, text);
}
writeIfChanged(asmOut, asm.join('\r\n') + '\r\n');
writeIfChanged(listOut, list.join('\n') + '\n');
