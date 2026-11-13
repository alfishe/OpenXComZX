// OpenXcom rules (*.rul, YAML) -> binary tables by schema (rulesschema.js).
//
// Table (TABLE resource): 8-byte header: u16 n, u16 record size, u16 tail offset from the
// resource start, u16 0; n fixed-size records (little-endian, unaligned — like packed SDCC
// structs), then the tail with lists. A table must fit in 16 KB (the engine reads it through
// one Win3 window).
//
// Field kinds: u8 i8 u16 i16 u32 i32; flag (bit of the flags field); x100 (fraction*100 -> i16);
// str (string key -> STRINGS number, #FFFF — none); ref:T (key of a record of table T -> number,
// #FFFF — none; "ref:items|crafts" — in the second table number | #8000); res (picture name ->
// resource id); refs:T (key list), refmap:T (object {key: number}), nums (number list), nums100
// (list of fractions *100), stats (11 stats as u8): in the record u16 tail offset + u8 element
// count (stats — 11 bytes right in the record).
'use strict';
const Y = require('./yaml');
const { ordinal, upInv, hex } = require('./text');
const { roundAway, leBytes } = require('./csmath');

const NONE = 0xFFFF, ALT_TABLE = 0x8000;
const TABLE_HDR = 8, TABLE_MAX = 16384, RECORD_MAX = 255;
const STAT_NAMES = ['tu', 'stamina', 'health', 'bravery', 'reactions', 'firing', 'throwing', 'strength', 'psiStrength', 'psiSkill', 'melee'];
const I16_MIN = -32768, I16_MAX = 32767, U8_MAX = 255, U16_MAX = 0xFFFF, U32_MAX = 0xFFFFFFFF;
const I32_MIN = -2147483648, I32_MAX = 2147483647;
const LON_FULL = 65536, LAT_QUARTER = 16384;

const isEmpty = s => s === null || s === undefined || s.length === 0;

// Clamp(Math.Round(v, AwayFromZero)) -> long (NaN propagates like .NET Math.Max/Min)
function clamp(v, lo, hi) {
	if (Number.isNaN(v)) return 0;   // (long)NaN; never seen in the rules
	return Math.max(lo, Math.min(hi, roundAway(v)));
}

// Engine "binary angles" (src/inc/state.h): longitude 0..65535 = 0..360° (360 -> 65535 so the
// end of a range does not wrap), latitude ±16384 = ±90°.
function lon(deg) { let d = deg % 360; if (d < 0) d += 360; return deg >= 360 ? U16_MAX : clamp(d * LON_FULL / 360, 0, U16_MAX); }
function lat(deg) { return clamp(deg * LAT_QUARTER / 90, -LAT_QUARTER, LAT_QUARTER); }

function size(kind) {
	switch (kind.split(':')[0]) {
	case 'u8': case 'i8': return 1;
	case 'u16': case 'i16': case 'x100': case 'str': case 'ref': case 'res': case 'lon': case 'lat': return 2;
	case 'u32': case 'i32': return 4;
	case 'refs': case 'refmap': case 'nums': case 'nums100': case 'areas': return 3;
	case 'stats': return STAT_NAMES.length;
	default: throw new Error('schema: bad kind ' + kind);
	}
}

const recordSize = t => t.fields.reduce((a, f) => a + size(f.kind), 0) + (t.flags.length > 0 ? (t.flags.length > 8 ? 2 : 1) : 0);

function* flatten(v) {
	const l = Y.list(v);
	if (l === null) { if (v !== null && v !== undefined) yield v; return; }
	for (const x of l) yield* flatten(x);
}

const splitKind = kind => { const i = kind.indexOf(':'); return i < 0 ? [kind] : [kind.slice(0, i), kind.slice(i + 1)]; };

