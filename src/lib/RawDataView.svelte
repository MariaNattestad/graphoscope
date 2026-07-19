<script lang="ts">
	// Raw-data inspector: shows the parsed graph as tables plus the raw GFA text,
	// so you can see exactly what the query returns before designing a viz.
	import type { Gfa } from './gfa';
	import { trackEvent } from './analytics';

	let { gfa, rawText }: { gfa: Gfa; rawText: string } = $props();

	const PREVIEW = 25; // rows shown per table

	const segments = $derived([...gfa.segments.values()]);
	const isReduced = $derived(gfa.reduced !== undefined);
	// Walk count to advertise: in reduced mode the non-reference walks were
	// aggregated into coverage counts, so `gfa.walks` holds only the reference.
	const walkCount = $derived(gfa.reduced ? gfa.reduced.totalWalks : gfa.walks.length);

	function stepsPreview(steps: { id: string; orient: string }[], n = 6): string {
		const head = steps
			.slice(0, n)
			.map((s) => (s.orient === '+' ? '>' : '<') + s.id)
			.join('');
		return steps.length > n ? head + '…' : head;
	}

	function seqPreview(seq: string, n = 40): string {
		return seq.length > n ? seq.slice(0, n) + '…' : seq;
	}

	let tab = $state<'segments' | 'links' | 'walks' | 'raw'>('walks');

	function download() {
		trackEvent('widget_interact', { widget: 'raw_data', action: 'download_gfa' });
		const blob = new Blob([rawText], { type: 'text/plain' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = 'subgraph.gfa';
		a.click();
		URL.revokeObjectURL(url);
	}

	const rawLineCount = $derived(rawText ? rawText.split('\n').length : 0);
	const RAW_LINES = 400;
	const rawPreview = $derived(rawText.split('\n').slice(0, RAW_LINES).join('\n'));
</script>

<div class="raw">
	<div class="tabs">
		<button class:active={tab === 'walks'} onclick={() => (tab = 'walks')}
			>{isReduced ? 'Reference path' : `Walks (${walkCount.toLocaleString()})`}</button
		>
		<button class:active={tab === 'segments'} onclick={() => (tab = 'segments')}
			>Segments ({gfa.segments.size})</button
		>
		<button class:active={tab === 'links'} onclick={() => (tab = 'links')}
			>Links ({gfa.links.length})</button
		>
		<button class:active={tab === 'raw'} onclick={() => (tab = 'raw')}>Raw GFA</button>
		<span class="spacer"></span>
		<button class="ghost" onclick={download}>Download .gfa</button>
	</div>

	{#if tab === 'walks'}
		{#if isReduced}
			<p class="desc">
				The reference path (a GFA <code>W</code>-line) through this subgraph. The other
				{(walkCount - 1).toLocaleString()} haplotype walks were counted per node and edge — see the
				<code>walks</code> column under Segments — and dropped before reaching the browser.
			</p>
		{:else}
			<p class="desc">
				Each row is one haplotype's path (a GFA <code>W</code>-line) through this subgraph, exactly
				as GBZ-base <code>query</code> extracts it. Haplotypes the graph carries without a sample
				name (e.g. anonymous minigraph paths) are reported as <code>unknown</code>.
			</p>
		{/if}
		<table>
			<thead>
				<tr><th>sample</th><th>hap</th><th>contig</th><th>start</th><th>end</th><th>steps</th><th>path (first steps)</th></tr>
			</thead>
			<tbody>
				{#each gfa.walks.slice(0, PREVIEW) as w (w.sample + w.hapIndex + w.seqId + w.start)}
					<tr>
						<td>{w.sample}</td><td>{w.hapIndex}</td><td>{w.seqId}</td>
						<td>{w.start.toLocaleString()}</td><td>{w.end.toLocaleString()}</td>
						<td>{w.steps.length}</td>
						<td class="mono">{stepsPreview(w.steps)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
		{#if gfa.walks.length > PREVIEW}<p class="note">showing {PREVIEW} of {gfa.walks.length} walks</p>{/if}
	{:else if tab === 'segments'}
		<table>
			<thead
				><tr
					><th>id</th><th>length (bp)</th>{#if isReduced}<th>walks (WC)</th>{/if}<th
						>sequence (preview)</th
					></tr
				></thead
			>
			<tbody>
				{#each segments.slice(0, PREVIEW) as s (s.id)}
					<tr
						><td class="mono">{s.id}</td><td>{s.length}</td>{#if isReduced}<td
								>{(s.coverage ?? 0).toLocaleString()}</td
							>{/if}<td class="mono">{seqPreview(s.seq)}</td></tr
					>
				{/each}
			</tbody>
		</table>
		{#if segments.length > PREVIEW}<p class="note">showing {PREVIEW} of {segments.length} segments</p>{/if}
	{:else if tab === 'links'}
		<table>
			<thead><tr><th>from</th><th></th><th>to</th></tr></thead>
			<tbody>
				{#each gfa.links.slice(0, PREVIEW) as l, i (i)}
					<tr>
						<td class="mono">{l.fromOrient}{l.from}</td><td>→</td><td class="mono">{l.toOrient}{l.to}</td>
					</tr>
				{/each}
			</tbody>
		</table>
		{#if gfa.links.length > PREVIEW}<p class="note">showing {PREVIEW} of {gfa.links.length} links</p>{/if}
	{:else}
		<pre class="rawtext">{rawPreview}</pre>
		{#if rawLineCount > RAW_LINES}<p class="note">showing first {RAW_LINES} of {rawLineCount.toLocaleString()} lines — use “Download .gfa” for all</p>{/if}
	{/if}
</div>

<style>
	.raw {
		font-size: 0.82rem;
	}
	.tabs {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		margin-bottom: 0.7rem;
		flex-wrap: wrap;
	}
	.tabs .spacer {
		flex: 1;
	}
	.tabs button {
		font: inherit;
		padding: 0.3rem 0.7rem;
		border: 1px solid #d0d0d0;
		background: #f6f6f6;
		border-radius: 6px;
		color: #333;
		cursor: pointer;
	}
	.tabs button.active {
		background: #2563eb;
		border-color: #2563eb;
		color: #fff;
	}
	.tabs button.ghost {
		background: #fff;
	}
	table {
		border-collapse: collapse;
		width: 100%;
	}
	th,
	td {
		text-align: left;
		padding: 0.25rem 0.6rem;
		border-bottom: 1px solid #eee;
		white-space: nowrap;
	}
	th {
		color: #666;
		font-weight: 600;
	}
	.mono {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
	}
	.rawtext {
		background: #0f172a;
		color: #cbd5e1;
		padding: 0.8rem;
		border-radius: 8px;
		max-height: 420px;
		overflow: auto;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.75rem;
		line-height: 1.45;
	}
	.note {
		color: #888;
		margin: 0.5rem 0 0;
	}
	.desc {
		color: #555;
		font-size: 0.8rem;
		line-height: 1.5;
		margin: 0 0 0.7rem;
		max-width: 80ch;
	}
	.desc code {
		background: #f0f0f0;
		padding: 0 3px;
		border-radius: 3px;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
	}
</style>
