// Screenshot sheets: the PNGs of a folder four to a sheet (2x2, with captions) - a quick look
// at every window after a test.
//   node tools/shotsheet.js [-Dir tmp/shots/ui] [-Out tmp/shots/sheets]
'use strict';
const fs = require('fs');
const path = require('path');
const { parseArgs, ROOT } = require('./args');
const png = require('./pngimg');

const opt = parseArgs({ Dir: 'tmp/shots/ui', Out: 'tmp/shots/sheets' });
const SHEET_W = 660, SHEET_H = 430;
const CELL_W = 320, CELL_H = 200;
const PER_SHEET = 4, COLS = 2;
const MARGIN_X = 5, STEP_X = 330, TOP = 14, STEP_Y = 214, CAPTION_UP = 11;
const BACKGROUND = [105, 105, 105, 255];  // DimGray
const dir = path.resolve(ROOT, opt.Dir), out = path.resolve(ROOT, opt.Out);
const files = fs.readdirSync(dir).filter((n) => /\.png$/i.test(n)).sort();
fs.mkdirSync(out, { recursive: true });
for (let s = 0; s < files.length; s += PER_SHEET) {
    const sheet = png.image(SHEET_W, SHEET_H, BACKGROUND);
    for (let k = 0; k < PER_SHEET && s + k < files.length; k++) {
        const img = png.read(path.join(dir, files[s + k]));
        const x = MARGIN_X + (k % COLS) * STEP_X;
        const y = TOP + Math.floor(k / COLS) * STEP_Y;
        png.blit(sheet, x, y, CELL_W, CELL_H, img);
        png.text(sheet, x, y - CAPTION_UP, files[s + k]);
    }
    png.write(path.join(out, `sheet_${String(s / PER_SHEET).padStart(2, '0')}.png`), sheet);
}
console.log(`shotsheet: ${files.length} shots -> ${out}`);
