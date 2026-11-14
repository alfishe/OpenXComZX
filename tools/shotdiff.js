// How many pixels differ in a rectangle of two screenshots (animation checks: palette cycling,
// blinking).  node tools/shotdiff.js -A a.png -B b.png [-X -Y -W -H]
'use strict';
const path = require('path');
const { parseArgs, ROOT } = require('./args');
const png = require('./pngimg');

const opt = parseArgs({ A: '', B: '', X: 0, Y: 0, W: 320, H: 200 });
if (!opt.A || !opt.B) { console.error('shotdiff: -A <png> -B <png>'); process.exit(2); }
const a = png.read(path.resolve(ROOT, opt.A)), b = png.read(path.resolve(ROOT, opt.B));
let n = 0;
for (let y = opt.Y; y < opt.Y + opt.H; y++) {
    for (let x = opt.X; x < opt.X + opt.W; x++) {
        const ia = (y * a.w + x) * 4, ib = (y * b.w + x) * 4;
        for (let k = 0; k < 4; k++) if (a.px[ia + k] !== b.px[ib + k]) { n++; break; }
    }
}
console.log(`shotdiff: ${n} of ${opt.W * opt.H} pixels differ`);
