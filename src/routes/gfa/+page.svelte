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
	// The file picker popover, opened from the header pill (mirrors the locus browser's
	// query popover). Open on first load — there's no file yet — and closed once one is
	// loaded; the pill toggles it thereafter, over the current graph.
	let pickerOpen = $state(true);

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

	// Whether the file carries its own selectable references (W/P lines).
	const hasReference = $derived(backboneKind === 'walk' || backboneKind === 'path');
	// A graph with no W/P reference — the assembly / raw-graph case. Gets the graph
	// report pane and the various no-reference notes.
	const referenceless = $derived(
		backboneKind === 'rgfa' || backboneKind === 'synthetic' || backboneKind === 'none'
	);
	// The report/haplotype-panel wording. Reference-less graphs still get a row —
	// showing "walks 0" — so the info box makes the absence of traversals explicit
	// rather than hiding it (gfaStats excludes the synthetic backbone from the count).
	const walkNoun = $derived<string>(
		backboneKind === 'walk' ? 'haplotype walks' : backboneKind === 'path' ? 'paths' : 'walks'
	);
	const initialLayoutMode = $derived<LayoutMode | undefined>(
		backboneKind === 'none' ? 'simple-force' : undefined
	);
	// The backbone picker (moved into GraphLayoutView's reference-based options) gets
	// the real sample/path names when the file has its own reference; otherwise a note
	// explaining where the backbone came from is shown in its place.
	const backboneOptions = $derived<string[]>(hasReference ? samples : []);
	const backboneNote = $derived<string | null>(
		backboneKind === 'rgfa'
			? `Backbone from rGFA tags${rgfaContig ? ` · ${rgfaContig}` : ''} (not a chosen reference)`
			: backboneKind === 'synthetic'
				? 'Backbone: a computed longest path (this file has no reference)'
				: null
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
			pickerOpen = false; // a graph is up — dismiss the picker
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

</script>

<svelte:head>
	<title>Graphoscope · GFA viewer</title>
</svelte:head>

<div class="app">
	<AppBar tagline="Drop in any .gfa — with or without a reference path">
		{#snippet children()}
			<!-- File pill, mirroring the locus browser's query pill: it names the current
			     file and opens the picker (drop zone + examples) below it. -->
			<div class="filepill-wrap">
				<button
					class="filepill"
					class:open={pickerOpen}
					onclick={() => (pickerOpen = !pickerOpen)}
					title="Open a .gfa file"
				>
					{#if gfa}
						<span class="fp-name">{fileName}</span>
					{:else}
						<span class="fp-placeholder">Open a <code>.gfa</code> file</span>
					{/if}
					<span class="fp-caret" aria-hidden="true">▾</span>
				</button>

				{#if pickerOpen}
					<div class="gfa-pop" role="dialog" aria-label="Open a GFA graph">
						<div class="qp-block">
							<span class="qp-head">Open a file</span>
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<label
								class="dz-drop"
								class:over={dragOver}
								ondragover={(e) => {
									e.preventDefault();
									dragOver = true;
								}}
								ondragleave={() => (dragOver = false)}
								ondrop={onDrop}
							>
								<span class="dz-drop-icon">🧬</span>
								<span class="dz-drop-main"
									>Drag a <code>.gfa</code> here, or <span class="dz-choose">choose a file</span></span
								>
								<span class="dz-drop-sub"
									>{loading ? 'Loading…' : 'parsed in your browser — nothing uploaded'}</span
								>
								<input type="file" accept=".gfa,.txt" onchange={onPick} hidden />
							</label>
						</div>

						<div class="qp-block">
							<span class="qp-head">Or try an example</span>
							<div class="gfa-ex-grid">
								{#each EXAMPLES as ex (ex.name)}
									<button
										class="gfa-ex"
										onclick={() => loadExample(ex)}
										disabled={loading}
										title={'url' in ex.src ? `Fetched from GitHub: ${ex.src.url}` : ex.name}
									>
										<b>{ex.label}</b>
										<span class="gfa-ex-kind">{ex.kind}</span>
									</button>
								{/each}
							</div>
						</div>

						<div class="gfa-foot">
							<span>Looking for HPRC pangenome loci?</span>
							<a href="{base}/" data-sveltekit-reload>Open the locus browser →</a>
						</div>
					</div>
				{/if}
			</div>
		{/snippet}
	</AppBar>

	{#if pickerOpen}
		<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
		<div class="pick-scrim" role="presentation" onclick={() => (pickerOpen = false)}></div>
	{/if}

	{#if error}
		<div class="error-banner"><pre>{error}</pre></div>
	{/if}

	<div class="workspace">
		{#if gfa && stats}
			<section class="mainview">
				<!-- The node/link/bp counts that used to sit in a bar here now live in the
				     info box inside GraphLayoutView (shared with the locus browser), and the
				     backbone picker moved into that view’s reference-based layout options. -->
				{#if assembly && gfa}
					<AssemblyReport {assembly} {gfa} />
				{/if}
				<div class="tabbody">
					<GraphLayoutView
						{gfa}
						bind:referenceSample
						locusLabel={fileName}
						showHaplotypes={hasReference}
						{initialLayoutMode}
						{walkNoun}
						{backboneOptions}
						{backboneNote}
						hasTraversals={hasReference}
					/>
				</div>
			</section>
		{:else}
			<!-- No file yet: an empty frame with a hint. The picker opens over it. -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<section
				class="empty-stage"
				class:over={dragOver}
				ondragover={(e) => {
					e.preventDefault();
					dragOver = true;
				}}
				ondragleave={() => (dragOver = false)}
				ondrop={onDrop}
			>
				<div class="empty-hint">
					<div class="dz-icon">🧬</div>
					<p>
						No graph loaded — <button class="link-inline" onclick={() => (pickerOpen = true)}
							>open a <code>.gfa</code> file</button
						> to begin, or drop one here.
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

	/* ---- file pill in the header + its picker popover (mirrors the locus browser) ---- */
	.filepill-wrap {
		position: relative;
		display: flex;
		justify-content: center;
	}
	.filepill {
		display: inline-flex;
		align-items: baseline;
		gap: 0.5rem;
		max-width: 46vw;
		padding: 0.3rem 0.9rem;
		border-radius: 999px;
		border: 1px solid rgba(255, 255, 255, 0.25);
		background: rgba(255, 255, 255, 0.12);
		color: #fff;
		font: inherit;
		cursor: pointer;
		white-space: nowrap;
		overflow: hidden;
	}
	.filepill:hover {
		background: rgba(255, 255, 255, 0.2);
		border-color: rgba(255, 255, 255, 0.4);
	}
	.filepill.open {
		background: #fff;
		border-color: #fff;
		color: #2e1065;
	}
	.fp-name {
		flex: 0 1 auto;
		min-width: 2.5rem;
		overflow: hidden;
		text-overflow: ellipsis;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.85rem;
		font-weight: 700;
	}
	.fp-placeholder {
		flex: 0 1 auto;
		font-size: 0.85rem;
		font-weight: 600;
	}
	.fp-placeholder code {
		background: rgba(255, 255, 255, 0.16);
		color: inherit;
	}
	.filepill.open .fp-placeholder code {
		background: #eef1f5;
		color: #2e1065;
	}
	.fp-caret {
		flex: 0 0 auto;
		font-size: 0.6rem;
		opacity: 0.8;
	}

	/* Dim scrim over the page — under the header (z 100), so the strip and its picker
	   stay bright while everything below dims. */
	.pick-scrim {
		position: fixed;
		inset: 0;
		z-index: 90;
		background: rgba(16, 24, 40, 0.4);
	}
	.gfa-pop {
		position: absolute;
		top: calc(100% + 10px);
		left: 50%;
		transform: translateX(-50%);
		z-index: 101;
		width: min(540px, 92vw);
		display: flex;
		flex-direction: column;
		gap: 0.9rem;
		background: #fff;
		border: 1px solid #e3e7ee;
		border-radius: 12px;
		padding: 1rem 1.1rem;
		box-shadow: 0 18px 44px rgba(16, 24, 40, 0.28);
		color: #1f2430;
		text-align: left;
	}
	.qp-block {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.qp-block + .qp-block {
		border-top: 1px solid #f0f2f5;
		padding-top: 0.9rem;
	}
	.qp-head {
		font-size: 0.68rem;
		font-weight: 700;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: #6b7280;
	}
	/* Drop zone / choose-file target inside the popover. */
	.dz-drop {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.2rem;
		text-align: center;
		padding: 1.1rem 1rem;
		border: 2px dashed #cbd2dd;
		border-radius: 10px;
		background: #fbfcfe;
		cursor: pointer;
		transition:
			border-color 0.15s ease,
			background 0.15s ease;
	}
	.dz-drop:hover {
		border-color: #9aa0aa;
		background: #f6f7f9;
	}
	.dz-drop.over {
		border-color: #7c3aed;
		background: #faf7ff;
	}
	.dz-drop-icon {
		font-size: 1.6rem;
	}
	.dz-drop-main {
		font-size: 0.9rem;
		color: #333;
	}
	.dz-choose {
		color: #6d28d9;
		font-weight: 600;
		text-decoration: underline;
	}
	.dz-drop-sub {
		font-size: 0.74rem;
		color: #9aa0aa;
	}
	.gfa-ex-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.5rem;
	}
	.gfa-ex {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		text-align: left;
		font: inherit;
		background: #f7f8fa;
		border: 1px solid #e3e7ee;
		border-radius: 9px;
		padding: 0.5rem 0.6rem;
		cursor: pointer;
	}
	.gfa-ex:hover:not(:disabled) {
		background: #f5f0ff;
		border-color: #c7b8ec;
	}
	.gfa-ex:disabled {
		opacity: 0.6;
		cursor: default;
	}
	.gfa-ex b {
		font-size: 0.82rem;
		color: #1f2430;
	}
	.gfa-ex-kind {
		font-size: 0.7rem;
		color: #7a828f;
	}
	/* Reverse of the locus picker's GFA-viewer pointer: back to the locus browser. */
	.gfa-foot {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.6rem;
		flex-wrap: wrap;
		font-size: 0.78rem;
		color: #8a94a6;
	}
	.gfa-foot a {
		color: #6d28d9;
		font-weight: 600;
		text-decoration: none;
		white-space: nowrap;
	}
	.gfa-foot a:hover {
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
	.tabbody {
		flex: 1;
		min-height: 0;
		overflow: auto;
	}
	.tabbody :global(.wrap) {
		height: 100%;
	}

	/* Empty stage shown before a file is chosen (the picker opens over it). */
	.empty-stage {
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
	.empty-stage.over {
		border-color: #7c3aed;
		background: #faf7ff;
	}
	.empty-hint {
		text-align: center;
		max-width: 28rem;
		padding: 2rem;
		color: #8a94a6;
	}
	.dz-icon {
		font-size: 2.5rem;
	}
	.empty-hint p {
		margin: 0.6rem 0 0;
		font-size: 0.95rem;
		line-height: 1.5;
	}
	.link-inline {
		font: inherit;
		font-size: inherit;
		font-weight: 600;
		color: #6d28d9;
		background: none;
		border: none;
		padding: 0;
		cursor: pointer;
		text-decoration: underline;
	}
	.link-inline:hover {
		color: #5b21b6;
	}
	code {
		background: #eef1f5;
		padding: 0 4px;
		border-radius: 4px;
		font-size: 0.9em;
	}
</style>
