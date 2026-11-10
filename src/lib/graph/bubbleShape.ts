import type { GfaGraph } from './types';
import { MinHeap } from './backbone';

/**
 * Where each bubble node belongs, as a smooth loop of string hanging off the
 * reference (anchored layouts). A bubble strand is drawn at its true bp length,
 * so a 120 bp insertion between two adjacent reference bases is a long string
 * whose two ends are tied to the same point. Placing it by graph depth crammed
 * that string into a short band and the simulation could only crumple it; here
 * each node instead gets a spot on a loop as long as the strand itself.
 *
 * For every bubble node we measure how far along the strands it is from the
 * reference in each direction (`dIn` back toward where it branches off, `dOut`
 * forward to where it rejoins), and where those two reference points are. The
 * strand through it is then a circular arc between those two points whose
 * length is exactly `dIn + dOut`, and the node sits `dIn` along it: a shallow
 * arch when the strand is barely longer than the stretch of reference it
 * replaces, a full circle resting on the line when both ends meet (an
 * insertion). Being exactly as long as the strand, the arc leaves no slack to
 * crumple. Alleles that share a prefix share the start of the arc and part ways
 * where the graph does.
 *
 * A loop only spreads sideways as far as its variant's room on the reference:
 * up to halfway to the next variant on either side. One too
 * long to fit as an arc in that room becomes a hairpin of the same length
 * instead — two straight legs and a round top as wide as the room — so it grows
 * upward rather than into its neighbours.
 *
 * A strand with only one way back to the reference (a dead end) hangs up from
 * where it attaches. A variant's dead ends fan out across its room, each at its
 * own slight angle, rather than all hanging on one line where the simulation
 * would twist them around each other. A strand with no way back
 * inside the window (it only connects to the reference off-screen) hangs up
 * from the strand it hangs off.
 */

export interface StringSpot {
	/** x on the loop. */
	x: number;
	/** Height above the reference line (always ≥ 0; the caller picks the side). */
	height: number;
	/** The reference line's y where the strand attaches. */
	baseY: number;
	/** The x range of its variant's room, which the layout keeps it inside. */
	room: [number, number];
}

interface Reach {
	dist: number;
	x: number;
	y: number;
	/** The segment this reach last came through (its own, at the reference). */
	via: string;
}


/** Half the angle a circular arc of `length` spans over a chord of `chord`:
 * solves sin(θ)/θ = chord/length for θ in (0, π] by bisection. */
function arcHalfAngle(chord: number, length: number): number {
	if (length <= chord) return 0;
	const ratio = chord / length;
	let lo = 0;
	let hi = Math.PI;
	for (let i = 0; i < 40; i++) {
		const mid = (lo + hi) / 2;
		if (Math.sin(mid) / mid > ratio) lo = mid;
		else hi = mid;
	}
	return (lo + hi) / 2;
}

