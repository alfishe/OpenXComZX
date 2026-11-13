// Output check: node oxzconv.js dump <OXZ/game dir> [table [count]]
// Without a table — resource list of all packs; with a table — RULES.PAK records decoded by the
// schema: numbers, string text (LANG.PAK), record names behind references.
'use strict';
const fs = require('fs');
const path = require('path');
const RulesSchema = require('./rulesschema');
const { ordinal, hex } = require('./text');

const DIR_OFFSET = 16, DIR_ENTRY = 16, SECTOR = 512;
const RES_STRINGS = 0x0020;
const NO_OFFSET = 0xFFFFFF, NONE = 0xFFFF, LINK_FLAG = 0x8000, LINK_MASK = 0x7FFF;
const TABLE_HEADER = 8, STAT_COUNT = 11, AREA_SIZE = 8, SIZE_PAD = 8;
const FULL_CIRCLE = 360.0 / 65536, QUARTER = 90.0 / 16384;

function readPak(file) {
	const b = fs.readFileSync(file);
	const n = b[6] | b[7] << 8;
	const l = [];
	for (let i = 0; i < n; i++) {
		const e = DIR_OFFSET + i * DIR_ENTRY;
		const sec = b[e + 4] | b[e + 5] << 8, size = b.readInt32LE(e + 6);
		l.push({
			id: b[e] | b[e + 1] << 8, type: b[e + 2],
			a: b[e + 10] | b[e + 11] << 8, b: b[e + 12] | b[e + 13] << 8, c: b[e + 14] | b[e + 15] << 8,
			data: b.subarray(sec * SECTOR, sec * SECTOR + size),
		});
	}
	return l;
}

function strings(dir) {
	const s = readPak(path.join(dir, 'LANG.PAK')).find(r => r.id === RES_STRINGS).data;
	const n = s[0] | s[1] << 8, hdr = 2 + 3 * n;
	const o = new Array(n).fill(null);
	for (let i = 0; i < n; i++) {
		const off = s[2 + i * 3] | s[3 + i * 3] << 8 | s[4 + i * 3] << 16;
		if (off === NO_OFFSET) continue;
		let sb = '';
		for (let p = hdr + off; s[p] !== 0; p++) sb += s[p] >= 0x20 && s[p] < 0x7F ? String.fromCharCode(s[p]) : s[p] === 0x0A ? '|' : '·';
		o[i] = sb;
	}
	return o;
}

// .NET custom format "0.##" / "0.#": up to d decimals, trailing zeros dropped
function fmt(v, d) {
	const s = v.toFixed(d);
	const t = s.indexOf('.') < 0 ? s : s.replace(/0+$/, '').replace(/\.$/, '');
	return t === '-0' ? '0' : t;
}

const s16 = v => (v << 16) >> 16;
const s8 = v => (v << 24) >> 24;

