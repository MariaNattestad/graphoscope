<script lang="ts">
	// The query report that sits at the top of the graph's options panel. While a
	// query/layout is running it stays expanded and fills in progressively (with the
	// numbers blank until the fresh graph arrives); once the layout settles it
	// collapses to a single line (the three counts you'd quote in a caption), which
	// the user can click to re-expand for the full breakdown. Collapsed is the
	// default on every subsequent render.
	import type { GfaStats, ReducedStats } from '../gfa';
	import { untrack } from 'svelte';

	interface FetchInfo {
		requestCount: number;
		bytesFetched: number;
		dbSize: number;
		elapsedMs: number;
	}

	let {
		locusLabel,
		stats = null,
		reduced = null,
		fetchInfo = null,
		querying = false,
		computing = false,
		layoutMs = 0
	}: {
		locusLabel: string;
		stats?: GfaStats | null;
		reduced?: ReducedStats | null;
		fetchInfo?: FetchInfo | null;
		/** A query round-trip is in flight (fetch + parse). */
		querying?: boolean;
		/** The layout worker is computing (excludes quick in-place recomputes). */
		computing?: boolean;
		layoutMs?: number;
	} = $props();

	// User's manual expand/collapse for the idle state. Reset to collapsed whenever
	// a new query starts (and after it settles) so collapsed is the default render.
	let open = $state(false);
	const busy = $derived(querying || computing);
	const showFull = $derived(busy || open);
	$effect(() => {
		querying;
		untrack(() => (open = false));
	});

	// While a query is fetching, the numbers on hand are stale — blank them until the
	// fresh graph lands (which flips `querying` off and turns on the checks).
	const pending = $derived(querying);
	const resolved = $derived(!querying && stats != null);

	// Live elapsed while busy, for the "…1.2 s" readout next to the progress bar.
	let elapsedMs = $state(0);
	$effect(() => {
		if (!busy) return;
		const t0 = performance.now();
		elapsedMs = 0;
		const id = setInterval(() => (elapsedMs = performance.now() - t0), 100);
		return () => clearInterval(id);
	});

	function fmtBytes(n: number): string {
		if (n < 1024) return `${n} B`;
		if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KiB`;
		if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
		return `${(n / 1024 / 1024 / 1024).toFixed(1)} GiB`;
	}
	const elapsed = $derived(`${(elapsedMs / 1000).toFixed(1)} s`);
	const num = (v: number) => v.toLocaleString();
</script>

<div class="report" class:busy>
	{#if showFull}
		<div class="rep-full">
			<div class="rep-head">
				<span class="rep-name">{locusLabel}</span>
				{#if !busy}
					<button class="rep-collapse" onclick={() => (open = false)} aria-label="Collapse report"
						>▴</button
					>
				{/if}
			</div>

			<div class="rep-grid">
				<span></span>
				<span class="col-h">simplified</span>
				<span class="col-h">raw</span>
				<span></span>

				<span class="rk">fetched</span>
				<span class="rv span2">{pending || !fetchInfo
						? ''
						: `${fmtBytes(fetchInfo.bytesFetched)} · ${fetchInfo.requestCount} blk`}</span>
				<span class="rc" class:on={resolved && fetchInfo}>✓</span>

				<span class="rk">nodes</span>
				<span class="pv">{pending || !stats ? '' : num(stats.segments)}</span>
				<span class="pv raw">{pending || !reduced ? '' : num(reduced.segmentsBefore)}</span>
				<span class="rc" class:on={resolved}>✓</span>

				<span class="rk">links</span>
				<span class="pv">{pending || !stats ? '' : num(stats.links)}</span>
				<span class="pv raw">{pending || !reduced ? '' : num(reduced.linksBefore)}</span>
				<span class="rc" class:on={resolved}>✓</span>

				<span class="rk">haplotype walks</span>
				<span class="rv span2">{pending || !stats ? '' : num(stats.walks)}</span>
				<span class="rc" class:on={resolved}>✓</span>

				<span class="rk">sites collapsed</span>
				<span class="rv span2">{pending || !reduced ? '' : num(reduced.sites)}</span>
				<span class="rc" class:on={resolved && reduced}>✓</span>

				<span class="rk">reference span</span>
				<span class="rv span2"
					>{pending || !stats || stats.referencePathBp == null
						? ''
						: `${num(stats.referencePathBp)} bp`}</span
				>
				<span class="rc" class:on={resolved && stats?.referencePathBp != null}>✓</span>

				{#if open && !busy && stats}
					<span class="grid-sep"></span>
					{#if reduced}
						<span class="rk">chains merged</span>
						<span class="rv span2">{num(reduced.unchopMerges)}</span>
						<span></span>
					{/if}
					<span class="rk">sequence shown</span>
					<span class="rv span2">{num(stats.totalSequenceBp)} bp</span>
					<span></span>
					{#if fetchInfo}
						<span class="rk">fetch time</span>
						<span class="rv span2">{num(fetchInfo.elapsedMs)} ms</span>
						<span></span>
					{/if}
					{#if layoutMs}
						<span class="rk">layout</span>
						<span class="rv span2">{num(layoutMs)} ms</span>
						<span></span>
					{/if}
				{/if}
			</div>

			{#if busy}
				<div class="rep-progress">
					<span class="rep-status">{querying ? 'fetching…' : 'laying out…'}</span>
					<span class="rep-elapsed">{elapsed}</span>
				</div>
				<div class="rep-bar"><div class="rep-bar-fill"></div></div>
			{/if}
		</div>
	{:else}
		<button class="rep-line" onclick={() => (open = true)} title="Show the full query report">
			<span class="rep-name">{locusLabel}</span>
			{#if stats}
				<span class="rep-mini"><b>{num(stats.segments)}</b> n</span>
				<span class="rep-mini"><b>{num(stats.links)}</b> l</span>
				<span class="rep-mini"><b>{num(stats.walks)}</b> w</span>
			{/if}
			<span class="rep-caret" aria-hidden="true">▾</span>
		</button>
	{/if}
</div>

<style>
	.report {
		background: #fff;
		border: 1px solid #e6e8ec;
		border-radius: 8px;
		font-size: 0.78rem;
		color: #333;
	}
	.report.busy {
		border-color: #d1c4f0;
		box-shadow: 0 0 0 1px rgba(124, 58, 237, 0.12);
	}

	/* Collapsed one-liner. */
	.rep-line {
		display: flex;
		align-items: baseline;
		gap: 0.45rem;
		width: 100%;
		font: inherit;
		text-align: left;
		background: none;
		border: none;
		cursor: pointer;
		padding: 0.4rem 0.55rem;
		border-radius: 8px;
		color: inherit;
		white-space: nowrap;
	}
	.rep-line:hover {
		background: #faf5ff;
	}
	.rep-mini {
		color: #6b7280;
		font-variant-numeric: tabular-nums;
	}
	.rep-mini b {
		color: #1f2430;
	}
	.rep-caret {
		margin-left: auto;
		font-size: 0.6rem;
		color: #9aa0aa;
	}

	/* Expanded block. */
	.rep-full {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0.55rem 0.6rem;
	}
	.rep-head {
		display: flex;
		align-items: baseline;
		gap: 0.45rem;
	}
	.rep-name {
		font-weight: 700;
		font-size: 0.9rem;
		letter-spacing: -0.01em;
		color: #1f2430;
	}
	.rep-collapse {
		margin-left: auto;
		background: none;
		border: none;
		color: #9aa0aa;
		cursor: pointer;
		font-size: 0.8rem;
		line-height: 1;
		padding: 0 0.15rem;
	}
	.rep-collapse:hover {
		color: #1f2430;
	}

	/* Rows: one grid so the simplified/raw columns line up across every row. */
	.rep-grid {
		display: grid;
		grid-template-columns: 1fr auto auto 0.85rem;
		column-gap: 0.5rem;
		row-gap: 0.24rem;
		align-items: baseline;
		font-variant-numeric: tabular-nums;
	}
	.col-h {
		font-size: 0.58rem;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		color: #b0b6c0;
		text-align: right;
	}
	.rk {
		color: #6b7280;
		white-space: nowrap;
	}
	.rv {
		text-align: right;
		color: #1f2430;
		white-space: nowrap;
	}
	.span2 {
		grid-column: 2 / 4;
	}
	.pv {
		text-align: right;
		white-space: nowrap;
		font-weight: 700;
		color: #1f2430;
	}
	.pv.raw {
		font-weight: 400;
		color: #a7adb8;
	}
	.rc {
		text-align: center;
		color: transparent;
		font-size: 0.72rem;
	}
	.rc.on {
		color: #16a34a;
	}
	.grid-sep {
		grid-column: 1 / -1;
		border-top: 1px solid #f2f2f5;
		margin: 0.1rem 0;
	}

	/* Progress. */
	.rep-progress {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		font-size: 0.74rem;
		color: #7c3aed;
	}
	.rep-elapsed {
		color: #9aa0aa;
		font-variant-numeric: tabular-nums;
	}
	.rep-bar {
		height: 4px;
		border-radius: 999px;
		background: #eee6fb;
		overflow: hidden;
	}
	.rep-bar-fill {
		height: 100%;
		width: 40%;
		border-radius: 999px;
		background: linear-gradient(90deg, #7c3aed, #db2777);
		animation: rep-slide 1.1s ease-in-out infinite;
	}
	@keyframes rep-slide {
		0% {
			transform: translateX(-100%);
		}
		100% {
			transform: translateX(350%);
		}
	}
</style>
