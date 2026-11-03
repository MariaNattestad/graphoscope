<script lang="ts">
	// The MSA view panel: a header of controls + a base-level canvas of the
	// reference plus every haplotype crossing a window of the reference, laid out
	// base by base along the graph's nodes (msa.ts builds the grid; nothing is
	// aligned). The window is either fixed (`region`: the stretch of reference the
	// graph was zoomed in on) or centred on the selected node. It always reads the
	// full, walk-bearing graph (`gfa`), whatever the graph view is showing; MsaCanvas
	// does the drawing.
	import type { Gfa } from '../gfa';
	import type { ColorMode } from './colors';
	import { buildMsaGrid } from './msa';
	import { limits } from '../limits.svelte';
	import MsaCanvas from './MsaCanvas.svelte';

	let {
		gfa,
		referenceSample,
		selectedSegId,
		region = null,
		lightMode = false,
		colorForSeg,
		colorMode,
		rowHighlights = null,
		loadingFullGraph = false,
		fullGraphBlocked = false,
		onClose,
		onNames,
		onNodeFlash,
		onWalkSpotlight
	}: {
		/** The full graph (every haplotype walk), or null while it loads. */
		gfa: Gfa | null;
		referenceSample?: string;
		/** Node to highlight (an id in `gfa`), or null. */
		selectedSegId: string | null;
		/** Reference window to show; null → a window centred on `selectedSegId`. */
		region?: { start: number; end: number } | null;
		lightMode?: boolean;
		/** The graph view's fill colour for a displayed segment id, so the MSA's
		 * per-node colour track matches the graph exactly. Omitted → no track. */
		colorForSeg?: (segId: string) => string;
		/** The graph's active "color by" mode — passed through purely so the canvas
		 * redraws the colour track when the user switches modes. */
		colorMode?: ColorMode;
		/** Walk key → highlight colour for walks currently spotlit in the graph, so the
		 * matching grid rows echo that colour on their label. */
		rowHighlights?: Map<string, string> | null;
		/** The full (walk-bearing) graph is loading — show a loading state. */
		loadingFullGraph?: boolean;
		/** The full graph is too heavy to load on this device, so the grid can't be
		 * built here — show the protected-device note instead of offering to switch. */
		fullGraphBlocked?: boolean;
		onClose?: () => void;
		/** Reports the window's segId → short-name map (R1/A1/…) so the graph can
		 * label the same nodes, or null when simplified names are off. */
		onNames?: (map: Map<string, string> | null) => void;
		/** A node was clicked in the grid; flash it in the graph. */
		onNodeFlash?: (segId: string) => void;
		/** A walk row was clicked; its walk key — spotlight it (disco-style) in the graph. */
		onWalkSpotlight?: (walkKey: string) => void;
	} = $props();

	// The grid always covers a generous window (up to the column cap) so the
	// user can zoom out to reveal context; the canvas opens focused on the clicked
	// node (see MsaCanvas.fit), so there is no window-size control to set.
	// Dim shared backbone sequence so variant columns pop (on by default).
	let emphasizeVariants = $state(true);
	// Rename nodes to short local R1/A1 names within the window (on by default).
	let simplifiedNames = $state(true);
	// The settings gear popover.
	let settingsOpen = $state(false);
	let gearWrap = $state<HTMLElement>();
	// Close the popover on a click outside it.
	$effect(() => {
		if (!settingsOpen) return;
		const onDoc = (e: PointerEvent) => {
			if (gearWrap && !gearWrap.contains(e.target as Node)) settingsOpen = false;
		};
		window.addEventListener('pointerdown', onDoc);
		return () => window.removeEventListener('pointerdown', onDoc);
	});

	// Whether we have a graph that carries individual haplotypes. A reduced graph
	// aggregates non-reference walks into coverage counts, so it has no rows to show;
	// the parent loads the full graph and hands it in.
	const isReduced = $derived(!gfa || gfa.reduced !== undefined);
	const hasTarget = $derived(!!region || !!selectedSegId);

	const grid = $derived(
		gfa && hasTarget && !isReduced
			? buildMsaGrid(gfa, {
					referenceSample,
					selectedSegId,
					window: region ?? undefined,
					windowBp: limits.maxMsaColumns,
					maxColumns: limits.maxMsaColumns,
					maxRows: limits.maxMsaRows
				})
			: null
	);

	// Publish (or clear) the short-name map for the graph to mirror.
	$effect(() => {
		onNames?.(simplifiedNames && grid && !grid.note ? grid.nameBySeg : null);
	});
	$effect(() => {
		// Clear the graph labels when the panel unmounts.
		return () => onNames?.(null);
	});

	const pathRows = $derived(grid ? grid.rows.filter((r) => !r.isReference).length : 0);
	const totalHaplotypes = $derived(
		grid ? grid.rows.reduce((s, r) => s + (r.isReference ? 0 : r.multiplicity), 0) : 0
	);