class RuleSet {
	constructor(sections, schema, strIndex, resId) {
		this.sections = sections; this.schema = schema; this.strIndex = strIndex; this.resId = resId;
		this.entries = new Map();   // table -> [[key, entry]]
		this.index = new Map();     // table -> Map key -> number
		this.warnings = [];
		this.cache = new Map();     // schema computations shared between tables (region zone starts)
		this.resFind = () => -1;    // id of an existing resource or -1
		for (const t of schema) this.entries.set(t.name, t.source ? [] : this._merge(t));
		for (const t of schema.filter(t => t.source)) this.entries.set(t.name, t.source(this));
		for (const t of schema) if (t.sortByKey) this.entries.get(t.name).sort((a, b) => ordinal(a[0], b[0]));
		for (const t of schema) this._rebuildIndex(t.name);
		// orders depending on other tables (craftWeapons by launcher etc.)
		for (const t of schema.filter(t => t.sort)) { this.entries.set(t.name, t.sort(this, this.entries.get(t.name))); this._rebuildIndex(t.name); }
	}

	_rebuildIndex(table) {
		const d = new Map();
		this.entries.get(table).forEach(([k], i) => d.set(k, i));
		this.index.set(table, d);
	}

	// Records of a section with the same key merge (later fields override), order of the
	// first appearance (like loadRule/listOrder); "delete: X" removes
	_merge(t) {
		const order = [];
		const map = new Map();
		const sec = t.section ?? t.name;
		for (const e of Y.list(this.sections.has(sec) ? this.sections.get(sec) : null) || []) {
			const m = Y.map(e);
			if (m === null) continue;
			if (m.has('delete')) {
				const dk = Y.str(m.get('delete'));
				map.delete(dk);
				const at = order.indexOf(dk); if (at >= 0) order.splice(at, 1);
				continue;
			}
			const k = Y.str(Y.get(m, t.key));
			if (k === null) continue;
			let acc = map.get(k);
			if (acc === undefined) { acc = new Map(); map.set(k, acc); order.push(k); }
			for (const [kk, vv] of m) acc.set(kk, vv);
		}
		return order.map(k => [k, map.get(k)]);
	}

	listOrder(table, key) { const d = this.index.get(table); return d && key !== null && d.has(key) ? d.get(key) : -1; }

	// Record number without a warning (or -1)
	find(table, keyObj) {
		const key = Y.str(keyObj);
		const d = this.index.get(table);
		return key !== null && d && d.has(key) ? d.get(key) : -1;
	}

	// Rank of the key among the table keys in std::map<std::string> order (byte comparison)
	sortRank(table, key) { return this.entries.get(table).filter(([k]) => ordinal(k, key) < 0).length; }

	ref(kind, keyObj, where) {
		const key = Y.str(keyObj);
		if (isEmpty(key)) return NONE;
		const tables = kind.split('|');
		for (let i = 0; i < tables.length; i++) {
			const idx = this.index.get(tables[i]);
			if (!idx) throw new Error('schema: unknown table ' + tables[i]);
			if (idx.has(key)) return idx.get(key) | (i > 0 ? ALT_TABLE : 0);
		}
		this.warnings.push(`${where}: unknown ${kind} '${key}'`);
		return NONE;
	}

	str(keyObj) {
		const key = Y.str(keyObj);
		if (isEmpty(key)) return NONE;
		return this.strIndex.has(key) ? this.strIndex.get(key) : NONE;
	}

	res(nameObj) { const n = Y.str(nameObj); return isEmpty(n) ? 0 : this.resId(n); }

