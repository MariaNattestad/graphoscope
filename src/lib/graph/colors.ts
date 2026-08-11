const GOLDEN_ANGLE = 137.508;

// Deterministic, visually distinct color per segment id. Hashes the id, then
// spaces hues by the golden angle so that even sequential ids (1, 2, 3, ...)
// land on well-separated hues instead of clustering together.
export function colorForSegment(id: string): string {
	let hash = 0;
	for (let i = 0; i < id.length; i++) {
		hash = (hash * 31 + id.charCodeAt(i)) | 0;
	}
	const hue = (Math.abs(hash) * GOLDEN_ANGLE) % 360;
	return `hsl(${hue}, 65%, 50%)`;
}

// Discrete, well-separated color for the Nth item (e.g. the Nth bubble). Spacing
// hues by the golden angle keeps consecutive indices far apart on the wheel, so a
// row of adjacent bubbles never fades into a single band. `lightness` lets the
// dark and light themes keep the swatches legible against their backgrounds.
export function discreteColor(index: number, lightness = 55): string {
	const hue = (index * GOLDEN_ANGLE) % 360;
	return `hsl(${hue}, 68%, ${lightness}%)`;
}

/** How each node's fill is colored in the graph view. */
export type ColorMode = 'coverage' | 'bubbleSize' | 'bubble' | 'length';

export interface ColorModeInfo {
	mode: ColorMode;
	/** Label shown in the on-graph legend picker. */
	label: string;
	/** The trailing caption next to the legend swatch ("→" for a low-high ramp). */
	caption: string;
	/** Discrete per-bubble hues vs. a low→high heatmap ramp — drives the legend swatch. */
	kind: 'heatmap' | 'discrete';
}

export const COLOR_MODES: ColorModeInfo[] = [
	{ mode: 'coverage', label: 'Walks through node', caption: 'more walks through node', kind: 'heatmap' },
	{ mode: 'bubbleSize', label: 'Bubble size', caption: 'longer path through bubble', kind: 'heatmap' },
	{ mode: 'bubble', label: 'Bubble', caption: 'one color per bubble', kind: 'discrete' },
	{ mode: 'length', label: 'Node length', caption: 'longer node', kind: 'heatmap' }
];

export const BACKBONE_COLOR = '#f2f4f8';

type Rgb = readonly [number, number, number];

/** Interpolated `rgb()` between two colors for a 0..1 ratio. */
export function heatmapColor(ratio: number, low: Rgb, high: Rgb): string {
	const t = Math.max(0, Math.min(1, ratio));
	const r = Math.round(low[0] + (high[0] - low[0]) * t);
	const g = Math.round(low[1] + (high[1] - low[1]) * t);
	const b = Math.round(low[2] + (high[2] - low[2]) * t);
	return `rgb(${r}, ${g}, ${b})`;
}

// Perceptually-uniform, colour-vision-deficiency-friendly sequential colormaps,
// sampled from D3/matplotlib's viridis and plasma. Giving "node length" and
// "bubble size" their own ramp keeps them visually distinct from the gold→red
// coverage heatmap (and from each other): viridis reads blue→green→yellow,
// plasma reads indigo→magenta→yellow, and neither collides with warm gold→red.
const VIRIDIS: Rgb[] = [
	[68, 1, 84],
	[72, 40, 120],
	[62, 74, 137],
	[49, 104, 142],
	[38, 130, 142],
	[31, 158, 137],
	[53, 183, 121],
	[110, 206, 88],
	[181, 222, 43],
	[253, 231, 37]
];
const PLASMA: Rgb[] = [
	[13, 8, 135],
	[70, 3, 159],
	[114, 1, 168],
	[156, 23, 158],
	[189, 55, 134],
	[216, 87, 107],
	[237, 121, 83],
	[251, 159, 58],
	[253, 202, 38],
	[240, 249, 33]
];

/** Sample a colormap (array of RGB stops) at a 0..1 position, linearly
 * interpolating between the two nearest stops. */
function sampleColormap(stops: Rgb[], t: number): Rgb {
	const x = Math.max(0, Math.min(1, t)) * (stops.length - 1);
	const i = Math.floor(x);
	if (i >= stops.length - 1) return stops[stops.length - 1];
	const f = x - i;
	const a = stops[i];
	const b = stops[i + 1];
	return [
		Math.round(a[0] + (b[0] - a[0]) * f),
		Math.round(a[1] + (b[1] - a[1]) * f),
		Math.round(a[2] + (b[2] - a[2]) * f)
	];
}

// Each metric maps its 0..1 ratio through a *theme-specific window* of its
// colormap, so neither extreme ever vanishes: on the dark screen theme we skip
// the near-black low end, and on the light figure theme we skip the bright-yellow
// high end. (The gold→red coverage ramp already ships light/dark variants in the
// theme, so it isn't handled here.)
interface Ramp {
	stops: Rgb[];
	dark: readonly [number, number];
	light: readonly [number, number];
}
const RAMPS: Record<'length' | 'bubbleSize', Ramp> = {
	length: { stops: VIRIDIS, dark: [0.32, 1], light: [0, 0.72] },
	bubbleSize: { stops: PLASMA, dark: [0.3, 1], light: [0, 0.72] }
};

