// Build a base-level multiple-sequence-alignment (MSA) matrix for a window of a
// pangenome graph, centred on a clicked node. This is the data model behind the
// MSA "zoom-in" view (MsaCanvas.svelte): the reference plus the haplotypes that
// pass through the selected node, laid out base-by-base along the reference axis.
//
// The alignment is *node-block* based, the same idea the 1D pangenome tools use:
// a graph node is a run of shared sequence, so every path that visits it is, by
// construction, aligned there. Each node becomes a block of `bpLen` columns; a
// row (path) either fills a block with that node's bases or shows a gap. There is
// no per-base realignment — divergent alleles between the same two anchors sit in
// adjacent blocks and the rows "trade off" between them, which reads cleanly and
// is exact for the sequence the graph actually stores.
//
// Kept as a pure module (no Svelte, no DOM) so it can be unit-tested directly.
import type { Gfa } from '../gfa';

export type Orient = '+' | '-';

export interface AlignBlock {
	/** Displayed segment id this block draws. */
	segId: string;
	/** Short local name within this window: R1,R2,… along the reference (left to
	 * right), A1,A2,… for the alt nodes. Stable for the life of the window; shared
	 * with the graph view so the same node reads the same in both. */
	simpleName: string;
	/** Node length in bp = number of base columns in the block. */
	bpLen: number;
	/** Cumulative bp offset of the block's left edge from the window's left. */
	colStart: number;
	/** On the reference/backbone walk (vs. an alt/insertion node). */
	isBackbone: boolean;
	/** The clicked node — highlighted across every row. */
	isSelected: boolean;
	/** Reference coordinate at the block's left edge (backbone blocks only). */
	refStart?: number;
	contig?: string;
}

export interface AlignRow {
	/** Stable id (walk name); reference row is `#ref`. */
	key: string;
	label: string;
	sample: string;
	isReference: boolean;
	/** Identical rows are collapsed; this many walks share this trace. */
	multiplicity: number;
	/** At least one walk in this (deduped) row passes through the selected node. Rows
	 * through the selected node are ordered first (just under the reference); the rest
	 * of the window's walks follow. */
	throughSelected: boolean;
	/** The path visits a shared backbone node in the opposite orientation — an
	 * inversion relative to the reference axis. Flagged, not re-laid-out. */
	hasInversion: boolean;
	/** One entry per block (aligned to `blocks`):
	 *   - `null`   — a gap: the path does not visit this node.
	 *   - `''`     — the path visits the node but its sequence is unknown (rGFA `*`).
	 *   - a string of length `bpLen` — the oriented bases (revcomp'd on `-`). */
	cells: (string | null)[];
}

export interface Alignment {
	blocks: AlignBlock[];
	rows: AlignRow[];
	/** Displayed segment id → its short local name (R1/A1/…) within this window. */
	nameBySeg: Map<string, string>;
	/** Total bp across all blocks (the horizontal extent, in base columns). */
	totalBp: number;
	selectedSegId: string;
	/** Whether the selected node sits on the reference backbone. */
	selectedOnBackbone: boolean;
	contig: string | null;
	/** Reference-coordinate span the window covers (backbone-derived). */
	window: { start: number; end: number } | null;
	/** Rows dropped by the row cap. */
	truncatedRows: number;
	/** The bp window was clamped by the column cap. */
	truncatedWindow: boolean;
	/** At least one block carries real sequence (vs. length-only rGFA nodes). */
	hasSequence: boolean;
	/** Non-fatal explanation when the alignment is empty or degraded. */
	note?: string;
}

export interface BuildOptions {
	referenceSample?: string;
	selectedSegId: string;
	/** Half-window on the reference axis, in bp (columns each side of centre). */
	windowBp: number;
	/** Hard caps (clamped, with truncation flags set). */
	maxColumns?: number;
	maxRows?: number;
	/** Max alt nodes recorded per inter-anchor gap, to bound pathological loci. */
	maxAltsPerGap?: number;
}