	build(t) {
		const recSize = recordSize(t);
		// The engine multiplies the record number by the size in a byte (src/kernel/win0/res.s
		// mul16, 8 iterations): a rule record wider than 255 bytes would give wrong addresses
		if (recSize > RECORD_MAX) throw new Error(`rules table ${t.name}: record ${recSize} bytes > 255 (res.s mul16)`);
		const recs = [];
		const tail = [];
		let tailLen = 0;
		const ents = this.entries.get(t.name);
		for (const [key, e] of ents) {
			const b = Buffer.alloc(recSize);
			let o = 0;
			const W = (v, n) => { const bytes = leBytes(v, n); for (let i = 0; i < n; i++) b[o + i] = bytes[i]; o += n; };
			const tailPush = buf => { const off = tailLen; tail.push(buf); tailLen += buf.length; return off; };
			for (const f of t.fields) {
				let v = f.fn ? f.fn(e, key, this) : f.name === '$key' ? key : Y.get(e, f.name);
				if (v === null || v === undefined) v = f.def ?? null;
				const where = `${t.name}.${key}.${f.name ?? f.cname}`;
				const ka = splitKind(f.kind);
				switch (ka[0]) {
				case 'u8': W(clamp(Y.num(v), 0, U8_MAX), 1); break;
				case 'i8': W(clamp(Y.num(v), -128, 127), 1); break;
				case 'u16': W(clamp(Y.num(v), 0, U16_MAX), 2); break;
				case 'i16': W(clamp(Y.num(v), I16_MIN, I16_MAX), 2); break;
				case 'u32': W(clamp(Y.num(v), 0, U32_MAX), 4); break;
				case 'i32': W(clamp(Y.num(v), I32_MIN, I32_MAX), 4); break;
				case 'x100': W(clamp(Y.num(v) * 100, I16_MIN, I16_MAX), 2); break;
				case 'lon': W(lon(Y.num(v)), 2); break;
				case 'lat': W(lat(Y.num(v)), 2); break;
				case 'str': W(this.str(v), 2); break;
				case 'ref': W(this.ref(ka[1], v, where), 2); break;
				case 'res': W(this.res(v), 2); break;
				case 'stats':
					for (const s of STAT_NAMES) W(clamp(Y.num(Y.get(v, s)), 0, U8_MAX), 1);
					break;
				case 'refs': case 'refmap': case 'nums': case 'nums100': case 'areas': {
					const items = [];
					let count;
					if (ka[0] === 'refs') { for (const k of Y.list(v) || []) items.push(this.ref(ka[1], k, where)); count = items.length; }
					else if (ka[0] === 'nums') { for (const k of flatten(v)) items.push(clamp(Y.num(k), I16_MIN, I16_MAX)); count = items.length; }
					else if (ka[0] === 'nums100') { for (const k of flatten(v)) items.push(clamp(Y.num(k) * 100, I16_MIN, I16_MAX)); count = items.length; }
					else if (ka[0] === 'areas') {
						// [lonMin, lonMax, latMin, latMax] x n: longitudes u16, latitudes i16 (binary angles)
						const l = [...flatten(v)].map(x => Y.num(x));
						for (let i = 0; i + 3 < l.length; i += 4) items.push(lon(l[i]), lon(l[i + 1]), lat(l[i + 2]), lat(l[i + 3]));
						count = Math.trunc(items.length / 4);
					} else {
						for (const [pk, pv] of Y.map(v) || new Map()) { items.push(this.ref(ka[1], pk, where)); items.push(clamp(Y.num(pv), I16_MIN, I16_MAX)); }
						count = Math.trunc(items.length / 2);
					}
					const buf = Buffer.alloc(items.length * 2);
					items.forEach((x, i) => { buf[i * 2] = x & 0xFF; buf[i * 2 + 1] = (x >> 8) & 0xFF; });
					const off = items.length > 0 ? tailPush(buf) : 0;
					W(off, 2); W(Math.min(count, U8_MAX), 1);
					break;
				}
				default: throw new Error('schema: bad kind ' + f.kind);
				}
			}
			if (t.flags.length > 0) {
				let fl = 0;
				t.flags.forEach((flag, i) => {
					const parts = flag.split('=');     // "recover=true" — default true
					const fv = Y.get(e, parts[0]);
					const on = fv !== null ? Y.bool(fv) : parts.length > 1 && parts[1] === 'true';
					if (on) fl |= 1 << i;
				});
				W(fl, t.flags.length > 8 ? 2 : 1);
			}
			recs.push(b);
		}
		const n = ents.length;
		const hdr = Buffer.alloc(TABLE_HDR);
		hdr.writeUInt16LE(n & 0xFFFF, 0); hdr.writeUInt16LE(recSize, 2);
		const tailOff = TABLE_HDR + recs.length * recSize;
		hdr[4] = tailOff & 0xFF; hdr[5] = (tailOff >> 8) & 0xFF;
		const data = Buffer.concat([hdr, ...recs, ...tail]);
		if (data.length > TABLE_MAX) this.warnings.push(`${t.name}: table ${data.length} bytes > 16 KB`);
		return { data, count: n, recSize };
	}

	// All game sections from *.rul files (alphabetical): lists concatenate, the rest overrides
	static loadSections(ox, folder) {
		const sections = new Map();
		for (const f of ox.ruleFiles(folder)) {
			const doc = Y.map(Y.load(ox.readText(`standard/${folder}/${f}`)));
			if (doc === null) continue;
			for (const [k, v] of doc) {
				const sec = Y.str(k);
				if (Array.isArray(v)) {
					const ex = sections.get(sec);
					if (Array.isArray(ex)) ex.push(...v);
					else sections.set(sec, v.slice());
				} else sections.set(sec, v);
			}
		}
		return sections;
	}