export function bubbleStringSpots(
	graph: GfaGraph,
	chainById: Map<string, { nodeIds: string[] }>,
	chainPxLength: Map<string, number>,
	positionOf: (nodeId: string) => { x: number; y: number },
	backboneSegIds: Set<string>,
	linkLength: number,
	minHeight: number
): Map<string, StringSpot> {
	// Each segment has two ends: `s` (its first chain node) and `e` (its last). A
	// link joins two ends; strands are walked in either direction.
	const endNode = (seg: string, end: 's' | 'e') => {
		const ids = chainById.get(seg)!.nodeIds;
		return end === 's' ? ids[0] : ids[ids.length - 1];
	};
	const neighbors = new Map<string, string[]>();
	const addEdge = (a: string, b: string) => {
		(neighbors.get(a) ?? neighbors.set(a, []).get(a)!).push(b);
		(neighbors.get(b) ?? neighbors.set(b, []).get(b)!).push(a);
	};
	for (const link of graph.links) {
		if (!chainById.has(link.from) || !chainById.has(link.to)) continue;
		addEdge(`${link.from}:${link.fromOrient === '+' ? 'e' : 's'}`, `${link.to}:${link.toOrient === '+' ? 's' : 'e'}`);
	}
	const segOf = (end: string) => end.slice(0, end.lastIndexOf(':'));
	const otherEnd = (end: string) => segOf(end) + (end.endsWith(':s') ? ':e' : ':s');

	// reach(end): the shortest way to the reference *leaving the segment through
	// that end* — never back through the segment itself. Seeded at every bubble end
	// linked straight to the reference, then grown outward: leaving U through g
	// enters S at its far end, runs S's length, and leaves S through its near end.
	const reach = new Map<string, Reach>();
	const attach: [string, number][] = [];
	const heap = new MinHeap();
	const settle = (end: string, r: Reach) => {
		const cur = reach.get(end);
		if (cur && cur.dist <= r.dist) return;
		reach.set(end, r);
		heap.push([r.dist, end]);
	};
	for (const [end, nbrs] of neighbors) {
		if (backboneSegIds.has(segOf(end))) continue;
		for (const nb of nbrs) {
			const seg = segOf(nb);
			if (!backboneSegIds.has(seg)) continue;
			const p = positionOf(endNode(seg, nb.endsWith(':s') ? 's' : 'e'));
			settle(end, { dist: linkLength, x: p.x, y: p.y, via: segOf(end) });
			attach.push([segOf(end), p.x]);
		}
	}
	const done = new Set<string>();
	for (let item = heap.pop(); item; item = heap.pop()) {
		const end = item[1];
		if (done.has(end)) continue;
		done.add(end);
		const r = reach.get(end)!;
		const seg = segOf(end);
		const through = r.dist + (chainPxLength.get(seg) ?? 0) + linkLength;
		for (const g of neighbors.get(otherEnd(end)) ?? []) {
			if (backboneSegIds.has(segOf(g))) continue;
			settle(g, { dist: through, x: r.x, y: r.y, via: seg });
		}
	}

	// Variants: bubble strands joined to each other (not through the reference)
	// are one variant, spanning every place it meets the reference; variants
	// whose spans overlap, or that sit closer together than two clearances (two
	// strands leaving either side of a few bases of reference are one site), are
	// merged. Each variant's room runs halfway to the next variant on either side,
	// and every strand of it shares that room.
	const parent = new Map<string, string>();
	const find = (seg: string): string => {
		let root = seg;
		while (parent.has(root) && parent.get(root) !== root) root = parent.get(root)!;
		parent.set(seg, root);
		return root;
	};
	for (const [end, nbrs] of neighbors) {
		if (backboneSegIds.has(segOf(end))) continue;
		for (const nb of nbrs) {
			if (backboneSegIds.has(segOf(nb))) continue;
			parent.set(find(segOf(end)), find(segOf(nb)));
		}
	}
	const spanOf = new Map<string, [number, number]>();
	for (const [seg, x] of attach) {
		const root = find(seg);
		const span = spanOf.get(root);
		spanOf.set(root, span ? [Math.min(span[0], x), Math.max(span[1], x)] : [x, x]);
	}
	const variants: [number, number][] = [];
	for (const [lo, hi] of [...spanOf.values()].sort((a, b) => a[0] - b[0])) {
		const last = variants[variants.length - 1];
		if (last && lo - last[1] <= 2 * minHeight) last[1] = Math.max(last[1], hi);
		else variants.push([lo, hi]);
	}
	/** The variant around reference x, by index (−1 if none). */
	const variantAt = (x: number) => variants.findIndex(([lo, hi]) => lo <= x && x <= hi);
	const roomOf = (v: number): [number, number] => [
		v > 0 ? (variants[v - 1][1] + variants[v][0]) / 2 : -Infinity,
		v < variants.length - 1 ? (variants[v][1] + variants[v + 1][0]) / 2 : Infinity
	];
	/** The room with an open side (the first or last variant) closed off by
	 * mirroring the other side, so dead ends have a width to spread across. */
	const finiteRoom = (v: number): [number, number] => {
		let [lo, hi] = roomOf(v);
		const [s, e] = variants[v];
		if (!Number.isFinite(lo)) lo = Number.isFinite(hi) ? s - (hi - e) : s - minHeight;
		if (!Number.isFinite(hi)) hi = e + (e - lo);
		return [lo, hi];
	};
	const room = (lo: number, hi: number): [number, number] => {
		const v = variantAt(lo);
		return v < 0 ? [lo, hi] : roomOf(v);
	};

	// Dead ends: each strand that hangs from the reference gets a lane, keyed by
	// its first dead-end segment (a dead end that carries on through more segments
	// keeps its lane). A variant's room is split into one lane per dead end, left
	// to right in the order they attach, and each bends from where it attaches
	// over to the middle of its lane, getting there once it has climbed a quarter
	// of the room's width — about a 45° lean.
	const reachOf = (seg: string) => reach.get(`${seg}:s`) ?? reach.get(`${seg}:e`);
	const isDeadEnd = (seg: string) => !backboneSegIds.has(seg) && !!reach.get(`${seg}:s`) !== !!reach.get(`${seg}:e`);
	const laneKey = new Map<string, string>();
	const keyOf = (seg: string): string => {
		let key = laneKey.get(seg);
		if (key) return key;
		const via = reachOf(seg)!.via;
		key = via !== seg && isDeadEnd(via) ? keyOf(via) : seg;
		laneKey.set(seg, key);
		return key;
	};
	const lanesIn = new Map<number, Map<string, number>>(); // variant → lane key → attach x
	for (const seg of chainById.keys()) {
		if (!isDeadEnd(seg)) continue;
		const x = reachOf(seg)!.x;
		const v = variantAt(x);
		(lanesIn.get(v) ?? lanesIn.set(v, new Map()).get(v)!).set(keyOf(seg), x);
	}
	const laneX = new Map<string, number>();
	for (const [v, keys] of lanesIn) {
		if (v < 0) continue;
		const [lo, hi] = finiteRoom(v);
		const sorted = [...keys].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1)).map(([k]) => k);
		sorted.forEach((k, i) => laneX.set(k, lo + ((i + 0.5) / sorted.length) * (hi - lo)));
	}

	const spots = new Map<string, StringSpot>();
	for (const [segId, chain] of chainById) {
		if (backboneSegIds.has(segId)) continue;
		const startReach = reach.get(`${segId}:s`);
		const endReach = reach.get(`${segId}:e`);
		if (!startReach && !endReach) continue; // placed below, off its neighbours
		const len = chainPxLength.get(segId) ?? 0;
		const n = chain.nodeIds.length - 1;
		chain.nodeIds.forEach((nodeId, i) => {
			const along = n === 0 ? 0 : (i / n) * len;
			if (!startReach || !endReach) {
				// A dead end: hang up from the one place it attaches, in its own lane.
				const r = (startReach ?? endReach)!;
				const d = r.dist + (startReach ? along : len - along);
				const v = variantAt(r.x);
				const lane = laneX.get(keyOf(segId)) ?? r.x;
				const width = v < 0 ? 0 : finiteRoom(v)[1] - finiteRoom(v)[0];
				spots.set(nodeId, {
					x: r.x + (lane - r.x) * (width > 0 ? Math.min(1, (4 * d) / width) : 0),
					height: Math.max(minHeight, d),
					baseY: r.y,
					room: v < 0 ? [-Infinity, Infinity] : roomOf(v)
				});
				return;
			}
			let a = { ...startReach, dist: startReach.dist + along };
			let b = { ...endReach, dist: endReach.dist + len - along };
			if (a.x > b.x) [a, b] = [b, a]; // always trace the loop left to right
			const [lo, hi] = room(a.x, b.x);
			const { x, height } = loopPoint(a.x, b.x, a.dist, a.dist + b.dist, lo, hi);
			spots.set(nodeId, {
				x,
				// Never closer to the line than the clearance the simulation keeps
				// anyway, so the ends of the loop don't start out fighting it.
				height: Math.max(minHeight, height),
				baseY: (a.y + b.y) / 2,
				room: [lo, hi]
			});
		});
	}

	// Strands that only reach the reference outside the window: hang each one up
	// from the end of an already placed strand it links to, continuing upward.
	const placed = new Set([...spots.keys()].map((id) => id.slice(0, id.lastIndexOf('::'))));
	const queue = [...placed];
	for (let head = 0; head < queue.length; head++) {
		const seg = queue[head];
		for (const end of ['s', 'e'] as const) {
			const from = spots.get(endNode(seg, end));
			if (!from) continue;
			for (const nb of neighbors.get(`${seg}:${end}`) ?? []) {
				const next = segOf(nb);
				if (placed.has(next) || backboneSegIds.has(next)) continue;
				placed.add(next);
				queue.push(next);
				const ids = chainById.get(next)!.nodeIds;
				const len = chainPxLength.get(next) ?? 0;
				const n = ids.length - 1;
				const fromNear = nb.endsWith(':s');
				ids.forEach((nodeId, i) => {
					const along = n === 0 ? 0 : ((fromNear ? i : n - i) / n) * len;
					spots.set(nodeId, { ...from, height: from.height + linkLength + along });
				});
			}
		}
	}
	return spots;
}

