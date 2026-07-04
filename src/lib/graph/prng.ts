/** FNV-1a string hash, used to seed per-node deterministic randomness. */
export function hashString(s: string): number {
	let h = 2166136261 >>> 0;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

/** mulberry32 PRNG: deterministic, fast, good enough for layout jitter (not cryptographic). */
export function seededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return function () {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** A stable pseudo-random value in [-0.5, 0.5) for a given string id, independent of call order. */
export function stableUnit(id: string): number {
	return seededRandom(hashString(id))() - 0.5;
}
