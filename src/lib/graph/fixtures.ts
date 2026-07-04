// Shared example graphs used by BOTH the simplification tests (simplify.test.ts)
// and the /playground page, so what you eyeball and what the tests assert are the
// exact same inputs.
//
// Synthetic fixtures are small but realistic: a reference backbone with flanks, a
// single variant site in the middle, and several haplotypes (so nodes carry real
// coverage and branch like a real subgraph). Each carries an `expect` block
// describing what the pop pass should do. Real fixtures are actual gbz-base
// `query` output (W-line GFA) for HPRC/MHC loci.
import mhc2kb from './fixtures/mhc_2kb.gfa?raw';
import mhc8kb from './fixtures/mhc_8kb.gfa?raw';
import mhc84kb from './fixtures/mhc_84kb.gfa?raw';

export interface FixtureExpect {
	/** Collapsed sites the pop pass should produce. */
	sites: number;
	/** Total alt alleles removed across all sites. */
	allelesRemoved: number;
	/** Alleles that were single-base substitutions (SNPs). */
	snpCount: number;
	/** Total ALT sequence bases condensed. */
	basesRemoved: number;
	/** Segment ids that must be gone after the pop pass. */
	removedNodes?: string[];
	/** Segment ids that must survive the pop pass. */
	keptNodes?: string[];
	/** Segment count after the full simplify (pop + unchop), if pinned. */
	segmentsAfterSimplify?: number;
}

export interface Fixture {
	id: string;
	label: string;
	description: string;
	kind: 'synthetic' | 'real';
	referenceSample: string;
	gfaText: string;
	expect?: FixtureExpect;
}

// --- tiny GFA builder ---------------------------------------------------------

const BASES = 'ACGTACGTAC';
function seq(n: number): string {
	if (n <= 0) return '*';
	return BASES.repeat(Math.ceil(n / BASES.length)).slice(0, n);
}

type Step = string | [string, '+' | '-'];
interface SynthWalk {
	sample: string;
	hap?: number;
	contig?: string;
	start?: number;
	steps: Step[];
}
interface SynthSpec {
	refSample: string;
	/** segment id -> sequence length in bp */
	segs: Record<string, number>;
	/** [from, to] (both '+') or [from, fromOrient, to, toOrient] */
	links: Array<[string, string] | [string, '+' | '-', string, '+' | '-']>;
	walks: SynthWalk[];
}

function buildGfa(spec: SynthSpec): string {
	const lines: string[] = [`H\tVN:Z:1.1\tRS:Z:${spec.refSample}`];
	for (const [id, len] of Object.entries(spec.segs)) lines.push(`S\t${id}\t${seq(len)}`);
	for (const l of spec.links) {
		const [from, fo, to, to_o] = l.length === 2 ? [l[0], '+', l[1], '+'] : l;
		lines.push(`L\t${from}\t${fo}\t${to}\t${to_o}\t0M`);
	}
	for (const w of spec.walks) {
		const steps = w.steps.map<[string, '+' | '-']>((s) => (typeof s === 'string' ? [s, '+'] : s));
		const len = steps.reduce((n, [id]) => n + (spec.segs[id] ?? 0), 0);
		const start = w.start ?? 0;
		const walkStr = steps.map(([id, o]) => (o === '+' ? '>' : '<') + id).join('');
		lines.push(
			`W\t${w.sample}\t${w.hap ?? 0}\t${w.contig ?? 'chr1'}\t${start}\t${start + len}\t${walkStr}`
		);
	}
	return lines.join('\n') + '\n';
}

const REF = 'ref';

/** Convenience: N haplotypes each following the given step list. */
function haps(prefix: string, count: number, steps: Step[]): SynthWalk[] {
	return Array.from({ length: count }, (_, i) => ({ sample: `${prefix}${i + 1}`, steps }));
}

// --- synthetic fixtures -------------------------------------------------------
// Skeleton: reference nodes 1..5 form the backbone (with 50 bp flanks 1 and 5,
// 20 bp anchors 2 and 4, and the variable middle 3); alt alleles use ids 20+.

