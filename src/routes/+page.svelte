<script lang="ts">
	import { onMount } from 'svelte';
	import { GbzClient, parseLocus, type QuerySource } from '$lib/gbzClient';
	import { parseGfa, gfaStats, type Gfa } from '$lib/gfa';
	import RefArcView from '$lib/RefArcView.svelte';
	import IgvView from '$lib/IgvView.svelte';
	import RawDataView from '$lib/RawDataView.svelte';
	import GraphLayoutView from '$lib/graph/GraphLayoutView.svelte';
	import { simplify } from '$lib/graph/simplify';

	let client: GbzClient | null = null;

	// Data source. Either a GBZ-base .gbz.db that we query per-locus over range
	// requests, or a whole .gfa loaded directly. Chosen via the File menu; the
	// HPRC .gbz.db URL is the default so the page opens with something to explore.
	const DEFAULT_DB_URL =
		'https://pub-32138fb437f04b75ac10fea079052edb.r2.dev/hprc-v1.1-mc-grch38.gbz.db';
	const DEFAULT_DB_LABEL = 'hprc-v1.1-mc-grch38.gbz.db';

	type Source =
		| { kind: 'gbz'; origin: 'url'; url: string; label: string }
		| { kind: 'gbz'; origin: 'file'; file: File; label: string }
		| { kind: 'gfa'; origin: 'url'; url: string; label: string }
		| { kind: 'gfa'; origin: 'file'; file: File; label: string };

	let source = $state<Source>({
		kind: 'gbz',
		origin: 'url',
		url: DEFAULT_DB_URL,
		label: DEFAULT_DB_LABEL
	});
	const isGbz = $derived(source.kind === 'gbz');

	// File menu + modal state.
	let menuOpen = $state(false);
	let modal = $state<{ target: 'gbz-url' | 'gfa-url'; title: string; placeholder: string; value: string } | null>(null);
	let gbzFileInput = $state<HTMLInputElement>();
	let gfaFileInput = $state<HTMLInputElement>();

	// Query
	let locusText = $state('chr6:31972046-32055647');
	let sample = $state('GRCh38');
	let haplotypes = $state<'all' | 'distinct' | 'reference-only'>('all');

	function labelFromUrl(url: string): string {
		try {
			const p = new URL(url).pathname;
			return p.split('/').filter(Boolean).pop() || url;
		} catch {
			return url.split('/').filter(Boolean).pop() || url;
		}
	}

	// Example loci for benchmarking across sizes (all against the default HPRC DB).
	const EXAMPLE_LOCI: { label: string; locus: string }[] = [
		{ label: 'small ~20 kb', locus: 'chr6:32000000-32020000' },
		{ label: 'MHC core ~84 kb', locus: 'chr6:31972046-32055647' },
		{ label: 'large ~500 kb', locus: 'chr6:31700000-32200000' },
		// A structurally complex region (~422 haplotype walks vs ~90-100 typical,
		// likely a segmental duplication) that simplifies far less than MHC — a
		// realistic stress test of the current single-pass algorithm's scaling
		// ceiling. Expect the graph layout to take ~15-20s here.
		{ label: 'chr20 ~200 kb (complex)', locus: 'chr20:30000000-30200000' }
	];

	// State
	let running = $state(false);
	let error = $state<string | null>(null);
	// `parsed` is the raw graph from the query/file; `gfa` is what the widgets see
	// (simplified upfront, unless the user turns it off).
	let parsed = $state<Gfa | null>(null);
	let rawGfa = $state<string>('');
	let simplifyOn = $state(true);
	let maxVariant = $state(50);
	let fetchInfo = $state<{
		requestCount: number;
		bytesFetched: number;
		dbSize: number;
		elapsedMs: number;
	} | null>(null);

	const simplified = $derived(
		parsed ? simplify(parsed, { referenceSample: sample, maxVariant }) : null
	);
	const gfa = $derived(simplifyOn && simplified ? simplified.gfa : parsed);
	const stats = $derived(gfa ? gfaStats(gfa) : null);

	onMount(() => {
		client = new GbzClient();
		// Auto-load the default (R2) locus so results appear on open.
		run();
		return () => client?.terminate();
	});

	async function run() {
		error = null;
		if (source.kind !== 'gbz') return;
		const qsource: QuerySource =
			source.origin === 'file'
				? { kind: 'file', file: source.file }
				: { kind: 'url', url: source.url };
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
		try {
			const result = await client!.query(qsource, locus);
			if (!result.ok) {
				error = `${result.error}\n${result.stderr ?? ''}`.trim();
			} else {
				rawGfa = result.gfa ?? '';
				parsed = parseGfa(rawGfa);
				fetchInfo = result.stats ?? null;
				logData('query', locus);
			}
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			running = false;
		}
	}

	// Load a whole .gfa (file or URL) directly, bypassing the query worker.
	async function loadGfa() {
		error = null;
		if (source.kind !== 'gfa') return;
		const t0 = performance.now();
		running = true;
		try {
			let text: string;
			let name: string;
			if (source.origin === 'file') {
				text = await source.file.text();
				name = source.file.name;
			} else {
				const res = await fetch(source.url);
				if (!res.ok) throw new Error(`HTTP ${res.status} fetching GFA`);
				text = await res.text();
				name = source.url;
			}
			rawGfa = text;
			parsed = parseGfa(text);
			fetchInfo = {
				requestCount: 1,
				bytesFetched: new Blob([text]).size,
				dbSize: new Blob([text]).size,
				elapsedMs: Math.round(performance.now() - t0)
			};
			logData('file', name);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			running = false;
		}
	}

	function runExampleLocus(locus: string) {
		locusText = locus;
		run();
	}

	// Lightweight console logging. Logs plain snapshots + a summary, and stashes
	// the full data on window.__pangenome for poking — never dumps the reactive
	// proxy or the multi-MB raw text into the console (that trips Svelte's
	// console_log_state warning and floods the log buffer).
	function logData(kind: string, ctx: unknown) {
		const snap = parsed ? $state.snapshot(parsed) : null;
		const summary = snap
			? { segments: snap.segments.size, links: snap.links.length, walks: snap.walks.length }
			: null;
		console.log(`[pangenome-viz] ${kind}`, { ctx, summary, fetch: fetchInfo });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(window as any).__pangenome = { parsed: snap, rawGfa, simplified: simplified?.stats };
	}

	// --- File menu + modal actions ---
	function openGbzUrl() {
		menuOpen = false;
		modal = {
			target: 'gbz-url',
			title: 'Open GBZ-base database by URL',
			placeholder: 'https://…/graph.gbz.db',
			value: source.kind === 'gbz' && source.origin === 'url' ? source.url : DEFAULT_DB_URL
		};
	}
	function openGfaUrl() {
		menuOpen = false;
		modal = {
			target: 'gfa-url',
			title: 'Open GFA by URL',
			placeholder: 'https://…/subgraph.gfa',
			value: source.kind === 'gfa' && source.origin === 'url' ? source.url : ''
		};
	}
	function confirmModal() {
		if (!modal) return;
		const url = modal.value.trim();
		if (!url) return;
		if (modal.target === 'gbz-url') {
			source = { kind: 'gbz', origin: 'url', url, label: labelFromUrl(url) };
			modal = null;
			run();
		} else {
			source = { kind: 'gfa', origin: 'url', url, label: labelFromUrl(url) };
			modal = null;
			loadGfa();
		}
	}
	function onGbzFile(e: Event) {
		const f = (e.target as HTMLInputElement).files?.[0];
		if (!f) return;
		source = { kind: 'gbz', origin: 'file', file: f, label: f.name };
		run();
	}
	function onGfaFile(e: Event) {
		const f = (e.target as HTMLInputElement).files?.[0];
		if (!f) return;
		source = { kind: 'gfa', origin: 'file', file: f, label: f.name };
		loadGfa();
	}
	function resetToDefault() {
		menuOpen = false;
		source = { kind: 'gbz', origin: 'url', url: DEFAULT_DB_URL, label: DEFAULT_DB_LABEL };
		run();
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
		<div class="menubar">
			<div class="menu">
				<button class="menu-btn" class:open={menuOpen} onclick={() => (menuOpen = !menuOpen)}>
					File ▾
				</button>
				{#if menuOpen}
					<!-- svelte-ignore a11y_consider_explicit_label -->
					<button class="menu-scrim" onclick={() => (menuOpen = false)}></button>
					<div class="menu-pop" role="menu">
						<button class="menu-item" role="menuitem" onclick={openGbzUrl}>
							Open GBZ-base database by URL…
						</button>
						<button
							class="menu-item"
							role="menuitem"
							onclick={() => {
								menuOpen = false;
								gbzFileInput?.click();
							}}
						>
							Open GBZ-base database file…
						</button>
						<div class="menu-sep"></div>
						<button class="menu-item" role="menuitem" onclick={openGfaUrl}>Open GFA by URL…</button>
						<button
							class="menu-item"
							role="menuitem"
							onclick={() => {
								menuOpen = false;
								gfaFileInput?.click();
							}}
						>
							Open GFA file…
						</button>
						<div class="menu-sep"></div>
						<button class="menu-item" role="menuitem" onclick={resetToDefault}>
							Reset to HPRC default
						</button>
					</div>
				{/if}
			</div>

			<span class="source-label">
				<span class="badge" class:gfa={!isGbz}>{isGbz ? 'GBZ-base' : 'GFA'}</span>
				<span class="src-name">{source.label}</span>
			</span>
			{#if running}<span class="muted small">working…</span>{/if}
			<span class="spacer"></span>
			<a class="pg-link" href="/playground">Simplification playground →</a>
		</div>

		{#if isGbz}
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

			<div class="row">
				<span class="muted small">examples:</span>
				{#each EXAMPLE_LOCI as ex (ex.locus)}
					<button class="chip" onclick={() => runExampleLocus(ex.locus)} disabled={running}>
						{ex.label}
					</button>
				{/each}
			</div>
		{:else}
			<div class="row">
				<label>
					Reference sample
					<select bind:value={sample}>
						<option value="GRCh38">GRCh38</option>
						<option value="CHM13">CHM13</option>
					</select>
				</label>
				<span class="muted small">first walk is used if this reference isn't present</span>
			</div>
		{/if}
	</section>

	<!-- hidden file pickers driven by the File menu -->
	<input
		bind:this={gbzFileInput}
		type="file"
		accept=".db"
		style="display:none"
		onchange={onGbzFile}
	/>
	<input
		bind:this={gfaFileInput}
		type="file"
		accept=".gfa,.gfa1,text/*"
		style="display:none"
		onchange={onGfaFile}
	/>

	{#if modal}
		<!-- svelte-ignore a11y_consider_explicit_label -->
		<button class="modal-scrim" onclick={() => (modal = null)}></button>
		<div class="modal" role="dialog" aria-modal="true" aria-label={modal.title}>
			<h3>{modal.title}</h3>
			<!-- svelte-ignore a11y_autofocus -->
			<input
				type="text"
				class="modal-input"
				placeholder={modal.placeholder}
				bind:value={modal.value}
				autofocus
				onkeydown={(e) => {
					if (e.key === 'Enter') confirmModal();
					else if (e.key === 'Escape') modal = null;
				}}
			/>
			<div class="modal-actions">
				<button class="ghost" onclick={() => (modal = null)}>Cancel</button>
				<button onclick={confirmModal}>Open</button>
			</div>
		</div>
	{/if}

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
			<div class="simplify-bar">
				<label class="opt">
					<input type="checkbox" bind:checked={simplifyOn} /> simplify graph
				</label>
				{#if simplifyOn}
					<label class="opt">
						collapse variants ≤
						<input type="number" min="1" max="1000" bind:value={maxVariant} /> bp
					</label>
					{#if simplified && parsed}
						<span class="muted small">
							{parsed.segments.size.toLocaleString()} → <b>{simplified.stats.segmentsAfter.toLocaleString()}</b>
							nodes · {simplified.stats.sites.toLocaleString()} sites collapsed
							({simplified.stats.snpCount.toLocaleString()} SNPs, {simplified.stats.basesRemoved.toLocaleString()} alt bp)
						</span>
					{/if}
				{/if}
			</div>
		</section>

		<section class="panel">
			<h2 class="panel-title">Reference-anchored graph layout</h2>
			<GraphLayoutView {gfa} referenceSample={sample} />
		</section>

		<section class="panel">
			<h2 class="panel-title">Large non-reference nodes</h2>
			<RefArcView {gfa} referenceSample={sample} />
		</section>

		<section class="panel">
			<h2 class="panel-title">Genome browser (IGV.js)</h2>
			<IgvView {gfa} referenceSample={sample} />
		</section>

		<section class="panel">
			<h2 class="panel-title">Raw data</h2>
			<RawDataView gfa={parsed ?? gfa} rawText={rawGfa} />
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
	input[type='text'],
	select {
		font: inherit;
		padding: 0.35rem 0.5rem;
		border: 1px solid #ccc;
		border-radius: 6px;
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
	button.chip {
		background: #eef2ff;
		color: #3730a3;
		font-weight: 500;
		padding: 0.25rem 0.7rem;
		font-size: 0.82rem;
	}
	button.chip:disabled {
		background: #f3f4f6;
		color: #9ca3af;
	}

	/* --- File menu --- */
	.menubar {
		display: flex;
		align-items: center;
		gap: 0.8rem;
		margin-bottom: 0.8rem;
	}
	.menubar .spacer {
		flex: 1;
	}
	.pg-link {
		color: #2563eb;
		font-size: 0.85rem;
		text-decoration: none;
		white-space: nowrap;
	}
	.pg-link:hover {
		text-decoration: underline;
	}
	.menu {
		position: relative;
	}
	.menu-btn {
		background: #f3f4f6;
		color: #1f2937;
		font-weight: 600;
		padding: 0.35rem 0.9rem;
		border: 1px solid #d1d5db;
	}
	.menu-btn.open,
	.menu-btn:hover {
		background: #e5e7eb;
	}
	.menu-scrim {
		position: fixed;
		inset: 0;
		z-index: 40;
		background: transparent;
		border: none;
		padding: 0;
		cursor: default;
	}
	.menu-pop {
		position: absolute;
		top: calc(100% + 4px);
		left: 0;
		z-index: 50;
		min-width: 240px;
		background: #fff;
		border: 1px solid #e2e5ea;
		border-radius: 8px;
		box-shadow: 0 8px 28px rgba(0, 0, 0, 0.14);
		padding: 4px;
		display: flex;
		flex-direction: column;
	}
	.menu-item {
		text-align: left;
		background: #fff;
		color: #1f2937;
		font-weight: 500;
		padding: 0.45rem 0.6rem;
		border: none;
		border-radius: 5px;
	}
	.menu-item:hover {
		background: #eef2ff;
		color: #3730a3;
	}
	.menu-sep {
		height: 1px;
		background: #eee;
		margin: 4px 2px;
	}
	.source-label {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.9rem;
		min-width: 0;
	}
	.src-name {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.82rem;
		color: #444;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 60ch;
	}
	.badge {
		background: #dbeafe;
		color: #1e40af;
		font-size: 0.72rem;
		font-weight: 700;
		padding: 0.1rem 0.45rem;
		border-radius: 999px;
		letter-spacing: 0.02em;
	}
	.badge.gfa {
		background: #dcfce7;
		color: #166534;
	}

	/* --- modal --- */
	.modal-scrim {
		position: fixed;
		inset: 0;
		z-index: 100;
		background: rgba(15, 23, 42, 0.35);
		border: none;
		padding: 0;
		cursor: default;
	}
	.modal {
		position: fixed;
		z-index: 101;
		top: 30%;
		left: 50%;
		transform: translate(-50%, -50%);
		width: min(560px, 92vw);
		background: #fff;
		border-radius: 12px;
		box-shadow: 0 20px 60px rgba(0, 0, 0, 0.28);
		padding: 1.2rem;
	}
	.modal h3 {
		margin: 0 0 0.8rem;
		font-size: 1rem;
	}
	.modal-input {
		width: 100%;
		box-sizing: border-box;
		font: inherit;
		padding: 0.5rem 0.6rem;
		border: 1px solid #ccc;
		border-radius: 6px;
	}
	.modal-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.6rem;
		margin-top: 1rem;
	}
	button.ghost {
		background: #fff;
		color: #374151;
		border: 1px solid #d1d5db;
	}

	.simplify-bar {
		display: flex;
		align-items: center;
		gap: 1rem;
		flex-wrap: wrap;
		margin-top: 0.6rem;
		padding-top: 0.6rem;
		border-top: 1px solid #f0f0f0;
	}
	.simplify-bar .opt {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		font-size: 0.85rem;
	}
	.simplify-bar .opt input[type='number'] {
		width: 4rem;
		padding: 0.15rem 0.35rem;
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
