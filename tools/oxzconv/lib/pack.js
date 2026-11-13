// *.PAK resource pack writer (format: project_docs/09_converter.md §5).
// Every resource starts on a 512-byte sector boundary: the engine loads it sector by sector
// from SD straight into a page (DMA SPI->RAM).
'use strict';
const fs = require('fs');

const ResType = { Img8: 1, Sprset: 2, Pal: 3, Font: 4, Str: 5, Table: 6, Music: 7, Blob: 8 };
const SECTOR = 512;
const HDR_SIZE = 16, ENTRY_SIZE = 16;
const PAK_VERSION = 1;
const MAX_SECTOR = 0xFFFF;

class PakWriter {
	constructor(game) { this.game = game === 'TFTD' ? 2 : 1; this.items = []; }

	add(id, type, data, a = 0, b = 0, c = 0, flags = 0) {
		if (this.items.some(it => it.id === id)) throw new Error('duplicate resource id ' + id);
		this.items.push({ id, type, data: Buffer.from(data), a, b, c, flags });
	}

	// -> { count, bytes }
	write(file) {
		const n = this.items.length;
		const hdrSectors = Math.ceil((HDR_SIZE + ENTRY_SIZE * n) / SECTOR);
		const hdr = Buffer.alloc(hdrSectors * SECTOR);
		hdr.write('OXZP', 0, 'ascii');
		hdr[4] = PAK_VERSION; hdr[5] = this.game;
		hdr.writeUInt16LE(n & 0xFFFF, 6); hdr.writeUInt16LE(hdrSectors & 0xFFFF, 8);
		const sorted = this.items.slice().sort((x, y) => x.id - y.id);   // stable, like OrderBy
		const parts = [hdr];
		let sector = hdrSectors;
		sorted.forEach((it, i) => {
			const e = HDR_SIZE + i * ENTRY_SIZE;
			const secs = Math.ceil(it.data.length / SECTOR);
			if (sector > MAX_SECTOR) throw new Error('pack too large');
			hdr.writeUInt16LE(it.id & 0xFFFF, e); hdr[e + 2] = it.type & 0xFF; hdr[e + 3] = it.flags & 0xFF;
			hdr.writeUInt16LE(sector & 0xFFFF, e + 4); hdr.writeUInt32LE(it.data.length >>> 0, e + 6);
			hdr.writeUInt16LE(it.a & 0xFFFF, e + 10); hdr.writeUInt16LE(it.b & 0xFFFF, e + 12); hdr.writeUInt16LE(it.c & 0xFFFF, e + 14);
			const padded = Buffer.alloc(secs * SECTOR);
			it.data.copy(padded);
			parts.push(padded);
			sector += secs;
		});
		fs.writeFileSync(file, Buffer.concat(parts));
		return { count: n, bytes: sector * SECTOR };
	}
}

module.exports = { PakWriter, ResType, SECTOR };
