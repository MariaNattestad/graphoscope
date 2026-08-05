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
	discoCore: 'rgba(17, 24, 39, 0.6)',
	discoLightness: 45,
	exitCue: 'rgba(100, 116, 139, 0.65)',
	exitCueFade: 'rgba(100, 116, 139, 0)'
};
