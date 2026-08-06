<script lang="ts">
	// The query report that sits at the top of the graph's options panel. While a
	// query/layout is running it stays expanded and fills in progressively; once
	// the layout settles it collapses to a single line (the four numbers you'd
	// quote in a caption), which the user can click to re-expand for the full
	// breakdown. Collapsed is the default on every subsequent render.
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
	// During the fetch phase we don't yet have fresh numbers; once the graph is in
	// hand (layout phase or idle) the stat rows carry a check.
	const resolved = $derived(!querying && stats != null);
</script>

<div class="report" class:busy>
	{#if showFull}
		<div class="rep-full">
			<div class="rep-head">
				<span class="rep-name">{locusLabel}</span>
				{#if stats?.referencePathBp != null}
					<span class="rep-span">{stats.referencePathBp.toLocaleString()} bp</span>
				{/if}
				{#if !busy}
					<button class="rep-collapse" onclick={() => (open = false)} aria-label="Collapse report"
						>▴</button
					>
				{/if}
			</div>

			<div class="rep-rows">
				{#if fetchInfo}
					<div class="rep-row">
						<span class="rk">fetched</span>
						<span class="rv">{fmtBytes(fetchInfo.bytesFetched)} · {fetchInfo.requestCount} blk</span>
						<span class="rc" class:on={resolved}>✓</span>
					</div>
				{/if}
				{#if stats}
					<div class="rep-row">
						<span class="rk">nodes</span>
						<span class="rv"
							><b>{stats.segments.toLocaleString()}</b>{#if reduced}
								<em>of {reduced.segmentsBefore.toLocaleString()}</em>{/if}</span
						>
						<span class="rc" class:on={resolved}>✓</span>
					</div>
					<div class="rep-row">
						<span class="rk">links</span>
						<span class="rv"
							><b>{stats.links.toLocaleString()}</b>{#if reduced}
								<em>of {reduced.linksBefore.toLocaleString()}</em>{/if}</span
						>
						<span class="rc" class:on={resolved}>✓</span>
					</div>
					<div class="rep-row">
						<span class="rk">haplotype walks</span>
						<span class="rv"><b>{stats.walks.toLocaleString()}</b></span>
						<span class="rc" class:on={resolved}>✓</span>
					</div>
					{#if reduced}
						<div class="rep-row">
							<span class="rk">sites collapsed</span>
							<span class="rv"><b>{reduced.sites.toLocaleString()}</b></span>
							<span class="rc" class:on={resolved}>✓</span>
						</div>
					{/if}

					<!-- The finer detail, only when the user has clicked to expand (not during
					     the run itself, which shows the resolving set above). -->
					{#if open && !busy}
						{#if reduced}
							<div class="rep-row detail">
								<span class="rk">chains merged</span>
								<span class="rv"><b>{reduced.unchopMerges.toLocaleString()}</b></span>
							</div>
						{/if}
						<div class="rep-row detail">
							<span class="rk">sequence shown</span>
							<span class="rv"><b>{stats.totalSequenceBp.toLocaleString()}</b> bp</span>
						</div>
						{#if layoutMs}
							<div class="rep-row detail">
								<span class="rk">layout</span>
								<span class="rv">{layoutMs.toLocaleString()} ms</span>
							</div>
						{/if}
						{#if fetchInfo}
							<div class="rep-row detail">
								<span class="rk">fetch time</span>
								<span class="rv">{fetchInfo.elapsedMs.toLocaleString()} ms</span>
							</div>
						{/if}
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
				<span class="rep-mini"><b>{stats.segments.toLocaleString()}</b> n</span>
				<span class="rep-mini"><b>{stats.links.toLocaleString()}</b> l</span>
				<span class="rep-mini"><b>{stats.walks.toLocaleString()}</b> w</span>
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
	.rep-span {
		font-size: 0.72rem;
		color: #7c3aed;
		font-variant-numeric: tabular-nums;
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

	.rep-rows {
		display: flex;
		flex-direction: column;
	}
	.rep-row {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		padding: 0.18rem 0;
		font-variant-numeric: tabular-nums;
	}
	.rep-row.detail {
		border-top: 1px solid #f2f2f5;
	}
	.rk {
		color: #6b7280;
		white-space: nowrap;
	}
	.rv {
		margin-left: auto;
		text-align: right;
		color: #1f2430;
		white-space: nowrap;
	}
	.rv b {
		font-weight: 700;
	}
	.rv em {
		font-style: normal;
		color: #a7adb8;
	}
	.rc {
		flex: 0 0 auto;
		width: 0.8rem;
		text-align: center;
		color: transparent;
		font-size: 0.72rem;
	}
	.rc.on {
		color: #16a34a;
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
