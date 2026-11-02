import type { GfaGraph } from './types';
import type { SegmentChain, SimNode, LayoutResult } from './forceLayout';

/**
 * Deterministic "bubble lanes" placement for the anchored layout: every
 * non-reference segment is placed directly, with no force simulation.
 *
 * The force layout pulled each bubble up to a BFS-depth height (scaled to the
 * whole locus's width) and pinned it to its attachment x, so a short insertion
 * hanging off one reference point became a thin column of stretched links with
 * its alt nodes stacked on top of each other (STAT2's polymorphic TE was the
 * motivating case). Here a bubble is drawn the way a genome browser draws
 * alternate tracks instead:
 *
 *  1. Bubbles are the connected components of non-reference segments. Each one
 *     attaches to the reference at one or more x positions (its "cut sites").
 *  2. Inside a bubble, segments are laid out left-to-right in sequence order:
 *     a segment starts just after the furthest-right of its predecessors (a
 *     longest-path pass over the bubble's directed links), and runs for its
 *     length in bp, at exactly the scale of the reference (which is drawn
 *     linear in bp, with no gaps between its nodes) — so a 300 bp TE reads as
 *     a 300 bp track, not a vertical stack, and an allele never looks longer
 *     than the sequence it carries. A 1 bp node is 1 bp wide, as it is on the
 *     reference; zooming in is how to tell such nodes apart.
 *  3. The bubble is split into lanes by path decomposition: its longest path
 *     takes lane 0, then the longest path through what's left takes the lowest
 *     lane it fits in without overlapping, and so on. Alternative alleles
 *     between the same anchors fan out into parallel lanes rather than piling
 *     onto one x.
 *  4. Each bubble is centred over the reference span it replaces, so a point
 *     insertion forms a symmetric tent above its cut site. Bubbles are never
 *     magnified: a short insertion in a wide window is drawn short, and zooming
 *     in is how to read it. With `spread` on, a crowded stretch of bubbles is
 *     moved apart sideways into the empty reference beside it, and its
 *     connectors lean back to the true anchors.
 *  5. Bubbles are stacked: narrow ones first, closest to the axis, each in the
 *     lowest band of rows that's clear of every bubble already placed over its
 *     footprint.
 *  6. A link that skips over nodes on its own lane (one allele bypassing a short
 *     run of others) bows above that lane through its bend node, higher the more
 *     nodes it jumps, so skips from the same node nest instead of crossing.
 *     Every other link is a straight connector.
 */

export interface LaneLayoutInput {
	graph: GfaGraph;
	nodesById: Map<string, SimNode>;
	chainById: Map<string, SegmentChain>;
	structuralLinkPaths: LayoutResult['structuralLinkPaths'];
	chainPxLength: Map<string, number>;
	/** Segments that are already positioned (the reference backbone, plus any
	 * straightened walk) — bubbles hang off these and they are not moved. */
	fixedSegIds: Set<string>;
	/** Vertical step between lanes, in world units. */
	laneGap: number;
	/** Spread crowded stretches sideways (step 4). */
	spread: boolean;
}

// Horizontal sizes are fractions of the reference's on-screen extent, so a
// bubble reads the same at any locus size (the layout is always fitted to the
// canvas width).
/** When picking each lane's path, a segment counts for at least this much, so
 * a long run of 1 bp nodes is taken as one lane rather than split into many. */
const LANE_WEIGHT_FRACTION = 1 / 2000;
/** Horizontal clearance kept between two bubbles sharing a row. */
const BUBBLE_PAD_FRACTION = 1 / 2000;
/** Furthest a crowded stretch may spread out on each side (step 4), and the
 * margin kept between spread stretches. */
const MAX_SPREAD_FRACTION = 1 / 10;
const SPREAD_CLEARANCE_FRACTION = 1 / 300;
/** Height, in lane gaps, at which a spread run's connectors finish leaning
 * (step 6). */
const SPREAD_BEND_HEIGHT = 0.5;
/** How high a skip link bows above its lane per lane node it jumps, and at
 * most, as fractions of the lane gap (kept under half so a bow never reaches the
 * lane above). */
