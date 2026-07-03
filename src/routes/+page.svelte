<script lang="ts">
	import { onMount } from 'svelte';
	import { GbzClient, parseLocus, type QuerySource } from '$lib/gbzClient';
	import { parseGfa, gfaStats, type Gfa } from '$lib/gfa';
	import GfaView from '$lib/GfaView.svelte';
	import RefArcView from '$lib/RefArcView.svelte';
	import RawDataView from '$lib/RawDataView.svelte';

	let client: GbzClient | null = null;

	// Data source
	const DEFAULT_DB_URL =
		'https://pub-32138fb437f04b75ac10fea079052edb.r2.dev/hprc-v1.1-mc-grch38.gbz.db';
	let sourceKind = $state<'file' | 'url'>('url');
	let dbFile = $state<File | null>(null);
	let dbUrl = $state(DEFAULT_DB_URL);

	// Query
	let locusText = $state('chr6:31972046-32055647');
	let sample = $state('GRCh38');
	let haplotypes = $state<'all' | 'distinct' | 'reference-only'>('all');

	// State
	let running = $state(false);
	let error = $state<string | null>(null);
	let gfa = $state<Gfa | null>(null);
	let rawGfa = $state<string>('');
	let stats = $state<ReturnType<typeof gfaStats> | null>(null);
	let fetchInfo = $state<{
		requestCount: number;
		bytesFetched: number;
		dbSize: number;
		elapsedMs: number;
	} | null>(null);

	onMount(() => {
		client = new GbzClient();
		// Auto-load the default (R2) locus so results appear on open.
		run();
		return () => client?.terminate();
	});

	function currentSource(): QuerySource | null {
		if (sourceKind === 'file') return dbFile ? { kind: 'file', file: dbFile } : null;
		return dbUrl.trim() ? { kind: 'url', url: dbUrl.trim() } : null;
	}

	async function run() {
		error = null;
		const source = currentSource();
		if (!source) {
			error = sourceKind === 'file' ? 'Choose a .gbz.db file first.' : 'Enter a .gbz.db URL first.';
			return;
		}
		let locus;
		try {
			locus = parseLocus(locusText, sample);
			locus.sample = sample;
			locus.haplotypes = haplotypes;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			return;
		}
		running = true;
		gfa = null;
		rawGfa = '';
		stats = null;
		fetchInfo = null;
		try {
			const result = await client!.query(source, locus);
			if (!result.ok) {
				error = `${result.error}\n${result.stderr ?? ''}`.trim();
			} else {
				rawGfa = result.gfa ?? '';
				gfa = parseGfa(rawGfa);
				stats = gfaStats(gfa);
				fetchInfo = result.stats ?? null;
				// Log the data so you can poke at it in the devtools console.
				console.log('[pangenome-viz] query', { locus, stats: fetchInfo });
				console.log('[pangenome-viz] parsed GFA', gfa);
				console.log('[pangenome-viz] segments', gfa.segments);
				console.log('[pangenome-viz] walks (haplotypes)', gfa.walks);
				console.log('[pangenome-viz] links', gfa.links);
				console.log('[pangenome-viz] raw GFA text', rawGfa);
			}
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			running = false;
		}
	}

	function onFile(e: Event) {
		const input = e.target as HTMLInputElement;
		dbFile = input.files?.[0] ?? null;
	}

	function fmtBytes(n: number): string {
		if (n < 1024) return `${n} B`;
		if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
		if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
		return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
	}
</script>

