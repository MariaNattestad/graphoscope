import { describe, it, expect } from 'vitest';
import { parseGfa } from '../gfa';
import { buildAlignment, revcomp, type Alignment } from './msa';

// Small hand-built graphs. Backbone is ref >1>2>3>4>5 (anchors 1..5); alt alleles
// use ids 20+. Sequences are chosen so a substitution/insertion/inversion is
// visible in the aligned cells, not just in the structure.

function blockIds(a: Alignment): string[] {
	return a.blocks.map((b) => b.segId);
}
function row(a: Alignment, key: string) {
	return a.rows.find((r) => r.key === key)!;
}
/** The cell string for a given row at a given block segId (null = gap). */
function cellAt(a: Alignment, rowKey: string, segId: string): string | null {
	const bi = a.blocks.findIndex((b) => b.segId === segId);
	return row(a, rowKey).cells[bi];
}

describe('revcomp', () => {
	it('reverse-complements DNA', () => {
		expect(revcomp('AAAC')).toBe('GTTT');
		expect(revcomp('ACGT')).toBe('ACGT'); // palindrome
		expect(revcomp('acgt')).toBe('acgt');
		expect(revcomp('N')).toBe('N');
	});
});

describe('buildAlignment — SNP substitution', () => {
	const gfa = parseGfa(
		[
			'H\tVN:Z:1.1\tRS:Z:ref',
			'S\t1\tACGTACGT',
			'S\t2\tAAAACCCC',
			'S\t3\tG', // reference allele
			'S\t4\tGGGGTTTT',
			'S\t5\tACGTACGT',
			'S\t20\tC', // alt allele (substitution)
			'W\tref\t0\tchr1\t0\t34\t>1>2>3>4>5',
			'W\talt1\t0\tchr1\t0\t34\t>1>2>20>4>5',
			'W\talt2\t0\tchr1\t0\t34\t>1>2>20>4>5'
		].join('\n')
	);

	it('places the alt node as its own block next to the ref allele', () => {
		const a = buildAlignment(gfa, { referenceSample: 'ref', selectedSegId: '2', windowBp: 10000 });
		// Alt block 20 sits adjacent to ref block 3 (both between anchors 2 and 4).
		const ids = blockIds(a);
		expect(ids).toContain('3');
		expect(ids).toContain('20');
		const i3 = ids.indexOf('3');
		const i20 = ids.indexOf('20');
		expect(Math.abs(i3 - i20)).toBe(1); // adjacent
		expect(a.selectedOnBackbone).toBe(true);
	});

	it('reference fills node 3 and gaps node 20; alt does the opposite', () => {
		const a = buildAlignment(gfa, { referenceSample: 'ref', selectedSegId: '2', windowBp: 10000 });
		expect(cellAt(a, '#ref', '3')).toBe('G');
		expect(cellAt(a, '#ref', '20')).toBe(null);
		const alt = a.rows.find((r) => !r.isReference)!;
		expect(alt.cells[blockIds(a).indexOf('3')]).toBe(null);
		expect(alt.cells[blockIds(a).indexOf('20')]).toBe('C');
	});

	it('collapses the two identical alt haplotypes into one row with multiplicity 2', () => {
		const a = buildAlignment(gfa, { referenceSample: 'ref', selectedSegId: '2', windowBp: 10000 });
		const alts = a.rows.filter((r) => !r.isReference);
		expect(alts.length).toBe(1);
		expect(alts[0].multiplicity).toBe(2);
	});

	it('backbone blocks carry monotone reference coordinates', () => {
		const a = buildAlignment(gfa, { referenceSample: 'ref', selectedSegId: '2', windowBp: 10000 });
		const bb = a.blocks.filter((b) => b.isBackbone);
		for (let i = 1; i < bb.length; i++) expect(bb[i].refStart!).toBeGreaterThan(bb[i - 1].refStart!);
		expect(a.contig).toBe('chr1');
	});

	it('assigns simplified R/A names (ref left-to-right, alts as A1…)', () => {
		const a = buildAlignment(gfa, { referenceSample: 'ref', selectedSegId: '2', windowBp: 10000 });
		// Backbone 1,2,3,4,5 → R1..R5 in order; alt 20 → A1.
		expect(a.nameBySeg.get('1')).toBe('R1');
		expect(a.nameBySeg.get('2')).toBe('R2');
		expect(a.nameBySeg.get('3')).toBe('R3');
		expect(a.nameBySeg.get('20')).toBe('A1');
		const b20 = a.blocks.find((b) => b.segId === '20')!;
		expect(b20.simpleName).toBe('A1');
		expect(b20.isBackbone).toBe(false);
	});

	it('assigns cumulative colStart matching bp lengths', () => {
		const a = buildAlignment(gfa, { referenceSample: 'ref', selectedSegId: '2', windowBp: 10000 });
		let col = 0;
		for (const b of a.blocks) {
			expect(b.colStart).toBe(col);
			col += b.bpLen;
		}
		expect(a.totalBp).toBe(col);
	});
});