/** The fill color for a heatmap color mode at a 0..1 ratio, on the current theme.
 * Coverage uses the theme's own gold→red ramp; length/bubble-size use viridis/
 * plasma sampled over their theme-appropriate window. */
export function heatmapModeColor(
	mode: ColorMode,
	ratio: number,
	lightMode: boolean,
	theme: GraphTheme
): string {
	const ramp = mode === 'length' || mode === 'bubbleSize' ? RAMPS[mode] : null;
	if (!ramp) return heatmapColor(ratio, theme.heatmapLow, theme.heatmapHigh);
	const [lo, hi] = lightMode ? ramp.light : ramp.dark;
	const [r, g, b] = sampleColormap(ramp.stops, lo + Math.max(0, Math.min(1, ratio)) * (hi - lo));
	return `rgb(${r}, ${g}, ${b})`;
}

/** A CSS `linear-gradient` matching a heatmap mode's ramp on the current theme,
 * so the legend swatch always shows exactly the scale the nodes use. */
export function legendGradientCss(mode: ColorMode, lightMode: boolean, theme: GraphTheme): string {
	const steps = 8;
	const cols: string[] = [];
	for (let i = 0; i <= steps; i++) cols.push(heatmapModeColor(mode, i / steps, lightMode, theme));
	return `linear-gradient(90deg, ${cols.join(', ')})`;
}

/** Every canvas color the graph view uses, so the whole thing can flip between a
 * dark screen theme and a light theme meant for figures/publication screenshots. */
export interface GraphTheme {
	background: string;
	backbone: string;
	structuralLink: string;
	heatmapLow: Rgb; // few non-reference walks through a node
	heatmapHigh: Rgb; // many
	coordText: string;
	coordPill: string; // legibility background behind coordinate labels
	tick: string;
	contigLabel: string;
	geneBandLine: string;
	geneIntron: string;
	geneChevron: string;
	geneExonCoding: string;
	geneExonUtr: string;
	geneLabel: string;
	bubbleHighlight: string; // strands of the hovered bubble (bubble mode)
	discoCore: string; // the bright center line down a spotlit walk
	discoLightness: number; // HSL lightness % for the cycling disco hue
	exitCue: string; // dashed "haplotype leaves the locus" cue, solid end
	exitCueFade: string; // same color, alpha 0, for the fade toward the frame edge
}

export const darkTheme: GraphTheme = {
	background: '#0b0d12',
	backbone: BACKBONE_COLOR,
	structuralLink: 'rgba(200, 210, 230, 0.35)',
	heatmapLow: [255, 214, 10],
	heatmapHigh: [214, 30, 30],
	coordText: '#a9c7ff',
	coordPill: 'rgba(11, 13, 18, 0.72)',
	tick: 'rgba(150, 165, 190, 0.6)',
	contigLabel: 'rgba(169, 199, 255, 0.85)',
	geneBandLine: 'rgba(150, 165, 190, 0.16)',
	geneIntron: 'rgba(140, 162, 196, 0.6)',
	geneChevron: 'rgba(140, 162, 196, 0.8)',
	geneExonCoding: '#6f9dff',
	geneExonUtr: 'rgba(111, 157, 255, 0.5)',
	geneLabel: 'rgba(214, 224, 245, 0.92)',
	bubbleHighlight: '#67e8f9',
	discoCore: 'rgba(255, 255, 255, 0.95)',
	discoLightness: 62,
	exitCue: 'rgba(154, 163, 178, 0.7)',
	exitCueFade: 'rgba(154, 163, 178, 0)'
};

export const lightTheme: GraphTheme = {
	background: '#ffffff',
	backbone: '#334155',
	structuralLink: 'rgba(100, 116, 139, 0.4)',
	// Darker gold→red than the dark theme's, so low-coverage nodes stay visible on white.
	heatmapLow: [214, 158, 0],
	heatmapHigh: [185, 28, 28],
	coordText: '#1d4ed8',
	coordPill: 'rgba(255, 255, 255, 0.8)',
	tick: 'rgba(71, 85, 105, 0.65)',
	contigLabel: 'rgba(29, 78, 216, 0.9)',
	geneBandLine: 'rgba(71, 85, 105, 0.22)',
	geneIntron: 'rgba(71, 85, 105, 0.6)',
	geneChevron: 'rgba(71, 85, 105, 0.85)',
	geneExonCoding: '#2563eb',
	geneExonUtr: 'rgba(37, 99, 235, 0.5)',
	geneLabel: 'rgba(30, 41, 59, 0.95)',
	bubbleHighlight: '#0891b2',
	discoCore: 'rgba(17, 24, 39, 0.6)',
	discoLightness: 45,
	exitCue: 'rgba(100, 116, 139, 0.65)',
	exitCueFade: 'rgba(100, 116, 139, 0)'
};