function run(dir, table, count, log) {
	if (table === null || table === undefined) {
		const files = fs.readdirSync(dir).filter(f => /\.PAK$/i.test(f)).map(f => path.join(dir, f)).sort(ordinal);
		for (const f of files) {
			const l = readPak(f);
			log(`${path.basename(f)}: ${l.length} resources`);
			for (const r of l) log(`  #${hex(r.id, 4)} type ${r.type} ${String(r.data.length).padStart(SIZE_PAD)} bytes  a=${r.a} b=${r.b} c=${r.c}`);
		}
		return 0;
	}
	const schema = RulesSchema.tables();
	const ti = schema.findIndex(t => t.name === table);
	const rules = readPak(path.join(dir, 'RULES.PAK'));
	const str = strings(dir);
	const tab = i => rules.find(r => r.id === RulesSchema.RES_BASE + i).data;
	const strText = s => (s < str.length ? str[s] ?? '' : '?');
	const nameOf = (tIdx, rec) => {
		if (rec === NONE) return '-';
		const d = tab(tIdx); const rs = d[2] | d[3] << 8;
		const s = d[TABLE_HEADER + rec * rs] | d[TABLE_HEADER + 1 + rec * rs] << 8;   // first field — name (str)
		return `${rec}:${strText(s)}`;
	};
	if (ti < 0) { log('unknown table ' + table); return 2; }
	const data = tab(ti);
	const n = data[0] | data[1] << 8, size = data[2] | data[3] << 8, tail = data[4] | data[5] << 8;
	log(`${table}: ${n} records x ${size} bytes, tail at ${tail}`);
	const t = schema[ti];
	for (let rec = 0; rec < Math.min(n, count); rec++) {
		let o = TABLE_HEADER + rec * size;
		const parts = [];
		const R = k => { let v = 0; for (let i = 0; i < k; i++) v |= data[o + i] << (8 * i); o += k; return v >>> 0; };
		for (const f of t.fields) {
			const cn = f.cname ?? f.name;
			const c = f.kind.indexOf(':');
			const ka = c < 0 ? [f.kind] : [f.kind.slice(0, c), f.kind.slice(c + 1)];
			let val;
			switch (ka[0]) {
			case 'u8': val = String(R(1)); break;
			case 'i8': val = String(s8(R(1))); break;
			case 'u16': val = String(R(2)); break;
			case 'i16': case 'x100': val = String(s16(R(2))); break;
			case 'lon': val = fmt(R(2) * FULL_CIRCLE, 2); break;
			case 'lat': val = fmt(s16(R(2)) * QUARTER, 2); break;
			case 'areas': {
				const off = R(2), cnt = R(1);
				const items = [];
				for (let i = 0; i < cnt; i++) {
					const p = tail + off + i * AREA_SIZE;
					const U = k => data[p + k] | data[p + k + 1] << 8;
					items.push(`[${fmt(U(0) * FULL_CIRCLE, 1)},${fmt(U(2) * FULL_CIRCLE, 1)},${fmt(s16(U(4)) * QUARTER, 1)},${fmt(s16(U(6)) * QUARTER, 1)}]`);
				}
				val = items.join(' ');
				break;
			}
			case 'u32': case 'i32': val = String(R(4) | 0); break;   // C# int: signed
			case 'str': { const s = R(2); val = s === NONE ? '-' : `"${strText(s)}"`; break; }
			case 'res': val = `#${hex(R(2), 4)}`; break;
			case 'ref': { const v = R(2); const tt = schema.findIndex(x => x.name === ka[1].split('|')[0]); val = tt >= 0 ? nameOf(tt, v) : String(v); break; }
			case 'stats': { const sb = []; for (let i = 0; i < STAT_COUNT; i++) sb.push(String(R(1))); val = `[${sb.join(',')}]`; break; }
			default: {
				const off = R(2), cnt = R(1);
				const items = [];
				for (let i = 0; i < cnt; i++) {
					const p = tail + off + i * (ka[0] === 'refmap' ? 4 : 2);
					const v = data[p] | data[p + 1] << 8;
					if (ka[0] === 'refs' || ka[0] === 'refmap') {
						const tabs = ka[1].split('|');
						const tt = schema.findIndex(x => x.name === tabs[(v & LINK_FLAG) !== 0 && tabs.length > 1 ? 1 : 0]);
						const nm = tt >= 0 ? nameOf(tt, v === NONE ? v : v & LINK_MASK) : String(v);
						items.push(ka[0] === 'refmap' ? `${nm}=${s16(data[p + 2] | data[p + 3] << 8)}` : nm);
					} else items.push(String(s16(v)));
				}
				val = `[${items.join(', ')}]`;
				break;
			}
			}
			parts.push(`${cn}=${val}`);
		}
		if (t.flags.length > 0) {
			const fl = R(t.flags.length > 8 ? 2 : 1);
			parts.push('flags=' + t.flags.filter((fn, i) => (fl & (1 << i)) !== 0).map(fn => fn.split('=')[0]).join('+'));
		}
		log(`[${rec}] ` + parts.join('  '));
	}
	return 0;
}

module.exports = { run };
