import { describe, expect, it } from 'vitest';
import { parseGfa, type Gfa } from '../gfa';
import { foldGfa, homePositions } from './fold';
import smn1 from './fixtures/smn1.gfa?raw';
import c4a from './fixtures/c4a.gfa?raw';

const A = (n: number) => 'A'.repeat(n);

// Reference 1→2→3 (100 bp each). One haplotype carries a 3 kb insertion after
// node 1, cut into three segments (10, 11, 13) by a nested SNP: 12 is a 1 bp
// alternative to 11 carried by a second haplotype. The SNP arm (12) is a small
// stub on a large bubble — exactly what per-node folding used to leave behind.
const INSERTION = [
	'H\tVN:Z:1.1',
	`S\t1\t${A(100)}`,
	`S\t2\t${A(100)}`,
	`S\t3\t${A(100)}`,
	`S\t10\t${A(1500)}`,
	`S\t11\t${A(1)}`,
	`S\t12\t${A(1)}`,
	`S\t13\t${A(1499)}`,
	'L\t1\t+\t2\t+\t0M',
	'L\t2\t+\t3\t+\t0M',
	'L\t1\t+\t10\t+\t0M',
	'L\t10\t+\t11\t+\t0M',
	'L\t10\t+\t12\t+\t0M',
	'L\t11\t+\t13\t+\t0M',
	'L\t12\t+\t13\t+\t0M',
	'L\t13\t+\t2\t+\t0M',
	'W\tREF\t0\tchr1\t0\t300\t>1>2>3',
	'W\thapA\t1\tchr1\t0\t3200\t>1>10>11>13>2>3',
	'W\thapB\t1\tchr1\t0\t3200\t>1>10>12>13>2>3'
].join('\n');

// A 93 bp alt segment that bypasses 7 kb of reference (2 is 7000 bp).
const REPLACEMENT = [
	'H\tVN:Z:1.1',
	`S\t1\t${A(100)}`,
	`S\t2\t${A(7000)}`,
	`S\t3\t${A(100)}`,
	`S\t9\t${A(93)}`,
	'L\t1\t+\t2\t+\t0M',
	'L\t2\t+\t3\t+\t0M',
	'L\t1\t+\t9\t+\t0M',
	'L\t9\t+\t3\t+\t0M',
	'W\tREF\t0\tchr1\t0\t7200\t>1>2>3',
	'W\thapA\t1\tchr1\t0\t293\t>1>9>3'
].join('\n');

// Reference 1..5 (20 bp each) with a 20 bp deletion (1→3) and a 60 bp one (1→5).
const DELETIONS = [
	'H\tVN:Z:1.1',
	...[1, 2, 3, 4, 5].map((i) => `S\t${i}\t${A(20)}`),
	'L\t1\t+\t2\t+\t0M',
	'L\t2\t+\t3\t+\t0M',
	'L\t3\t+\t4\t+\t0M',
	'L\t4\t+\t5\t+\t0M',
	'L\t1\t+\t3\t+\t0M',
	'L\t1\t+\t5\t+\t0M',
	'W\tREF\t0\tchr1\t0\t100\t>1>2>3>4>5'
].join('\n');

function components(g: Gfa): number {
	const parent = new Map<string, string>();
	const find = (x: string): string => {
		const p = parent.get(x) ?? x;
		if (p === x) return x;
		const r = find(p);
		parent.set(x, r);
		return r;
	};
	for (const id of g.segments.keys()) parent.set(id, id);
	for (const l of g.links) parent.set(find(l.from), find(l.to));
	return new Set([...g.segments.keys()].map(find)).size;
}

function refBp(g: Gfa, sample: string): number {
	const w = g.walks.find((w) => w.sample === sample)!;
	return w.steps.reduce((s, st) => s + g.segments.get(st.id)!.length, 0);
}

describe('homePositions', () => {
	it('places reference segments by walk coordinate and others on their first walk', () => {
		const h = homePositions(parseGfa(INSERTION), 'REF');
		expect(h.get('2')).toMatchObject({ seq: 'chr1', start: 100, rank: 0 });
		expect(h.get('11')).toMatchObject({ start: 1600, rank: 1 });
		expect(h.get('12')!.rank).toBe(2); // only hapB visits it
	});
});

