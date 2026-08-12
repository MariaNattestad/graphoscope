<script lang="ts">
	// A structure & depth report for a reference-less GFA (assembly graph, rGFA, or
	// any bare S/L graph) — the numbers Bandage-style tools lead with and the locus
	// browser never needed. Lives entirely on the /gfa route so none of this reaches
	// the hosted locus viewer. Collapsed to a one-line summary by default; expands to
	// the full breakdown plus a segment lookup.
	import type { Gfa } from '$lib/gfa';
	import type { AssemblyStats } from '$lib/graph/assemblyStats';

	let { assembly, gfa }: { assembly: AssemblyStats; gfa: Gfa } = $props();

	let open = $state(false);
	let query = $state('');

	// Neighbour index (undirected), built once per graph — powers the segment lookup.
	const neighbors = $derived.by(() => {
		const m = new Map<string, Set<string>>();
		for (const l of gfa.links) {
			if (l.from === l.to) continue;
			(m.get(l.from) ?? m.set(l.from, new Set()).get(l.from)!).add(l.to);
			(m.get(l.to) ?? m.set(l.to, new Set()).get(l.to)!).add(l.from);
		}
		return m;
	});

	// The looked-up segment (exact id match), with the fields worth showing.
	const found = $derived.by(() => {
		const id = query.trim();
		if (!id) return null;
		const seg = gfa.segments.get(id);
		if (!seg) return { id, missing: true as const };
		return {
			id,
			missing: false as const,
			length: seg.length,
			depth: seg.depth,
			depthUnit: seg.depthUnit,
			rank: seg.rank,
			stableName: seg.stableName,
			stableOffset: seg.stableOffset,
			neighbors: [...(neighbors.get(id) ?? [])]
		};
	});

	function bp(n: number): string {
		if (n >= 1e6) return `${(n / 1e6).toFixed(2)} Mb`;
		if (n >= 1e3) return `${(n / 1e3).toFixed(1)} kb`;
		return `${n} bp`;
	}
	const num = (n: number) => n.toLocaleString();
	function depthStr(v: number, unit: 'x' | 'reads'): string {
		return unit === 'x' ? `${v.toFixed(1)}×` : `${num(Math.round(v))} reads`;
	}
	const pct = (f: number) => `${Math.round(f * 100)}%`;
</script>

