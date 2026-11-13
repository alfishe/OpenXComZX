// YAML as a tree, the same shape YamlDotNet gave the C# converter: Map (keys in source order),
// Array, string (every scalar, quoted or not), null (plain ~, null or empty).
// Accessors behave like field access in JS (missing = null).
'use strict';
const jsyaml = require('../vendor/js-yaml.js');

const SCHEMA = jsyaml.FAILSAFE_SCHEMA.extend({ implicit: [jsyaml.types.null] });

function load(text) { return jsyaml.load(text, { schema: SCHEMA }); }
const map = o => (o instanceof Map ? o : null);
const list = o => (Array.isArray(o) ? o : null);
function get(m, key) { m = map(m); if (!m) return null; const v = m.get(key); return v === undefined ? null : v; }
const has = (m, key) => { m = map(m); return m !== null && m.has(key); };
const str = o => (o === null || o === undefined ? null : typeof o === 'string' ? o : String(o));

// C# double.TryParse(NumberStyles.Float, invariant): optional sign, digits, '.', exponent,
// surrounding white space; no hex, no "Infinity" words beyond what .NET accepts.
const FLOAT_RE = /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/;
function num(o, def = 0) {
	const s = str(o);
	if (s === null) return def;
	if (s === 'true') return 1;
	if (s === 'false') return 0;
	if (/^0x/i.test(s)) { const h = s.slice(2); if (/^[0-9a-fA-F]+$/.test(h)) return parseInt(h, 16); }
	if (FLOAT_RE.test(s)) return parseFloat(s);
	if (/^\s*[+-]?(Infinity|∞)\s*$/.test(s)) return s.includes('-') ? -Infinity : Infinity;
	return def;
}
// C# (int)double: truncation toward zero; out-of-range and NaN give int.MinValue on x86/x64
function toInt(d) {
	if (Number.isNaN(d) || d >= 2147483648 || d < -2147483648) return -2147483648;
	return Math.trunc(d) | 0;
}
const int = (o, def = 0) => toInt(num(o, def));
const bool = o => str(o) === 'true';
// Scalar as String(v) after js-yaml would give it ("~" and "null" are empty)
function jsString(o) {
	if (o === null || o === undefined) return '';
	const s = str(o);
	return s === '~' || s === 'null' ? '' : s;
}

module.exports = { load, map, list, get, has, str, num, int, toInt, bool, jsString };
