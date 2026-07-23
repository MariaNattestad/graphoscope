<script lang="ts">
	import { onMount } from 'svelte';
	import { GbzClient, parseLocus, type QuerySource } from '$lib/gbzClient';
	import { parseGfa, gfaStats, type Gfa } from '$lib/gfa';
	import RefArcView from '$lib/RefArcView.svelte';
	import RawDataView from '$lib/RawDataView.svelte';
	import GraphLayoutView from '$lib/graph/GraphLayoutView.svelte';
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
	// The last three are loci that used to be unrenderable: before the reduce
	// moved into the wasm query, LPA's ~50 MB of haplotype walks crashed the tab
	// outright, and the fallback that avoided the crash also left the graph
	// unsimplified. Measured now: LPA 9,406 → 635 nodes in ~6 s, MUC5B
	// 3,218 → 169, C4A 758 → 58. Keeping them visible is the point — they are
	// where the pangenome is actually interesting.
	const EXAMPLE_GENES = ['HLA-A', 'AMY1A', 'SMN1', 'CYP2D6', 'LPA', 'MUC5B', 'C4A'];
	// SMN1 is the lightest of the four examples (35 segments vs. HLA-A's 130,
	// ~35 KiB less to fetch, layout in well under a second) — the default should
	// load fast and stay responsive on mobile, not showcase the heaviest case.
	const DEFAULT_GENE = 'SMN1';

	let graphId = $state<'grch38' | 'chm13'>('grch38');
	const graph = $derived(GRAPHS.find((g) => g.id === graphId)!);

	// Backstop only. The walks that used to dominate GFA size (and blow up the tab
	// once parsed into per-step objects) are aggregated away in the wasm query, so
	// a reduced response is governed by topology: measured loci from 10 kb to
	// 3.2 Mb all came back three orders of magnitude under this ceiling. Reaching
	// it means something pathological, and we refuse rather than try to render.
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
	// The graph the widgets see. It arrives already simplified + walk-counted from
	// the wasm `query --format reduced` step (small-variant popping, unchop, and
	// per-node/edge coverage tags), so the browser never parses the full,
	// walk-dominated GFA — that server-side reduction is the whole memory win.
	let gfa = $state<Gfa | null>(null);
	let rawGfa = $state<string>('');
	// Set only if the reduced GFA somehow still exceeds MAX_GFA_BYTES.
	let oversized = $state<{ bytes: number } | null>(null);
	let fetchInfo = $state<{
		requestCount: number;
		bytesFetched: number;
		dbSize: number;
		elapsedMs: number;
	} | null>(null);

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
			// The wasm query (crates/reduce) simplifies and walk-counts before it
			// ever returns, so the browser receives a graph sized by topology, not by
			// haplotype count. This is what keeps a large/repetitive locus from
			// blowing up the tab. The collapse threshold is the reducer's default;
			// it isn't exposed as a control because changing it re-runs the query
			// and then re-runs the layout, which is a long stall for a knob most
			// people don't need. Anyone who wants the uncollapsed graph can
			// download it instead (downloadRaw below).
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
			const gfaText = result.gfa ?? '';
			fetchInfo = result.stats ?? null;

			if (gfaText.length > MAX_GFA_BYTES) {
				// Backstop only. The walks are aggregated away before this point, so
				// the reduced graph is governed by topology and is normally tiny —
				// measured loci up to 3.2 Mb land three orders of magnitude under this
				// ceiling. Reaching it means something pathological, so just refuse.
				oversized = { bytes: gfaText.length };
				gfa = null;
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

			rawGfa = gfaText;
			gfa = parseGfa(gfaText);
			trackEvent('query', {
				graph: graph.id,
				contig: locus.contig,
				start: locus.start,
				end: locus.end,
				span: locus.end - locus.start,
				input: sourceKind,
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

	// ---- Break-glass: view the unsimplified graph -------------------------------
	// Simplification is what makes a locus renderable, but sometimes you want to
	// see the whole thing — the workaround was downloading the GFA and opening it
	// in Bandage. This loads it into the layout instead.
	//
	// Guarded on node count rather than offered unconditionally: the unsimplified
	// graph is what the reduce exists to avoid, so it has to be a deliberate
	// choice, and past MAX_UNSIMPLIFIED_NODES it would take minutes to lay out
	// and gigabytes to hold. Between the two, the layout drops to rough mode on
	// its own (see GraphLayoutView).
	const MAX_UNSIMPLIFIED_NODES = 25000;
	let unsimplified = $state<Gfa | null>(null);
	let loadingUnsimplified = $state(false);
	let showUnsimplified = $state(false);
	/** Nodes the unsimplified graph would have, known from the reduced X line. */
	const unsimplifiedNodes = $derived(gfa?.reduced?.segmentsBefore ?? 0);
	const canShowUnsimplified = $derived(
		unsimplifiedNodes > 0 && unsimplifiedNodes <= MAX_UNSIMPLIFIED_NODES
	);
	/** What the layout is actually drawing. */
	const displayGfa = $derived(showUnsimplified && unsimplified ? unsimplified : gfa);

	async function toggleUnsimplified() {
		if (showUnsimplified) {
			showUnsimplified = false;
			return;
		}
		if (unsimplified) {
			showUnsimplified = true;
			return;
		}
		if (!client || loadingUnsimplified) return;
		loadingUnsimplified = true;
		try {
			const locus = parseLocus(locusText, graph.referenceSample);
			locus.sample = graph.referenceSample;
			locus.raw = true;
			const result = await client.query({ kind: 'url', url: graph.dbUrl }, locus);
			if (!result.ok) {
				error = `${result.error}\n${result.stderr ?? ''}`.trim();
				return;
			}
			trackEvent('widget_interact', { widget: 'graph_layout', action: 'view_unsimplified' });
			unsimplified = parseGfa(result.gfa ?? '');
			showUnsimplified = true;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			loadingUnsimplified = false;
		}
	}

	// A new query invalidates the cached unsimplified graph.
	$effect(() => {
		gfa;
		unsimplified = null;
		showUnsimplified = false;
	});

	// Fetches the unsimplified subgraph — every haplotype walk — purely to hand
	// the user a file. It is streamed straight to a download and never parsed:
	// on a repetitive locus this is the tens-of-megabytes response that the
	// reduced pipeline exists to avoid putting in the browser's heap.
	let downloadingRaw = $state(false);
	async function downloadRaw() {
		if (!client || downloadingRaw) return;
		downloadingRaw = true;
		try {
			const locus = parseLocus(locusText, graph.referenceSample);
			locus.sample = graph.referenceSample;
			locus.raw = true;
			const result = await client.query({ kind: 'url', url: graph.dbUrl }, locus);
			if (!result.ok) {
				error = `${result.error}\n${result.stderr ?? ''}`.trim();
				return;
			}
			trackEvent('widget_interact', { widget: 'raw_data', action: 'download_unsimplified_gfa' });
			const blob = new Blob([result.gfa ?? ''], { type: 'text/plain' });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = `${locus.contig}_${locus.start}-${locus.end}.unsimplified.gfa`;
			a.click();
			URL.revokeObjectURL(url);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			downloadingRaw = false;
		}
	}

	function fmtBytes(n: number): string {
		if (n < 1024) return `${n} B`;
		if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
		if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
		return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
	}
</script>

<main>
	<header class="topbar">
		<h1>Graphoscope</h1>
		<span class="tagline">HPRC human pangenome graphs, queried by locus</span>
		<span class="spacer"></span>
		<div class="graph-switch" role="group" aria-label="Choose pangenome graph">
			{#each GRAPHS as g (g.id)}
				<button
					class="gbtn"
					class:active={g.id === graphId}
					onclick={() => selectGraph(g.id)}
					disabled={running}
					title="reference: {g.referenceSample}"
				>
					{g.label}
				</button>
			{/each}
		</div>
		<a class="pg-link" href="{base}/playground">Playground →</a>
	</header>

	<section class="toolbar">
		<label class="locus-field">
			<span class="lbl">Locus or gene</span>
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
					size="26"
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
		<button class="go" onclick={() => run()} disabled={running}>
			{running ? 'Querying…' : 'Query'}
		</button>
		<span class="examples">
			{#each EXAMPLE_GENES as gene (gene)}
				<button class="chip" onclick={() => runExampleGene(gene)} disabled={running}>
					{gene}
				</button>
			{/each}
		</span>
	</section>

	{#if error}
		<pre class="error">{error}</pre>
	{/if}

	{#if oversized}
		<section class="panel">
			<p class="oversized">
				<b>This region's graph is too tangled to render.</b> Even after simplification it came back at
				~{fmtBytes(oversized.bytes)}, which is far past anything we've seen from a normal locus — try
				a smaller window or a specific gene.
			</p>
		</section>
	{/if}

	{#if stats && gfa}
		<section class="panel graph-panel">
			<div class="title-row">
				<h2 class="panel-title">
					Reference-anchored graph layout
					{#if queriedGene}<span class="muted small">· {queriedGene} · <code>{locusText}</code></span
						>{/if}
				</h2>
				{#if canShowUnsimplified}
					<button
						class="mini-toggle"
						class:on={showUnsimplified}
						onclick={toggleUnsimplified}
						disabled={loadingUnsimplified}
						title="Load every node, before small-variant collapsing — {unsimplifiedNodes.toLocaleString()} nodes"
					>
						{#if loadingUnsimplified}
							loading…
						{:else if showUnsimplified}
							showing all {unsimplifiedNodes.toLocaleString()} nodes — simplify
						{:else}
							show all {unsimplifiedNodes.toLocaleString()} nodes
						{/if}
					</button>
				{:else if unsimplifiedNodes > MAX_UNSIMPLIFIED_NODES}
					<span class="muted small" title="Download it from the data panel below to inspect elsewhere">
						{unsimplifiedNodes.toLocaleString()} nodes unsimplified — too many to render
					</span>
				{/if}
			</div>
			{#if displayGfa}
				<GraphLayoutView gfa={displayGfa} referenceSample={graph.referenceSample} />
			{/if}
		</section>

		<section class="panel">
			<h2 class="panel-title">This locus</h2>
			<table class="statstable">
				<thead>
					<tr>
						<th></th>
						<th>as stored</th>
						<th>after simplification</th>
					</tr>
				</thead>
				<tbody>
					<tr>
						<th>nodes</th>
						<td>{(gfa.reduced?.segmentsBefore ?? stats.segments).toLocaleString()}</td>
						<td><b>{stats.segments.toLocaleString()}</b></td>
					</tr>
					<tr>
						<th>links</th>
						<td>{(gfa.reduced?.linksBefore ?? stats.links).toLocaleString()}</td>
						<td><b>{stats.links.toLocaleString()}</b></td>
					</tr>
					<tr>
						<th>haplotype walks</th>
						<td>{stats.walks.toLocaleString()}</td>
						<td class="muted">counted per node, not stored</td>
					</tr>
					{#if gfa.reduced}
						<tr>
							<th>sites collapsed</th>
							<td class="muted">—</td>
							<td
								>{gfa.reduced.sites.toLocaleString()}
								<span class="muted"
									>({gfa.reduced.snpCount.toLocaleString()} SNPs, {gfa.reduced.basesRemoved.toLocaleString()}
									alt bp)</span
								></td
							>
						</tr>
						<tr>
							<th>chains merged</th>
							<td class="muted">—</td>
							<td>{gfa.reduced.unchopMerges.toLocaleString()}</td>
						</tr>
					{/if}
					{#if stats.referencePathBp != null}
						<tr>
							<th>reference span</th>
							<td colspan="2">{stats.referencePathBp.toLocaleString()} bp</td>
						</tr>
					{/if}
					<tr>
						<th>sequence shown</th>
						<td colspan="2">{stats.totalSequenceBp.toLocaleString()} bp</td>
					</tr>
					<tr>
						<th>samples</th>
						<td colspan="2">{stats.samples.toLocaleString()}</td>
					</tr>
				</tbody>
			</table>
			{#if fetchInfo}
				<p class="muted small">
					Fetched <b>{fmtBytes(fetchInfo.bytesFetched)}</b> in {fetchInfo.requestCount} block reads from
					a {fmtBytes(fetchInfo.dbSize)} database · {fetchInfo.elapsedMs} ms
				</p>
			{/if}
		</section>

		<section class="panel">
			<h2 class="panel-title">Large non-reference nodes</h2>
			<RefArcView {gfa} referenceSample={graph.referenceSample} refKey={graph.refKey} />
		</section>

		<section class="panel">
			<h2 class="panel-title">Simplified graph data</h2>
			<RawDataView {gfa} rawText={rawGfa} {downloadRaw} {downloadingRaw} />
		</section>
	{/if}

	<section class="panel">
		<h2 class="panel-title">How the on-demand querying works</h2>
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
				The visualizations above (graph layout, variant arcs with a gene track, and the
				simplification described next) are a few prototypes we built for inspecting a graph's
				complex patterns around a particular reference locus.
			</p>
			<p>
				A raw locus can still be far too tangled to read — and, more to the point, far too heavy to
				hold in a browser tab, since the per-haplotype walks through the graph dominate the data
				(for a repetitive locus like <b>LPA</b> they are the great majority of the bytes). So before
				anything is drawn, Graphoscope runs its own <b>reference-guided simplification</b> — a second
				WebAssembly module we wrote (<code>crates/reduce</code>, independent of GBZ-base) that reads
				the query's output as a stream and never materialises the whole graph. Anchored on the
				reference path, it detects the <i>superbubbles</i> hanging off it and collapses any whose
				alternate alleles are shorter than a <b>collapse threshold</b> (50&nbsp;bp), then merges the
				resulting non-branching runs of nodes into single segments.
				Crucially, instead of keeping every walk it just <b>counts</b> how many pass through each node
				and edge — that count is what the yellow&#8202;→&#8202;red colouring shows. The effect on
				memory is large: a locus like LPA drops from hundreds of megabytes of parsed graph to a few.
			</p>
			<p>
				Currently showing: <code>{graph.s3Source}</code> — the public HPRC v2.0 Minigraph-Cactus
				graph, converted to a GBZ-base <code>.gbz.db</code> (SQLite) and hosted on Cloudflare R2
				for coordinate range queries.
			</p>
		</div>
	</section>

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
	.how-body {
		margin-top: 0.5rem;
		font-size: 0.85rem;
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
	.topbar {
		display: flex;
		align-items: baseline;
		gap: 0.75rem;
		flex-wrap: wrap;
		padding: 0 0 0.75rem;
		border-bottom: 1px solid #ececec;
		margin-bottom: 0.75rem;
	}
	.topbar h1 {
		margin: 0;
		font-size: 1.15rem;
	}
	.topbar .tagline {
		color: #777;
		font-size: 0.82rem;
	}
	.topbar .spacer {
		flex: 1;
	}
	.toolbar {
		display: flex;
		align-items: flex-end;
		gap: 0.6rem;
		flex-wrap: wrap;
		margin-bottom: 0.75rem;
	}
	.toolbar .lbl {
		display: block;
		font-size: 0.72rem;
		color: #777;
		margin-bottom: 0.15rem;
	}
	.toolbar .examples {
		display: flex;
		gap: 0.3rem;
		flex-wrap: wrap;
		align-items: center;
	}
	.toolbar .go {
		padding: 0.4rem 1rem;
	}
	.mini-toggle {
		font: inherit;
		font-size: 0.75rem;
		padding: 0.2rem 0.6rem;
		border: 1px solid #d0d0d0;
		background: #fff;
		border-radius: 6px;
		color: #444;
		cursor: pointer;
	}
	.mini-toggle:hover:not(:disabled) {
		border-color: #999;
	}
	.mini-toggle.on {
		background: #2563eb;
		border-color: #2563eb;
		color: #fff;
	}
	.mini-toggle:disabled {
		opacity: 0.6;
		cursor: default;
	}
	.graph-panel {
		margin-bottom: 0.75rem;
	}
	.statstable {
		border-collapse: collapse;
		font-size: 0.85rem;
		min-width: min(520px, 100%);
	}
	.statstable th,
	.statstable td {
		text-align: left;
		padding: 0.3rem 1rem 0.3rem 0;
		border-bottom: 1px solid #f0f0f0;
		white-space: nowrap;
	}
	.statstable thead th {
		font-size: 0.72rem;
		font-weight: 500;
		color: #888;
		text-transform: uppercase;
		letter-spacing: 0.03em;
	}
	.statstable tbody th {
		font-weight: 400;
		color: #555;
	}
	.statstable td {
		font-variant-numeric: tabular-nums;
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
	label {
		font-size: 0.9rem;
	}
	input[type='text'] {
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