</script>

<section class="msa-panel" class:light={lightMode}>
	<header class="msa-head">
		<div class="title">
			<span class="badge">MSA</span>
			{#if region && grid && !grid.note}
				<span class="node">
					{#if grid.contig}{grid.contig}:{/if}{Math.round(region.start).toLocaleString()}–{Math.round(
						region.end
					).toLocaleString()}
					<span class="dim">· {Math.round(region.end - region.start).toLocaleString()} bp in view</span>
				</span>
			{:else if grid?.selectedSegId && !grid.note}
				<span class="node">
					node <b>{simplifiedNames
						? (grid.nameBySeg.get(grid.selectedSegId) ?? grid.selectedSegId)
						: grid.selectedSegId}</b>
					<span class="dim">
						{#if simplifiedNames && grid.nameBySeg.has(grid.selectedSegId)}· {grid.selectedSegId} · {:else}·{' '}{/if}{grid.selectedOnBackbone ? 'on reference' : 'alt allele'}
						{#if grid.window && grid.contig}
							· {grid.contig}:{Math.round(grid.window.start).toLocaleString()}–{Math.round(
								grid.window.end
							).toLocaleString()}
						{/if}
					</span>
				</span>
			{:else if hasTarget && isReduced}
				<span class="dim">
					{#if fullGraphBlocked}full graph unavailable on this device{:else if loadingFullGraph}loading the full graph…{:else}needs the full graph{/if}
				</span>
			{:else}
				<span class="dim">MSA view: the sequences of the graph above, laid out base by base along its nodes.</span>
			{/if}
		</div>

		<div class="controls">
			{#if grid && !grid.note}
				<div class="gear-wrap" bind:this={gearWrap}>
					<button
						class="gear"
						class:active={settingsOpen}
						title="MSA settings"
						aria-label="MSA settings"
						aria-expanded={settingsOpen}
						onclick={() => (settingsOpen = !settingsOpen)}
					>⚙</button>
					{#if settingsOpen}
						<div class="settings-pop">
							<div class="settings-title">MSA settings</div>
							<label class="set-row">
								<input type="checkbox" bind:checked={simplifiedNames} />
								<span>
									Short node IDs
									<span class="set-sub">R1, R2… along the reference; A1, A2… for alt nodes. Also labels these nodes in the graph.</span>
								</span>
							</label>
							<label class="set-row">
								<input type="checkbox" bind:checked={emphasizeVariants} />
								<span>Hide non-variant bases</span>
							</label>
						</div>
					{/if}
				</div>
			{/if}
			{#if onClose}
				<button class="close" title="Close MSA view" onclick={onClose}>✕</button>
			{/if}
		</div>
	</header>

	{#if grid && !grid.note && !isReduced}
		{#if grid.truncatedWindow || grid.truncatedRows > 0 || !grid.hasSequence}
			<div class="notes">
				{#if !grid.hasSequence}
					<span class="warn">This graph carries node lengths but not sequences — showing blocks without bases.</span>
				{/if}
				{#if grid.truncatedWindow}
					<span
						>{region
							? `Clipped to ${limits.maxMsaColumns.toLocaleString()} bp of reference.`
							: `${limits.maxMsaColumns.toLocaleString()} bp of context loaded around this node (zoom out to see it).`}</span
					>
				{/if}
				{#if grid.truncatedRows > 0}
					<span>{grid.truncatedRows} more distinct path{grid.truncatedRows === 1 ? '' : 's'} not shown.</span>
				{/if}
			</div>
		{/if}
	{/if}

	<div class="canvas-host">
		{#if !hasTarget}
			<div class="placeholder">
				<p>Select a node in the graph above to show the sequences around it.</p>
			</div>
		{:else if isReduced}
			<!-- The base-level view needs the full graph's per-haplotype walks. The panel
			     opens the full graph automatically; while that loads (or if this device
			     can't hold it) we say so here rather than showing a bare reference row. -->
			{#if fullGraphBlocked}
				<div class="placeholder">
					<p>This locus's full graph is too large to load on this device, so the base-level view can't be shown here.</p>
					<p class="dim">Open this locus on a desktop to see its haplotypes.</p>
				</div>
			{:else if loadingFullGraph}
				<div class="placeholder">
					<span class="msa-spinner"></span>
					<p>Loading the full graph to show its sequences…</p>
				</div>
			{:else}
				<div class="placeholder">
					<p>Couldn't load the full graph to show it here.</p>
					<p class="dim">Close this panel and show the MSA again to retry.</p>
				</div>
			{/if}
		{:else if grid?.note}
			<div class="placeholder">
				<p>{grid.note}</p>
			</div>
		{:else if grid}
			<MsaCanvas
				{grid}
				{lightMode}
				{emphasizeVariants}
				{simplifiedNames}
				{colorForSeg}
				{colorMode}
				{rowHighlights}
				onNodeClick={(segId) => onNodeFlash?.(segId)}
				onWalkClick={(key) => onWalkSpotlight?.(key)}
			/>
		{/if}
	</div>

	{#if grid && !grid.note}
		<footer class="msa-foot">
			<span class="count">
				{totalHaplotypes} walk{totalHaplotypes === 1 ? '' : 's'}
				{#if pathRows !== totalHaplotypes}<span class="dim">({pathRows} distinct)</span>{/if}
			</span>
		</footer>
	{/if}
</section>

<style>
	.msa-panel {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		background: #0b0d12;
		color: #e6ebf5;
		font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
	}
	.msa-panel.light {
		background: #ffffff;
		color: #1e293b;
	}
	.msa-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.5rem 0.75rem;
		border-bottom: 1px solid rgba(140, 155, 180, 0.18);
		flex-wrap: wrap;
	}
	.title {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.85rem;
		min-width: 0;
	}
	.badge {
		background: rgba(103, 232, 249, 0.16);
		color: #67e8f9;
		font-weight: 700;
		font-size: 0.68rem;
		letter-spacing: 0.06em;
		padding: 2px 7px;
		border-radius: 5px;
	}
	.light .badge {
		background: rgba(8, 145, 178, 0.14);
		color: #0891b2;
	}
	.node b {
		font-family: ui-monospace, monospace;
	}
	.dim {
		opacity: 0.6;
		font-size: 0.78rem;
	}
	.controls {
		display: flex;
		align-items: center;
		gap: 0.9rem;
		flex-wrap: wrap;
	}
	.count {
		font-size: 0.78rem;
		opacity: 0.9;
	}
	/* Pinned footer: stays put at the bottom of the panel while the grid rows
	   scroll inside the canvas above it. */
	.msa-foot {
		flex: none;
		display: flex;
		align-items: center;
		padding: 0.3rem 0.75rem;
		border-top: 1px solid rgba(140, 155, 180, 0.18);
	}
	.gear-wrap {
		position: relative;
	}
	.gear {
		background: transparent;
		border: 1px solid rgba(140, 155, 180, 0.3);
		color: inherit;
		width: 26px;
		height: 26px;
		border-radius: 6px;
		cursor: pointer;
		font-size: 0.85rem;
		line-height: 1;
	}
	.gear:hover,
	.gear.active {
		background: rgba(140, 155, 180, 0.15);
	}
	.settings-pop {
		position: absolute;
		top: calc(100% + 6px);
		right: 0;
		z-index: 20;
		width: 260px;
		background: #12151c;
		color: #e6ebf5;
		border: 1px solid rgba(140, 155, 180, 0.28);
		border-radius: 9px;
		padding: 0.7rem 0.8rem;
		box-shadow: 0 8px 26px rgba(0, 0, 0, 0.4);
	}
	.light .settings-pop {
		background: #ffffff;
		color: #1e293b;
		border-color: rgba(100, 116, 139, 0.3);
	}
	.settings-title {
		font-size: 0.72rem;
		font-weight: 700;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		opacity: 0.6;
		margin-bottom: 0.6rem;
	}
	.set-row {
		display: flex;
		gap: 0.5rem;
		align-items: flex-start;
		font-size: 0.82rem;
		padding: 0.3rem 0;
		cursor: pointer;
	}
	.set-row input {
		margin-top: 2px;
	}
	.set-sub {
		display: block;
		font-size: 0.72rem;
		opacity: 0.6;
		margin-top: 2px;
	}
	.close {
		background: transparent;
		border: 1px solid rgba(140, 155, 180, 0.3);
		color: inherit;
		width: 26px;
		height: 26px;
		border-radius: 6px;
		cursor: pointer;
		font-size: 0.8rem;
	}
	.close:hover {
		background: rgba(140, 155, 180, 0.15);
	}
	.notes {
		display: flex;
		gap: 1rem;
		flex-wrap: wrap;
		padding: 0.35rem 0.75rem;
		font-size: 0.74rem;
		opacity: 0.85;
		border-bottom: 1px solid rgba(140, 155, 180, 0.12);
	}
	.notes .warn {
		color: #fbbf24;
	}
	.canvas-host {
		position: relative;
		flex: 1;
		min-height: 0;
	}
	.placeholder {
		height: 100%;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.4rem;
		text-align: center;
		padding: 1rem;
		opacity: 0.75;
		font-size: 0.85rem;
	}
	.placeholder p {
		margin: 0;
		max-width: 42ch;
	}
	.msa-spinner {
		width: 22px;
		height: 22px;
		border-radius: 50%;
		border: 2px solid rgba(140, 155, 180, 0.3);
		border-top-color: #67e8f9;
		animation: msa-spin 0.8s linear infinite;
	}
	.light .msa-spinner {
		border-top-color: #0891b2;
	}
	@keyframes msa-spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