const snp: Fixture = {
	id: 'snp',
	label: 'Single SNP',
	description: 'One 1 bp substitution carried by 3 of 5 haplotypes — collapses to reference.',
	kind: 'synthetic',
	referenceSample: REF,
	gfaText: buildGfa({
		refSample: REF,
		segs: { '1': 50, '2': 20, '3': 1, '4': 20, '5': 50, '20': 1 },
		links: [['1', '2'], ['2', '3'], ['3', '4'], ['4', '5'], ['2', '20'], ['20', '4']],
		walks: [
			{ sample: REF, steps: ['1', '2', '3', '4', '5'] },
			...haps('alt', 3, ['1', '2', '20', '4', '5']),
			...haps('r', 2, ['1', '2', '3', '4', '5'])
		]
	}),
	expect: {
		sites: 1,
		allelesRemoved: 1,
		snpCount: 1,
		basesRemoved: 1,
		removedNodes: ['20'],
		keptNodes: ['1', '2', '3', '4', '5'],
		segmentsAfterSimplify: 1
	}
};

const smallIns: Fixture = {
	id: 'small_ins',
	label: 'Small insertion',
	description: '4 bp insertion (no reference skipped) carried by 2 of 4 haplotypes — collapses.',
	kind: 'synthetic',
	referenceSample: REF,
	gfaText: buildGfa({
		refSample: REF,
		segs: { '1': 50, '2': 20, '3': 20, '4': 50, '20': 4 },
		links: [['1', '2'], ['2', '3'], ['3', '4'], ['2', '20'], ['20', '3']],
		walks: [
			{ sample: REF, steps: ['1', '2', '3', '4'] },
			...haps('alt', 2, ['1', '2', '20', '3', '4']),
			...haps('r', 2, ['1', '2', '3', '4'])
		]
	}),
	expect: {
		sites: 1,
		allelesRemoved: 1,
		snpCount: 0,
		basesRemoved: 4,
		removedNodes: ['20'],
		keptNodes: ['1', '2', '3', '4'],
		segmentsAfterSimplify: 1
	}
};

const largeIns: Fixture = {
	id: 'large_ins',
	label: 'Large insertion (kept)',
	description: '60 bp insertion — exceeds threshold, preserved as a visible alt allele.',
	kind: 'synthetic',
	referenceSample: REF,
	gfaText: buildGfa({
		refSample: REF,
		segs: { '1': 50, '2': 20, '3': 20, '4': 50, '30': 60 },
		links: [['1', '2'], ['2', '3'], ['3', '4'], ['2', '30'], ['30', '3']],
		walks: [
			{ sample: REF, steps: ['1', '2', '3', '4'] },
			...haps('alt', 2, ['1', '2', '30', '3', '4']),
			...haps('r', 2, ['1', '2', '3', '4'])
		]
	}),
	expect: {
		sites: 0,
		allelesRemoved: 0,
		snpCount: 0,
		basesRemoved: 0,
		keptNodes: ['1', '2', '3', '4', '30']
	}
};

const largeDel: Fixture = {
	id: 'large_del',
	label: 'Large deletion (kept)',
	description:
		'Edge skipping a 60 bp reference node — the flagged case: tiny alt allele, big event, must be preserved.',
	kind: 'synthetic',
	referenceSample: REF,
	gfaText: buildGfa({
		refSample: REF,
		segs: { '1': 50, '2': 20, '3': 60, '4': 20, '5': 50 },
		links: [['1', '2'], ['2', '3'], ['3', '4'], ['4', '5'], ['2', '4']],
		walks: [
			{ sample: REF, steps: ['1', '2', '3', '4', '5'] },
			...haps('del', 2, ['1', '2', '4', '5']),
			...haps('r', 2, ['1', '2', '3', '4', '5'])
		]
	}),
	expect: {
		sites: 0,
		allelesRemoved: 0,
		snpCount: 0,
		basesRemoved: 0,
		keptNodes: ['1', '2', '3', '4', '5']
	}
};