describe('buildAlignment — insertion', () => {
	const gfa = parseGfa(
		[
			'H\tVN:Z:1.1\tRS:Z:ref',
			'S\t1\tACGTACGT',
			'S\t2\tAAAACCCC',
			'S\t3\tGGGGTTTT',
			'S\t20\tTTTT', // 4 bp insertion between 2 and 3
			'W\tref\t0\tchr1\t0\t20\t>1>2>3',
			'W\talt1\t0\tchr1\t0\t24\t>1>2>20>3'
		].join('\n')
	);

	it('inserts the alt block between its anchors, ref shows a gap there', () => {
		const a = buildAlignment(gfa, { referenceSample: 'ref', selectedSegId: '2', windowBp: 10000 });
		const ids = blockIds(a);
		expect(ids.indexOf('20')).toBeGreaterThan(ids.indexOf('2'));
		expect(ids.indexOf('20')).toBeLessThan(ids.indexOf('3'));
		expect(cellAt(a, '#ref', '20')).toBe(null);
		const alt = a.rows.find((r) => !r.isReference)!;
		expect(alt.cells[ids.indexOf('20')]).toBe('TTTT');
	});
});

describe('buildAlignment — deletion (skipped reference node)', () => {
	const gfa = parseGfa(
		[
			'H\tVN:Z:1.1\tRS:Z:ref',
			'S\t1\tACGTACGT',
			'S\t2\tAAAACCCC',
			'S\t3\tGGGGTTTT',
			'S\t4\tACGTACGT',
			'W\tref\t0\tchr1\t0\t32\t>1>2>3>4',
			'W\tdel1\t0\tchr1\t0\t24\t>1>2>4' // skips node 3
		].join('\n')
	);

	it('the deletion row gaps the skipped backbone node', () => {
		const a = buildAlignment(gfa, { referenceSample: 'ref', selectedSegId: '2', windowBp: 10000 });
		expect(cellAt(a, '#ref', '3')).toBe('GGGGTTTT');
		const del = a.rows.find((r) => !r.isReference)!;
		expect(del.cells[blockIds(a).indexOf('3')]).toBe(null);
		expect(del.cells[blockIds(a).indexOf('4')]).toBe('ACGTACGT');
	});
});

describe('buildAlignment — inversion / reverse-complement', () => {
	const gfa = parseGfa(
		[
			'H\tVN:Z:1.1\tRS:Z:ref',
			'S\t1\tACGTACGT',
			'S\t2\tAAACCCGG', // revcomp = CCGGGTTT
			'S\t3\tACGTACGT',
			'W\tref\t0\tchr1\t0\t24\t>1>2>3',
			'W\tinv1\t0\tchr1\t0\t24\t>1<2>3' // visits node 2 in reverse
		].join('\n')
	);

	it('shows the reverse-complemented bases and flags the inversion', () => {
		const a = buildAlignment(gfa, { referenceSample: 'ref', selectedSegId: '2', windowBp: 10000 });
		expect(cellAt(a, '#ref', '2')).toBe('AAACCCGG');
		const inv = a.rows.find((r) => !r.isReference)!;
		expect(inv.cells[blockIds(a).indexOf('2')]).toBe('CCGGGTTT');
		expect(inv.hasInversion).toBe(true);
	});
});

describe('buildAlignment — length-only (rGFA-style, no sequence)', () => {
	const gfa = parseGfa(
		[
			'H\tVN:Z:1.1\tRS:Z:ref',
			'S\t1\t*\tLN:i:8',
			'S\t2\t*\tLN:i:8',
			'S\t3\t*\tLN:i:8',
			'W\tref\t0\tchr1\t0\t24\t>1>2>3'
		].join('\n')
	);

	it('reports no sequence and marks visited cells as present-without-bases', () => {
		const a = buildAlignment(gfa, { referenceSample: 'ref', selectedSegId: '2', windowBp: 10000 });
		expect(a.hasSequence).toBe(false);
		expect(cellAt(a, '#ref', '2')).toBe(''); // visited, but no bases
		expect(a.blocks.find((b) => b.segId === '2')!.bpLen).toBe(8);
	});
});