describe('foldGfa', () => {
	it('keeps a big insertion as one allele and drops its nested SNP stub', () => {
		const r = foldGfa(parseGfa(INSERTION), 50, { referenceSample: 'REF' });
		const ids = [...r.gfa.segments.keys()];
		expect(ids).not.toContain('12');
		// 10, 11, 13 are one allele, merged into a single 3000 bp segment.
		expect(r.repOf.get('11')).toBe('10');
		expect(r.repOf.get('13')).toBe('10');
		expect(r.gfa.segments.get('10')!.length).toBe(3000);
		expect(r.gfa.segments.get('10')!.members).toEqual(['10', '11', '13']);
		expect(components(r.gfa)).toBe(1);
	});

	it('sizes an allele by the reference it replaces', () => {
		const g = parseGfa(REPLACEMENT);
		expect(foldGfa(g, 5000, { referenceSample: 'REF' }).gfa.segments.has('9')).toBe(true);
		expect(foldGfa(g, 8000, { referenceSample: 'REF' }).gfa.segments.has('9')).toBe(false);
	});

	it('drops deletion links under the threshold and keeps larger ones', () => {
		const r = foldGfa(parseGfa(DELETIONS), 40, { referenceSample: 'REF' });
		// Ref is one unbranched-at-junctions run except where the 60 bp deletion
		// attaches (end of 1, start of 5), so 2..4 merge into one segment.
		const links = r.gfa.links.map((l) => `${l.from}>${l.to}`);
		expect(links).toContain('1>5');
		expect(links).not.toContain('1>3');
		expect(r.stats.droppedSkips).toBe(1);
		expect(refBp(r.gfa, 'REF')).toBe(100);
	});

	it('leaves the backbone untouched on real loci', () => {
		for (const [text, sample] of [
			[smn1, 'GRCh38'],
			[c4a, 'GRCh38']
		] as const) {
			const g = parseGfa(text);
			const before = refBp(g, sample);
			for (const t of [10, 100, 1000, 10000]) {
				const r = foldGfa(g, t, { referenceSample: sample });
				expect(r.applied).toBe(true);
				expect(refBp(r.gfa, sample)).toBe(before);
				expect(components(r.gfa)).toBe(components(g) === 1 ? 1 : components(r.gfa));
				// Every original reference segment still has a representative.
				for (const st of g.walks.find((w) => w.sample === sample)!.steps)
					expect(r.repOf.has(st.id)).toBe(true);
			}
		}
	});

	it('connects every kept segment to the backbone', () => {
		const g = parseGfa(smn1);
		const r = foldGfa(g, 200, { referenceSample: 'GRCh38' });
		expect(components(r.gfa)).toBe(1);
		expect(r.gfa.segments.size).toBeLessThan(g.segments.size / 3);
	});

	it('keeps every off-locus exit and never invents one', () => {
		// A side with no link is drawn as a haplotype leaving the locus.
		const linkedSides = (g: Gfa) => {
			const s = new Set<string>();
			for (const l of g.links) {
				s.add(`${l.from}:${l.fromOrient === '+' ? 'end' : 'start'}`);
				s.add(`${l.to}:${l.toOrient === '+' ? 'start' : 'end'}`);
			}
			return s;
		};
		const looseSides = (g: Gfa, skip: (id: string) => boolean) => {
			const linked = linkedSides(g);
			const out: string[] = [];
			for (const id of g.segments.keys()) {
				if (skip(id)) continue;
				for (const side of ['start', 'end']) if (!linked.has(`${id}:${side}`)) out.push(`${id}:${side}`);
			}
			return out;
		};
		for (const text of [smn1, c4a]) {
			const g = parseGfa(text);
			const homes = homePositions(g, 'GRCh38');
			const exits = looseSides(g, (id) => homes.get(id)?.rank === 0);
			expect(exits.length).toBeGreaterThan(0);
			for (const t of [10, 50, 200, 1000, 10000]) {
				const r = foldGfa(g, t, { referenceSample: 'GRCh38' });
				// Every original exit survives on its segment's representative...
				for (const e of exits) expect(r.repOf.has(e.split(':')[0])).toBe(true);
				// ...and every hanging side in the fold is one of those exits.
				const inputLoose = new Set(exits.map((e) => e.split(':')[0]));
				for (const e of looseSides(r.gfa, (id) => r.homes.get(id)?.rank === 0)) {
					const members = r.gfa.segments.get(e.split(':')[0])!.members ?? [e.split(':')[0]];
					expect(members.some((m) => inputLoose.has(m)), `${e} at ${t} bp`).toBe(true);
				}
			}
		}
	});

	it('chains: folding at t1 then t2 is close to folding once at t2', () => {
		for (const text of [smn1, c4a]) {
			const g = parseGfa(text);
			const once = foldGfa(g, 1000, { referenceSample: 'GRCh38' });
			const first = foldGfa(g, 50, { referenceSample: 'GRCh38' });
			const twice = foldGfa(first.gfa, 1000, { referenceSample: 'GRCh38', homes: first.homes });
			const a = once.gfa.segments.size;
			const b = twice.gfa.segments.size;
			expect(Math.abs(a - b)).toBeLessThanOrEqual(Math.max(3, a * 0.15));
			const bpA = [...once.gfa.segments.values()].reduce((s, x) => s + x.length, 0);
			const bpB = [...twice.gfa.segments.values()].reduce((s, x) => s + x.length, 0);
			expect(Math.abs(bpA - bpB)).toBeLessThanOrEqual(bpA * 0.1);
		}
	});

	it('is deterministic', () => {
		const g = parseGfa(c4a);
		const a = foldGfa(g, 300, { referenceSample: 'GRCh38' });
		const b = foldGfa(g, 300, { referenceSample: 'GRCh38' });
		expect([...a.gfa.segments.keys()]).toEqual([...b.gfa.segments.keys()]);
		expect(a.gfa.links).toEqual(b.gfa.links);
	});
});
