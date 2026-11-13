// Soldier name pools (common/SoldierName/*.nam, soldiers.rul soldierNames: SoldierName/)
// -> NAMES resource (LANG.PAK). Like SoldierNamePool in OpenXcom: the pool is random, first and
// last names by gender; no female last names — male ones are used.
// NAMES: u8 n; u16 offs[n] (from the resource start); pool: u8 cnt[4] (maleFirst, femaleFirst,
// maleLast, femaleLast; up to 255), then the strings back to back (game string encoding,
// terminating 0) in the same order.
'use strict';
const Y = require('./yaml');
const Strings = require('./strings');

const KEYS = ['maleFirst', 'femaleFirst', 'maleLast', 'femaleLast'];
const MAX_COUNT = 255, MAX_POOLS = 255, MAX_OFFSET = 0xFFFF;

function build(ox, cs, warnings) {
	const files = ox.files('common/SoldierName', '.nam');
	let pools = [];
	let total = 0;
	for (const f of files) {
		let doc;
		try { doc = Y.load(ox.readText('common/SoldierName/' + f)); }
		catch (e) { warnings.push(`SoldierName/${f}: ${e.message} — pool skipped`); continue; }
		const body = [];
		const cnt = Buffer.alloc(KEYS.length);
		for (let k = 0; k < KEYS.length; k++) {
			const l = (Y.list(Y.get(doc, KEYS[k])) || []).map(Y.str).filter(s => s !== null && s.length > 0).slice(0, MAX_COUNT);
			cnt[k] = l.length;
			for (const s of l) body.push(Strings.encode(s, cs));
			total += l.length;
		}
		if (cnt[0] === 0 && cnt[1] === 0) continue;
		pools.push(Buffer.concat([cnt, ...body]));
	}
	if (pools.length > MAX_POOLS) pools = pools.slice(0, MAX_POOLS);
	const head = Buffer.alloc(1 + pools.length * 2);
	head[0] = pools.length;
	let pos = head.length;
	pools.forEach((p, i) => {
		if (pos > MAX_OFFSET) throw new Error('NAMES too large');
		head.writeUInt16LE(pos, 1 + i * 2);
		pos += p.length;
	});
	return { data: Buffer.concat([head, ...pools]), pools: pools.length, names: total };
}

module.exports = { build };
