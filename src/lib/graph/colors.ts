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

const HEATMAP_LOW = [255, 214, 10]; // yellow: few/no non-reference paths
const HEATMAP_HIGH = [214, 30, 30]; // red: many non-reference paths

/** Yellow (low) to red (high) heatmap color for a 0..1 path-coverage ratio. */
export function heatmapColor(ratio: number): string {
	const t = Math.max(0, Math.min(1, ratio));
	const r = Math.round(HEATMAP_LOW[0] + (HEATMAP_HIGH[0] - HEATMAP_LOW[0]) * t);
	const g = Math.round(HEATMAP_LOW[1] + (HEATMAP_HIGH[1] - HEATMAP_LOW[1]) * t);
	const b = Math.round(HEATMAP_LOW[2] + (HEATMAP_HIGH[2] - HEATMAP_LOW[2]) * t);
	return `rgb(${r}, ${g}, ${b})`;
}
