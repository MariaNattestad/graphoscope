<script lang="ts">
	// The MSA base-alignment panel: a header of controls + a base-level canvas of
	// the reference plus every haplotype through the selected node, aligned across a
	// window centred on it. Owns the window-size control and derives the alignment;
	// MsaCanvas does the drawing. Drop it under the graph and feed it the selected
	// node — it re-derives whenever the selection or graph changes.
	import type { Gfa } from '../gfa';
	import { buildAlignment } from './msa';
	import { limits } from '../limits.svelte';
	import { baseThemeDark, baseThemeLight } from './colors';
	import MsaCanvas from './MsaCanvas.svelte';

	let {
		gfa,
		referenceSample,
		selectedSegId,
		lightMode = false,
		onClose
	}: {
		gfa: Gfa;
		referenceSample?: string;
		selectedSegId: string | null;
		lightMode?: boolean;
		onClose?: () => void;
	} = $props();

	const WINDOW_PRESETS = [60, 150, 300, 700, 1500, 4000];
	let windowBp = $state(limits.defaultMsaWindowBp);
	// Dim shared backbone sequence so variant columns pop (on by default).
	let emphasizeVariants = $state(true);

	const alignment = $derived(
		selectedSegId
			? buildAlignment(gfa, {
					referenceSample,
					selectedSegId,
					windowBp,
					maxColumns: limits.maxMsaColumns,
					maxRows: limits.maxMsaRows
				})
			: null
	);

	const theme = $derived(lightMode ? baseThemeLight : baseThemeDark);

	// Whether this graph carries individual haplotypes at all. A reduced graph
	// aggregates non-reference walks into coverage counts, so only the reference
	// remains — worth saying, rather than showing a lone reference row unexplained.
	const isReduced = $derived(gfa.reduced !== undefined);
	const pathRows = $derived(alignment ? alignment.rows.filter((r) => !r.isReference).length : 0);
	const totalHaplotypes = $derived(
		alignment ? alignment.rows.reduce((s, r) => s + (r.isReference ? 0 : r.multiplicity), 0) : 0
	);
</script>

<section class="msa-panel" class:light={lightMode}>
	<header class="msa-head">
		<div class="title">
			<span class="badge">MSA</span>
			{#if selectedSegId && alignment && !alignment.note}
				<span class="node">
					node <b>{alignment.selectedSegId}</b>
					<span class="dim">
						{alignment.selectedOnBackbone ? 'on reference' : 'alt allele'}
						{#if alignment.window && alignment.contig}
							· {alignment.contig}:{Math.round(alignment.window.start).toLocaleString()}–{Math.round(
								alignment.window.end
							).toLocaleString()}
						{/if}
					</span>
				</span>
			{:else}
				<span class="dim">click a node in the graph to align its sequences</span>
			{/if}
		</div>

		<div class="controls">
			{#if selectedSegId && alignment && !alignment.note}
				<label class="win">
					window
					<select bind:value={windowBp}>
						{#each WINDOW_PRESETS as w (w)}
							<option value={w}>±{w.toLocaleString()} bp</option>
						{/each}
					</select>
				</label>
				<span class="count">
					{totalHaplotypes} path{totalHaplotypes === 1 ? '' : 's'}
					{#if pathRows !== totalHaplotypes}<span class="dim">({pathRows} distinct)</span>{/if}
				</span>
				<label class="hv" title="Dim sequence shared with the reference so the variant columns stand out">
					<input type="checkbox" bind:checked={emphasizeVariants} /> highlight variants
				</label>
			{/if}
			<div class="legend" aria-hidden="true">
				{#each ['A', 'C', 'G', 'T'] as b (b)}
					<span class="sw" style="background:{theme[b as 'A' | 'C' | 'G' | 'T']}">{b}</span>
				{/each}
			</div>
			{#if onClose}
				<button class="close" title="Close MSA view" onclick={onClose}>✕</button>
			{/if}
		</div>
	</header>

	{#if alignment && !alignment.note}
		{#if alignment.truncatedWindow || alignment.truncatedRows > 0 || !alignment.hasSequence || (isReduced && pathRows === 0)}
			<div class="notes">
				{#if isReduced && pathRows === 0}
					<span class="warn">Simplified graph — individual haplotypes were aggregated into coverage counts. Switch on the full/unsimplified graph to align them here.</span>
				{/if}
				{#if !alignment.hasSequence}
					<span class="warn">This graph carries node lengths but not sequences — showing blocks without bases.</span>
				{/if}
				{#if alignment.truncatedWindow}
					<span>Window clamped to {limits.maxMsaColumns.toLocaleString()} columns; narrow the window for full detail.</span>
				{/if}
				{#if alignment.truncatedRows > 0}
					<span>{alignment.truncatedRows} more distinct path{alignment.truncatedRows === 1 ? '' : 's'} not shown.</span>
				{/if}
			</div>
		{/if}
	{/if}

	<div class="canvas-host">
		{#if !selectedSegId}
			<div class="placeholder">
				<p>Select a node to open its base alignment.</p>
			</div>
		{:else if alignment?.note}
			<div class="placeholder">
				<p>{alignment.note}</p>
				{#if isReduced}
					<p class="dim">
						This is the simplified graph — individual haplotypes were aggregated into coverage. Load the
						full haplotypes (haplotype panel) to align them here.
					</p>
				{/if}
			</div>
		{:else if alignment}
			<MsaCanvas {alignment} {lightMode} {emphasizeVariants} />
		{/if}
	</div>
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
	.win {
		font-size: 0.78rem;
		display: flex;
		align-items: center;
		gap: 0.35rem;
		opacity: 0.85;
	}
	.win select {
		font: inherit;
		font-size: 0.78rem;
		padding: 2px 4px;
		border-radius: 5px;
		border: 1px solid rgba(140, 155, 180, 0.35);
		background: transparent;
		color: inherit;
	}
	.win select option {
		color: #111;
	}
	.count {
		font-size: 0.78rem;
		opacity: 0.9;
	}
	.hv {
		font-size: 0.78rem;
		display: flex;
		align-items: center;
		gap: 0.3rem;
		opacity: 0.85;
		cursor: pointer;
		user-select: none;
	}
	.legend {
		display: flex;
		gap: 3px;
	}
	.sw {
		width: 18px;
		height: 18px;
		border-radius: 4px;
		display: grid;
		place-items: center;
		font-size: 0.68rem;
		font-weight: 700;
		color: #fff;
		font-family: ui-monospace, monospace;
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
</style>