const smallDel: Fixture = {
	id: 'small_del',
	label: 'Small deletion',
	description: 'Edge skipping a 3 bp reference node — collapses (haplotypes rerouted onto reference).',
	kind: 'synthetic',
	referenceSample: REF,
	gfaText: buildGfa({
		refSample: REF,
		segs: { '1': 50, '2': 20, '3': 3, '4': 20, '5': 50 },
		links: [['1', '2'], ['2', '3'], ['3', '4'], ['4', '5'], ['2', '4']],
		walks: [
			{ sample: REF, steps: ['1', '2', '3', '4', '5'] },
			...haps('del', 2, ['1', '2', '4', '5']),
			...haps('r', 2, ['1', '2', '3', '4', '5'])
		]
	}),
	expect: {
		sites: 1,
		allelesRemoved: 1,
		snpCount: 0,
		basesRemoved: 0,
		keptNodes: ['1', '2', '3', '4', '5'],
		segmentsAfterSimplify: 1
	}
};

const multiallelic: Fixture = {
	id: 'multiallelic',
	label: 'Multiallelic SNPs',
	description: 'Two parallel 1 bp alt alleles at one site — both collapse.',
	kind: 'synthetic',
	referenceSample: REF,
	gfaText: buildGfa({
		refSample: REF,
		segs: { '1': 50, '2': 20, '3': 1, '4': 20, '5': 50, '20': 1, '21': 1 },
		links: [
			['1', '2'], ['2', '3'], ['3', '4'], ['4', '5'],
			['2', '20'], ['20', '4'], ['2', '21'], ['21', '4']
		],
		walks: [
			{ sample: REF, steps: ['1', '2', '3', '4', '5'] },
			...haps('a', 2, ['1', '2', '20', '4', '5']),
			...haps('b', 2, ['1', '2', '21', '4', '5']),
			...haps('r', 1, ['1', '2', '3', '4', '5'])
		]
	}),
	expect: {
		sites: 1,
		allelesRemoved: 2,
		snpCount: 2,
		basesRemoved: 2,
		removedNodes: ['20', '21'],
		keptNodes: ['1', '2', '3', '4', '5'],
		segmentsAfterSimplify: 1
	}
};

const mixed: Fixture = {
	id: 'mixed',
	label: 'Mixed small + large allele',
	description:
		'A 1 bp SNP and a 60 bp insertion share the same anchors — surgical: drop the SNP, keep the big allele.',
	kind: 'synthetic',
	referenceSample: REF,
	gfaText: buildGfa({
		refSample: REF,
		segs: { '1': 50, '2': 20, '3': 1, '4': 20, '5': 50, '20': 1, '30': 60 },
		links: [
			['1', '2'], ['2', '3'], ['3', '4'], ['4', '5'],
			['2', '20'], ['20', '4'], ['2', '30'], ['30', '4']
		],
		walks: [
			{ sample: REF, steps: ['1', '2', '3', '4', '5'] },
			...haps('snp', 2, ['1', '2', '20', '4', '5']),
			...haps('sv', 2, ['1', '2', '30', '4', '5']),
			...haps('r', 1, ['1', '2', '3', '4', '5'])
		]
	}),
	expect: {
		sites: 1,
		allelesRemoved: 1,
		snpCount: 1,
		basesRemoved: 1,
		removedNodes: ['20'],
		keptNodes: ['1', '2', '3', '4', '5', '30']
	}
};

