<script lang="ts">
	import { onMount } from 'svelte';
	import { GbzClient, parseLocus, type QuerySource } from '$lib/gbzClient';
	import {
		parseGfa,
		gfaStats,
		gfaLightStats,
		filterToReferenceWalks,
		type Gfa,
		type GfaStats
	} from '$lib/gfa';
	import RefArcView from '$lib/RefArcView.svelte';
	import IgvView from '$lib/IgvView.svelte';
	import RawDataView from '$lib/RawDataView.svelte';
	import GraphLayoutView from '$lib/graph/GraphLayoutView.svelte';
	import { simplify } from '$lib/graph/simplify';
	import { initAnalytics, trackEvent } from '$lib/analytics';
	import { searchGenes, resolveGene, geneToLocus, type GeneEntry, type RefKey } from '$lib/genes';
	import { base } from '$app/paths';

	let client: GbzClient | null = null;

	// ---- The two hosted graphs -------------------------------------------------
	// Both are HPRC Release 2 (v2.0) Minigraph-Cactus pangenome graphs. We took the
	// public `.gbz` files, converted each to a GBZ-base `.gbz.db` (SQLite) with
	// `gbz2db`, and host them on Cloudflare R2 with CORS + HTTP range support so the
	// browser can query a locus without downloading the multi-GB database.
	const R2_BASE = 'https://pub-32138fb437f04b75ac10fea079052edb.r2.dev';

	interface GraphDef {
		id: 'grch38' | 'chm13';
		label: string;
		/** Reference sample name inside the graph — also the coordinate system. */
		referenceSample: string;
		/** Which bundled gene map matches this reference. */
		refKey: RefKey;
		dbUrl: string;
		/** Original public source we indexed. */
		s3Source: string;
	}

	const GRAPHS: GraphDef[] = [
		{
			id: 'grch38',
			label: 'GRCh38-based',
			referenceSample: 'GRCh38',
			refKey: 'grch38',
			dbUrl: `${R2_BASE}/hprc-v2.0-mc-grch38.gbz.db`,
			s3Source:
				's3://human-pangenomics/pangenomes/freeze/release2/minigraph-cactus/hprc-v2.0-mc-grch38.gbz'
		},
		{
			id: 'chm13',
			label: 'CHM13-based (T2T)',
			referenceSample: 'CHM13',
			refKey: 'chm13',
			dbUrl: `${R2_BASE}/hprc-v2.0-mc-chm13.gbz.db`,
			s3Source:
				's3://human-pangenomics/pangenomes/freeze/release2/minigraph-cactus/hprc-v2.0-mc-chm13.gbz'
		}
	];

	// Example loci are gene symbols, not raw coordinates — resolved through the
	// exact same gene → coordinate lookup as manual search (below), separately
	// per graph, so they're never out of sync with what search would actually
	// return. Deliberately NOT the old hardcoded "MHC core" coordinate range:
	// that number wasn't standardized anywhere except an odgi documentation
	// example. Chosen for a mix of real pangenome-relevant variation and to
	// stay comfortably under MAX_GFA_BYTES on both assemblies (tested directly
	// against both databases): HLA-A (immune/MHC hypervariability — closest to
	// the size ceiling of this set, since MHC class I is genuinely that
	// diverse even in a ~20kb window), AMY1A (salivary amylase copy-number
	// variation), SMN1 (spinal muscular atrophy locus, segmental duplication),
	// CYP2D6 (pharmacogenomics, common structural variation).
	const EXAMPLE_GENES = ['HLA-A', 'AMY1A', 'SMN1', 'CYP2D6'];
	const DEFAULT_GENE = 'HLA-A';

	let graphId = $state<'grch38' | 'chm13'>('grch38');
	const graph = $derived(GRAPHS.find((g) => g.id === graphId)!);

	// A locus that returns a very large subgraph will blow up the browser: the GFA
	// is parsed into millions of step objects, then simplify deep-copies them, then
	// each view walks them again — the live-object footprint is ~100× the GFA text,
	// so the tab freezes then OOMs ("Aw Snap"). We refuse to render past this raw-GFA
	// size (checked before parsing, so a pathological region never enters the
	// pipeline). Calibrated empirically: the ~10.5 MB MHC locus renders smoothly, a
	// ~17 MB (150 kb) region already wedges the tab, so the ceiling sits between —
	// all built-in example loci are ≤ ~10.5 MB and clear it with headroom.
	const MAX_GFA_BYTES = 13 * 1024 * 1024;

	// ---- Query state -----------------------------------------------------------
	let locusText = $state(DEFAULT_GENE);
	// Set to the resolved gene's symbol whenever the current results came from a
	// gene-name search (manual or an example chip) — kept alongside the
	// coordinates so a user can look back and remember what they searched for,
	// since `locusText` itself gets overwritten with the resolved coordinates.
	let queriedGene = $state<string | null>(null);

	// State
	let running = $state(false);
	let error = $state<string | null>(null);
	// `parsed` is the raw graph from the query; `gfa` is what the widgets see
	// (simplified upfront, unless the user turns it off).
	let parsed = $state<Gfa | null>(null);
	let rawGfa = $state<string>('');
	// Set when even the locally-filtered reference-only graph is still more GFA
	// than MAX_GFA_BYTES (rare — see run()); the heavy views are skipped and
	// these line-counted-only stats (never fully parsed) are shown instead.
	let oversized = $state<{ bytes: number } | null>(null);
	let lightStats = $state<GfaStats | null>(null);
	// Set when the full (all-haplotype) query was too big and we locally
	// dropped every walk but the reference's (see filterToReferenceWalks):
	// same segments/links (full topology), but only the reference walk — no
	// per-haplotype coverage/heatmap, raw walk listing, or endpoint-artifact
	// hints for this locus.
	let reducedMode = $state<'reference-only' | null>(null);
	let simplifyOn = $state(true);
	let maxVariant = $state(50);
	let fetchInfo = $state<{
		requestCount: number;
		bytesFetched: number;
		dbSize: number;
		elapsedMs: number;
	} | null>(null);

	const simplified = $derived(
		parsed ? simplify(parsed, { referenceSample: graph.referenceSample, maxVariant }) : null
	);
	const gfa = $derived(simplifyOn && simplified ? simplified.gfa : parsed);
	const stats = $derived(gfa ? gfaStats(gfa, graph.referenceSample) : null);

	// ---- Gene-name autocomplete for the Locus field ----------------------------
	let suggestions = $state<GeneEntry[]>([]);
	let showSuggest = $state(false);
	let activeSuggest = $state(0);
	let suggestSeq = 0;

	const looksLikeLocus = (s: string) => /:\s*[\d,]+\s*-\s*[\d,]+\s*$/.test(s);

	function onLocusInput() {
		const q = locusText.trim();
		if (q.length < 2 || looksLikeLocus(q)) {
			suggestions = [];
			showSuggest = false;
			return;
		}
		const seq = ++suggestSeq;
		searchGenes(graph.refKey, q).then((res) => {
			if (seq !== suggestSeq) return; // superseded
			suggestions = res;
			activeSuggest = 0;
			showSuggest = res.length > 0;
		});
	}

	function pickGene(gene: GeneEntry) {
		// Set the symbol, not pre-resolved coordinates, so this goes through the
		// same resolution path as typing a name and hitting Enter (run() sets
		// queriedGene there) rather than duplicating that logic here.
		locusText = gene.name;
		showSuggest = false;
		suggestions = [];
		run('gene');
	}

	function onLocusKey(e: KeyboardEvent) {
		if (showSuggest && suggestions.length > 0) {
			if (e.key === 'ArrowDown') {
				e.preventDefault();
				activeSuggest = (activeSuggest + 1) % suggestions.length;
				return;
			}
			if (e.key === 'ArrowUp') {
				e.preventDefault();
				activeSuggest = (activeSuggest - 1 + suggestions.length) % suggestions.length;
				return;
			}
			if (e.key === 'Enter') {
				e.preventDefault();
				pickGene(suggestions[activeSuggest]);
				return;
			}
			if (e.key === 'Escape') {
				showSuggest = false;
				return;
			}
		}
		if (e.key === 'Enter') run();
	}

	onMount(() => {
		initAnalytics();
		client = new GbzClient();
		run();
		return () => client?.terminate();
	});

	async function run(sourceKind: 'coords' | 'gene' | 'example' = 'coords') {
		error = null;
		oversized = null;
		queriedGene = null;
		lightStats = null;
		reducedMode = null;
		showSuggest = false;
		const qsource: QuerySource = { kind: 'url', url: graph.dbUrl };
		let locus;
		const raw = locusText.trim();
		try {
			// If it isn't a coordinate string, try to resolve it as a gene name.
			if (!looksLikeLocus(raw)) {
				const gene = await resolveGene(graph.refKey, raw);
				if (gene) {
					locusText = geneToLocus(gene);
					queriedGene = gene.name;
					sourceKind = 'gene';
				}
			}
			locus = parseLocus(locusText, graph.referenceSample);
			locus.sample = graph.referenceSample;
			locus.haplotypes = 'all';
		} catch (e) {
			// parseLocus's own message already gives a coordinate example; just add
			// the gene-symbol option rather than repeating the same example twice.
			error = e instanceof Error ? `${e.message}, or a gene symbol (e.g. HLA-A).` : String(e);
			return;
		}
		running = true;
		try {
			const result = await client!.query(qsource, locus);
			if (!result.ok) {
				error = `${result.error}\n${result.stderr ?? ''}`.trim();
				return;
			}
			let gfaText = result.gfa ?? '';
			fetchInfo = result.stats ?? null;

			if (gfaText.length > MAX_GFA_BYTES) {
				// Full (all-haplotype) query too big. On a large or repetitive locus,
				// haplotype walks — not sequence or topology — dominate GFA size (measured
				// ~97% of bytes on a real large locus): each haplotype can traverse the
				// same handful of nodes thousands of times. Segments/links are determined
				// by the query interval, not by which walks reference them, so we can drop
				// every walk but the reference locally — no second query needed, and no
				// extra network round-trip for data we already have in hand. This is
				// typically ~35x smaller, so it usually succeeds where the full query
				// didn't. Cost: no per-haplotype coverage heatmap, no raw walk listing, no
				// endpoint-artifact hints for this locus.
				const refOnlyText = filterToReferenceWalks(gfaText, graph.referenceSample);

				if (refOnlyText.length <= MAX_GFA_BYTES) {
					gfaText = refOnlyText;
					reducedMode = 'reference-only';
				} else {
					// Even reference-only is too big (rare — topology itself is huge).
					// Final fallback: line-counted stats only, never fully parsed, so
					// there's no size this can't at least summarize.
					lightStats = gfaLightStats(refOnlyText);
					oversized = { bytes: gfaText.length };
					parsed = null;
					rawGfa = '';
					trackEvent('query', {
						graph: graph.id,
						contig: locus.contig,
						start: locus.start,
						end: locus.end,
						span: locus.end - locus.start,
						input: sourceKind,
						oversized: true
					});
					return;
				}
			}

			rawGfa = gfaText;
			parsed = parseGfa(gfaText);
			trackEvent('query', {
				graph: graph.id,
				contig: locus.contig,
				start: locus.start,
				end: locus.end,
				span: locus.end - locus.start,
				input: sourceKind,
				reducedMode: !!reducedMode,
				oversized: false
			});
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			running = false;
		}
	}

	function selectGraph(id: 'grch38' | 'chm13') {
		if (id === graphId) return;
		graphId = id;
		locusText = DEFAULT_GENE;
		suggestions = [];
		showSuggest = false;
		trackEvent('select_graph', { graph: id });
		run();
	}

	function runExampleGene(gene: string) {
		locusText = gene;
		run('example');
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
			Explore an HPRC human pangenome graph at any locus, straight from the browser — pick a region
			by coordinates or gene name and the subgraph is read on demand, no multi-gigabyte download.
		</p>

		<details class="how">
			<summary>How the on-demand querying works</summary>
			<div class="how-body">
				<p>
					The graphs themselves are the <b>HPRC Release 2 Minigraph-Cactus pangenomes</b> — built by
					the Human Pangenome Reference Consortium. Each is distributed as a
					<code>.gbz</code> file of several gigabytes.
				</p>
				<p>
					Querying one by genomic coordinate normally means downloading the whole thing. Instead we
					use <b>GBZ-base</b> (<code>gbz2db</code> / <code>query</code>, part of the
					<a href="https://github.com/jltsiren/gbz-base" target="_blank" rel="noopener">vg / GBZ-base</a>
					tooling by Jouni Sirén and colleagues), which stores a graph in a SQLite database that
					<i>can</i> be queried by position.
				</p>
				<p>
					What <b>we</b> added: we compiled GBZ-base's <code>query</code> program to WebAssembly
					(<code>wasm32-wasip1</code>) and wrote a small WASI filesystem shim that backs SQLite's
					page reads with <b>HTTP range requests</b>. So the browser runs the real query engine in a
					Web Worker and pulls only the few megabytes of database pages a locus actually touches
					from the file on Cloudflare R2 — an approach inspired by
					<a href="https://42basepairs.com" target="_blank" rel="noopener">42basepairs</a>.
					The visualizations below (graph layout, variant arcs, the IGV.js
					track, and the reference-guided simplification) are a few prototypes we built for
					inspecting a graph's complex patterns around a particular reference locus.
				</p>
			</div>
		</details>
	</header>

	<section class="panel">
		<div class="graph-switch" role="group" aria-label="Choose pangenome graph">
			{#each GRAPHS as g (g.id)}
				<button
					class="gbtn"
					class:active={g.id === graphId}
					onclick={() => selectGraph(g.id)}
					disabled={running}
				>
					{g.label}
					<span class="gref">reference: {g.referenceSample}</span>
				</button>
			{/each}
			{#if running}<span class="muted small">working…</span>{/if}
		</div>

		<div class="row">
			<label class="locus-field">
				Locus or gene
				<div class="locus-input">
					<input
						type="text"
						bind:value={locusText}
						oninput={onLocusInput}
						onkeydown={onLocusKey}
						onblur={() => setTimeout(() => (showSuggest = false), 120)}
						onfocus={onLocusInput}
						placeholder="chr6:31972046-32055647 or HLA-A"
						autocomplete="off"
						size="30"
					/>
					{#if showSuggest && suggestions.length > 0}
						<ul class="suggest" role="listbox">
							{#each suggestions as s, i (s.name)}
								<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
								<li
									role="option"
									aria-selected={i === activeSuggest}
									class:active={i === activeSuggest}
									onmousedown={(e) => {
										e.preventDefault();
										pickGene(s);
									}}
								>
									<b>{s.name}</b>
									<span class="scoord">{s.contig}:{s.start.toLocaleString()}-{s.end.toLocaleString()}</span>
								</li>
							{/each}
						</ul>
					{/if}
				</div>
			</label>
			<button onclick={() => run()} disabled={running}>{running ? 'Querying…' : 'Query'}</button>
		</div>

		<div class="row">
			<span class="muted small">examples:</span>
			{#each EXAMPLE_GENES as gene (gene)}
				<button class="chip" onclick={() => runExampleGene(gene)} disabled={running}>
					{gene}
				</button>
			{/each}
		</div>

		<p class="provenance muted small">
			Source: <code>{graph.s3Source}</code> — the public HPRC v2.0 Minigraph-Cactus graph. We
			converted it to a GBZ-base <code>.gbz.db</code> (SQLite) and host it on Cloudflare R2 for
			coordinate range queries.
		</p>
	</section>

	{#if error}
		<pre class="error">{error}</pre>
	{/if}

	{#if oversized}
		<section class="panel">
			<p class="oversized">
				<b>This region is too large to render, even reference-only.</b> Here's what we can tell
				you about it without parsing the full thing:
			</p>
			{#if lightStats}
				<div class="stats">
					<div><b>{lightStats.segments.toLocaleString()}</b><span>segments</span></div>
					<div><b>{lightStats.links.toLocaleString()}</b><span>links</span></div>
					<div><b>{lightStats.walks.toLocaleString()}</b><span>haplotype walks</span></div>
					<div><b>{lightStats.totalSequenceBp.toLocaleString()}</b><span>bp of sequence</span></div>
					<div><b>{lightStats.samples.toLocaleString()}</b><span>samples</span></div>
				</div>
			{/if}
			<p class="muted small">
				~{fmtBytes(oversized.bytes)} of raw graph — parsing and laying that out would use enough
				memory to crash the tab, so it's been skipped entirely. Try a smaller window (a few
				hundred kb or less; the built-in examples are ≤ ~100 kb) or a specific gene.
			</p>
			{#if fetchInfo}
				<p class="muted small">
					Fetched <b>{fmtBytes(fetchInfo.bytesFetched)}</b> in {fetchInfo.requestCount} block reads · {fetchInfo.elapsedMs}
					ms
				</p>
			{/if}
		</section>
	{/if}

	{#if reducedMode === 'reference-only'}
		<section class="panel reduced-mode">
			<p class="reduced-note">
				<b>Showing reference topology only.</b> The full query (every haplotype) was too large to
				render — on a large or repetitive locus, haplotype walks dominate the data, not sequence or
				topology. This falls back to the reference path plus the full structural graph (every
				variant node/edge that exists anywhere in the pangenome is still here), just without
				per-haplotype coverage: no coverage heatmap, no raw walk listing below, no "N haplotypes
				support this" counts.
			</p>
		</section>
	{/if}

	{#if stats && gfa}
		<section class="panel">
			{#if queriedGene}
				<p class="gene-tag muted small">
					Searched gene: <b>{queriedGene}</b> · <code>{locusText}</code>
				</p>
			{/if}
			<div class="stats">
				<div><b>{stats.segments.toLocaleString()}</b><span>segments</span></div>
				<div><b>{stats.links.toLocaleString()}</b><span>links</span></div>
				<div><b>{stats.walks.toLocaleString()}</b><span>haplotype walks</span></div>
				{#if stats.referencePathBp != null}
					<div><b>{stats.referencePathBp.toLocaleString()}</b><span>bp of reference path</span></div>
				{/if}
				<div><b>{stats.totalSequenceBp.toLocaleString()}</b><span>bp of total sequence</span></div>
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
			<div class="title-row">
				<h2 class="panel-title">Reference-anchored graph layout</h2>
				<a class="pg-link" href="{base}/playground">Simplification playground →</a>
			</div>
			<GraphLayoutView {gfa} referenceSample={graph.referenceSample} />
		</section>

		<section class="panel">
			<h2 class="panel-title">Large non-reference nodes</h2>
			<RefArcView {gfa} referenceSample={graph.referenceSample} />
		</section>

		<section class="panel">
			<h2 class="panel-title">Genome browser (IGV.js)</h2>
			<IgvView {gfa} referenceSample={graph.referenceSample} />
		</section>

		<section class="panel">
			<h2 class="panel-title">Raw data</h2>
			<RawDataView gfa={parsed ?? gfa} rawText={rawGfa} />
		</section>
	{/if}

	<section class="panel ack">
		<h2 class="panel-title">Acknowledgements</h2>
		<p class="muted small">
			Big thanks to:
		</p>
		<ul class="ack-list">
			<li>
				<b>The Human Pangenome Reference Consortium (HPRC)</b> and the
				<b>Minigraph-Cactus</b> team for building and openly releasing the pangenome graphs shown
				here.
			</li>
			<li>
				<b>GBZ-base</b> and the <b>vg</b> toolkit (Jouni Sirén and colleagues) for
				<code>gbz2db</code>/<code>query</code>, which make coordinate queries over a graph
				possible.
			</li>
			<li>
				<b>browser_wasi_shim</b> (@bjorn3) for running the WASI query binary in the browser, and the
				<b>SQLite</b> and <b>Rust</b> projects underneath it.
			</li>
			<li>
				<b>IGV.js</b> and <b>D3</b> for visualization frameworks.
			</li>
			<li>
				<b>Bandage</b> for the strand-like node rendering style that the reference-anchored graph
				layout draws inspiration from.
			</li>
			<li>
				<b>42basepairs</b> for the range-request idea that this is modelled on.
			</li>
			<li>Gene coordinates from <b>GENCODE</b> (GRCh38) and the <b>T2T-CHM13v2.0</b> annotation.</li>
		</ul>
	</section>

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
		margin: 0 0 0.8rem;
		color: #555;
	}
	.how {
		margin-bottom: 0.4rem;
		font-size: 0.85rem;
	}
	.how summary {
		cursor: pointer;
		color: #2563eb;
		font-weight: 600;
		width: fit-content;
	}
	.how-body {
		margin-top: 0.5rem;
		padding: 0.6rem 0.9rem;
		border-left: 3px solid #dbeafe;
		background: #f8faff;
		border-radius: 0 8px 8px 0;
		color: #444;
	}
	.how-body p {
		margin: 0 0 0.6rem;
	}
	.how-body p:last-child {
		margin-bottom: 0;
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
	.title-row {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.8rem;
		flex-wrap: wrap;
	}
	.title-row .panel-title {
		margin: 0 0 0.8rem;
	}
	.row {
		display: flex;
		align-items: flex-end;
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
	input[type='number'] {
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

	/* --- graph switch --- */
	.graph-switch {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		flex-wrap: wrap;
		margin-bottom: 0.9rem;
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
	.gbtn {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.1rem;
		background: #f3f4f6;
		color: #1f2937;
		border: 1px solid #d1d5db;
		padding: 0.45rem 0.9rem;
		line-height: 1.2;
	}
	.gbtn:hover:not(:disabled) {
		background: #e5e7eb;
	}
	.gbtn.active {
		background: #2563eb;
		border-color: #2563eb;
		color: #fff;
	}
	.gbtn .gref {
		font-size: 0.68rem;
		font-weight: 500;
		opacity: 0.75;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
	}

	/* --- locus field + gene autocomplete --- */
	.locus-field {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	.locus-input {
		position: relative;
	}
	.suggest {
		position: absolute;
		top: calc(100% + 2px);
		left: 0;
		right: 0;
		z-index: 30;
		margin: 0;
		padding: 4px;
		list-style: none;
		background: #fff;
		border: 1px solid #e2e5ea;
		border-radius: 8px;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
		max-height: 260px;
		overflow-y: auto;
	}
	.suggest li {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 0.8rem;
		padding: 0.3rem 0.5rem;
		border-radius: 5px;
		cursor: pointer;
		font-size: 0.85rem;
	}
	.suggest li.active,
	.suggest li:hover {
		background: #eef2ff;
	}
	.suggest .scoord {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.74rem;
		color: #6b7280;
		white-space: nowrap;
	}
	.provenance {
		margin: 0.4rem 0 0;
		padding-top: 0.6rem;
		border-top: 1px solid #f0f0f0;
	}
	.provenance code {
		word-break: break-all;
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
	.gene-tag {
		margin: 0 0 0.6rem;
	}
	.gene-tag code {
		background: #f0f0f0;
		padding: 0 4px;
		border-radius: 4px;
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
	.oversized {
		margin: 0 0 0.4rem;
		color: #92400e;
		font-size: 0.9rem;
		line-height: 1.5;
	}
	.reduced-mode {
		background: #f8faff;
		border-color: #dbeafe;
	}
	.reduced-note {
		margin: 0;
		color: #444;
		font-size: 0.85rem;
		line-height: 1.5;
	}
	.ack-list {
		margin: 0.4rem 0 0;
		padding-left: 1.1rem;
		font-size: 0.82rem;
		color: #555;
		line-height: 1.6;
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
