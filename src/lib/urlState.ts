// Every view setting a Graphoscope link can carry, parsed from and written back
// to the URL. A link is the thing an AI agent (or a colleague) can construct,
// open, and reproduce, so everything that changes what the graph looks like
// belongs here, not only the query.
//
// Pure (no Svelte, no DOM) so it's testable, and shared by the locus browser,
// the /gfa viewer, and /api's parameter listing. `PARAMS` is the one list of
// what each parameter means; static/llms.txt documents the same list, and a
// test keeps the two in step.

import { LAYOUT_MODES, type LayoutMode } from './graph/layoutModes';
import { COLOR_MODES, type ColorMode } from './graph/colors';

export interface GenomicRange {
	contig: string;
	start: number;
	end: number;
}

/** A highlighted stretch of reference (`mark=chr:start-end,label`). */
export interface Mark extends GenomicRange {
	label: string;
}

/** Which page a parameter applies to. */
export type ParamPage = 'locus' | 'gfa';

export interface ParamDoc {
	name: string;
	pages: ParamPage[];
	values: string;
	description: string;
}

/** The parameters every Graphoscope link understands, in documentation order. */
export const PARAMS: ParamDoc[] = [
	{ name: 'ref', pages: ['locus'], values: 'grch38 | chm13', description: 'Which HPRC graph to query. Default grch38.' },
	{
		name: 'locus',
		pages: ['locus'],
		values: 'gene symbol or contig:start-end',
		description: 'What to query, e.g. SMN1 or chr5:70,925,000-70,955,000. `gene` is an alias.'
	},
	{
		name: 'context',
		pages: ['locus'],
		values: 'bp',
		description: 'How far past the locus haplotypes are followed. Default 10000.'
	},
	{
		name: 'simplify',
		pages: ['locus'],
		values: 'bp | off',
		description: 'Pop variants under this many bp (default 50). `off` shows the unsimplified graph.'
	},
	{ name: 'example', pages: ['gfa'], values: 'example name', description: 'Open a bundled example graph, e.g. mlph.' },
	{ name: 'url', pages: ['gfa'], values: 'https URL', description: 'Load a GFA from a URL (it must allow CORS).' },
	{
		name: 'layout',
		pages: ['locus', 'gfa'],
		values: LAYOUT_MODES.map((m) => m.id).join(' | '),
		description: 'Layout mode. Shown names work too: strands, skyline, untangled, dag.'
	},
	{
		name: 'theme',
		pages: ['locus', 'gfa'],
		values: 'dark | light',
		description: 'Graph canvas background. light is for figures. Default dark.'
	},
	{
		name: 'color',
		pages: ['locus', 'gfa'],
		values: COLOR_MODES.map((m) => m.mode).join(' | '),
		description: 'What node colour encodes. Default coverage (length for a graph with no walks).'
	},
	{ name: 'genes', pages: ['locus', 'gfa'], values: '1 | 0', description: 'Draw the gene track. Default 1.' },
	{
		name: 'exits',
		pages: ['locus'],
		values: '1 | 0',
		description: 'Draw cues on haplotypes cut off at the window edge. Default 1.'
	},
	{ name: 'view', pages: ['locus'], values: 'graph | data', description: 'Which tab is open. Default graph.' },
	{
		name: 'range',
		pages: ['locus', 'gfa'],
		values: 'contig:start-end',
		description: 'Zoom the graph to this stretch of reference after layout.'
	},
	{ name: 'select', pages: ['locus', 'gfa'], values: 'node id', description: 'Select a node and open its inspector.' },
	{
		name: 'pin',
		pages: ['locus', 'gfa'],
		values: 'walk name, repeatable',
		description: 'Trace a walk: a sample name, sample#haplotype, a full key, or "Walk 3".'
	},
	{ name: 'msa', pages: ['locus', 'gfa'], values: '1', description: 'Open the alignment panel under the graph.' },
	{
		name: 'mark',
		pages: ['locus', 'gfa'],
		values: 'contig:start-end,label (repeatable)',
		description: 'Highlight a stretch of reference with a labelled band. With no locus, the first mark is queried.'
	},
	{
		name: 'chrome',
		pages: ['locus', 'gfa'],
		values: '1 | 0',
		description: '0 hides the header, tabs and options panel, leaving only the graph.'
	},
	{
		name: 'size',
		pages: ['locus', 'gfa'],
		values: 'WIDTHxHEIGHT',
		description: 'Render the page at a fixed pixel size, e.g. 1600x900, so screenshots match.'
	}
];