	// C header: record structs, table resource ids, flag bits
	static header(schema, resBase) {
		let sb = '// Сгенерировано OxzConv (tools/oxzconv/lib/rulesschema.js) — не править вручную.\n';
		sb += '// Таблицы правил (RULES.PAK): заголовок rtable_t, записи r_<таблица>_t, «хвост» со списками.\n';
		sb += '#ifndef RULES_H\n#define RULES_H\n\n#include <stdint.h>\n\n';
		sb += 'typedef struct { uint16_t off; uint8_t n; } rlist_t;   // хвост: u16 элементы (refmap — пары u16 номер, i16 число)\n';
		sb += 'typedef struct { uint16_t n, rec_size, tail, reserved; } rtable_t;\n';
		sb += 'typedef struct { uint8_t tu, stamina, health, bravery, reactions, firing, throwing, strength, psi_strength, psi_skill, melee; } rstats_t;\n';
		sb += '_Static_assert(sizeof(rlist_t) == 3 && sizeof(rstats_t) == 11, "packed records");\n';
		sb += '#define RNONE      0xFFFF\n#define RREF_ALT   0x8000   // ref на вторую таблицу («items|crafts» -> craft)\n\n';
		schema.forEach((t, i) => { sb += `#define RES_RULE_${upInv(t.name).padEnd(16)} 0x${hex(resBase + i, 4)}\n`; });
		sb += `#define RES_RULE_VARS             0x${hex(resBase - 1, 4)}\n\n`;
		for (const t of schema) {
			sb += `// ${t.section ?? t.name}${t.comment != null ? ' — ' + t.comment : ''}\n`;
			sb += 'typedef struct {\n';
			for (const f of t.fields) {
				const k = f.kind.split(':')[0];
				const ct = k === 'u8' ? 'uint8_t' : k === 'i8' ? 'int8_t' : k === 'u16' || k === 'str' || k === 'ref' || k === 'res' || k === 'lon' ? 'uint16_t'
					: k === 'i16' || k === 'x100' || k === 'lat' ? 'int16_t'
					: k === 'u32' ? 'uint32_t' : k === 'i32' ? 'int32_t' : k === 'stats' ? 'rstats_t' : 'rlist_t';
				const cn = f.cname ?? (f.name === '$key' ? 'name' : f.name);
				const note = f.comment ?? (f.kind.includes(':') ? f.kind : k === 'x100' ? '* 100' : k === 'nums100' ? 'i16 * 100'
					: k === 'lon' ? 'двоичный угол 0..65535' : k === 'lat' ? 'двоичный угол ±16384'
					: k === 'areas' ? '{u16 lonMin, lonMax; i16 latMin, latMax} x n, двоичные углы' : null);
				sb += `\t${ct.padEnd(9)} ${snake(cn)};${note != null ? '   // ' + note : ''}\n`;
			}
			if (t.flags.length > 0) sb += `\t${(t.flags.length > 8 ? 'uint16_t' : 'uint8_t').padEnd(9)} flags;\n`;
			sb += `} r_${t.name}_t;\n`;
			sb += `_Static_assert(sizeof(r_${t.name}_t) == ${recordSize(t)}, "r_${t.name}_t: size must match the table record");\n`;
			t.flags.forEach((flag, i) => {
				sb += `#define ${upInv(t.name)}_F_${upInv(snake(flag.split('=')[0])).padEnd(20)} 0x${hex(1 << i, 4)}\n`;
			});
			sb += '\n';
		}
		sb += '#endif\n';
		return sb;
	}
}

// camelCase -> snake_case (ASCII identifiers)
function snake(s) {
	let r = '';
	const upper = c => /\p{Lu}/u.test(c);
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (upper(c) && i > 0 && !upper(s[i - 1])) r += '_';
		r += /[\p{L}\p{Nd}]/u.test(c) ? c.toLowerCase() : '_';
	}
	return r;
}

module.exports = { RuleSet, recordSize, lon, lat, STAT_NAMES };
