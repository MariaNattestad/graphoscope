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
	import { parseGfa, gfaStats, type Gfa, type Walk } from '$lib/gfa';
	import { computeLongestPath } from '$lib/graph/longestPath';
	import { rgfaBackbone } from '$lib/graph/rgfaBackbone';
	import { computeAssemblyStats, type AssemblyStats } from '$lib/graph/assemblyStats';
	import type { LayoutMode } from '$lib/graph/layoutModes';
	import GraphLayoutView from '$lib/graph/GraphLayoutView.svelte';
	import AssemblyReport from './AssemblyReport.svelte';
	import AppBar from '$lib/AppBar.svelte';
	import { base } from '$app/paths';

	// The label given to the synthetic longest-path backbone we compute for a graph
	// that carries no reference of its own. Kept distinct from anything a real file
	// would name so it can never collide with a user's sample/path.
	const SYNTH_BACKBONE = '(computed backbone)';
	// The label for a reference recovered from rGFA SN/SO/SR tags.
	const RGFA_BACKBONE = '(rGFA reference)';

	let gfa = $state.raw<Gfa | null>(null);
	let fileName = $state<string>('');
	let error = $state<string | null>(null);
	let loading = $state(false);
	let dragOver = $state(false);

	// What the layout hangs its straight reference axis off, and where it came from:
	//  - 'walk'      — the file has W-line haplotypes (GFA 1.1).
	//  - 'path'      — the file has P-line paths (GFA 1.0: odgi/vg/seqwish/minigraph).
	//  - 'rgfa'      — no walks/paths, but rGFA SN/SO/SR tags gave a real reference.
	//  - 'synthetic' — none of the above; we computed a longest-path backbone so the
	//                  anchored layouts still work. Flagged so the UI can say so.
	//  - 'none'      — nothing usable, and too big to compute one; reference-free.
	type BackboneKind = 'walk' | 'path' | 'rgfa' | 'synthetic' | 'none';
	let backboneKind = $state<BackboneKind>('none');
	// The rGFA reference contig name (for the note), when backboneKind === 'rgfa'.
	let rgfaContig = $state<string>('');

	// The backbone/reference sample the layout pins to a straight line. For a general
	// GFA there may be no canonical reference, so this is user-choosable; it defaults
	// to the header RS: sample, else the first walk/path's name. `gfaToGraph` falls
	// back to the first walk when the named sample isn't found, so any value is safe.
	let referenceSample = $state<string>('');

	// Distinct real sample/path names across the graph's traversals, in first-seen
	// order — the choices for the backbone picker. Excludes the synthetic backbone
	// (there's nothing to pick when it's the only "walk").
	const samples = $derived.by(() => {
		if (!gfa) return [];
		const seen = new Set<string>();
		const out: string[] = [];
		for (const w of gfa.walks) {
			if (w.kind === 'synthetic') continue;
			if (!seen.has(w.sample)) {
				seen.add(w.sample);
				out.push(w.sample);
			}
		}
		return out;
	});

	// What to call the traversals in the UI: paths for a P-line graph, walks otherwise.
	const traversalNoun = $derived(backboneKind === 'path' ? 'paths' : 'walks');
	// Real traversals only (a computed / rGFA backbone isn't one of the file's own).
	const realWalkCount = $derived(gfa ? gfa.walks.filter((w) => w.kind !== 'synthetic').length : 0);
	// Whether the file carries its own selectable references (W/P lines).
	const hasReference = $derived(backboneKind === 'walk' || backboneKind === 'path');
	// A graph with no W/P reference — the assembly / raw-graph case. Gets the graph
	// report pane and the various no-reference notes.
	const referenceless = $derived(
		backboneKind === 'rgfa' || backboneKind === 'synthetic' || backboneKind === 'none'
	);
	// The report/haplotype-panel wording and whether to open on a reference-free mode.
	const walkNoun = $derived<string | null>(
		backboneKind === 'walk' ? 'haplotype walks' : backboneKind === 'path' ? 'paths' : null
	);
	const initialLayoutMode = $derived<LayoutMode | undefined>(
		backboneKind === 'none' ? 'simple-force' : undefined
	);

	const stats = $derived(gfa ? gfaStats(gfa, referenceSample) : null);
	// Structural / assembly metrics — only for reference-less graphs (the case the
	// locus-browser-style "walks / samples" readout says nothing useful about).
	const assembly = $derived<AssemblyStats | null>(
		gfa && referenceless ? computeAssemblyStats(gfa) : null
	);

	async function loadText(text: string, name: string) {
		error = null;
		loading = true;
		try {
			const parsed = parseGfa(text);
			if (parsed.segments.size === 0) {
				error = 'No segments (S lines) found — is this a GFA file?';
				return;
			}
			const hasW = parsed.walks.some((w) => w.kind === 'W' || w.kind === undefined);
			const hasP = parsed.walks.some((w) => w.kind === 'P');
			if (hasW || hasP) {
				// The file carries its own reference(s): use them directly.
				backboneKind = hasW ? 'walk' : 'path';
				gfa = parsed;
				referenceSample = parsed.referenceSamples[0] ?? parsed.walks[0].sample;
			} else {
				// No W- or P-lines. Best real reference first: rGFA SN/SO/SR tags give an
				// exact backbone with true coordinates. Failing that, a computed longest
				// path. Failing that (too big), a reference-free layout.
				rgfaContig = '';
				const rg = rgfaBackbone(parsed);
				const backbone = rg ?? computeLongestPath(parsed.segments, parsed.links);
				if (backbone) {
					const isRgfa = rg != null;
					const synthetic: Walk = {
						sample: isRgfa ? RGFA_BACKBONE : SYNTH_BACKBONE,
						hapIndex: 0,
						seqId: isRgfa ? rg!.contig : 'longest path',
						start: isRgfa ? rg!.start : 0,
						end: (isRgfa ? rg!.start : 0) + backbone.bp,
						steps: backbone.steps,
						tags: {},
						kind: 'synthetic'
					};
					backboneKind = isRgfa ? 'rgfa' : 'synthetic';
					if (isRgfa) rgfaContig = rg!.contig;
					gfa = { ...parsed, walks: [synthetic] };
					referenceSample = synthetic.sample;
				} else {
					backboneKind = 'none';
					gfa = parsed;
					referenceSample = '';
				}
			}
			fileName = name;
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

	// Example graphs, one per kind the viewer handles. The first is bundled (it's the
	// hosted W-line example); the rest are fetched on demand from the test-data of
	// well-known tools (odgi, gfatools, Bandage) so they don't bloat the app bundle.
	// raw.githubusercontent.com sends permissive CORS, so a client-side fetch works.
	interface Example {
		label: string;
		/** Short badge for what kind of graph it is. */
		kind: string;
		/** Downloaded filename / display name. */
		name: string;
		/** Bundled path under static/examples, or a full URL to fetch. */
		src: { bundle: string } | { url: string };
	}
	const RAW = 'https://raw.githubusercontent.com';
	const EXAMPLES: Example[] = [
		{
			label: 'MLPH pangenome',
			kind: 'W-line walks',
			name: 'MLPH.chm13.subset.gfa',
			src: { bundle: 'MLPH.chm13.subset.gfa' }
		},
		{
			label: 'HLA-DRB1',
			kind: 'P-line paths',
			name: 'DRB1-3123.gfa',
			src: { url: `${RAW}/pangenome/odgi/master/test/DRB1-3123.gfa` }
		},
		{
			label: 'Human/orang MT',
			kind: 'rGFA, no paths',
			name: 'MT.gfa',
			src: { url: `${RAW}/lh3/gfatools/master/test/MT.gfa` }
		},
		{
			label: 'Bacterial plasmids',
			kind: 'assembly graph',
			name: 'test_plasmids.gfa',
			src: { url: `${RAW}/rrwick/Bandage/main/tests/test_plasmids.gfa` }
		},
		{
			label: 'Tiny path graph',
			kind: 'minimal',
			name: 't.gfa',
			src: { url: `${RAW}/pangenome/odgi/master/test/t.gfa` }
		}
	];

	async function loadExample(ex: Example) {
		error = null;
		loading = true;
		try {
			const url = 'bundle' in ex.src ? `${base}/examples/${ex.src.bundle}` : ex.src.url;
			const res = await fetch(url);
			if (!res.ok) throw new Error(`Failed to load example (${res.status})`);
			await loadText(await res.text(), ex.name);
		} catch (e) {
			error =
				(e instanceof Error ? e.message : String(e)) +
				('url' in ex.src ? ' — this example is fetched from GitHub; check your connection.' : '');
			loading = false;
		}
	}

	function reset() {
		gfa = null;
		fileName = '';
		error = null;
		referenceSample = '';
		backboneKind = 'none';
		rgfaContig = '';
	}
</script>

<svelte:head>
	<title>Graphoscope · GFA viewer</title>
</svelte:head>

<div class="app">
	<AppBar tagline="Drop in any .gfa — with or without a reference path">
		{#snippet links()}
			{#if gfa}
				<span class="fname" title={fileName}>{fileName}</span>
				<button class="link-btn" onclick={reset}>Load another</button>
			{/if}
		{/snippet}
	</AppBar>

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
						{#if hasReference}
							<span class="stat"
								><b>{realWalkCount.toLocaleString()}</b> {traversalNoun}</span
							>
							{#if backboneKind === 'walk'}
								<span class="stat"><b>{samples.length.toLocaleString()}</b> samples</span>
							{/if}
						{/if}
						<span class="stat"
							><b>{stats.totalSequenceBp.toLocaleString()}</b> bp total sequence</span
						>
					</div>
					{#if hasReference}
						<label class="backbone">
							backbone
							<select bind:value={referenceSample}>
								{#each samples as s (s)}
									<option value={s}>{s}</option>
								{/each}
							</select>
						</label>
					{:else if backboneKind === 'rgfa'}
						<div class="ref-note" title="Reference recovered from rGFA SN/SO/SR tags.">
							⌖ Reference backbone from <b>rGFA tags</b>{rgfaContig ? ` · ${rgfaContig}` : ''}
						</div>
					{:else if backboneKind === 'synthetic'}
						<div class="no-ref" title="This graph has no W-line or P-line reference.">
							⚠︎ No walks or paths — anchored to a <b>computed longest path</b> (not a reference).
						</div>
					{:else}
						<div class="no-ref">
							⚠︎ No walks or paths, and too large to compute a backbone — showing a
							<b>reference-free</b> layout.
						</div>
					{/if}
				</div>
				{#if assembly && gfa}
					<AssemblyReport {assembly} {gfa} />
				{/if}
				<div class="tabbody">
					<GraphLayoutView
						{gfa}
						{referenceSample}
						locusLabel={fileName}
						showHaplotypes={hasReference}
						{initialLayoutMode}
						{walkNoun}
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
					</div>
					<div class="dz-examples">
						<span class="dz-examples-label">or try an example</span>
						<div class="dz-example-btns">
							{#each EXAMPLES as ex (ex.name)}
								<button
									class="dz-btn small"
									onclick={() => loadExample(ex)}
									disabled={loading}
									title={'url' in ex.src ? `Fetched from GitHub: ${ex.src.url}` : ex.name}
								>
									<span class="ex-label">{ex.label}</span>
									<span class="ex-kind">{ex.kind}</span>
								</button>
							{/each}
						</div>
					</div>
					<p class="dz-note">
						Reads GFA 1.1 <code>W</code>-line haplotype walks and GFA 1.0 <code>P</code>-line paths
						— each becomes a clickable trace through the graph. A graph with no walks or paths still
						opens: a reference is recovered from rGFA <code>SN/SO/SR</code> tags if present, else a
						longest path is computed; assembly-style graphs also get a structure &amp; depth report.
						All examples but the first are fetched from the test data of odgi, gfatools and Bandage.
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

	/* The file name shown in the shared top bar (passed through AppBar's `links`
	   snippet, so it's styled here, in the parent scope). */
	.fname {
		color: #ede9fe;
		font-size: 0.8rem;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		max-width: 30vw;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
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
	/* Shown in place of the backbone picker when the file names no reference. */
	.no-ref {
		font-size: 0.76rem;
		color: #92580a;
		background: #fef6e7;
		border: 1px solid #f5d9a0;
		border-radius: 6px;
		padding: 0.3rem 0.55rem;
		max-width: 34rem;
	}
	.no-ref b {
		color: #7a4906;
		font-weight: 700;
	}
	/* Positive variant, for a real reference recovered from rGFA tags. */
	.ref-note {
		font-size: 0.76rem;
		color: #3730a3;
		background: #eef2ff;
		border: 1px solid #c7d2fe;
		border-radius: 6px;
		padding: 0.3rem 0.55rem;
	}
	.ref-note b {
		color: #312e81;
		font-weight: 700;
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
	.dz-btn.small {
		font-size: 0.8rem;
		padding: 0.4rem 0.7rem;
		display: inline-flex;
		flex-direction: column;
		align-items: center;
		gap: 0.1rem;
		line-height: 1.2;
	}
	.ex-label {
		font-weight: 600;
	}
	.ex-kind {
		font-size: 0.68rem;
		font-weight: 500;
		color: #9aa0aa;
	}
	.dz-examples {
		margin-top: 1.4rem;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.55rem;
	}
	.dz-examples-label {
		font-size: 0.75rem;
		color: #9aa0aa;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.dz-example-btns {
		display: flex;
		gap: 0.5rem;
		justify-content: center;
		flex-wrap: wrap;
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