export function paramsFor(page: ParamPage): ParamDoc[] {
	return PARAMS.filter((p) => p.pages.includes(page));
}

// ---- parsing ---------------------------------------------------------------

const num = (s: string) => Number(s.replace(/,/g, ''));

/** `chr1:1,000-2,000` → a range, or an error message. */
export function parseRange(text: string): GenomicRange | string {
	const m = /^\s*([^:\s]+):\s*([\d,]+)\s*-\s*([\d,]+)\s*$/.exec(text);
	if (!m) return `"${text}" isn't contig:start-end`;
	const start = num(m[2]);
	const end = num(m[3]);
	if (!(end > start)) return `"${text}" ends before it starts`;
	return { contig: m[1], start, end };
}

/** `chr1:1,000-2,000,Alu insertion` → a mark, or an error message. The label is
 * everything after the first comma that follows the end coordinate, so commas
 * inside the coordinates are fine; with no label the coordinates stand in. */
export function parseMark(text: string): Mark | string {
	const m = /^\s*([^:\s]+:\s*[\d,]*\d\s*-\s*[\d,]*\d)\s*(?:,(.*))?$/.exec(text);
	if (!m) return `mark "${text}" isn't contig:start-end,label`;
	const range = parseRange(m[1]);
	if (typeof range === 'string') return `mark ${range}`;
	const label = (m[2] ?? '').trim();
	return { ...range, label: label || `${range.contig}:${range.start}-${range.end}` };
}

/** Accepts a mode id or its shown name (any case, spaces or dashes). */
export function parseLayoutMode(text: string): LayoutMode | null {
	const t = text.trim().toLowerCase().replace(/[\s_]+/g, '-');
	const alias: Record<string, LayoutMode> = {
		strands: 'stacked',
		skyline: 'classic',
		untangled: 'fm3',
		'untangled-(fm³)': 'fm3',
		force: 'simple-force',
		'simple-force-directed': 'simple-force',
		dag: 'layered',
		'layered-(dag)': 'layered',
		'assembly-graph': 'assembly'
	};
	if (alias[t]) return alias[t];
	const mode = LAYOUT_MODES.find((m) => m.id === t || m.label.toLowerCase().replace(/\s+/g, '-') === t);
	return mode?.id ?? null;
}

function parseColor(text: string): ColorMode | null {
	const t = text.trim().toLowerCase();
	const mode = COLOR_MODES.find((m) => m.mode.toLowerCase() === t || m.label.toLowerCase() === t);
	return mode?.mode ?? (t === 'bubble-size' ? 'bubbleSize' : null);
}

function parseBool(text: string): boolean | null {
	const t = text.trim().toLowerCase();
	if (['1', 'true', 'on', 'yes'].includes(t)) return true;
	if (['0', 'false', 'off', 'no'].includes(t)) return false;
	return null;
}

/** Settings the graph view (GraphLayoutView) owns. Absent = its own default. */
export interface GraphViewParams {
	layout?: LayoutMode;
	theme?: 'light' | 'dark';
	color?: ColorMode;
	genes?: boolean;
	exits?: boolean;
	range?: GenomicRange;
	select?: string;
	pin?: string[];
	msa?: boolean;
	marks: Mark[];
}

/** Settings the page owns around the graph view. */
export interface PageParams {
	view?: 'graph' | 'data';
	/** A variant threshold in bp, or 'off' for the unsimplified graph. */
	simplify?: number | 'off';
	chrome: boolean;
	size?: { width: number; height: number };
}

export interface ParsedParams {
	graph: GraphViewParams;
	page: PageParams;
	/** Human-readable problems: unknown parameters and values that didn't parse.
	 * Shown on the page and in window.graphoscope.warnings, never silently dropped. */
	warnings: string[];
}

/** Parse the view settings in a query string. Query parameters the page itself
 * handles (ref, locus, example, …) are left to it but count as known here. */
