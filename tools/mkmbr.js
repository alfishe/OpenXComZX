// Creates an empty SD card image with an MBR holding one FAT32 (LBA) partition,
// the layout robimg -f=0 makes on Windows (dist.ps1). The partition itself is
// formatted and filled by mtools (mformat/mcopy -i <image>@@<offset>).
//   node tools/mkmbr.js <image> <size MB> <first sector>
// Prints the partition size in sectors.
'use strict';
const fs = require('fs');

const SECTOR_BYTES = 512;
const MB_BYTES = 1024 * 1024;
const MBR_TABLE_OFFSET = 446;      // first partition entry
const MBR_SIGNATURE_OFFSET = 510;  // 0x55 0xAA
const PART_TYPE_FAT32_LBA = 0x0C;
const CHS_UNUSED = [0xFE, 0xFF, 0xFF]; // CHS fields beyond 8 GB / ignored: LBA only

const [image, sizeArg, firstArg] = process.argv.slice(2);
if (!image || !sizeArg || !firstArg) {
    console.error('usage: node tools/mkmbr.js <image> <size MB> <first sector>');
    process.exit(2);
}
const totalSectors = Number(sizeArg) * MB_BYTES / SECTOR_BYTES;
const first = Number(firstArg);
const count = totalSectors - first;
if (!(count > 0)) { console.error('partition does not fit'); process.exit(2); }

const fd = fs.openSync(image, 'w');
fs.ftruncateSync(fd, totalSectors * SECTOR_BYTES);  // sparse file
const mbr = Buffer.alloc(SECTOR_BYTES);
const e = MBR_TABLE_OFFSET;
mbr[e] = 0x00;                                       // not active
Buffer.from(CHS_UNUSED).copy(mbr, e + 1);
mbr[e + 4] = PART_TYPE_FAT32_LBA;
Buffer.from(CHS_UNUSED).copy(mbr, e + 5);
mbr.writeUInt32LE(first, e + 8);
mbr.writeUInt32LE(count, e + 12);
mbr[MBR_SIGNATURE_OFFSET] = 0x55;
mbr[MBR_SIGNATURE_OFFSET + 1] = 0xAA;
fs.writeSync(fd, mbr, 0, SECTOR_BYTES, 0);
fs.closeSync(fd);
console.log(count);