describe('buildAlignment — includes all walks in the window', () => {
	// Backbone 1>2>3>4>5 (ref allele at node 3); alt allele node 20 between 2 and 4.
	// Two haplotypes take the alt (node 20); one takes the reference allele (node 3).
	const gfa = parseGfa(
		[
			'H\tVN:Z:1.1\tRS:Z:ref',
			'S\t1\tACGTACGT',
			'S\t2\tAAAACCCC',
			'S\t3\tG',
			'S\t4\tGGGGTTTT',
			'S\t5\tACGTACGT',
			'S\t20\tC',
			'W\tref\t0\tchr1\t0\t34\t>1>2>3>4>5',
			'W\taltA\t0\tchr1\t0\t34\t>1>2>20>4>5',
			'W\taltB\t0\tchr1\t0\t34\t>1>2>20>4>5',
			'W\trefish\t0\tchr1\t0\t34\t>1>2>3>4>5'
		].join('\n')
	);

	it('shows walks that avoid the selected node, ordered after the through-selected ones', () => {
		// Select the alt node 20; the refish walk does NOT pass through it.
		const a = buildAlignment(gfa, { referenceSample: 'ref', selectedSegId: '20', windowBp: 10000 });
		const nonRef = a.rows.filter((r) => !r.isReference);
		// One row through node 20 (altA+altB collapsed, ×2) and one that avoids it (refish).
		const through = nonRef.filter((r) => r.throughSelected);
		const avoiding = nonRef.filter((r) => !r.throughSelected);
		expect(through.length).toBe(1);
		expect(through[0].multiplicity).toBe(2);
		expect(avoiding.length).toBe(1);
		// Reference is first; the through-selected row precedes the avoiding one.
		expect(a.rows[0].isReference).toBe(true);
		const iThrough = a.rows.indexOf(through[0]);
		const iAvoiding = a.rows.indexOf(avoiding[0]);
		expect(iThrough).toBeLessThan(iAvoiding);
	});
});

describe('buildAlignment — windowing', () => {
	// A long backbone; clicking a middle node should only include nearby nodes.
	const seg = (id: number, len: number) => `S\t${id}\t${'A'.repeat(len)}`;
	const ids = Array.from({ length: 21 }, (_, i) => i + 1);
	const gfa = parseGfa(
		[
			'H\tVN:Z:1.1\tRS:Z:ref',
			...ids.map((i) => seg(i, 100)),
			`W\tref\t0\tchr1\t0\t2100\t${ids.map((i) => '>' + i).join('')}`
		].join('\n')
	);

	it('limits blocks to a window around the clicked node', () => {
		const a = buildAlignment(gfa, { referenceSample: 'ref', selectedSegId: '11', windowBp: 250 });
		// node 11 spans [1000,1100); ±250 bp reaches nodes ~8..14.
		const bbIds = a.blocks.filter((b) => b.isBackbone).map((b) => b.segId);
		expect(bbIds).toContain('11');
		expect(bbIds).not.toContain('1');
		expect(bbIds).not.toContain('21');
		expect(bbIds.length).toBeLessThan(ids.length);
	});

	it('clamps the window when it would exceed the column cap', () => {
		const a = buildAlignment(gfa, {
			referenceSample: 'ref',
			selectedSegId: '11',
			windowBp: 100000,
			maxColumns: 500
		});
		expect(a.truncatedWindow).toBe(true);
		expect(a.totalBp).toBeLessThanOrEqual(500);
	});
});

describe('buildAlignment — degenerate inputs', () => {
	it('returns a note when the node is absent', () => {
		const gfa = parseGfa(['H\tVN:Z:1.1', 'S\t1\tACGT', 'W\tref\t0\tc\t0\t4\t>1'].join('\n'));
		const a = buildAlignment(gfa, { selectedSegId: 'nope', windowBp: 100 });
		expect(a.note).toBeTruthy();
		expect(a.blocks.length).toBe(0);
	});
});
