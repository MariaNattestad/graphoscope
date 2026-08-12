/**
 * Layout modes: named presets that replace the old loose collection of layout
 * switches (one-sided / anchor-to-reference / bendy). Each mode is a complete
 * recipe for one way of looking at a graph, tuned for a particular kind of
 * inspection. Two families:
 *
 *  - `anchored` modes lay the graph out along a chosen reference backbone
 *    (genome-browser style): a straight horizontal axis with variant bubbles
 *    hanging off it. Good when you have a reference and want coordinates. They
 *    all show the coordinate axis and gene track.
 *
 *  - `free` modes ignore the backbone for positioning entirely and let the
 *    graph find its own shape from a force simulation. There is no reference
 *    axis, no coordinates and no gene track — good for graphs with no natural
 *    reference, or when the reference layout hides real topology.
 *
 * The renderer (GraphCanvas) is agnostic to which family produced the layout —
 * it only reads node positions plus the shared chain/link/coverage data — so a
 * mode is fully defined by how it seeds and relaxes the simulation.
 */

export type LayoutFamily = 'anchored' | 'free';

export type LayoutMode =
	// reference-anchored
	| 'classic'
	| 'spread'
	| 'naive'
	// reference-free
	| 'fm3'
	| 'simple-force'
	| 'flow'
	| 'layered'
	| 'radial';

/** How reference-free modes place and relax nodes. */
export interface RefFreeParams {
	/** d3 forceManyBody strength (negative = repulsion). */
	charge: number;
	/** Cap on the charge force's range, so huge graphs stay O(n·k) not O(n²)-ish. */
	chargeDistanceMax: number;
	/** Multiplier on every structural link's rest distance (bigger = more spread). */
	linkDistanceScale: number;
	/** Structural link strength (how hard links pull their endpoints together). */
	linkStrength: number;
	/** forceCollide radius (hard minimum separation between any two nodes). */
	collide: number;
	/** Initial placement strategy before relaxation. */
	seeding: 'scatter' | 'layered' | 'radial' | 'dag' | 'fm3';
	/** Simulation iterations (defaults to the layout's own default when omitted). */
	iterations?: number;
}

export interface LayoutModeConfig {
	id: LayoutMode;
	label: string;
	family: LayoutFamily;
	/** One-line description for the UI. */
	blurb: string;
	// --- anchored-mode knobs (ignored by free modes) ---
	/** Keep bubbles on one side (above the reference line), freeing the space below
	 * for the gene track. */
	bubblesAbove: boolean;
	/** Pull each bubble onto its reference node's x so it stacks into a tidy column.
	 * Off gives the older, freer relaxation where bubbles open out sideways. */
	anchorToReference: boolean;
	/** Push bubbles clear of the reference line so nothing overlaps it. Off lets the
	 * relaxation drift across the line (part of the "naive" older look). */
	avoidBaseline: boolean;
	/** Let alt bubbles fan out horizontally into the space over their neighbouring
	 * reference nodes (up to ~halfway across each) instead of stacking into a tight
	 * column above their attachment point. */
	spread: boolean;
	/** Whether to draw curved strands through bend nodes (both families honor this). */
	bendNodes: boolean;
	/** Tuning for free modes (undefined for anchored modes). */
	refFree?: RefFreeParams;
}