export function parseParams(p: URLSearchParams, page: ParamPage): ParsedParams {
	const graph: GraphViewParams = { marks: [] };
	const out: PageParams = { chrome: true };
	const warnings: string[] = [];
	const known = new Set(paramsFor(page).map((d) => d.name));
	if (page === 'locus') known.add('gene');
	const bad = (name: string, value: string, expected: string) =>
		warnings.push(`Ignored ${name}=${value}: expected ${expected}.`);

	for (const key of new Set(p.keys())) {
		if (!known.has(key)) {
			const elsewhere = PARAMS.find((d) => d.name === key);
			warnings.push(
				elsewhere
					? `Ignored ${key}: it only applies to the ${elsewhere.pages.includes('gfa') ? '/gfa viewer' : 'locus browser'}.`
					: `Ignored unknown parameter "${key}". See llms.txt for the list.`
			);
		}
	}

	const one = (name: string) => {
		const v = p.get(name);
		return v == null || v.trim() === '' ? null : v.trim();
	};
	const doc = (name: string) => PARAMS.find((d) => d.name === name)!.values;

	let v: string | null;
	if ((v = one('layout'))) {
		const mode = parseLayoutMode(v);
		if (mode) graph.layout = mode;
		else bad('layout', v, doc('layout'));
	}
	if ((v = one('theme'))) {
		if (v === 'light' || v === 'dark') graph.theme = v;
		else bad('theme', v, 'dark or light');
	}
	if ((v = one('color'))) {
		const c = parseColor(v);
		if (c) graph.color = c;
		else bad('color', v, doc('color'));
	}
	for (const name of ['genes', 'exits', 'msa', 'chrome'] as const) {
		if (!known.has(name) || (v = one(name)) == null) continue;
		const b = parseBool(v);
		if (b == null) bad(name, v, '1 or 0');
		else if (name === 'chrome') out.chrome = b;
		else graph[name] = b;
	}
	if ((v = one('range'))) {
		const r = parseRange(v);
		if (typeof r === 'string') warnings.push(`Ignored range: ${r}.`);
		else graph.range = r;
	}
	if ((v = one('select'))) graph.select = v;
	const pins = p.getAll('pin').map((s) => s.trim()).filter(Boolean);
	if (pins.length) graph.pin = pins;
	for (const raw of p.getAll('mark')) {
		const m = parseMark(raw);
		if (typeof m === 'string') warnings.push(`Ignored ${m}.`);
		else graph.marks.push(m);
	}

	if (known.has('view') && (v = one('view'))) {
		if (v === 'graph' || v === 'data') out.view = v;
		else bad('view', v, 'graph or data');
	}
	if (known.has('simplify') && (v = one('simplify'))) {
		const n = num(v);
		if (v.toLowerCase() === 'off') out.simplify = 'off';
		else if (Number.isInteger(n) && n > 0) out.simplify = n;
		else bad('simplify', v, 'a positive number of bp, or off');
	}
	if ((v = one('size'))) {
		const m = /^(\d+)\s*[x×*]\s*(\d+)$/i.exec(v);
		const width = m ? Number(m[1]) : 0;
		const height = m ? Number(m[2]) : 0;
		if (width >= 200 && height >= 200 && width <= 8000 && height <= 8000) out.size = { width, height };
		else bad('size', v, 'WIDTHxHEIGHT between 200 and 8000 px, e.g. 1600x900');
	}
	return { graph, page: out, warnings };
}

// ---- writing ---------------------------------------------------------------

/** A change to the address bar: a value sets the parameter, an array sets a
 * repeatable one, null removes it. */
export type ParamPatch = Record<string, string | string[] | null>;

export function applyPatch(p: URLSearchParams, patch: ParamPatch): URLSearchParams {
	for (const [key, value] of Object.entries(patch)) {
		p.delete(key);
		if (value == null) continue;
		for (const v of Array.isArray(value) ? value : [value]) p.append(key, v);
	}
	return p;
}

/** Query string with `:` and `,` left readable — URLSearchParams escapes them,
 * which turns chr1:1,000-2,000 into chr1%3A1%2C000-2%2C000. Both are legal in
 * a query component, and a legible link is the point. */
export function formatQuery(p: URLSearchParams): string {
	return p.toString().replace(/%3A/gi, ':').replace(/%2C/gi, ',');
}

export function formatRange(r: GenomicRange): string {
	return `${r.contig}:${Math.round(r.start)}-${Math.round(r.end)}`;
}

export function formatMark(m: Mark): string {
	const coords = formatRange(m);
	return m.label === coords ? coords : `${coords},${m.label}`;
}
