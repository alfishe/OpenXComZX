// 3D vector with the exact operation order of the C# struct V (Globe.cs): results must be
// bit-identical, so every operator keeps the same expression shape.
'use strict';

class V {
	constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
	add(b) { return new V(this.x + b.x, this.y + b.y, this.z + b.z); }
	sub(b) { return new V(this.x - b.x, this.y - b.y, this.z - b.z); }
	mul(k) { return new V(this.x * k, this.y * k, this.z * k); }
	neg() { return new V(-this.x, -this.y, -this.z); }
	get len() { return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z); }
	norm() { const l = this.len; return new V(this.x / l, this.y / l, this.z / l); }
	static dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
	static cross(a, b) { return new V(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x); }
}

// Math.Round(v) of .NET: midpoint to even
function roundEven(v) {
	const f = Math.floor(v), d = v - f;
	if (d < 0.5) return f;
	if (d > 0.5) return f + 1;
	return f % 2 === 0 ? f : f + 1;
}

// (int)double of C# on x64: truncation, out of range / NaN -> int.MinValue
function toInt(d) {
	if (Number.isNaN(d) || d >= 2147483648 || d < -2147483648) return -2147483648;
	return Math.trunc(d) | 0;
}

module.exports = { V, roundEven, toInt };
