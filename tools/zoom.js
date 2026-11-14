// An enlarged piece of a screenshot (no smoothing) - to look at small details of a window.
//   node tools/zoom.js -In tmp/shots/ui/54_dogfight.png -X 80 -Y 52 -W 160 -H 96 [-Scale 4] [-Out file]
'use strict';
const path = require('path');
const { parseArgs, ROOT } = require('./args');
const png = require('./pngimg');

const opt = parseArgs({ In: '', X: 0, Y: 0, W: 320, H: 200, Scale: 4, Out: '' });
if (!opt.In) { console.error('zoom: -In <png>'); process.exit(2); }
const src = path.resolve(ROOT, opt.In);
const out = opt.Out ? path.resolve(ROOT, opt.Out) : src.replace(/\.[^./\\]*$/, '') + '_zoom.png';
const img = png.read(src);
const dst = png.image(opt.W * opt.Scale, opt.H * opt.Scale);
png.blit(dst, 0, 0, dst.w, dst.h, img, opt.X, opt.Y, opt.W, opt.H);
png.write(out, dst);
console.log(`zoom: ${out}`);
