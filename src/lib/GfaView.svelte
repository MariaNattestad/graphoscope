<script lang="ts">
	// Deliberately minimal placeholder visualization — meant to be replaced.
	// Lays out the reference path's nodes left-to-right and colors each by how
	// many haplotypes traverse it (a simple conservation / copy-number cue).
	import type { Gfa } from './gfa';

	let { gfa, referenceSample }: { gfa: Gfa; referenceSample: string } = $props();

	interface Cell {
		id: string;
		length: number;
		coverage: number;
	}

	const view = $derived.by(() => {
		const coverage = new Map<string, number>();
		for (const w of gfa.walks) {
			for (const step of w.steps) coverage.set(step.id, (coverage.get(step.id) ?? 0) + 1);
		}
		const ref = gfa.walks.find((w) => w.sample === referenceSample) ?? gfa.walks[0];
		const cells: Cell[] = (ref?.steps ?? []).map((s) => ({
			id: s.id,
			length: gfa.segments.get(s.id)?.length ?? 1,
			coverage: coverage.get(s.id) ?? 0
		}));
		const maxCov = Math.max(1, ...cells.map((c) => c.coverage));
		return { cells, maxCov, refName: ref ? `${ref.sample}#${ref.hapIndex}#${ref.seqId}` : '(none)' };
	});

	const CELL_W = 10;
	const CELL_H = 46;
	const GAP = 1;

	function color(coverage: number, maxCov: number): string {
		const t = coverage / maxCov;
		const hue = 210 * t + 20 * (1 - t);
		const light = 75 - 35 * t;
		return `hsl(${hue.toFixed(0)} 70% ${light.toFixed(0)}%)`;
	}

	let hovered = $state<Cell | null>(null);
</script>

<div class="viz">
	<div class="viz-head">
		<span>Reference path: <code>{view.refName}</code></span>
		<span class="muted">{view.cells.length} nodes along reference · color = # haplotypes through node</span>
	</div>

	<div class="track" role="list">
		<svg
			width={view.cells.length * (CELL_W + GAP)}
			height={CELL_H}
			role="presentation"
		>
			{#each view.cells as cell, i (i)}
				<rect
					x={i * (CELL_W + GAP)}
					y={0}
					width={CELL_W}
					height={CELL_H}
					fill={color(cell.coverage, view.maxCov)}
					onmouseenter={() => (hovered = cell)}
					onmouseleave={() => (hovered = null)}
					role="listitem"
				/>
			{/each}
		</svg>
	</div>

	<div class="legend">
		<span class="muted">variable</span>
		<span class="swatch" style="background:{color(0, view.maxCov)}"></span>
		<span class="swatch" style="background:{color(view.maxCov / 2, view.maxCov)}"></span>
		<span class="swatch" style="background:{color(view.maxCov, view.maxCov)}"></span>
		<span class="muted">conserved (up to {view.maxCov} haplotypes)</span>
	</div>

	<div class="hover">
		{#if hovered}
			node <code>{hovered.id}</code> · {hovered.length} bp · {hovered.coverage} haplotypes
		{:else}
			<span class="muted">hover a node…</span>
		{/if}
	</div>
</div>

<style>
	.viz {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}
	.viz-head {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		flex-wrap: wrap;
		font-size: 0.85rem;
	}
	.track {
		overflow-x: auto;
		border: 1px solid #e2e2e2;
		border-radius: 6px;
		background: #fafafa;
		padding: 8px;
	}
	.track svg rect {
		cursor: pointer;
	}
	.track svg rect:hover {
		stroke: #111;
		stroke-width: 1.5;
	}
	.legend {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 0.8rem;
	}
	.swatch {
		width: 22px;
		height: 14px;
		border-radius: 3px;
		display: inline-block;
	}
	.hover {
		font-size: 0.85rem;
		min-height: 1.2em;
	}
	.muted {
		color: #888;
	}
	code {
		background: #f0f0f0;
		padding: 0 4px;
		border-radius: 4px;
	}
</style>
