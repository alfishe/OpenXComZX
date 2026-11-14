// Globe shots on every zoom at a fixed time (byte-exact comparison when reworking the render).
//   node tools/globeshots.js -Tag ref ; then -Tag new and node tools/globeshots_cmp.js ref new
'use strict';
const fs = require('fs');
const path = require('path');
const { parseArgs, runScenario, ROOT } = require('./args');

const opt = parseArgs({ Tag: 'new' });
const src = fs.readFileSync(path.join(ROOT, 'tools', 'globeshots.oxs.tmpl'), 'utf8').split('TAG').join(opt.Tag);
const scr = `tmp/asmshots_${opt.Tag}.oxs`;
fs.writeFileSync(path.join(ROOT, scr), src);
const { code, out } = runScenario(scr);
for (const l of out.split(/\r?\n/)) if (/screenshot|PANIC|exit code/i.test(l)) console.log(l);
process.exit(code);
