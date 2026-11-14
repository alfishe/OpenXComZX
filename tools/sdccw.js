#!/usr/bin/env node
// Runs sdcc / sdasz80 for the CMake build (CMakeLists.txt) with the checks the old tools/build.ps1
// used to do around every tool call:
//   - prints the tool output; a non-zero exit code fails the step;
//   - SDCC warning 112 (implicit function declaration) fails the step: in a bank it
//     compiles into a direct call by the low address word - into its own page instead of
//     the ___sdcc_bcall_ehl trampoline - and the game silently restarts (findings_log
//     2026-09-17, scr_dogf.c without globe.h);
//   - --dep <target>: sdcc -MMD names the depfile target "<name>.o"; Ninja wants the real
//     output (the .rel), so the first target of the depfile is replaced;
//   - --tmp <dir>: TMPDIR/TEMP/TMP of the tool - its temporary files stay in the project.
//
//   node tools/sdccw.js [--dep <out.rel> <file.d>] [--tmp <dir>] -- <tool> <args...>
'use strict';
const fs = require('fs');
const { spawnSync } = require('child_process');

const SDCC_IMPLICIT_DECL = /warning 112/;

const argv = process.argv.slice(2);
let dep = null, tmp = null;
while (argv.length && argv[0] !== '--') {
	const o = argv.shift();
	if (o === '--dep') dep = { target: argv.shift(), file: argv.shift() };
	else if (o === '--tmp') tmp = argv.shift();
	else { console.error('sdccw: unknown option ' + o); process.exit(2); }
}
argv.shift();
if (!argv.length) { console.error('usage: sdccw.js [--dep out d] [--tmp dir] -- tool args...'); process.exit(2); }

const env = Object.assign({}, process.env);
if (tmp) {
	fs.mkdirSync(tmp, { recursive: true });
	env.TMPDIR = env.TEMP = env.TMP = tmp;
}
const r = spawnSync(argv[0], argv.slice(1), { env, encoding: 'latin1', maxBuffer: 64 * 1024 * 1024 });
if (r.error) { console.error(`sdccw: ${argv[0]}: ${r.error.message}`); process.exit(1); }
const log = (r.stdout || '') + (r.stderr || '');
if (log.length) process.stdout.write(log);
if (r.status !== 0) { console.error(`sdccw: ${argv[0]} failed with code ${r.status}`); process.exit(1); }
if (SDCC_IMPLICIT_DECL.test(log)) {
	console.error('sdccw: implicit function declaration (sdcc warning 112) - include the header');
	process.exit(1);
}
if (dep) {
	const d = fs.readFileSync(dep.file, 'latin1');
	const k = d.indexOf(': ');
	if (k < 0) { console.error('sdccw: no target in ' + dep.file); process.exit(1); }
	// Ninja reads depfile paths with backslash escapes: spaces as "\ ", Windows paths with "/"
	const target = dep.target.split('\\').join('/').replace(/ /g, '\\ ');
	fs.writeFileSync(dep.file, target + d.slice(k), 'latin1');
}
