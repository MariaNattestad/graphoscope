/**
 * Layout modes: named presets that replace the old loose collection of layout
 * switches (one-sided / anchor-to-reference / bendy). Each mode is a complete
 * recipe for one way of looking at a graph, tuned for a particular kind of
 * inspection. Two families:
 *
 *  - `anchored` modes lay the graph out along a chosen reference backbone
 *    (genome-browser style): a straight horizontal axis with variant bubbles
 *    hanging off it. Good when you have a reference and want coordinates.
 *
 *  - `free` modes ignore the backbone for positioning entirely and let the
 *    graph find its own shape from a force simulation. Good for graphs with no
 *    natural reference, or when the reference layout hides real topology.
 *
 * The renderer (GraphCanvas) is agnostic to which family produced the layout —
 * it only reads node positions plus the shared chain/link/coverage data — so a
 * mode is fully defined by how it seeds and relaxes the simulation.
 */

export type LayoutFamily = 'anchored' | 'free';

export type LayoutMode =
	// reference-anchored
	| 'classic'
	| 'ribbon'
	| 'balanced'
	// reference-free
	| 'naive'
	| 'stringy'
	| 'bubble-repel'
	| 'flow'
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
	seeding: 'scatter' | 'layered' | 'radial';
	/** Add an inter-bubble repulsion force that pushes distinct bubble clusters apart. */
	bubbleRepel: boolean;
	/** Simulation iterations (defaults to the layout's own default when omitted). */
	iterations?: number;
}

export interface LayoutModeConfig {
	id: LayoutMode;
	label: string;
	family: LayoutFamily;
	/** One-line description for the UI. */
	blurb: string;
	/** Primitive knobs for anchored modes (ignored by free modes). */
	bubblesAbove: boolean;
	anchorToReference: boolean;
	/** Whether to draw curved strands through bend nodes (both families honor this). */
	bendNodes: boolean;
	/** Tuning for free modes (undefined for anchored modes). */
	refFree?: RefFreeParams;
}

export const LAYOUT_MODES: LayoutModeConfig[] = [
	// --- reference-anchored ---
	{
		id: 'classic',
		label: 'Graphoscope classic',
		family: 'anchored',
		blurb: 'Straight reference axis, variant bubbles stacked above it. The genome-browser view.',
		bubblesAbove: true,
		anchorToReference: true,
		bendNodes: false
	},
	{
		id: 'ribbon',
		label: 'Ribbon',
		family: 'anchored',
		blurb: 'Classic, but with smooth curved strands. For clean publication figures.',
		bubblesAbove: true,
		anchorToReference: true,
		bendNodes: true
	},
	{
		id: 'balanced',
		label: 'Balanced',
		family: 'anchored',
		blurb: 'Anchored to the reference, bubbles free to fall on either side. Symmetric variant density.',
		bubblesAbove: false,
		anchorToReference: true,
		bendNodes: true
	},
	// --- reference-free ---
	{
		id: 'naive',
		label: 'Naive',
		family: 'free',
		blurb: 'Plain force layout — no reference, no anchoring. The graph finds its own shape.',
		bubblesAbove: false,
		anchorToReference: false,
		bendNodes: false,
		refFree: {
			charge: -34,
			chargeDistanceMax: 320,
			linkDistanceScale: 1,
			linkStrength: 0.5,
			collide: 8,
			seeding: 'scatter',
			bubbleRepel: false
		}
	},
	{
		id: 'stringy',
		label: 'Stringy',
		family: 'free',
		blurb: 'Long, loose strands that spread out organically. Good for tangles and repeats.',
		bubblesAbove: false,
		anchorToReference: false,
		bendNodes: true,
		refFree: {
			charge: -90,
			chargeDistanceMax: 700,
			linkDistanceScale: 2.4,
			linkStrength: 0.12,
			collide: 11,
			seeding: 'scatter',
			bubbleRepel: false
		}
	},
	{
		id: 'bubble-repel',
		label: 'Bubble-repel',
		family: 'free',
		blurb: 'Force layout that pushes distinct variant bubbles apart so each reads on its own.',
		bubblesAbove: false,
		anchorToReference: false,
		bendNodes: true,
		refFree: {
			charge: -46,
			chargeDistanceMax: 420,
			linkDistanceScale: 1.3,
			linkStrength: 0.4,
			collide: 9,
			seeding: 'scatter',
			bubbleRepel: true
		}
	},
	{
		id: 'flow',
		label: 'Flow',
		family: 'free',
		blurb: 'Left-to-right layering by graph distance — direction without picking a reference.',
		bubblesAbove: false,
		anchorToReference: false,
		bendNodes: true,
		refFree: {
			charge: -40,
			chargeDistanceMax: 400,
			linkDistanceScale: 1,
			linkStrength: 0.25,
			collide: 9,
			seeding: 'layered',
			bubbleRepel: false
		}
	},
	{
		id: 'radial',
		label: 'Radial',
		family: 'free',
		blurb: 'Grows outward from a central node by graph depth. An overview of overall topology.',
		bubblesAbove: false,
		anchorToReference: false,
		bendNodes: true,
		refFree: {
			charge: -50,
			chargeDistanceMax: 500,
			linkDistanceScale: 1.1,
			linkStrength: 0.2,
			collide: 9,
			seeding: 'radial',
			bubbleRepel: false
		}
	}
];

const MODE_BY_ID = new Map(LAYOUT_MODES.map((m) => [m.id, m]));

export const DEFAULT_LAYOUT_MODE: LayoutMode = 'classic';

export function getModeConfig(mode: LayoutMode | undefined): LayoutModeConfig {
	return MODE_BY_ID.get(mode ?? DEFAULT_LAYOUT_MODE) ?? MODE_BY_ID.get(DEFAULT_LAYOUT_MODE)!;
}