<main>
	<header>
		<h1>Pangenome locus browser</h1>
		<p class="sub">
			Query an HPRC pangenome graph at a locus, straight from a GBZ-base <code>.gbz.db</code> — read
			on demand via range requests, no full download.
		</p>
	</header>

	<section class="panel">
		<div class="row">
			<label class="seg">
				<input type="radio" bind:group={sourceKind} value="file" /> Local file
			</label>
			<label class="seg">
				<input type="radio" bind:group={sourceKind} value="url" /> URL (R2/S3)
			</label>
		</div>

		{#if sourceKind === 'file'}
			<div class="row">
				<input type="file" accept=".db" onchange={onFile} />
				{#if dbFile}<span class="muted">{dbFile.name} · {fmtBytes(dbFile.size)}</span>{/if}
			</div>
		{:else}
			<div class="row">
				<input
					class="grow"
					type="text"
					placeholder="https://…r2.dev/hprc-v1.1-mc-grch38.gbz.db"
					bind:value={dbUrl}
				/>
			</div>
		{/if}

		<div class="row">
			<label>Locus <input type="text" bind:value={locusText} size="26" /></label>
			<label>
				Sample
				<select bind:value={sample}>
					<option value="GRCh38">GRCh38</option>
					<option value="CHM13">CHM13</option>
				</select>
			</label>
			<label>
				Haplotypes
				<select bind:value={haplotypes}>
					<option value="all">all</option>
					<option value="distinct">distinct (weighted)</option>
					<option value="reference-only">reference only</option>
				</select>
			</label>
			<button onclick={run} disabled={running}>{running ? 'Querying…' : 'Query'}</button>
		</div>
	</section>

	{#if error}
		<pre class="error">{error}</pre>
	{/if}

	{#if stats && gfa}
		<section class="panel">
			<div class="stats">
				<div><b>{stats.segments.toLocaleString()}</b><span>segments</span></div>
				<div><b>{stats.links.toLocaleString()}</b><span>links</span></div>
				<div><b>{stats.walks.toLocaleString()}</b><span>haplotype walks</span></div>
				<div><b>{stats.samples.toLocaleString()}</b><span>samples</span></div>
				<div><b>{stats.totalSequenceBp.toLocaleString()}</b><span>bp of sequence</span></div>
			</div>
			{#if fetchInfo}
				<p class="muted small">
					Fetched <b>{fmtBytes(fetchInfo.bytesFetched)}</b> in {fetchInfo.requestCount} block reads from
					a {fmtBytes(fetchInfo.dbSize)} database · {fetchInfo.elapsedMs} ms
				</p>
			{/if}
		</section>

		<section class="panel">
			<GfaView {gfa} referenceSample={sample} />
		</section>

		<section class="panel">
			<h2 class="panel-title">Large non-reference nodes</h2>
			<RefArcView {gfa} referenceSample={sample} />
		</section>

		<section class="panel">
			<h2 class="panel-title">Raw data</h2>
			<RawDataView {gfa} rawText={rawGfa} />
		</section>
	{/if}

	<footer class="muted small">
		GBZ-base <code>query.wasm</code> · WASI in a Web Worker · SQLite pages served by range requests
	</footer>
</main>

<style>
	:global(body) {
		margin: 0;
		font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
		color: #1a1a1a;
		background: #fff;
	}
	main {
		max-width: 1100px;
		margin: 0 auto;
		padding: 2rem 1.5rem 4rem;
	}
	h1 {
		margin: 0 0 0.2rem;
		font-size: 1.5rem;
	}
	.sub {
		margin: 0 0 1.2rem;
		color: #555;
	}
	.panel {
		border: 1px solid #e6e6e6;
		border-radius: 10px;
		padding: 1rem;
		margin-bottom: 1rem;
		background: #fff;
	}
	.panel-title {
		margin: 0 0 0.8rem;
		font-size: 0.95rem;
		font-weight: 600;
		color: #444;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 0.8rem;
		flex-wrap: wrap;
		margin-bottom: 0.6rem;
	}
	.row:last-child {
		margin-bottom: 0;
	}
	label {
		font-size: 0.9rem;
	}
	.seg {
		font-weight: 500;
	}
	input[type='text'],
	select {
		font: inherit;
		padding: 0.35rem 0.5rem;
		border: 1px solid #ccc;
		border-radius: 6px;
	}
	.grow {
		flex: 1;
		min-width: 320px;
	}
	button {
		font: inherit;
		font-weight: 600;
		padding: 0.4rem 1.1rem;
		border: none;
		border-radius: 6px;
		background: #2563eb;
		color: #fff;
		cursor: pointer;
	}
	button:disabled {
		background: #9db8ef;
		cursor: default;
	}
	.stats {
		display: flex;
		gap: 1.8rem;
		flex-wrap: wrap;
	}
	.stats div {
		display: flex;
		flex-direction: column;
	}
	.stats b {
		font-size: 1.3rem;
	}
	.stats span {
		color: #777;
		font-size: 0.8rem;
	}
	.error {
		background: #fef2f2;
		border: 1px solid #fca5a5;
		color: #991b1b;
		padding: 0.8rem;
		border-radius: 8px;
		white-space: pre-wrap;
	}
	.muted {
		color: #888;
	}
	.small {
		font-size: 0.8rem;
	}
	code {
		background: #f0f0f0;
		padding: 0 4px;
		border-radius: 4px;
	}
	footer {
		margin-top: 2rem;
	}
</style>