<div class="report" class:open>
	<button class="summary" onclick={() => (open = !open)} aria-expanded={open}>
		<span class="tag">Graph report</span>
		<span class="chips">
			<span class="chip"><b>{num(assembly.components)}</b> {assembly.components === 1 ? 'component' : 'components'}</span>
			<span class="chip">N50 <b>{bp(assembly.n50)}</b></span>
			<span class="chip"><b>{num(assembly.deadEnds)}</b> dead ends</span>
			{#if assembly.isolated > 0}
				<span class="chip"><b>{num(assembly.isolated)}</b> isolated</span>
			{/if}
			{#if assembly.selfLoops > 0}
				<span class="chip"><b>{num(assembly.selfLoops)}</b> self-loops</span>
			{/if}
			{#if assembly.depth}
				<span class="chip">depth <b>{depthStr(assembly.depth.median, assembly.depth.unit)}</b> median</span>
			{/if}
		</span>
		<span class="caret" aria-hidden="true">{open ? '▴' : '▾'}</span>
	</button>

	{#if open}
		<div class="detail">
			<div class="grid">
				<div class="cell"><span class="k">segments</span><span class="v">{num(assembly.segments)}</span></div>
				<div class="cell"><span class="k">links</span><span class="v">{num(assembly.links)}</span></div>
				<div class="cell"><span class="k">total sequence</span><span class="v">{bp(assembly.totalBp)}</span></div>
				<div class="cell"><span class="k">contig N50</span><span class="v">{bp(assembly.n50)}</span></div>
				<div class="cell"><span class="k">components</span><span class="v">{num(assembly.components)}</span></div>
				<div class="cell"><span class="k">largest component</span><span class="v">{pct(assembly.largestComponentFraction)}</span></div>
				<div class="cell"><span class="k">dead ends (tips)</span><span class="v">{num(assembly.deadEnds)}</span></div>
				<div class="cell"><span class="k">isolated nodes</span><span class="v">{num(assembly.isolated)}</span></div>
				<div class="cell"><span class="k">self-loops</span><span class="v">{num(assembly.selfLoops)}</span></div>
				{#if assembly.depth}
					<div class="cell wide">
						<span class="k">depth (min · median · max)</span>
						<span class="v"
							>{depthStr(assembly.depth.min, assembly.depth.unit)} ·
							{depthStr(assembly.depth.median, assembly.depth.unit)} ·
							{depthStr(assembly.depth.max, assembly.depth.unit)}</span
						>
					</div>
					<div class="cell"><span class="k">nodes with depth</span><span class="v">{num(assembly.depth.covered)} / {num(assembly.segments)}</span></div>
				{/if}
			</div>

			<div class="lookup">
				<label class="lookup-label" for="seg-lookup">find a segment</label>
				<input id="seg-lookup" bind:value={query} placeholder="segment id…" spellcheck="false" />
				{#if found}
					{#if found.missing}
						<span class="lk-miss">no segment <code>{found.id}</code></span>
					{:else}
						<div class="lk-hit">
							<span class="lk-id">{found.id}</span>
							<span class="lk-field">{bp(found.length)}</span>
							{#if found.depth !== undefined && found.depthUnit}
								<span class="lk-field">depth {depthStr(found.depth, found.depthUnit)}</span>
							{/if}
							{#if found.rank !== undefined}
								<span class="lk-field">rank {found.rank}</span>
							{/if}
							{#if found.stableName !== undefined}
								<span class="lk-field"
									>{found.stableName}{found.stableOffset !== undefined
										? `:${num(found.stableOffset)}`
										: ''}</span
								>
							{/if}
							<span class="lk-field"
								>{found.neighbors.length}
								{found.neighbors.length === 1 ? 'neighbor' : 'neighbors'}{found.neighbors.length
									? `: ${found.neighbors.slice(0, 8).join(', ')}${found.neighbors.length > 8 ? '…' : ''}`
									: ''}</span
							>
						</div>
					{/if}
				{/if}
			</div>
		</div>
	{/if}
</div>

<style>
	.report {
		flex: 0 0 auto;
		border-bottom: 1px solid #e3e7ee;
		background: #fbfcfe;
	}
	.summary {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		width: 100%;
		border: none;
		background: none;
		cursor: pointer;
		font: inherit;
		text-align: left;
		padding: 0.4rem 0.8rem;
		color: #1f2430;
	}
	.summary:hover {
		background: #f4f6fb;
	}
	.tag {
		font-size: 0.7rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: #6d28d9;
		flex: 0 0 auto;
	}
	.chips {
		display: flex;
		gap: 0.5rem 0.9rem;
		flex-wrap: wrap;
		flex: 1 1 auto;
		font-size: 0.78rem;
		color: #6b7280;
	}
	.chip b {
		color: #1f2430;
		font-weight: 700;
	}
	.caret {
		flex: 0 0 auto;
		color: #9aa0aa;
		font-size: 0.8rem;
	}

	.detail {
		padding: 0.2rem 0.8rem 0.7rem;
		display: flex;
		flex-direction: column;
		gap: 0.7rem;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr));
		gap: 0.2rem 1.2rem;
	}
	.cell {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.5rem;
		font-size: 0.8rem;
		border-bottom: 1px dotted #e6e9f0;
		padding: 0.15rem 0;
		min-width: 0;
	}
	/* A long value (the depth triple) gets its own full-width row so it never
	   collides with the next column. */
	.cell.wide {
		grid-column: 1 / -1;
	}
	.k {
		color: #6b7280;
	}
	.v {
		color: #1f2430;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.lookup {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
	}
	.lookup-label {
		font-size: 0.72rem;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		color: #9aa0aa;
	}
	.lookup input {
		font: inherit;
		font-size: 0.8rem;
		padding: 0.25rem 0.5rem;
		border: 1px solid #d3d9e2;
		border-radius: 6px;
		background: #fff;
		width: 12rem;
	}
	.lk-miss {
		font-size: 0.78rem;
		color: #b45309;
	}
	.lk-hit {
		display: flex;
		gap: 0.4rem 0.7rem;
		flex-wrap: wrap;
		align-items: baseline;
		font-size: 0.78rem;
		color: #6b7280;
	}
	.lk-id {
		font-weight: 700;
		color: #1f2430;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
	}
	.lk-field {
		font-variant-numeric: tabular-nums;
	}
	code {
		background: #eef1f5;
		padding: 0 4px;
		border-radius: 4px;
	}
</style>