const COMPLEMENT: Record<string, string> = {
	A: 'T', T: 'A', G: 'C', C: 'G', a: 't', t: 'a', g: 'c', c: 'g',
	U: 'A', u: 'a', N: 'N', n: 'n'
};

/** Reverse-complement a DNA string; unknown symbols are passed through reversed. */
export function revcomp(seq: string): string {
	let out = '';
	for (let i = seq.length - 1; i >= 0; i--) out += COMPLEMENT[seq[i]] ?? seq[i];
	return out;
}

/** The oriented base string a path reads at a node, upper-cased. */
function orientedSeq(seq: string, orient: Orient): string {
	const s = seq.toUpperCase();
	return orient === '-' ? revcomp(s) : s;
}

interface Walkish {
	sample: string;
	hapIndex: number;
	seqId: string;
	start?: number;
	steps: { id: string; orient: Orient }[];
	kind?: string;
}

interface Projected {
	/** Collapsed run of displayed segments the walk visits, with orientation. */
	steps: { id: string; orient: Orient }[];
}

/** Map original node ids onto the displayed segment that stands for them (itself,
 * or the unchop-merged u-chain that swallowed it). Identity on a full GFA. */
function buildOrigToDisplayed(gfa: Gfa): Map<string, string> {
	const m = new Map<string, string>();
	for (const seg of gfa.segments.values()) {
		m.set(seg.id, seg.id);
		if (seg.members) for (const orig of seg.members) m.set(orig, seg.id);
	}
	return m;
}

/** Project a walk onto displayed segments: map through origToDisplayed, drop
 * unrepresented steps, collapse consecutive steps in the same displayed node. */
function project(steps: { id: string; orient: Orient }[], o2d: Map<string, string>): Projected {
	const out: { id: string; orient: Orient }[] = [];
	let last: string | null = null;
	for (const s of steps) {
		const id = o2d.get(s.id);
		if (!id || id === last) continue;
		out.push({ id, orient: s.orient });
		last = id;
	}
	return { steps: out };
}

interface BackboneNode {
	segId: string;
	refStart: number;
	refEnd: number;
	orient: Orient;
}

/** Pick the reference/backbone walk: the first walk of the named reference
 * sample, else the first non-synthetic walk, else the first walk at all. */
function pickReferenceWalk(gfa: Gfa, referenceSample?: string): Walkish | null {
	const walks = gfa.walks as Walkish[];
	if (referenceSample) {
		const r = walks.find((w) => w.sample === referenceSample);
		if (r) return r;
	}
	return walks.find((w) => w.kind !== 'synthetic') ?? walks[0] ?? null;
}

/** Build the ordered backbone (reference walk projected onto displayed nodes,
 * each carrying its running reference coordinate). First occurrence wins if a
 * node recurs, matching the graph view's `refCoords`. */
function buildBackbone(ref: Walkish, gfa: Gfa, o2d: Map<string, string>): {
	nodes: BackboneNode[];
	index: Map<string, number>;
} {
	const nodes: BackboneNode[] = [];
	const index = new Map<string, number>();
	const proj = project(ref.steps, o2d);
	let cursor = (ref.start ?? 0) as number;
	for (const step of proj.steps) {
		const len = gfa.segments.get(step.id)?.length ?? 0;
		if (!index.has(step.id)) {
			index.set(step.id, nodes.length);
			nodes.push({ segId: step.id, refStart: cursor, refEnd: cursor + len, orient: step.orient });
		}
		cursor += len;
	}
	return { nodes, index };
}