const SKIP_BOW_STEP = 0.07;
const MAX_SKIP_BOW = 0.35;

interface DirEdge {
	u: string;
	v: string;
	/** The chain node each end of the link actually touches. */
	uNode: string;
	vNode: string;
}

interface Bubble {
	members: string[];
	baselineY: number;
	/** Leftmost and rightmost reference x the bubble attaches at. */
	entryX: number;
	exitX: number;
	/** Midpoint of that span: the bubble is centred about it. */
	centre: number;
	/** Segment start x and width, already centred. */
	xs: Map<string, number>;
	widths: Map<string, number>;
	lane: Map<string, number>;
	/** Each lane's segments, left to right. */
	lanes: string[][];
	/** Extent of the bubble's own segments. */
	altWidth: number;
	/** Footprint: its segments and the reference span they hang off. */
	lo: number;
	hi: number;
	row: number;
	/** Sideways offset of the drawn lanes from their anchor (step 4). */
	shift: number;
}

export function placeBubbleLanes(input: LaneLayoutInput): void {
	const { graph, nodesById, chainById, chainPxLength, fixedSegIds, laneGap } = input;

	let refLo = Infinity;
	let refHi = -Infinity;
	for (const s of fixedSegIds) {
		for (const id of chainById.get(s)?.nodeIds ?? []) {
			refLo = Math.min(refLo, nodesById.get(id)!.x);
			refHi = Math.max(refHi, nodesById.get(id)!.x);
		}
	}
	const refWidth = Number.isFinite(refLo) ? Math.max(1, refHi - refLo) : 1;
	const bubblePad = refWidth * BUBBLE_PAD_FRACTION;

	// Directed edges in reference order. A '-'/'-' link is the same adjacency read
	// backwards, so it's flipped; mixed-orientation links (inversion boundaries)
	// keep their written direction. Orientation votes decide which way round each
	// free segment's chain is drawn.
	const succ = new Map<string, DirEdge[]>();
	const pred = new Map<string, DirEdge[]>();
	const orientVote = new Map<string, number>();
	const vote = (seg: string, o: string) =>
		orientVote.set(seg, (orientVote.get(seg) ?? 0) + (o === '+' ? 1 : -1));
	for (const link of graph.links) {
		const fromChain = chainById.get(link.from);
		const toChain = chainById.get(link.to);
		if (!fromChain || !toChain || link.from === link.to) continue;
		const fromNode =
			link.fromOrient === '+' ? fromChain.nodeIds[fromChain.nodeIds.length - 1] : fromChain.nodeIds[0];
		const toNode = link.toOrient === '+' ? toChain.nodeIds[0] : toChain.nodeIds[toChain.nodeIds.length - 1];
		const flip = link.fromOrient === '-' && link.toOrient === '-';
		const e: DirEdge = flip
			? { u: link.to, v: link.from, uNode: toNode, vNode: fromNode }
			: { u: link.from, v: link.to, uNode: fromNode, vNode: toNode };
		(succ.get(e.u) ?? succ.set(e.u, []).get(e.u)!).push(e);
		(pred.get(e.v) ?? pred.set(e.v, []).get(e.v)!).push(e);
		vote(link.from, flip ? '+' : link.fromOrient);
		vote(link.to, flip ? '+' : link.toOrient);
	}

	// --- 1. Bubbles: connected components of free segments ---
	const free = [...chainById.keys()].filter((s) => !fixedSegIds.has(s)).sort();
	const compOf = new Map<string, number>();
	const bubbles: Bubble[] = [];
	for (const start of free) {
		if (compOf.has(start)) continue;
		const id = bubbles.length;
		const members: string[] = [];
		const stack = [start];
		compOf.set(start, id);
		while (stack.length) {
			const s = stack.pop()!;
			members.push(s);
			for (const e of [...(succ.get(s) ?? []), ...(pred.get(s) ?? [])]) {
				const o = e.u === s ? e.v : e.u;
				if (fixedSegIds.has(o) || compOf.has(o)) continue;
				compOf.set(o, id);
				stack.push(o);
			}
		}
		members.sort();

		const attachXs: number[] = [];
		let baselineY = 0;
		for (const s of members) {
			for (const e of pred.get(s) ?? []) {
				if (!fixedSegIds.has(e.u)) continue;
				const n = nodesById.get(e.uNode)!;
				attachXs.push(n.x);
				baselineY = n.componentBaselineY;
			}
			for (const e of succ.get(s) ?? []) {
				if (!fixedSegIds.has(e.v)) continue;
				const n = nodesById.get(e.vNode)!;
				attachXs.push(n.x);
				baselineY = n.componentBaselineY;
			}
		}
		const entryX = attachXs.length ? Math.min(...attachXs) : 0;
		const exitX = attachXs.length ? Math.max(...attachXs) : 0;
		const b: Bubble = {
			members,
			baselineY,
			entryX,
			exitX,
			centre: (entryX + exitX) / 2,
			xs: new Map(),
			widths: new Map(),
			lane: new Map(),
			lanes: [],
			altWidth: 0,
			lo: 0,
			hi: 0,
			row: 0,
			shift: 0
		};
		arrange(b);
		bubbles.push(b);
	}

	/** Steps 2–3 for one bubble. */
	function arrange(b: Bubble) {
		const id = compOf.get(b.members[0]);
		const width = (s: string) => chainPxLength.get(s) ?? 0;
		for (const s of b.members) b.widths.set(s, width(s));

		// x by longest path from the bubble's entry: a segment starts where the
		// last of its predecessors ends — a free predecessor's end is its own x +
		// width, a reference predecessor's is the x where the link leaves it. Back
		// edges (into a segment still being resolved) are ignored, which breaks any
		// cycle.
		const xs = new Map<string, number>();
		const state = new Map<string, 1 | 2>();
		const resolve = (s: string): number => {
			const st = state.get(s);
			if (st === 2) return xs.get(s)!;
			if (st === 1) return NaN;
			state.set(s, 1);
			let x = -Infinity;
			for (const e of pred.get(s) ?? []) {
				if (fixedSegIds.has(e.u)) x = Math.max(x, nodesById.get(e.uNode)!.x);
				else if (compOf.get(e.u) === id) {
					const px = resolve(e.u);
					if (!Number.isNaN(px)) x = Math.max(x, px + width(e.u));
				}
			}
			if (x === -Infinity) x = b.entryX;
			xs.set(s, x);
			state.set(s, 2);
			return x;
		};
		for (const s of b.members) resolve(s);
		let minX = Infinity;
		let maxX = -Infinity;
		for (const s of b.members) {
			minX = Math.min(minX, xs.get(s)!);
			maxX = Math.max(maxX, xs.get(s)! + width(s));
		}

		// Lanes by path decomposition. best(s) = weight(s) + best of its remaining
		// successors that lie to its right — x order makes that a DAG, so the
		// recursion can't loop.
		const weight = (s: string) => Math.max(width(s), refWidth * LANE_WEIGHT_FRACTION);
		const remaining = new Set(b.members);
		// Right to left, so every successor is scored before the segments that
		// lead to it.
		const rightToLeft = [...b.members].sort((p, q) => xs.get(q)! - xs.get(p)! || (p < q ? -1 : 1));
		const laneSpans: [number, number][][] = [];
		b.lane.clear();
		b.lanes = [];
		while (remaining.size) {
			const best = new Map<string, { w: number; next: string | null }>();
			const order = rightToLeft.filter((s) => remaining.has(s));
			for (const s of order) {
				let w = 0;
				let next: string | null = null;
				for (const e of succ.get(s) ?? []) {
					if (!remaining.has(e.v) || xs.get(e.v)! <= xs.get(s)!) continue;
					const nb = best.get(e.v)!;
					if (next === null || nb.w > w || (nb.w === w && e.v < next)) {
						w = nb.w;
						next = e.v;
					}
				}
				best.set(s, { w: w + weight(s), next });
			}
			let start = order[order.length - 1];
			for (const s of order) if (best.get(s)!.w > best.get(start)!.w) start = s;
			const path: string[] = [];
			for (let s: string | null = start; s !== null; s = best.get(s)!.next) path.push(s);

			const last = path[path.length - 1];
			const lo = xs.get(path[0])!;
			const hi = xs.get(last)! + width(last);
			let l = 0;
			while (laneSpans[l]?.some(([a, c]) => a < hi && lo < c)) l++;
			(laneSpans[l] ??= []).push([lo, hi]);
			(b.lanes[l] ??= []).push(...path);
			for (const s of path) {
				b.lane.set(s, l);
				remaining.delete(s);
			}
		}
		for (const l of b.lanes) l.sort((p, q) => xs.get(p)! - xs.get(q)!);

		// Centre over the reference span.
		const shift = b.centre - (minX + maxX) / 2;
		for (const s of b.members) b.xs.set(s, xs.get(s)! + shift);
		b.altWidth = maxX - minX;
		setFootprint(b);
	}

	function setFootprint(b: Bubble) {
		b.lo = Math.min(b.centre - b.altWidth / 2, b.entryX) - bubblePad;
		b.hi = Math.max(b.centre + b.altWidth / 2, b.exitX) + bubblePad;
	}

	// --- 4. Spread crowded stretches into the free room beside them ---
	// A run of bubbles whose anchor spans overlap (or come within the spread
	// margin) would otherwise stack into a tower over its anchors. Its bubbles
	// are moved apart about the run's centre, as if that stretch of
	// reference were drawn wider: lanes keep their bp widths and order, only
	// their positions spread, and connectors lean back to the true anchors. A run
	// spreads only as far as it needs to set its bubbles side by side, and each
	// side no further than the room before the neighbouring run (less the
	// margin) or MAX_SPREAD_FRACTION of the view. A lone bubble, or a run that wouldn't
	// stack anyway, stays centred over its anchors.
	// Runs are found from anchor spans alone: a wide bubble's lanes sit above
	// the small ones under it anyway, so they don't make those a crowd.
	const clearance = refWidth * SPREAD_CLEARANCE_FRACTION;
	const aLo = (b: Bubble) => b.entryX - bubblePad;
	const aHi = (b: Bubble) => b.exitX + bubblePad;
	const runs: Bubble[][] = [];
	let runHi = -Infinity;
	for (const b of [...bubbles].sort((p, q) => aLo(p) - aLo(q))) {
		if (runs.length && aLo(b) < runHi + clearance) {
			runs[runs.length - 1].push(b);
			runHi = Math.max(runHi, aHi(b));
		} else {
			runs.push([b]);
			runHi = aHi(b);
		}
	}
	const extent = runs.map((run) => ({
		lo: Math.min(...run.map(aLo)),
		hi: Math.max(...run.map(aHi))
	}));
	const spreadOf = new Map<Bubble, number>();
	// Only a run that would actually stack is spread; one whose bubbles merely
	// sit close together already reads fine where it is. A gap between two
	// spreading runs is shared; a run next to one that stays put may use all of it.
	const stacks = runs.map((run) =>
		run.some((b, i) => run.slice(0, i).some((o) => aLo(o) < aHi(b) && aLo(b) < aHi(o)))
	);
	runs.forEach((run, k) => {
		const { lo, hi } = extent[k];
		const c = (lo + hi) / 2;
		const share = (j: number) => (stacks[j] ? 2 : 1);
		const roomLeft = k === 0 ? lo - refLo : (lo - extent[k - 1].hi - clearance) / share(k - 1);
		const roomRight = k === runs.length - 1 ? refHi - hi : (extent[k + 1].lo - hi - clearance) / share(k + 1);
		// The run asks for enough width to set its bubbles side by side, and each
		// side of its centre gets as much of that as its own room allows.
		const half = (hi - lo) / 2;
		const need = run.reduce((w, b) => w + Math.max(aHi(b) - aLo(b), b.altWidth + 2 * bubblePad), 0);
		const ask = Math.min(Math.max(0, need - (hi - lo)) / 2, refWidth * MAX_SPREAD_FRACTION);
		const factor = (room: number) =>
			!input.spread || !stacks[k] || half <= 0 ? 1 : 1 + Math.max(0, Math.min(ask, room)) / half;
		const fLeft = factor(roomLeft);
		const fRight = factor(roomRight);
		for (const b of run) {
			const f = b.centre < c ? fLeft : fRight;
			spreadOf.set(b, Math.max(fLeft, fRight));
			b.shift = (f - 1) * (b.centre - c);
		}
	});

	// --- 5. Stack bubbles: narrow first, each in the lowest clear band of rows ---
	// Footprints are measured where the bubbles now sit: lanes and anchor span
	// both moved by the bubble's shift.
	const rows: [number, number][][] = [];
	const stackOrder = [...bubbles].sort((p, q) => p.hi - p.lo - (q.hi - q.lo) || p.lo - q.lo);
	for (const b of stackOrder) {
		const lo = Math.min(b.entryX, b.centre - b.altWidth / 2) + b.shift - bubblePad;
		const hi = Math.max(b.exitX, b.centre + b.altWidth / 2) + b.shift + bubblePad;
		const clear = (r: number) => !rows[r]?.some(([a, c]) => a < hi && lo < c);
		let base = 0;
		while (!b.lanes.every((_, l) => clear(base + l))) base++;
		b.lanes.forEach((_, l) => (rows[base + l] ??= []).push([lo, hi]));
		b.row = base;
	}

	// --- Write positions ---
	const segLane = new Map<string, { b: Bubble; l: number; idx: number }>();
	for (const b of bubbles) {
		b.lanes.forEach((segs, l) => segs.forEach((s, idx) => segLane.set(s, { b, l, idx })));
		for (const s of b.members) {
			const chain = chainById.get(s)!;
			const x0 = b.xs.get(s)! + b.shift;
			const w = b.widths.get(s)!;
			const y = b.baselineY - (b.row + b.lane.get(s)! + 1) * laneGap;
			const reversed = (orientVote.get(s) ?? 0) < 0;
			const numEdges = chain.nodeIds.length - 1;
			chain.nodeIds.forEach((id, i) => {
				const t = numEdges === 0 ? 0.5 : i / numEdges;
				const node = nodesById.get(id)!;
				node.x = x0 + (reversed ? 1 - t : t) * w;
				node.y = y;
				node.fx = node.x;
				node.fy = node.y;
				node.componentBaselineY = b.baselineY;
			});
		}
	}

	// --- 6. Bend nodes: connectors, bowed skips ---
	for (const path of input.structuralLinkPaths) {
		if (!path.bendNode) continue;
		const bend = nodesById.get(path.bendNode)!;
		const a = nodesById.get(path.fromNode)!;
		const c = nodesById.get(path.toNode)!;
		bend.x = (a.x + c.x) / 2;
		bend.y = (a.y + c.y) / 2;
		bend.componentBaselineY = a.componentBaselineY;
		const la = segLane.get(path.from);
		const lc = segLane.get(path.to);
		if (la && lc && la.b === lc.b && la.l === lc.l && Math.abs(la.idx - lc.idx) > 1) {
			// The bend node is a quadratic control point, so the curve peaks at half
			// its offset.
			const skipped = Math.abs(la.idx - lc.idx) - 1;
			bend.y -= 2 * laneGap * Math.min(MAX_SKIP_BOW, SKIP_BOW_STEP * (1 + skipped));
		} else if (!la !== !lc && spreadOf.get((la ?? lc)!.b)! > 1) {
			// A connector from a spread run back to its true anchor is drawn as an
			// elbow: just above the axis it leans over by its bubble's shift, then
			// rises to its lane. All of a run's leans happen at the same height and
			// keep the anchors' order, so they fan out side by side without
			// crossing, and above them each bubble keeps its usual tent shape.
			const anchor = la ? c : a;
			bend.x = anchor.x + (la ?? lc)!.b.shift;
			bend.y = anchor.y - laneGap * SPREAD_BEND_HEIGHT;
			path.elbow = true;
		}
		bend.fx = bend.x;
		bend.fy = bend.y;
	}
}
