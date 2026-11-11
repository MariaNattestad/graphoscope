import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
	PARAMS,
	applyPatch,
	formatMark,
	formatQuery,
	parseLayoutMode,
	parseMark,
	parseParams,
	parseRange
} from './urlState';
import { LAYOUT_MODES } from './graph/layoutModes';
import { COLOR_MODES } from './graph/colors';

const parse = (qs: string, page: 'locus' | 'gfa' = 'locus') => parseParams(new URLSearchParams(qs), page);

describe('parseMark', () => {
	it('reads coordinates with commas and a label', () => {
		expect(parseMark('chr1:116,520,100-116,520,400,Alu insertion')).toEqual({
			contig: 'chr1',
			start: 116520100,
			end: 116520400,
			label: 'Alu insertion'
		});
	});

	it('keeps commas inside the label', () => {
		expect(parseMark('chr5:100-200,exon 7, SMN1')).toMatchObject({ label: 'exon 7, SMN1' });
	});

	it('falls back to the coordinates when there is no label', () => {
		expect(parseMark('chrX:1000-2000')).toMatchObject({ label: 'chrX:1000-2000' });
	});

	it('rejects malformed or backwards ranges', () => {
		expect(typeof parseMark('chr1:500')).toBe('string');
		expect(typeof parseMark('chr1:500-100,x')).toBe('string');
	});

	it('round-trips through formatMark', () => {
		const m = parseMark('chr1:100-200,Alu');
		expect(typeof m).toBe('object');
		if (typeof m === 'object') expect(parseMark(formatMark(m))).toEqual(m);
	});
});

describe('parseRange', () => {
	it('accepts commas and spaces', () => {
		expect(parseRange('chr6: 29,942,000 - 29,943,500')).toEqual({ contig: 'chr6', start: 29942000, end: 29943500 });
	});
});

describe('parseLayoutMode', () => {
	it('accepts every mode id', () => {
		for (const m of LAYOUT_MODES) expect(parseLayoutMode(m.id)).toBe(m.id);
	});

	it('accepts the names the UI shows', () => {
		expect(parseLayoutMode('Strands')).toBe('stacked');
		expect(parseLayoutMode('skyline')).toBe('classic');
		expect(parseLayoutMode('untangled')).toBe('fm3');
		expect(parseLayoutMode('Layered (DAG)')).toBe('layered');
		expect(parseLayoutMode('simple force-directed')).toBe('simple-force');
		expect(parseLayoutMode('strandz')).toBeNull();
	});
});

describe('parseParams', () => {
	it('parses a full figure link', () => {
		const { graph, page, warnings } = parse(
			'ref=grch38&locus=CD58&layout=strands&theme=light&color=length&genes=0&exits=0&range=chr1:1-2000' +
				'&select=42&pin=HG002&pin=HG00438%231&msa=1&mark=chr1:100-200,Alu&mark=chr1:300-400' +
				'&simplify=250&view=data&chrome=0&size=1600x900'
		);
		expect(warnings).toEqual([]);
		expect(graph).toEqual({
			layout: 'stacked',
			theme: 'light',
			color: 'length',
			genes: false,
			exits: false,
			range: { contig: 'chr1', start: 1, end: 2000 },
			select: '42',
			pin: ['HG002', 'HG00438#1'],
			msa: true,
			marks: [
				{ contig: 'chr1', start: 100, end: 200, label: 'Alu' },
				{ contig: 'chr1', start: 300, end: 400, label: 'chr1:300-400' }
			]
		});
		expect(page).toEqual({ simplify: 250, view: 'data', chrome: false, size: { width: 1600, height: 900 } });
	});

	it('leaves defaults out when nothing is given', () => {
		expect(parse('')).toEqual({ graph: { marks: [] }, page: { chrome: true }, warnings: [] });
	});

	it('reads simplify=off', () => {
		expect(parse('simplify=off').page.simplify).toBe('off');
	});

	it('warns about unknown parameters and bad values instead of dropping them silently', () => {
		const { graph, warnings } = parse('layuot=fm3&layout=strandz&theme=blue&genes=maybe&size=10x10&mark=nope');
		expect(graph.layout).toBeUndefined();
		expect(warnings).toHaveLength(6);
		expect(warnings[0]).toMatch(/unknown parameter "layuot"/);
		expect(warnings.join('\n')).toMatch(/layout=strandz/);
		expect(warnings.join('\n')).toMatch(/theme=blue/);
		expect(warnings.join('\n')).toMatch(/genes=maybe/);
		expect(warnings.join('\n')).toMatch(/size=10x10/);
		expect(warnings.join('\n')).toMatch(/mark "nope"/);
	});

	it('names the page a misplaced parameter belongs to', () => {
		expect(parse('example=mlph').warnings[0]).toMatch(/only applies to the \/gfa viewer/);
		expect(parse('simplify=100', 'gfa').warnings[0]).toMatch(/only applies to the locus browser/);
		expect(parse('simplify=100', 'gfa').page.simplify).toBeUndefined();
	});

	it('accepts the gene alias on the locus page', () => {
		expect(parse('gene=SMN1').warnings).toEqual([]);
	});
});

describe('writing', () => {
	it('applies a patch, including repeatable and removed parameters', () => {
		const p = applyPatch(new URLSearchParams('ref=grch38&locus=SMN1&pin=a&theme=light'), {
			pin: ['b', 'c'],
			theme: null,
			layout: 'fm3'
		});
		expect(p.getAll('pin')).toEqual(['b', 'c']);
		expect(p.has('theme')).toBe(false);
		expect(p.get('layout')).toBe('fm3');
	});

	it('keeps coordinates legible in the query string', () => {
		const p = new URLSearchParams();
		p.set('mark', 'chr1:1,000-2,000,Alu insertion');
		expect(formatQuery(p)).toBe('mark=chr1:1,000-2,000,Alu+insertion');
		expect(parseParams(new URLSearchParams(formatQuery(p)), 'locus').graph.marks[0].label).toBe('Alu insertion');
	});
});

describe('llms.txt', () => {
	it('documents every parameter the app understands', () => {
		const text = fs.readFileSync(path.resolve(__dirname, '../../static/llms.txt'), 'utf8');
		for (const p of PARAMS) expect(text, `llms.txt is missing ${p.name}`).toContain(`\`${p.name}\``);
		for (const m of LAYOUT_MODES) expect(text, `llms.txt is missing layout ${m.id}`).toContain(`\`${m.id}\``);
		for (const m of COLOR_MODES) expect(text, `llms.txt is missing color ${m.mode}`).toContain(`\`${m.mode}\``);
	});

	it('documents every /gfa example id', () => {
		const text = fs.readFileSync(path.resolve(__dirname, '../../static/llms.txt'), 'utf8');
		const gfaPage = fs.readFileSync(path.resolve(__dirname, '../routes/gfa/+page.svelte'), 'utf8');
		const examples = gfaPage.slice(gfaPage.indexOf('const EXAMPLES'));
		const ids = [...examples.matchAll(/^\s*id: '([\w-]+)'/gm)].map((m) => m[1]);
		expect(ids.length).toBeGreaterThan(0);
		for (const id of ids) expect(text, `llms.txt is missing example ${id}`).toContain(`\`${id}\``);
	});
});