/**
 * The point `along` px into a strand of length `total` from reference x `ax` to
 * `bx` (ax ≤ bx), as an x and a height. A circular arc of exactly that length
 * over the chord when it fits within [lo, hi]; otherwise a hairpin no wider
 * than that room — out along the line to its edge, straight up, a half circle
 * over, straight down, and back along the line — again exactly `total` long.
 */
export function loopPoint(ax: number, bx: number, along: number, total: number, lo: number, hi: number) {
	const chord = bx - ax;
	const theta = arcHalfAngle(chord, total);
	if (theta === 0) return { x: ax + (total > 0 ? (along / total) * chord : chord / 2), height: 0 };
	// The arc's centre sits over the chord's midpoint; φ sweeps from −θ at the left
	// attachment to +θ at the right, measured from straight up.
	const r = total / (2 * theta);
	const mid = (ax + bx) / 2;
	const halfWidth = theta > Math.PI / 2 ? r : chord / 2;
	if (mid - halfWidth >= lo && mid + halfWidth <= hi) {
		const phi = -theta + (2 * theta * along) / total;
		return { x: mid + r * Math.sin(phi), height: r * (Math.cos(phi) - Math.cos(theta)) };
	}
	const w = Math.min(hi - lo, 2 * halfWidth);
	const centre = Math.min(Math.max(mid, lo + w / 2), hi - w / 2);
	const xl = centre - w / 2;
	const xr = centre + w / 2;
	const out = ax - xl;
	const back = xr - bx;
	const leg = Math.max(0, (total - out - back - (Math.PI * w) / 2) / 2);
	let s = along;
	if (s <= out) return { x: ax - s, height: 0 };
	s -= out;
	if (s <= leg) return { x: xl, height: s };
	s -= leg;
	const top = (Math.PI * w) / 2;
	if (s <= top) {
		const phi = Math.PI - (s / top) * Math.PI; // π at the left leg → 0 at the right
		return { x: xl + w / 2 + (w / 2) * Math.cos(phi), height: leg + (w / 2) * Math.sin(phi) };
	}
	s -= top;
	if (s <= leg) return { x: xr, height: leg - s };
	s -= leg;
	return { x: xr - s, height: 0 };
}