const nested: Fixture = {
	id: 'nested',
	label: 'Nested bubble (kept)',
	description:
		'An alt region that itself branches (a bubble within the bubble) — not a simple chain, so the whole site is left intact.',
	kind: 'synthetic',
	referenceSample: REF,
	gfaText: buildGfa({
		refSample: REF,
		segs: { '1': 50, '2': 20, '3': 20, '4': 50, '20': 2, '21': 2, '22': 2 },
		links: [
			['1', '2'], ['2', '3'], ['3', '4'],
			['2', '20'], ['20', '21'], ['20', '22'], ['21', '3'], ['22', '3']
		],
		walks: [
			{ sample: REF, steps: ['1', '2', '3', '4'] },
			...haps('a', 2, ['1', '2', '20', '21', '3', '4']),
			...haps('b', 2, ['1', '2', '20', '22', '3', '4']),
			...haps('r', 1, ['1', '2', '3', '4'])
		]
	}),
	expect: {
		sites: 0,
		allelesRemoved: 0,
		snpCount: 0,
		basesRemoved: 0,
		keptNodes: ['1', '2', '3', '4', '20', '21', '22']
	}
};

const cyclic: Fixture = {
	id: 'cyclic',
	label: 'Cyclic alt (kept)',
	description: 'An alt node with a self-loop (a tandem-repeat-like cycle) — never collapsed.',
	kind: 'synthetic',
	referenceSample: REF,
	gfaText: buildGfa({
		refSample: REF,
		segs: { '1': 50, '2': 20, '3': 20, '4': 50, '20': 2 },
		links: [['1', '2'], ['2', '3'], ['3', '4'], ['2', '20'], ['20', '20'], ['20', '3']],
		walks: [
			{ sample: REF, steps: ['1', '2', '3', '4'] },
			...haps('a', 2, ['1', '2', '20', '20', '3', '4']),
			...haps('r', 1, ['1', '2', '3', '4'])
		]
	}),
	expect: {
		sites: 0,
		allelesRemoved: 0,
		snpCount: 0,
		basesRemoved: 0,
		keptNodes: ['1', '2', '3', '4', '20']
	}
};

const longRun: Fixture = {
	id: 'long_run',
	label: 'Long linear run (unchop)',
	description: 'Six reference nodes in a row with no variation — unchop merges them into one.',
	kind: 'synthetic',
	referenceSample: REF,
	gfaText: buildGfa({
		refSample: REF,
		segs: { '1': 100, '2': 100, '3': 100, '4': 100, '5': 100, '6': 100 },
		links: [['1', '2'], ['2', '3'], ['3', '4'], ['4', '5'], ['5', '6']],
		walks: [{ sample: REF, steps: ['1', '2', '3', '4', '5', '6'] }]
	}),
	expect: {
		sites: 0,
		allelesRemoved: 0,
		snpCount: 0,
		basesRemoved: 0,
		segmentsAfterSimplify: 1
	}
};

export const SYNTHETIC_FIXTURES: Fixture[] = [
	snp,
	smallIns,
	largeIns,
	largeDel,
	smallDel,
	multiallelic,
	mixed,
	nested,
	cyclic,
	longRun
];

// --- real fixtures ------------------------------------------------------------

export const REAL_FIXTURES: Fixture[] = [
	{
		id: 'mhc_2kb',
		label: 'MHC ~2 kb (real)',
		description: 'chr6:31,499,826–31,502,155 from HPRC GRCh38 — 98 nodes, 91 haplotype walks.',
		kind: 'real',
		referenceSample: 'GRCh38',
		gfaText: mhc2kb
	},
	{
		id: 'mhc_8kb',
		label: 'MHC ~8 kb (real)',
		description: 'chr6:31,999,817–32,008,111 from HPRC GRCh38 — 361 nodes, 76 haplotype walks.',
		kind: 'real',
		referenceSample: 'GRCh38',
		gfaText: mhc8kb
	},
	{
		id: 'mhc_84kb',
		label: 'MHC core ~84 kb (real)',
		description:
			"chr6:31,972,046–32,055,647 from HPRC GRCh38 — the app's default locus: 2,207 nodes, 98 haplotype walks.",
		kind: 'real',
		referenceSample: 'GRCh38',
		gfaText: mhc84kb
	}
];

export const ALL_FIXTURES: Fixture[] = [...SYNTHETIC_FIXTURES, ...REAL_FIXTURES];
