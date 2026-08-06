<script lang="ts">
	// A general-purpose GFA viewer, reusing the same graph-layout module the hosted
	// locus browser uses — but for any .gfa file the user drops in, not just the
	// coordinate-queried HPRC subgraphs. Unlike the front page, there's no reference
	// path assumption: a GFA may carry named haplotype W-lines (or none). When it
	// does, the layout view shows a haplotype list you can click to trace one walk's
	// path (see GraphLayoutView's `showHaplotypes`).
	//
	// This is a client-only page: parsing happens in the browser off the picked
	// File, exactly like the query pipeline elsewhere. Deliberately separate from the
	// front page — nothing here touches the hosted-graph flow.
	import { parseGfa, gfaStats, type Gfa } from '$lib/gfa';
	import GraphLayoutView from '$lib/graph/GraphLayoutView.svelte';
	import { base } from '$app/paths';

	let gfa = $state.raw<Gfa | null>(null);
	let fileName = $state<string>('');
	let error = $state<string | null>(null);
	let loading = $state(false);
	let dragOver = $state(false);

	// The backbone/reference sample the layout pins to a straight line. For a general
	// GFA there may be no canonical reference, so this is user-choosable; it defaults
	// to the header RS: sample, else the first walk's sample. `gfaToGraph` falls back
	// to the first walk when the named sample isn't found, so any value is safe.
	let referenceSample = $state<string>('');

	// Distinct sample names across the graph's walks, in first-seen order — the
	// choices for the backbone picker.
	const samples = $derived.by(() => {
		if (!gfa) return [];
		const seen = new Set<string>();
		const out: string[] = [];
		for (const w of gfa.walks) {
			if (!seen.has(w.sample)) {
				seen.add(w.sample);
				out.push(w.sample);
			}
		}
		return out;
	});

	const stats = $derived(gfa ? gfaStats(gfa, referenceSample) : null);

	async function loadText(text: string, name: string) {
		error = null;
		loading = true;
		try {
			const parsed = parseGfa(text);
			if (parsed.segments.size === 0) {
				error = 'No segments (S lines) found — is this a GFA file?';
				return;
			}
			gfa = parsed;
			fileName = name;
			// Pick a sensible default backbone: header reference sample if named,
			// otherwise the first walk's sample (or empty if there are no walks).
			referenceSample =
				parsed.referenceSamples[0] ?? (parsed.walks.length > 0 ? parsed.walks[0].sample : '');
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}

	async function loadFile(file: File) {
		const text = await file.text();
		await loadText(text, file.name);
	}

	function onPick(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (file) loadFile(file);
	}

	function onDrop(e: DragEvent) {
		e.preventDefault();
		dragOver = false;
		const file = e.dataTransfer?.files?.[0];
		if (file) loadFile(file);
	}

	async function loadExample() {
		error = null;
		loading = true;
		try {
			const res = await fetch(`${base}/examples/MLPH.chm13.subset.gfa`);
			if (!res.ok) throw new Error(`Failed to load example (${res.status})`);
			await loadText(await res.text(), 'MLPH.chm13.subset.gfa');
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			loading = false;
		}
	}

	function reset() {
		gfa = null;
		fileName = '';
		error = null;
		referenceSample = '';
	}
</script>

<svelte:head>
	<title>Graphoscope · GFA viewer</title>
</svelte:head>

<div class="app">
	<header class="appbar">
		<div class="brand">
			<h1>GFA viewer</h1>
			<span class="tagline">Drop in any .gfa — with or without a reference path</span>
		</div>
		<div class="appbar-links">
			{#if gfa}
				<span class="fname" title={fileName}>{fileName}</span>
				<button class="link-btn" onclick={reset}>Load another</button>
			{/if}
			<a class="link-btn" href="{base}/" data-sveltekit-reload>← Locus browser</a>
		</div>
	</header>

	{#if error}
		<div class="error-banner"><pre>{error}</pre></div>
	{/if}

	<div class="workspace">
		{#if gfa && stats}
			<section class="mainview">
				<div class="subbar">
					<div class="stat-row">
						<span class="stat"><b>{stats.segments.toLocaleString()}</b> nodes</span>
						<span class="stat"><b>{stats.links.toLocaleString()}</b> links</span>
						<span class="stat"><b>{gfa.walks.length.toLocaleString()}</b> walks</span>
						<span class="stat"><b>{samples.length.toLocaleString()}</b> samples</span>
						<span class="stat"
							><b>{stats.totalSequenceBp.toLocaleString()}</b> bp total sequence</span
						>
					</div>
					{#if samples.length > 0}
						<label class="backbone">
							backbone
							<select bind:value={referenceSample}>
								{#each samples as s (s)}
									<option value={s}>{s}</option>
								{/each}
							</select>
						</label>
					{/if}
				</div>
				<div class="tabbody">
					<GraphLayoutView
						{gfa}
						{referenceSample}
						locusLabel={fileName}
						showHaplotypes={true}
					/>
				</div>
			</section>
		{:else}
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<section
				class="dropzone"
				class:over={dragOver}
				ondragover={(e) => {
					e.preventDefault();
					dragOver = true;
				}}
				ondragleave={() => (dragOver = false)}
				ondrop={onDrop}
			>
				<div class="dz-inner">
					<div class="dz-icon">🧬</div>
					<h2>Open a GFA graph</h2>
					<p class="dz-sub">
						Drag a <code>.gfa</code> file here, or choose one. Everything is parsed in your browser —
						nothing is uploaded.
					</p>
					<div class="dz-actions">
						<label class="dz-btn primary">
							{loading ? 'Loading…' : 'Choose file'}
							<input type="file" accept=".gfa,.txt" onchange={onPick} hidden />
						</label>
						<button class="dz-btn" onclick={loadExample} disabled={loading}>
							Load example (MLPH pangenome)
						</button>
					</div>
					<p class="dz-note">
						Supports GFA 1.1 with <code>W</code>-line haplotype walks. Named haplotypes show up in a
						list you can click to trace one path through the graph.
					</p>
				</div>
			</section>
		{/if}
	</div>
</div>

<style>
	:global(html),
	:global(body) {
		height: 100%;
		margin: 0;
		font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
		color: #1f2430;
		background: #eef1f5;
	}
	:global(*),
	:global(*::before),
	:global(*::after) {
		box-sizing: border-box;
	}

	.app {
		height: 100vh;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		background: #eef1f5;
	}

	.appbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.4rem 1rem;
		background: linear-gradient(90deg, #2e1065 0%, #6d28d9 58%, #9333ea 100%);
		border-bottom: 1px solid #4c1d95;
		box-shadow: 0 1px 3px rgba(76, 29, 149, 0.25);
		flex: 0 0 auto;
	}
	.brand {
		display: flex;
		flex-direction: column;
		line-height: 1.15;
	}
	.brand h1 {
		margin: 0;
		font-size: 1.15rem;
		font-weight: 700;
		letter-spacing: -0.01em;
		color: #fff;
	}
	.tagline {
		color: #d6bcfa;
		font-size: 0.72rem;
	}
	.appbar-links {
		display: flex;
		align-items: center;
		gap: 0.6rem;
	}
	.fname {
		color: #ede9fe;
		font-size: 0.8rem;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		max-width: 30vw;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.link-btn {
		background: none;
		border: none;
		color: #ede9fe;
		font: inherit;
		font-size: 0.85rem;
		font-weight: 600;
		cursor: pointer;
		padding: 0.2rem 0.3rem;
		text-decoration: none;
	}
	.link-btn:hover {
		color: #fff;
		text-decoration: underline;
	}

	.error-banner {
		flex: 0 0 auto;
		margin: 0.6rem 1rem 0;
	}
	.error-banner pre {
		margin: 0;
		background: #fef2f2;
		border: 1px solid #fca5a5;
		color: #991b1b;
		padding: 0.7rem 0.9rem;
		border-radius: 8px;
		white-space: pre-wrap;
		font-size: 0.82rem;
	}

	.workspace {
		flex: 1;
		min-height: 0;
		display: flex;
		padding: 0.75rem 1rem 1rem;
		overflow: hidden;
	}
	.mainview {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		background: #fff;
		border: 1px solid #e3e7ee;
		border-radius: 10px;
		overflow: hidden;
		box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04);
	}
	.subbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		flex-wrap: wrap;
		padding: 0.5rem 0.8rem;
		border-bottom: 1px solid #e3e7ee;
		background: #fafbfc;
	}
	.stat-row {
		display: flex;
		align-items: center;
		gap: 1rem;
		flex-wrap: wrap;
		font-size: 0.82rem;
		color: #6b7280;
	}
	.stat b {
		color: #1f2430;
		font-weight: 700;
	}
	.backbone {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.78rem;
		color: #6b7280;
	}
	.backbone select {
		font: inherit;
		font-size: 0.8rem;
		padding: 0.2rem 0.4rem;
		border: 1px solid #d3d9e2;
		border-radius: 6px;
		background: #fff;
		color: #1f2430;
	}
	.tabbody {
		flex: 1;
		min-height: 0;
		overflow: auto;
	}
	.tabbody :global(.wrap) {
		height: 100%;
	}

	/* Empty-state drop zone. */
	.dropzone {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		border: 2px dashed #cbd2dd;
		border-radius: 12px;
		background: #fff;
		transition:
			border-color 0.15s ease,
			background 0.15s ease;
	}
	.dropzone.over {
		border-color: #7c3aed;
		background: #faf7ff;
	}
	.dz-inner {
		text-align: center;
		max-width: 30rem;
		padding: 2rem;
	}
	.dz-icon {
		font-size: 2.5rem;
	}
	.dz-inner h2 {
		margin: 0.6rem 0 0.3rem;
		font-size: 1.2rem;
	}
	.dz-sub {
		margin: 0 0 1.2rem;
		color: #6b7280;
		font-size: 0.9rem;
		line-height: 1.5;
	}
	.dz-actions {
		display: flex;
		gap: 0.6rem;
		justify-content: center;
		flex-wrap: wrap;
	}
	.dz-btn {
		font: inherit;
		font-size: 0.88rem;
		font-weight: 600;
		cursor: pointer;
		border: 1px solid #d3d9e2;
		background: #fff;
		color: #333;
		padding: 0.5rem 1rem;
		border-radius: 8px;
	}
	.dz-btn:hover:not(:disabled) {
		border-color: #9aa0aa;
		background: #f6f7f9;
	}
	.dz-btn.primary {
		border-color: #7c3aed;
		background: #7c3aed;
		color: #fff;
	}
	.dz-btn.primary:hover {
		background: #6d28d9;
	}
	.dz-btn:disabled {
		opacity: 0.6;
		cursor: default;
	}
	.dz-note {
		margin: 1.2rem 0 0;
		color: #9aa0aa;
		font-size: 0.78rem;
		line-height: 1.5;
	}
	code {
		background: #eef1f5;
		padding: 0 4px;
		border-radius: 4px;
		font-size: 0.9em;
	}
</style>