export function buildAlignment(gfa: Gfa, opts: BuildOptions): Alignment {
	const {
		referenceSample,
		selectedSegId,
		windowBp,
		maxColumns = 6000,
		maxRows = 300,
		maxAltsPerGap = 24
	} = opts;

	const empty = (note: string): Alignment => ({
		blocks: [], rows: [], nameBySeg: new Map(), totalBp: 0, selectedSegId,
		selectedOnBackbone: false, contig: null, window: null,
		truncatedRows: 0, truncatedWindow: false, hasSequence: false, note
	});

	const o2d = buildOrigToDisplayed(gfa);
	const selected = o2d.get(selectedSegId) ?? selectedSegId;
	if (!gfa.segments.has(selected)) return empty('The selected node is not in this graph.');

	const ref = pickReferenceWalk(gfa, referenceSample);
	if (!ref) return empty('This graph has no reference walk to anchor an alignment on.');
	const { nodes: backbone, index: backboneIdx } = buildBackbone(ref, gfa, o2d);
	if (backbone.length === 0) return empty('The reference walk has no nodes to anchor on.');
	const contig = ref.seqId ?? null;

	// Relevant walks: every non-synthetic walk that passes through the selected
	// node (mapped through origToDisplayed), deduped by name.
	const walks = gfa.walks as Walkish[];
	const throughSelected: Walkish[] = [];
	const seenNames = new Set<string>();
	for (const w of walks) {
		if (w === ref) continue; // the reference is its own row, not a "through" haplotype
		if (w.kind === 'synthetic') continue;
		if (w.steps.length < 1) continue;
		let hits = false;
		for (const s of w.steps) if (o2d.get(s.id) === selected) { hits = true; break; }
		if (!hits) continue;
		const name = `${w.sample}#${w.hapIndex}#${w.seqId}`;
		if (seenNames.has(name)) continue;
		seenNames.add(name);
		throughSelected.push(w);
	}
	// Project once; reused for gap discovery and cell filling.
	const projSelected = throughSelected.map((w) => ({ w, p: project(w.steps, o2d) }));
	const projRef = project(ref.steps, o2d);

	// --- centre the window on the reference axis --------------------------------
	let center: number;
	let selectedOnBackbone = false;
	if (backboneIdx.has(selected)) {
		const b = backbone[backboneIdx.get(selected)!];
		center = (b.refStart + b.refEnd) / 2;
		selectedOnBackbone = true;
	} else {
		// An alt node: centre between the nearest backbone anchors flanking the
		// selected step in some walk that carries it.
		center = NaN;
		for (const { p } of projSelected) {
			const at = p.steps.findIndex((s) => s.id === selected);
			if (at < 0) continue;
			let leftEnd: number | null = null;
			let rightStart: number | null = null;
			for (let i = at - 1; i >= 0; i--) {
				const bi = backboneIdx.get(p.steps[i].id);
				if (bi != null) { leftEnd = backbone[bi].refEnd; break; }
			}
			for (let i = at + 1; i < p.steps.length; i++) {
				const bi = backboneIdx.get(p.steps[i].id);
				if (bi != null) { rightStart = backbone[bi].refStart; break; }
			}
			if (leftEnd != null && rightStart != null) { center = (leftEnd + rightStart) / 2; break; }
			if (leftEnd != null) { center = leftEnd; break; }
			if (rightStart != null) { center = rightStart; break; }
		}
		if (Number.isNaN(center)) {
			// Unanchored: fall back to the middle of the whole backbone.
			center = (backbone[0].refStart + backbone[backbone.length - 1].refEnd) / 2;
		}
	}

	// --- backbone nodes inside the window --------------------------------------
	let lo = center - windowBp;
	let hi = center + windowBp;
	const inWindow = (b: BackboneNode) => b.refEnd > lo && b.refStart < hi;
	let firstIdx = backbone.findIndex(inWindow);
	if (firstIdx < 0) {
		// Window fell between backbone nodes; snap to the nearest one.
		firstIdx = 0;
		let best = Infinity;
		for (let i = 0; i < backbone.length; i++) {
			const d = Math.abs((backbone[i].refStart + backbone[i].refEnd) / 2 - center);
			if (d < best) { best = d; firstIdx = i; }
		}
	}
	let lastIdx = firstIdx;
	for (let i = firstIdx; i < backbone.length; i++) if (inWindow(backbone[i])) lastIdx = i;

	// Clamp the window so the backbone bp alone can't blow past the column cap.
	let truncatedWindow = false;
	const backboneBp = (a: number, b: number) =>
		backbone.slice(a, b + 1).reduce((s, n) => s + (n.refEnd - n.refStart), 0);
	while (lastIdx > firstIdx && backboneBp(firstIdx, lastIdx) > maxColumns) {
		// Trim from whichever end is further from centre.
		const distFirst = center - backbone[firstIdx].refEnd;
		const distLast = backbone[lastIdx].refStart - center;
		if (distFirst > distLast) firstIdx++;
		else lastIdx--;
		truncatedWindow = true;
	}
	lo = backbone[firstIdx].refStart;
	hi = backbone[lastIdx].refEnd;

	const windowBackbone = new Set<string>();
	for (let i = firstIdx; i <= lastIdx; i++) windowBackbone.add(backbone[i].segId);

	// --- every walk that touches the window -------------------------------------
	// Not just the walks through the selected node: we show all haplotypes crossing
	// this window, so the alternative alleles at the locus are visible too. Each is
	// flagged `through` (does it visit the selected node) so the rows can be ordered
	// with the through-selected walks first, right under the reference.
	const windowWalks: { w: Walkish; p: Projected; through: boolean }[] = [];
	const seenWindowNames = new Set<string>();
	for (const w of walks) {
		if (w === ref || w.kind === 'synthetic' || w.steps.length < 1) continue;
		const name = `${w.sample}#${w.hapIndex}#${w.seqId}`;
		if (seenWindowNames.has(name)) continue;
		const p = project(w.steps, o2d);
		let hits = false;
		let through = false;
		for (const s of p.steps) {
			if (s.id === selected) {
				through = true;
				hits = true;
			} else if (windowBackbone.has(s.id)) {
				hits = true;
			}
		}
		if (!hits) continue; // the walk never enters this window
		seenWindowNames.add(name);
		windowWalks.push({ w, p, through });
	}

	// --- discover alt (non-backbone) nodes per inter-anchor gap ----------------
	// Attribute each alt node to the gap after the last backbone-in-window node
	// the walk was at, preserving first-seen order.
	const gapAlts: string[][] = Array.from({ length: lastIdx - firstIdx + 1 }, () => []);
	const altSeen = new Set<string>();
	const recordAlt = (windowPos: number, segId: string) => {
		if (windowPos < 0) return;
		if (backboneIdx.has(segId)) return; // a backbone node is never an alt
		if (altSeen.has(segId)) return;
		if (gapAlts[windowPos].length >= maxAltsPerGap) return;
		if ((gfa.segments.get(segId)?.length ?? 0) <= 0) return;
		altSeen.add(segId);
		gapAlts[windowPos].push(segId);
	};
	for (const { p } of windowWalks) {
		let lastPos = -1;
		let entered = false;
		for (const s of p.steps) {
			const bi = backboneIdx.get(s.id);
			if (bi != null && bi >= firstIdx && bi <= lastIdx) {
				lastPos = bi - firstIdx;
				entered = true;
			} else if (bi != null) {
				// A backbone node outside the window: if we'd already exited past the
				// right edge, stop; otherwise ignore (still in flank).
				if (entered && bi > lastIdx) break;
			} else if (entered) {
				recordAlt(lastPos, s.id);
			}
		}
	}
	// Ensure the selected alt node is always present, even if capped out.
	if (!selectedOnBackbone && !altSeen.has(selected)) {
		// Place it in the gap nearest the window centre.
		const mid = Math.round((lastIdx - firstIdx) / 2);
		gapAlts[mid].unshift(selected);
		altSeen.add(selected);
	}

	// --- assemble blocks in global left-to-right order -------------------------
	const blocks: AlignBlock[] = [];
	const nameBySeg = new Map<string, string>();
	let col = 0;
	let hasSequence = false;
	let refCount = 0;
	let altCount = 0;
	const pushBlock = (segId: string, isBackbone: boolean, bb?: BackboneNode) => {
		const seg = gfa.segments.get(segId);
		const bpLen = seg?.length ?? 0;
		if (bpLen <= 0) return;
		if (seg?.seq && seg.seq.length > 0) hasSequence = true;
		const simpleName = isBackbone ? `R${++refCount}` : `A${++altCount}`;
		nameBySeg.set(segId, simpleName);
		blocks.push({
			segId, simpleName, bpLen, colStart: col,
			isBackbone, isSelected: segId === selected,
			refStart: bb?.refStart, contig: isBackbone ? contig ?? undefined : undefined
		});
		col += bpLen;
	};
	for (let i = firstIdx; i <= lastIdx; i++) {
		const pos = i - firstIdx;
		pushBlock(backbone[i].segId, true, backbone[i]);
		for (const alt of gapAlts[pos]) pushBlock(alt, false);
	}
	const totalBp = col;
	if (blocks.length === 0) return empty('Nothing to align in this window.');

	// --- fill rows -------------------------------------------------------------
	const blockIndex = new Map<string, number>();
	blocks.forEach((b, i) => blockIndex.set(b.segId, i));

	const cellsFor = (proj: Projected): { cells: (string | null)[]; inversion: boolean } => {
		const cells: (string | null)[] = new Array(blocks.length).fill(null);
		let inversion = false;
		for (const s of proj.steps) {
			const bi = blockIndex.get(s.id);
			if (bi == null || cells[bi] != null) continue; // first visit wins
			const b = blocks[bi];
			const seg = gfa.segments.get(s.id);
			const raw = seg?.seq ?? '';
			cells[bi] = raw.length > 0 ? orientedSeq(raw, s.orient) : '';
			if (b.isBackbone) {
				const bb = backbone[backboneIdx.get(s.id)!];
				if (bb.orient !== s.orient) inversion = true;
			}
		}
		return { cells, inversion };
	};

	const rows: AlignRow[] = [];
	const refRes = cellsFor(projRef);
	rows.push({
		key: '#ref',
		label: referenceLabel(ref),
		sample: ref.sample,
		isReference: true,
		multiplicity: 1,
		throughSelected: false,
		hasInversion: refRes.inversion,
		cells: refRes.cells
	});

	// Dedup non-reference rows by their exact cell signature; collapse into one
	// row carrying a multiplicity, so a 400-haplotype locus stays legible. The
	// walks through the selected node come first (right under the reference), then
	// the rest of the window's walks — preserving first-seen order within each group.
	const bySig = new Map<string, AlignRow>();
	const orderThrough: string[] = [];
	const orderOther: string[] = [];
	let truncatedRows = 0;
	for (const { w, p, through } of windowWalks) {
		const { cells, inversion } = cellsFor(p);
		const sig = cells.map((c) => (c === null ? '.' : c === '' ? '?' : c)).join('|');
		const existing = bySig.get(sig);
		if (existing) {
			existing.multiplicity++;
			existing.throughSelected ||= through;
			continue;
		}
		if (bySig.size >= maxRows - 1) { truncatedRows++; continue; }
		const row: AlignRow = {
			key: `${w.sample}#${w.hapIndex}#${w.seqId}`,
			label: walkLabel(w),
			sample: w.sample,
			isReference: false,
			multiplicity: 1,
			throughSelected: through,
			hasInversion: inversion,
			cells
		};
		bySig.set(sig, row);
		(through ? orderThrough : orderOther).push(sig);
	}
	for (const sig of orderThrough) rows.push(bySig.get(sig)!);
	for (const sig of orderOther) rows.push(bySig.get(sig)!);

	return {
		blocks, rows, nameBySeg, totalBp, selectedSegId: selected, selectedOnBackbone,
		contig, window: { start: lo, end: hi },
		truncatedRows, truncatedWindow, hasSequence
	};
}

function referenceLabel(w: Walkish): string {
	if (w.kind === 'synthetic') return 'reference (computed backbone)';
	return w.sample === 'unknown' ? 'reference' : w.sample;
}

function walkLabel(w: Walkish): string {
	// Anonymised walks (a gbz-base subgraph extract labels every haplotype
	// 'unknown', so only the contig — e.g. "chr5" — distinguishes them, which says
	// nothing useful): call them what they are rather than repeating the contig.
	if (w.sample === 'unknown') return 'non-reference walk';
	const hap = w.hapIndex != null ? ` (hap ${w.hapIndex})` : '';
	return `${w.sample}${hap}`;
}
