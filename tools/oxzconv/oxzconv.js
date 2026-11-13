#!/usr/bin/env node
// OxzConv — converter of the original X-COM data (UFO / TFTD) for OpenXComZX.
//   node tools/oxzconv/oxzconv.js --game DIR --out DIR [--preview DIR] [--oxcom DIR]
//                                 [--lang en-US] [--music adlib|midi]
//   node tools/oxzconv/oxzconv.js headers DIR          — C headers for the engine
//   node tools/oxzconv/oxzconv.js dump OXZ/<game> [table [count]]  — check: resources / rule records
// --oxcom — OpenXcom bin folder (rules, strings, fonts); default REF/OpenXcom/bin.
// Description — project_docs/09_converter.md.
'use strict';
const path = require('path');
const { Converter } = require('./lib/converter');
const { OxcomData } = require('./lib/oxcom');

const USAGE = 'usage: oxzconv --game DIR --out DIR [--preview DIR] [--oxcom DIR] [--lang en-US] [--music adlib|midi] | headers DIR | dump DIR [table [count]]';

function main(args) {
	if (args.length >= 2 && args[0] === 'dump')
		return require('./lib/dump').run(args[1], args.length > 2 ? args[2] : null, args.length > 3 ? parseInt(args[3], 10) : 5, console.log);
	if (args.length >= 1 && args[0] === 'headers') {
		if (args.length < 2) { console.error('usage: oxzconv headers <dir>'); return 2; }
		require('./lib/headers').generate(args[1], console.log);
		return 0;
	}
	const opt = {};
	for (let i = 0; i < args.length; i += 2) {
		if (!args[i].startsWith('--') || i + 1 >= args.length) { console.error(USAGE); return 2; }
		opt[args[i].slice(2)] = args[i + 1];
	}
	if (!opt.game || !opt.out) { console.error(USAGE); return 2; }
	if (opt.music !== undefined && opt.music !== 'adlib' && opt.music !== 'midi') {
		console.error('oxzconv: --music takes adlib or midi');
		return 2;
	}
	const conv = new Converter(opt.game, opt.out, opt.preview || null, new OxcomData(opt.oxcom || null), opt.lang || 'en-US', console.log);
	conv.musicSource = opt.music || 'adlib';
	conv.run();
	console.log(`Copy the folder ${path.join(opt.out, 'OXZ')} to the root of the SD card.`);
	return 0;
}

try {
	process.exitCode = main(process.argv.slice(2));
} catch (e) {
	console.error('oxzconv: ' + (process.env.OXZ_CONV_TRACE ? e.stack : e.message));
	process.exitCode = 1;
}