export const LAYOUT_MODES: LayoutModeConfig[] = [
	// --- reference-anchored ---
	{
		id: 'classic',
		label: 'Recommended',
		family: 'anchored',
		blurb: 'Straight reference axis, variant bubbles stacked above it. The genome-browser view.',
		bubblesAbove: true,
		anchorToReference: true,
		avoidBaseline: true,
		spread: false,
		bendNodes: false
	},
	{
		id: 'spread',
		label: 'Spread',
		family: 'anchored',
		blurb:
			'Like Recommended, but bubbles fan out horizontally into the space over their neighbouring reference nodes instead of stacking into a tight column.',
		bubblesAbove: true,
		anchorToReference: true,
		avoidBaseline: true,
		spread: true,
		bendNodes: false
	},
	{
		id: 'naive',
		label: 'Naïve',
		family: 'anchored',
		blurb: 'The reference on a straight axis, but otherwise a simple force-directed layout.',
		bubblesAbove: false,
		anchorToReference: false,
		avoidBaseline: false,
		spread: false,
		bendNodes: false
	},
	// --- reference-free ---
	// Listed first so it's the default whenever the reference-free family is chosen
	// (the UI lands on the family's first entry — see GraphLayoutView.selectFamily).
	{
		id: 'fm3',
		label: 'Untangled (FM³)',
		family: 'free',
		blurb:
			'Multilevel force-directed (FM³) layout: coarsens the graph, lays out the coarse skeleton, then refines down to a clean, untangled drawing. The best general reference-free view.',
		bubblesAbove: false,
		anchorToReference: false,
		avoidBaseline: false,
		spread: false,
		// The strand/"noodle" curve comes from each segment's length-proportional
		// bead chain bending, not from bend nodes on the connectors — so we skip bend
		// nodes (they'd ~double the simulation's node count for a straight-connector
		// detail that's barely visible here) and keep the layout fast enough to be a
		// default.
		bendNodes: false,
		refFree: {
			charge: -45,
			chargeDistanceMax: 500,
			linkDistanceScale: 1,
			linkStrength: 0.35,
			collide: 9,
			seeding: 'fm3',
			// FM³ hands the relaxation an already-untangled seed, so it only needs a
			// light final pass to bend the strands — not the 350-iteration default.
			iterations: 120
		}
	},
	{
		id: 'simple-force',
		label: 'Simple force-directed',
		family: 'free',
		blurb: 'Plain force layout — no reference, no anchoring. The graph finds its own shape.',
		bubblesAbove: false,
		anchorToReference: false,
		avoidBaseline: false,
		spread: false,
		bendNodes: false,
		refFree: {
			charge: -34,
			chargeDistanceMax: 320,
			linkDistanceScale: 1,
			linkStrength: 0.5,
			collide: 8,
			seeding: 'scatter',
		}
	},
	{
		id: 'flow',
		label: 'Flow',
		family: 'free',
		blurb: 'Left-to-right layering by graph distance — direction without picking a reference.',
		bubblesAbove: false,
		anchorToReference: false,
		avoidBaseline: false,
		spread: false,
		bendNodes: true,
		refFree: {
			charge: -40,
			chargeDistanceMax: 400,
			linkDistanceScale: 1,
			linkStrength: 0.25,
			collide: 9,
			seeding: 'layered',
		}
	},
	{
		id: 'layered',
		label: 'Layered (DAG)',
		family: 'free',
		blurb:
			'Sugiyama-style layered drawing: ranks by graph distance with the rows ordered to minimise edge crossings. Best for DAG-like graphs.',
		bubblesAbove: false,
		anchorToReference: false,
		avoidBaseline: false,
		spread: false,
		bendNodes: true,
		refFree: {
			charge: -14,
			chargeDistanceMax: 240,
			linkDistanceScale: 1,
			linkStrength: 0.15,
			collide: 8,
			seeding: 'dag',
			iterations: 70
		}
	},
	{
		id: 'radial',
		label: 'Radial',
		family: 'free',
		blurb: 'Grows outward from a central node by graph depth. An overview of overall topology.',
		bubblesAbove: false,
		anchorToReference: false,
		avoidBaseline: false,
		spread: false,
		bendNodes: true,
		refFree: {
			charge: -50,
			chargeDistanceMax: 500,
			linkDistanceScale: 1.1,
			linkStrength: 0.2,
			collide: 9,
			seeding: 'radial',
		}
	}
];

const MODE_BY_ID = new Map(LAYOUT_MODES.map((m) => [m.id, m]));

export const DEFAULT_LAYOUT_MODE: LayoutMode = 'classic';

export function getModeConfig(mode: LayoutMode | undefined): LayoutModeConfig {
	return MODE_BY_ID.get(mode ?? DEFAULT_LAYOUT_MODE) ?? MODE_BY_ID.get(DEFAULT_LAYOUT_MODE)!;
}
