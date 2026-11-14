// Writes an SD card image: MBR with one FAT32 (LBA) partition holding a copy of a host
// folder. Replaces robimg (Windows) and mkmbr.js + mtools (macOS/Linux) in dist.js, so the
// card is built the same way on every host with Node alone.
//   node tools/fat32img.js <image> <folder> [--mb 256] [--first 2048] [--cluster 4] [--label OXZ]
// Layout (what TS-BIOS and the game's fat.c expect, project_docs/23_distribution.md):
//   MBR, partition type 0x0C from sector <first>; FAT32 only (TS-BIOS does not boot FAT16),
//   32 reserved sectors, FSInfo at 1 / backup boot at 6, two FATs, root at cluster 2.
// Files are stored contiguously, directories and files in ordinal name order. Names that are
// valid 8.3 get a short entry only (lower case base/ext via the NT case bits, as Windows
// does); others get long-name (VFAT) entries plus a NAME~N short alias.
'use strict';
const fs = require('fs');
const path = require('path');

const SECTOR = 512;
const MB = 1024 * 1024;
const DIRENT = 32;
const RESERVED_SECTORS = 32;
const FAT_COUNT = 2;
const FSINFO_SECTOR = 1;
const BACKUP_BOOT_SECTOR = 6;
const ROOT_CLUSTER = 2;
const FIRST_DATA_CLUSTER = 2;
const FAT32_MIN_CLUSTERS = 65525;          // fewer clusters = FAT16 by definition
const FAT_EOC = 0x0FFFFFFF;
const FAT_MEDIA = 0xF8;
const PART_TYPE_FAT32_LBA = 0x0C;
const CHS_UNUSED = [0xFE, 0xFF, 0xFF];
const MBR_TABLE = 446;
const SIG_OFFSET = 510;
const GEOM_HEADS = 255;
const GEOM_SECTORS = 63;
const ATTR_READONLY = 0x01, ATTR_VOLUME = 0x08, ATTR_DIR = 0x10, ATTR_ARCHIVE = 0x20, ATTR_LFN = 0x0F;
const NT_LOWER_BASE = 0x08, NT_LOWER_EXT = 0x10;
const LFN_CHARS = 13;
const LFN_LAST = 0x40;
const SHORT_BASE = 8, SHORT_EXT = 3;
const SHORT_CHARS = /^[A-Z0-9$%'\-_@~`!(){}^#&]+$/;  // allowed in 8.3 names (upper case)
const DOS_EPOCH_YEAR = 1980;

const sigBytes = (b) => { b[SIG_OFFSET] = 0x55; b[SIG_OFFSET + 1] = 0xAA; };

function dosTime(d) {
    const date = ((d.getFullYear() - DOS_EPOCH_YEAR) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    return { date, time };
}

// 8.3 split of a name if it is valid as is (ignoring case); null when a long name is needed.
function shortSplit(name) {
    const dot = name.lastIndexOf('.');
    const base = dot < 0 ? name : name.slice(0, dot);
    const ext = dot < 0 ? '' : name.slice(dot + 1);
    if (!base || base.length > SHORT_BASE || ext.length > SHORT_EXT) return null;
    if (dot >= 0 && !ext) return null;
    const ub = base.toUpperCase(), ue = ext.toUpperCase();
    if (!SHORT_CHARS.test(ub) || (ue && !SHORT_CHARS.test(ue))) return null;
    // Each part must be in one case: mixed case needs a long name to survive.
    const caseOf = (s, u) => (s === u ? 0 : s === s.toLowerCase() ? 1 : -1);
    const cb = caseOf(base, ub), ce = ext ? caseOf(ext, ue) : 0;
    if (cb < 0 || ce < 0) return null;
    return { base: ub, ext: ue, nt: (cb ? NT_LOWER_BASE : 0) | (ce ? NT_LOWER_EXT : 0) };
}

function pad83(base, ext) {
    return Buffer.from(base.padEnd(SHORT_BASE, ' ') + ext.padEnd(SHORT_EXT, ' '), 'latin1');
}

// NAME~N alias for a long name, unique within its directory.
function shortAlias(name, taken) {
    const dot = name.lastIndexOf('.');
    const clean = (s) => s.toUpperCase().replace(/[^A-Z0-9$%'\-_@~`!(){}^#&]/g, '_');
    const base = clean((dot > 0 ? name.slice(0, dot) : name).replace(/[ .]/g, ''));
    const ext = dot > 0 ? clean(name.slice(dot + 1).replace(/ /g, '')).slice(0, SHORT_EXT) : '';
    for (let n = 1; ; n++) {
        const tail = '~' + n;
        const b = base.slice(0, SHORT_BASE - tail.length) + tail;
        const key = b + '.' + ext;
        if (!taken.has(key)) { taken.add(key); return { base: b, ext }; }
    }
}

function lfnChecksum(short11) {
    let s = 0;
    for (let i = 0; i < short11.length; i++) s = (((s & 1) << 7) | (s >> 1)) + short11[i] & 0xFF;
    return s;
}

// Directory entries of one name: [LFN entries..., short entry] (short entry filled later).
function nameEntries(name, taken) {
    const sp = shortSplit(name);
    if (sp && !taken.has(sp.base + '.' + sp.ext)) {
        taken.add(sp.base + '.' + sp.ext);
        return { short: pad83(sp.base, sp.ext), nt: sp.nt, lfn: [] };
    }
    const al = shortAlias(name, taken);
    const short = pad83(al.base, al.ext);
    const sum = lfnChecksum(short);
    const units = [];
    for (let i = 0; i < name.length; i++) units.push(name.charCodeAt(i));
    units.push(0);
    while (units.length % LFN_CHARS) units.push(0xFFFF);
    const count = units.length / LFN_CHARS;
    const lfn = [];
    for (let k = count; k >= 1; k--) {
        const e = Buffer.alloc(DIRENT);
        e[0] = k | (k === count ? LFN_LAST : 0);
        e[11] = ATTR_LFN;
        e[13] = sum;
        const u = units.slice((k - 1) * LFN_CHARS, k * LFN_CHARS);
        const at = [1, 3, 5, 7, 9, 14, 16, 18, 20, 22, 24, 28, 30];
        u.forEach((c, i) => e.writeUInt16LE(c, at[i]));
        lfn.push(e);
    }
    if (name.length + 1 > count * LFN_CHARS) throw new Error('lfn overflow');
    return { short, nt: 0, lfn };
}

// Host folder -> tree of { name, dir, size, src, children, mtime }.
function scan(dir, name = '') {
    const st = fs.statSync(dir);
    const node = { name, dir: true, mtime: st.mtime, children: [] };
    const names = fs.readdirSync(dir).filter((n) => !n.startsWith('.')).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const n of names) {
        const p = path.join(dir, n);
        const s = fs.statSync(p);
        if (s.isDirectory()) node.children.push(scan(p, n));
        else if (s.isFile()) node.children.push({ name: n, dir: false, size: s.size, src: p, mtime: s.mtime });
    }
    return node;
}

// Volume geometry: FAT size from the cluster count it has to cover (fixed point).
function geometry(totalSectors, clusterSectors) {
    let fatSectors = 1;
    for (;;) {
        const data = totalSectors - RESERVED_SECTORS - FAT_COUNT * fatSectors;
        const clusters = Math.floor(data / clusterSectors);
        const need = Math.ceil((clusters + FIRST_DATA_CLUSTER) * 4 / SECTOR);
        if (need <= fatSectors) return { fatSectors, clusters };
        fatSectors = need;
    }
}

function build(image, folder, opt = {}) {
    const mb = opt.mb ?? 256;
    const first = opt.first ?? 2048;
    const spc = opt.cluster ?? 4;
    const label = (opt.label ?? 'NO NAME').toUpperCase().slice(0, 11).padEnd(11, ' ');
    const totalImage = mb * MB / SECTOR;
    const partSectors = totalImage - first;
    const { fatSectors, clusters } = geometry(partSectors, spc);
    if (clusters < FAT32_MIN_CLUSTERS) throw new Error(`${clusters} clusters: too few for FAT32 (bigger image or smaller cluster)`);
    const clusterBytes = spc * SECTOR;
    const fatLba = first + RESERVED_SECTORS;
    const dataLba = fatLba + FAT_COUNT * fatSectors;
    const now = opt.time ?? new Date();

    const fat = new Uint32Array(clusters + FIRST_DATA_CLUSTER);
    fat[0] = 0x0FFFFF00 | FAT_MEDIA;
    fat[1] = FAT_EOC;
    let nextFree = FIRST_DATA_CLUSTER;
    const alloc = (bytes) => {
        const n = Math.max(1, Math.ceil(bytes / clusterBytes));
        if (nextFree + n > clusters + FIRST_DATA_CLUSTER) throw new Error('image full');
        const c = nextFree;
        for (let i = 0; i < n - 1; i++) fat[c + i] = c + i + 1;
        fat[c + n - 1] = FAT_EOC;
        nextFree += n;
        return { clus: c, n };
    };

    // Entries of every directory first (their size fixes the cluster count), then layout.
    const prepare = (node, isRoot) => {
        const taken = new Set();
        node.entries = [];
        node.slots = isRoot ? (label.trim() ? 1 : 0) : 2;  // volume label / "." and ".."
        for (const ch of node.children) {
            ch.ne = nameEntries(ch.name, taken);
            node.slots += ch.ne.lfn.length + 1;
            if (ch.dir) prepare(ch, false);
        }
    };
    const root = scan(folder);
    prepare(root, true);
    const place = (node) => {
        node.at = alloc(node.slots * DIRENT);
        for (const ch of node.children) if (ch.dir) place(ch);
        for (const ch of node.children) if (!ch.dir) ch.at = ch.size ? alloc(ch.size) : { clus: 0, n: 0 };
    };
    place(root);
    if (root.at.clus !== ROOT_CLUSTER) throw new Error('root not at cluster 2');

    const fd = fs.openSync(image, 'w');
    try {
        fs.ftruncateSync(fd, totalImage * SECTOR);  // sparse: unwritten sectors are zero
        const put = (buf, lba) => fs.writeSync(fd, buf, 0, buf.length, lba * SECTOR);
        const clusLba = (c) => dataLba + (c - FIRST_DATA_CLUSTER) * spc;

        // MBR
        const mbr = Buffer.alloc(SECTOR);
        Buffer.from(CHS_UNUSED).copy(mbr, MBR_TABLE + 1);
        mbr[MBR_TABLE + 4] = PART_TYPE_FAT32_LBA;
        Buffer.from(CHS_UNUSED).copy(mbr, MBR_TABLE + 5);
        mbr.writeUInt32LE(first, MBR_TABLE + 8);
        mbr.writeUInt32LE(partSectors, MBR_TABLE + 12);
        sigBytes(mbr);
        put(mbr, 0);

        // Boot sector (BPB) and FSInfo, each with its backup copy
        const bs = Buffer.alloc(SECTOR);
        Buffer.from([0xEB, 0x58, 0x90]).copy(bs, 0);
        bs.write('OXZCARD ', 3, 'latin1');
        bs.writeUInt16LE(SECTOR, 11);
        bs[13] = spc;
        bs.writeUInt16LE(RESERVED_SECTORS, 14);
        bs[16] = FAT_COUNT;
        bs[21] = FAT_MEDIA;
        bs.writeUInt16LE(GEOM_SECTORS, 24);
        bs.writeUInt16LE(GEOM_HEADS, 26);
        bs.writeUInt32LE(first, 28);
        bs.writeUInt32LE(partSectors, 32);
        bs.writeUInt32LE(fatSectors, 36);
        bs.writeUInt32LE(ROOT_CLUSTER, 44);
        bs.writeUInt16LE(FSINFO_SECTOR, 48);
        bs.writeUInt16LE(BACKUP_BOOT_SECTOR, 50);
        bs[64] = 0x80;                               // drive number
        bs[66] = 0x29;                               // extended boot signature
        const t = dosTime(now);
        bs.writeUInt32LE(((t.date << 16) | t.time) >>> 0, 67);  // volume id
        bs.write(label, 71, 'latin1');
        bs.write('FAT32   ', 82, 'latin1');
        sigBytes(bs);
        const fsi = Buffer.alloc(SECTOR);
        fsi.writeUInt32LE(0x41615252, 0);
        fsi.writeUInt32LE(0x61417272, 484);
        fsi.writeUInt32LE(clusters + FIRST_DATA_CLUSTER - nextFree, 488);  // free clusters
        fsi.writeUInt32LE(nextFree, 492);                                  // next free hint
        sigBytes(fsi);
        for (const base of [0, BACKUP_BOOT_SECTOR]) {
            put(bs, first + base);
            put(fsi, first + base + FSINFO_SECTOR);
        }

        // FATs (only the used part: the rest is free = zero)
        const usedFat = Buffer.alloc(Math.ceil(nextFree * 4 / SECTOR) * SECTOR);
        for (let c = 0; c < nextFree; c++) usedFat.writeUInt32LE(fat[c], c * 4);
        for (let k = 0; k < FAT_COUNT; k++) put(usedFat, fatLba + k * fatSectors);

        const entry = (short, attr, nt, clus, size, mtime) => {
            const e = Buffer.alloc(DIRENT);
            short.copy(e, 0);
            e[11] = attr;
            e[12] = nt;
            const d = dosTime(mtime);
            e.writeUInt16LE(d.time, 14); e.writeUInt16LE(d.date, 16);  // created
            e.writeUInt16LE(d.date, 18);                               // accessed
            e.writeUInt16LE(clus >>> 16, 20);
            e.writeUInt16LE(d.time, 22); e.writeUInt16LE(d.date, 24);  // modified
            e.writeUInt16LE(clus & 0xFFFF, 26);
            e.writeUInt32LE(size, 28);
            return e;
        };
        const writeDir = (node, parentClus, isRoot) => {
            const buf = Buffer.alloc(node.at.n * clusterBytes);
            let o = 0;
            const add = (e) => { e.copy(buf, o); o += DIRENT; };
            if (isRoot) {
                if (label.trim()) add(entry(Buffer.from(label, 'latin1'), ATTR_VOLUME, 0, 0, 0, now));
            } else {
                add(entry(pad83('.', ''), ATTR_DIR, 0, node.at.clus, 0, node.mtime));
                add(entry(pad83('..', ''), ATTR_DIR, 0, parentClus === ROOT_CLUSTER ? 0 : parentClus, 0, node.mtime));
            }
            for (const ch of node.children) {
                ch.ne.lfn.forEach(add);
                add(entry(ch.ne.short, ch.dir ? ATTR_DIR : ATTR_ARCHIVE, ch.ne.nt, ch.at.clus, ch.dir ? 0 : ch.size, ch.mtime));
            }
            put(buf, clusLba(node.at.clus));
            for (const ch of node.children) {
                if (ch.dir) writeDir(ch, node.at.clus, false);
                else if (ch.size) put(fs.readFileSync(ch.src), clusLba(ch.at.clus));
            }
        };
        writeDir(root, 0, true);
    } finally {
        fs.closeSync(fd);
    }
    return { clusters, used: nextFree - FIRST_DATA_CLUSTER, clusterBytes };
}

module.exports = { build, shortSplit, ATTR_READONLY };

if (require.main === module) {
    const a = process.argv.slice(2);
    const pos = [], opt = {};
    for (let i = 0; i < a.length; i++) {
        const m = /^--?(mb|first|cluster|label)$/i.exec(a[i]);
        if (m) { const k = m[1].toLowerCase(); opt[k] = k === 'label' ? a[++i] : Number(a[++i]); } else pos.push(a[i]);
    }
    if (pos.length !== 2) {
        console.error('usage: node tools/fat32img.js <image> <folder> [--mb 256] [--first 2048] [--cluster 4] [--label OXZ]');
        process.exit(2);
    }
    try {
        const r = build(pos[0], pos[1], opt);
        console.log(`${pos[0]}: FAT32, ${r.used}/${r.clusters} clusters of ${r.clusterBytes} bytes`);
    } catch (e) {
        console.error('fat32img: ' + e.message);
        process.exit(1);
    }
}
