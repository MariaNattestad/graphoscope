// Single source of truth for every performance limit, the device signals they
// scale on, and the warning text that quotes them. Before this, the thresholds
// were scattered across graphs.ts, +page.svelte, GraphLayoutView.svelte and
// forceLayout.ts, each with its own prose rationale — so the numbers and the
// text that mentioned them drifted apart (a warning said "a few minutes" for a
// graph that lays out in ~14 s). Keeping them here keeps them consistent and
// makes the desktop/mobile split a single decision instead of a per-component
// one.
//
// Two device signals drive the split:
//   • narrow    — a phone-sized UI (small screen or coarse pointer).
//   • lowMemory — narrow, OR a device reporting ≤ 4 GB of RAM. This drives the
//     *hard* ceilings that exist to stop the browser killing the tab ("aw
//     snap") when a repetitive locus's walks are parsed into memory. On mobile,
//     avoiding that crash matters more than shaving seconds off a layout, so the
//     memory ceilings refuse rather than warn.
//
// The numbers come from measuring the real pipeline (see the perf review):
//   • fetch + parse of walks is cheap CPU (tens of ms) — but the *parsed* walks
//     are the memory cost, and at a repetitive locus (e.g. LPA) that is enough
//     to OOM a phone tab.
//   • layout time is ~0.55 ms/node in rough mode, ~5 ms/node at full detail —
//     so full ("bendy") detail is only affordable on small graphs.

import { browser } from '$app/environment';
import type { ReducedStats } from './gfa';

/** How the full-walk graph load should be offered for a given locus.
 *   • 'auto'    — light enough to load without asking.
 *   • 'manual'  — load on an explicit click; fine once asked for.
 *   • 'risky'   — big enough that parsing all walks risks an OOM. On a
 *                 memory-constrained device this is refused outright; on desktop
 *                 it is still offered, with a caution.
 */
export type WalkLoadTier = 'auto' | 'manual' | 'risky';

class Limits {
	/** Phone-sized UI: small screen or coarse pointer. */
	narrow = $state(false);
	/** navigator.deviceMemory (approx GB), when the browser exposes it. */
	deviceMemoryGb = $state<number | undefined>(undefined);

	constructor() {
		if (!browser) return;
		const mq = window.matchMedia('(max-width: 768px), (pointer: coarse)');
		this.narrow = mq.matches;
		mq.addEventListener('change', (e) => (this.narrow = e.matches));
		// deviceMemory is Chromium-only and coarsely bucketed (0.25–8); absent
		// elsewhere, in which case `narrow` alone stands in for "constrained".
		this.deviceMemoryGb = (navigator as unknown as { deviceMemory?: number }).deviceMemory;
	}

	/** A phone, or any device that reports ≤ 4 GB of RAM. */
	get lowMemory(): boolean {
		return this.narrow || (this.deviceMemoryGb !== undefined && this.deviceMemoryGb <= 4);
	}

	// ---- layout speed -------------------------------------------------------
	// Full-detail ("bendy") layout costs ~5 ms/node, so it's only affordable on
	// small graphs; above this it auto-switches to the ~0.55 ms/node rough mode.
	// Lowered from the old 2,000 (where full detail already took ~7 s) now that
	// the user can force detail back on with the Bendy-nodes switch.
	get roughLayoutNodes(): number {
		return this.narrow ? 700 : 1200;
	}
	// Past this the layout itself runs long enough to warrant a "still working"
	// note while it computes. Rough @12k ≈ 6–8 s; the phone bar is lower.
	get slowLayoutWarnNodes(): number {
		return this.narrow ? 6000 : 12000;
	}
	/** A finished layout slower than this (ms) prompts the live "make it faster"
	 *  tip. Device-independent on purpose: the clock already reflects the device,
	 *  so a slow phone trips it at a smaller graph on its own. */
	readonly slowLayoutMs = 4000;

	// ---- unsimplified "show all nodes" --------------------------------------
	// Rough layout stays interactive up to the tens of thousands, but the phone
	// ceiling is set by memory, not layout time (see lowMemory ceilings below).
	get maxUnsimplifiedNodes(): number {
		return this.narrow ? 8000 : 25000;
	}

	// ---- loading the full-walk graph (haplotypes / disco / walk-hover) ------
	/** Below both of these, walks load automatically (no button to hunt for). */
	get autoLoadMaxNodes(): number {
		return this.narrow ? 2000 : 6000;
	}
	get autoLoadMaxWalkRecords(): number {
		return this.narrow ? 6000 : 20000;
	}
	/** Above this many W-records, parsing every walk risks an OOM tab-kill. The
	 *  phone ceiling is deliberately low — this is the LPA "aw snap" guard. */
	get walkLoadMemoryRiskRecords(): number {
		return this.lowMemory ? 25000 : 250000;
	}

	// ---- hover modes --------------------------------------------------------
	// Bubble/walk hover build an index over the graph. Raised from the old
	// 10,000 (whose own comment noted ~10k traces fine); mainly a phone guard.
	get hoverHeavyNodes(): number {
		return this.narrow ? 8000 : 15000;
	}

	// ---- MSA / base-alignment view ------------------------------------------
	// The base-alignment view holds one string per (row, node block); a window of
	// `maxMsaColumns` bp over `maxMsaRows` rows bounds both that memory and the
	// per-frame cell draw. Phones get a tighter window so the letters stay legible
	// on a small screen and the canvas fill stays cheap.
	get maxMsaColumns(): number {
		return this.narrow ? 3000 : 6000;
	}
	get maxMsaRows(): number {
		return this.narrow ? 150 : 400;
	}
	/** Default half-window (bp each side of the clicked node) for the MSA view. */
	get defaultMsaWindowBp(): number {
		return this.narrow ? 150 : 300;
	}

	/** Classify how the full-walk graph load should be offered for a locus,
	 *  from the reduced graph's own stats (known before anything is fetched). */
	walkLoadTier(reduced: ReducedStats | null | undefined): WalkLoadTier {
		const nodes = reduced?.segmentsBefore ?? 0;
		const records = reduced?.walkRecords ?? reduced?.totalWalks ?? 0;
		if (records > this.walkLoadMemoryRiskRecords || nodes > this.maxUnsimplifiedNodes) return 'risky';
		if (nodes <= this.autoLoadMaxNodes && records <= this.autoLoadMaxWalkRecords) return 'auto';
		return 'manual';
	}
}

export const limits = new Limits();
