<script lang="ts">
	import { onMount } from 'svelte';
	import { GbzClient, parseLocus, DEFAULT_CONTEXT, type QuerySource } from '$lib/gbzClient';
	import { parseGfa, gfaStats, type Gfa } from '$lib/gfa';
	import RawDataView from '$lib/RawDataView.svelte';
	import AppBar from '$lib/AppBar.svelte';
	import GraphLayoutView from '$lib/graph/GraphLayoutView.svelte';
	import QueryReport from '$lib/graph/QueryReport.svelte';
	import { initAnalytics, trackEvent } from '$lib/analytics';
	import { searchGenes, resolveGene, geneToLocus, type GeneEntry } from '$lib/genes';
	import { GRAPHS, DEFAULT_GENE, MAX_GFA_BYTES, type GraphId } from '$lib/graphs';
	import { limits } from '$lib/limits.svelte';
	import { base } from '$app/paths';

	let client: GbzClient | null = null;

	// The two hosted graphs (definitions in $lib/graphs, shared with the /api
	// route). Example loci are gene symbols, not raw coordinates — resolved through the
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

	let graphId = $state<GraphId>('grch38');
	const graph = $derived(GRAPHS.find((g) => g.id === graphId)!);

	// ---- Query state -----------------------------------------------------------
	let locusText = $state(DEFAULT_GENE);
	// Subgraph context radius in bp (GBZ-base's `--context`, wasm default 100): how
	// far past the locus haplotypes are followed before they're cut off. Applied on
	// the next query, so changing it takes a Query click like the locus does.
	const DEFAULT_CONTEXT_BP = DEFAULT_CONTEXT;
	let contextBp = $state(DEFAULT_CONTEXT_BP);
	// Set to the resolved gene's symbol whenever the current results came from a
	// gene-name search (manual or an example chip) — kept alongside the
	// coordinates so a user can look back and remember what they searched for,
	// since `locusText` itself gets overwritten with the resolved coordinates.
	let queriedGene = $state<string | null>(null);

	// State
	let running = $state(false);
	let error = $state<string | null>(null);
	// Which visualization fills the main workspace, and whether the About/docs
	// overlay is open. UI-only, so plain local state. (The variant arcs, once their
	// own tab, are now an optional track inside the graph layout view.)
	let view = $state<'graph' | 'data'>('graph');
	// The query popover, opened from the header pill: reference graph, locus/gene,
	// examples, and context — everything needed to compose or change a query. The
	// graph stays visible behind a dim scrim. Closed by the pill, the scrim, Escape,
	// or running a query.
	let queryOpen = $state(false);
	// The locus field inside that popover, focused + selected when it opens.
	let queryInputEl = $state<HTMLInputElement | null>(null);
	// One-line explanation of each hosted graph, shown in that popover so the
	// choice isn't just two opaque labels.
	const GRAPH_BLURB: Record<GraphId, string> = {
		grch38: 'The standard human reference. Coordinates most tools and papers use.',
		chm13: 'The T2T complete assembly — gapless, including centromeres and other regions GRCh38 leaves out.'
	};
	// The graph the widgets see. It arrives already simplified + walk-counted from
	// the wasm `query --format reduced` step (small-variant popping, unchop, and
	// per-node/edge coverage tags), so the browser never parses the full,
	// walk-dominated GFA — that server-side reduction is the whole memory win.
	//
	// `$state.raw`: the parsed GFA is large (segments, links, and walks with many
	// steps) and only ever reassigned wholesale, never mutated. Plain `$state`
	// would deep-proxy all of it, and then every read — including the deep clone
	// the layout worker needs — pays Svelte's proxy-trap cost per access, which was
	// blocking the main thread ~1s when re-laying-out the full graph. Raw keeps it
	// as plain objects: fast to read and to structured-clone across the worker.
	let gfa = $state.raw<Gfa | null>(null);
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

	// ---- Shareable URL: ?ref=grch38|chm13 & ?locus=<gene or contig:start-end> --
	// These make a query a single link — the thing an AI agent (or a colleague)
	// can construct, open, and reproduce. On load we adopt them; after each query
	// we write the current state back, preferring the gene symbol over resolved
	// coordinates so the link stays legible (e.g. ?locus=SMN1, not chr5:709…).
	function applyUrlParams(): boolean {
		const p = new URLSearchParams(window.location.search);
		const ref = p.get('ref');
		if (ref === 'grch38' || ref === 'chm13') graphId = ref;
		const ctxParam = p.get('context');
		if (ctxParam != null) {
			const ctx = Number(ctxParam);
			if (Number.isFinite(ctx) && ctx >= 0) contextBp = ctx;
		}
		const locus = p.get('locus') ?? p.get('gene');
		if (locus && locus.trim()) {
			locusText = locus.trim();
			return true;
		}
		return false;
	}

	function syncUrlParams() {
		const p = new URLSearchParams(window.location.search);
		p.set('ref', graphId);
		p.set('locus', queriedGene ?? locusText);
		if (contextBp !== DEFAULT_CONTEXT_BP) p.set('context', String(contextBp));
		else p.delete('context');
		const qs = p.toString();
		// replaceState (not a navigation) so this never reloads or adds history
		// entries — it just keeps the address bar reproducible.
		window.history.replaceState(window.history.state, '', `${window.location.pathname}?${qs}`);
	}

	onMount(() => {
		initAnalytics();
		client = new GbzClient();
		applyUrlParams();
		run();
		return () => client?.terminate();
	});

	// Focus + select the locus field whenever the query popover opens, so the user
	// can immediately overtype what they're replacing.
	$effect(() => {
		if (queryOpen && queryInputEl) {
			queryInputEl.focus();
			queryInputEl.select();
		}
	});

	async function run(sourceKind: 'coords' | 'gene' | 'example' = 'coords') {
		error = null;
		oversized = null;
		queriedGene = null;
		showSuggest = false;
		queryOpen = false;
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
			locus.context = contextBp;
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
			// Reflect the query in the address bar so the link reproduces it. Runs
			// on success and failure alike — a link to a bad locus is still worth
			// being able to share.
			syncUrlParams();
		}
	}


	function selectGraph(id: GraphId) {
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

	// Widen the context and re-query the current locus. Offered from the off-locus
	// exit inspector in the graph, where "there's more past the edge" is the whole
	// point; doubling is a meaningful jump without a fiddly guess (100 → 200 → 400).
	function requestMoreContext() {
		contextBp = contextBp > 0 ? contextBp * 2 : 200;
		trackEvent('widget_interact', { widget: 'graph_layout', action: 'increase_context' });
		run();
	}

	// ---- Break-glass: view the unsimplified graph -------------------------------
	// Simplification is what makes a locus renderable, but sometimes you want to
	// see the whole thing — the workaround was downloading the GFA and opening it
	// in Bandage. This loads it into the layout instead.
	//
	// Guarded rather than offered unconditionally: the unsimplified graph is what
	// the reduce exists to avoid, so it has to be a deliberate choice, and a big one
	// is slow to lay out and heavy to hold. The ceiling (and its much lower mobile
	// value, where holding every walk can crash the tab) lives in the shared `limits`
	// module. `walkLoadTier === 'risky'` folds in both the node cap and the memory
	// cap; on a memory-constrained device that means we don't offer it at all.
	// Raw for the same reason as `gfa` above: large, reassigned wholesale, and deep
	// cloned to the layout worker — proxying it would tax every read.
	let unsimplified = $state.raw<Gfa | null>(null);
	let loadingUnsimplified = $state(false);
	let showUnsimplified = $state(false);
	/** Nodes the unsimplified graph would have, known from the reduced X line. */
	const unsimplifiedNodes = $derived(gfa?.reduced?.segmentsBefore ?? 0);
	const unsimplifiedTier = $derived(limits.walkLoadTier(gfa?.reduced));
	// Refuse the full graph when it's 'risky' — too many nodes to lay out (desktop:
	// too slow) or too many walk-records to hold (mobile: an OOM risk). The tier folds
	// in both caps at their device-scaled values, so this one check covers "too slow
	// on desktop" and "would crash a phone" alike; the message names which.
	const canShowUnsimplified = $derived(unsimplifiedNodes > 0 && unsimplifiedTier !== 'risky');
	/** What the layout is actually drawing. */
	const displayGfa = $derived(showUnsimplified && unsimplified ? unsimplified : gfa);

	// One in-browser cache of the full (unsimplified) subgraph for the current
	// locus, shared by everything that needs it — the "show all nodes" toggle,
	// disco-walks, and the raw download — so the range round-trips (and the
	// tens-of-MB response they pull) happen at most once, whichever feature asks
	// first. Two layers, because the consumers want different forms of it:
	//   • `unsimplifiedGfaText` — the raw GFA text, what the download writes to a file.
	//   • `unsimplified`        — that text parsed into a `Gfa`, what the layout draws.
	// Both are cleared together when a new query invalidates the locus (below).
	let unsimplifiedGfaText = $state<string | null>(null);
	// Dedupes concurrent fetches (e.g. clicking disco-walks while a download is
	// already in flight) onto a single request instead of firing the range
	// fetches twice. Not reactive — purely a concurrency guard.
	let unsimplifiedFetch: Promise<string | null> | null = null;

	// Fetch the unsimplified subgraph's GFA text once and cache it. Returns the
	// cached text on any later call for the same locus.
	async function fetchUnsimplifiedGfa(): Promise<string | null> {
		if (unsimplifiedGfaText !== null) return unsimplifiedGfaText;
		if (unsimplifiedFetch) return unsimplifiedFetch;
		if (!client) return null;
		unsimplifiedFetch = (async () => {
			try {
				const locus = parseLocus(locusText, graph.referenceSample);
				locus.sample = graph.referenceSample;
				locus.context = contextBp;
				locus.raw = true;
				const result = await client!.query({ kind: 'url', url: graph.dbUrl }, locus);
				if (!result.ok) {
					error = `${result.error}\n${result.stderr ?? ''}`.trim();
					return null;
				}
				unsimplifiedGfaText = result.gfa ?? '';
				return unsimplifiedGfaText;
			} catch (e) {
				error = e instanceof Error ? e.message : String(e);
				return null;
			} finally {
				unsimplifiedFetch = null;
			}
		})();
		return unsimplifiedFetch;
	}

	// Load + parse the unsimplified subgraph (every haplotype walk) and switch the
	// layout to it. Shared by the "show all nodes" toggle and disco-walks, which
	// both need the full graph; the fetch itself goes through the shared cache
	// above, so a prior download (or vice-versa) means no second round-trip.
	// `showUnsimplified` is flipped together with the parsed graph (not by the
	// caller after the await) so there's never a frame where loading has finished
	// but the layout is still the reduced graph — disco's pending-start effect keys
	// off exactly that transition and would otherwise be dropped in the gap.
	// Returns whether the full graph is now showing.
	// Fetch + parse the full graph into `unsimplified` without switching the view to
	// it. Used both by the "show all nodes" toggle (which then shows it) and by
	// disco-walks (which hands it off for background layout, showing it only once
	// laid out).
	async function ensureUnsimplifiedParsed(): Promise<Gfa | null> {
		if (unsimplified) return unsimplified;
		if (loadingUnsimplified) return null;
		loadingUnsimplified = true;
		try {
			const text = await fetchUnsimplifiedGfa();
			if (text === null) return null;
			unsimplified = parseGfa(text);
			return unsimplified;
		} finally {
			loadingUnsimplified = false;
		}
	}

	async function toggleUnsimplified() {
		if (showUnsimplified) {
			showUnsimplified = false;
			return;
		}
		if (!unsimplified) {
			trackEvent('widget_interact', { widget: 'graph_layout', action: 'view_unsimplified' });
		}
		if (await ensureUnsimplifiedParsed()) showUnsimplified = true;
	}

	// disco-walks asked for the full-walk graph. Load it, then hand it to the layout
	// view as `discoPrewarmGfa` to lay out *in the background* — the reduced graph
	// stays on screen and interactive meanwhile — disco animates over the displayed
	// (simplified) graph, mapping the loaded walks onto it, so no swap is needed.
	async function requestDiscoGraph() {
		await ensureUnsimplifiedParsed(); // populates `unsimplified` (passed as discoWalksGfa)
	}

	// A new query invalidates every cached form of the previous locus's full graph.
	$effect(() => {
		gfa;
		unsimplifiedGfaText = null;
		unsimplified = null;
		showUnsimplified = false;
	});

	// Hands the user the unsimplified subgraph — every haplotype walk — as a file.
	// Fetches through the shared cache, so if the full graph was already pulled for
	// the layout (show-all-nodes / disco-walks) this reuses it with no round-trip;
	// and if the download comes first, it seeds the cache for those in turn. On a
	// repetitive locus this is the tens-of-megabytes response the reduced pipeline
	// avoids parsing — held once here, and dropped as soon as the locus changes.
	let downloadingRaw = $state(false);
	async function downloadRaw() {
		if (downloadingRaw) return;
		downloadingRaw = true;
		try {
			const text = await fetchUnsimplifiedGfa();
			if (text === null) return;
			trackEvent('widget_interact', { widget: 'raw_data', action: 'download_unsimplified_gfa' });
			const locus = parseLocus(locusText, graph.referenceSample);
			const blob = new Blob([text], { type: 'text/plain' });
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

<svelte:window
	onkeydown={(e) => {
		if (e.key === 'Escape') queryOpen = false;
	}}
/>

<div class="app">
	<AppBar tagline="HPRC pangenome graphs, queried by locus" aboutSource={graph.s3Source}>
		{#snippet children()}
		<div class="querypill-wrap">
			<button
				class="querypill"
				class:open={queryOpen}
				onclick={() => (queryOpen = !queryOpen)}
				title="Change the query: reference graph, locus/gene, and context"
			>
				<span class="qp-ref">{graph.referenceSample}</span>
				<span class="qp-slash">/</span>
				<span class="qp-main">{queriedGene ?? locusText}</span>
				{#if queriedGene}<span class="qp-coord">{locusText}</span>{/if}
				<span class="qp-caret" aria-hidden="true">▾</span>
			</button>

			{#if queryOpen}
				<div class="query-pop" role="dialog" aria-label="Query">
					<div class="qp-block">
						<span class="qp-head">Reference graph</span>
						<div class="qp-graphs" role="group" aria-label="Choose pangenome graph">
							{#each GRAPHS as g (g.id)}
								<button
									class="qp-graph"
									class:active={g.id === graphId}
									onclick={() => selectGraph(g.id)}
									disabled={running}
								>
									<b>{g.label}</b>
									<span class="qp-desc">{GRAPH_BLURB[g.id]}</span>
								</button>
							{/each}
						</div>
					</div>

					<div class="qp-block">
						<span class="qp-head">Locus or gene</span>
						<div class="qp-locus-row">
							<div class="locus-input">
								<input
									bind:this={queryInputEl}
									type="text"
									bind:value={locusText}
									oninput={onLocusInput}
									onkeydown={onLocusKey}
									onblur={() => setTimeout(() => (showSuggest = false), 120)}
									onfocus={onLocusInput}
									placeholder="chr6:31972046-32055647 or HLA-A"
									autocomplete="off"
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
												<span class="scoord"
													>{s.contig}:{s.start.toLocaleString()}-{s.end.toLocaleString()}</span
												>
											</li>
										{/each}
									</ul>
								{/if}
							</div>
							<button class="go" onclick={() => run()} disabled={running}>
								{running ? 'Querying…' : 'Query'}
							</button>
						</div>
						<div class="qp-examples">
							<span class="ex-lbl">e.g.</span>
							{#each EXAMPLE_GENES as gene (gene)}
								<button class="chip" onclick={() => runExampleGene(gene)} disabled={running}>
									{gene}
								</button>
							{/each}
						</div>
					</div>

					<div class="qp-block">
						<span class="qp-head">Context <span class="qp-unit">bp</span></span>
						<div class="qp-ctx-row">
							<input
								class="qp-ctx-input"
								type="number"
								min="0"
								step="50"
								bind:value={contextBp}
								onkeydown={(e) => e.key === 'Enter' && run()}
							/>
							<span class="qp-ctx-help"
								>bp past the locus each haplotype is followed before it is cut off</span
							>
						</div>
					</div>
				</div>
			{/if}
		</div>
		{/snippet}
	</AppBar>

	{#if queryOpen}
		<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
		<div class="query-scrim" role="presentation" onclick={() => (queryOpen = false)}></div>
	{/if}

	{#if error}
		<div class="error-banner"><pre>{error}</pre></div>
	{/if}

	<div class="workspace">
		{#if stats && gfa}
			<section class="mainview">
				<nav class="tabs">
					<button class="tab" class:active={view === 'graph'} onclick={() => (view = 'graph')}
						>Graph layout</button
					>
					<button class="tab" class:active={view === 'data'} onclick={() => (view = 'data')}
						>Raw data</button
					>
				</nav>

				<div class="tabbody" class:pad={view !== 'graph'}>
					{#if view === 'graph' && displayGfa}
						<GraphLayoutView
							gfa={displayGfa}
							referenceSample={graph.referenceSample}
							refKey={graph.refKey}
							discoAvailable={canShowUnsimplified}
							discoLoading={loadingUnsimplified}
							onRequestDiscoGraph={requestDiscoGraph}
							discoWalksGfa={unsimplified}
							showingAllNodes={showUnsimplified}
							allNodesCount={unsimplifiedNodes}
							allNodesTooMany={unsimplifiedNodes > 0 && !canShowUnsimplified}
							onToggleSimplify={toggleUnsimplified}
							onRequestMoreContext={requestMoreContext}
							locusLabel={queriedGene ?? locusText}
							showHaplotypes={true}
							{fetchInfo}
							querying={running}
						/>
					{:else if view === 'data'}
						<RawDataView {gfa} rawText={rawGfa} {downloadRaw} {downloadingRaw} />
					{/if}
				</div>
			</section>
		{:else}
			<!-- Before the first graph exists, still show the whole shell (tabs, options
			     panel with the live report, canvas frame) rather than a bare message. -->
			<section class="mainview">
				<nav class="tabs">
					<button class="tab active">Graph layout</button>
					<button class="tab" disabled>Raw data</button>
				</nav>
				<div class="tabbody">
					<div class="shell">
						<aside class="shell-side">
							<QueryReport locusLabel={queriedGene ?? locusText} querying={running} />
						</aside>
						<div class="shell-stage">
							{#if running}
								<div class="ph-inner light">
									<span class="ph-spinner"></span> Querying <code>{locusText}</code>…
								</div>
							{:else if oversized}
								<div class="ph-inner warn">
									<b>This region's graph is too tangled to render.</b> Even after simplification it came
									back at ~{fmtBytes(oversized.bytes)}, far past anything we've seen from a normal locus —
									try a smaller window or a specific gene.
								</div>
							{:else}
								<div class="ph-inner light">Open the query menu at the top to choose a locus.</div>
							{/if}
						</div>
					</div>
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

	/* The top bar (wordmark, GitHub / About links, About modal) now lives in the
	   shared AppBar component. Only the query pill it hosts stays here. */

	/* ---- query pill in the header + its popover ---- */
	.querypill-wrap {
		position: relative;
		display: flex;
		justify-content: center;
	}
	.querypill {
		display: inline-flex;
		align-items: baseline;
		gap: 0.45rem;
		max-width: 46vw;
		padding: 0.3rem 0.85rem;
		border-radius: 999px;
		border: 1px solid rgba(255, 255, 255, 0.25);
		background: rgba(255, 255, 255, 0.12);
		color: #fff;
		font: inherit;
		cursor: pointer;
		white-space: nowrap;
		overflow: hidden;
	}
	.querypill:hover {
		background: rgba(255, 255, 255, 0.2);
		border-color: rgba(255, 255, 255, 0.4);
	}
	.querypill.open {
		background: #fff;
		border-color: #fff;
		color: #2e1065;
	}
	.qp-ref {
		flex: 0 0 auto;
		font-size: 0.82rem;
		opacity: 0.75;
	}
	.qp-slash {
		flex: 0 0 auto;
		opacity: 0.5;
	}
	/* The user's input can be a long coordinate; let it ellipsize so the caret
	   (and reference) stay visible rather than being pushed out of the pill. */
	.qp-main {
		flex: 0 1 auto;
		min-width: 2.5rem;
		overflow: hidden;
		text-overflow: ellipsis;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.85rem;
		font-weight: 700;
	}
	.qp-coord {
		flex: 0 1 auto;
		min-width: 0;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.72rem;
		opacity: 0.65;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.qp-caret {
		flex: 0 0 auto;
		font-size: 0.6rem;
		opacity: 0.8;
	}

	/* Dim scrim over the page — under the header (z 100), so the strip and its
	   popover stay bright while everything below dims. */
	.query-scrim {
		position: fixed;
		inset: 0;
		z-index: 90;
		background: rgba(16, 24, 40, 0.4);
	}
	.query-pop {
		position: absolute;
		top: calc(100% + 10px);
		left: 50%;
		transform: translateX(-50%);
		z-index: 101;
		width: min(540px, 90vw);
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
	.qp-unit {
		font-weight: 500;
		letter-spacing: 0;
		text-transform: none;
		color: #b0b6c0;
	}
	.qp-graphs {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.5rem;
	}
	.qp-graph {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		text-align: left;
		font: inherit;
		background: #f7f8fa;
		border: 1px solid #e3e7ee;
		border-radius: 9px;
		padding: 0.5rem 0.6rem;
		cursor: pointer;
	}
	.qp-graph:hover:not(:disabled) {
		background: #eef2ff;
		border-color: #c7d2fe;
	}
	.qp-graph.active {
		background: #f5f0ff;
		border-color: #9333ea;
		box-shadow: inset 0 0 0 1px rgba(147, 51, 234, 0.35);
	}
	.qp-graph b {
		font-size: 0.85rem;
		color: #1f2430;
	}
	.qp-graph.active b {
		color: #6d28d9;
	}
	.qp-desc {
		font-size: 0.72rem;
		line-height: 1.35;
		color: #7a828f;
	}
	.qp-graph:disabled {
		opacity: 0.6;
		cursor: default;
	}
	.qp-locus-row {
		display: flex;
		gap: 0.5rem;
	}
	.qp-locus-row .locus-input {
		flex: 1;
	}
	.qp-locus-row input[type='text'] {
		width: 100%;
		font: inherit;
		font-size: 0.95rem;
		padding: 0.45rem 0.6rem;
		border: 1px solid #d3d9e2;
		border-radius: 8px;
		background: #eef4ff;
		color: #1f2430;
	}
	.qp-locus-row input[type='text']:focus {
		outline: 2px solid #2563eb;
		outline-offset: -1px;
		border-color: #2563eb;
		background: #fff;
	}
	.qp-examples {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		flex-wrap: wrap;
	}
	.qp-ctx-row {
		display: flex;
		align-items: center;
		gap: 0.6rem;
	}
	.qp-ctx-input {
		width: 5rem;
		font: inherit;
		font-size: 0.9rem;
		padding: 0.4rem 0.5rem;
		border: 1px solid #d3d9e2;
		border-radius: 8px;
		background: #fff;
		color: #1f2430;
	}
	.qp-ctx-input:focus {
		outline: 2px solid #2563eb;
		outline-offset: -1px;
		border-color: #2563eb;
	}
	.qp-ctx-help {
		font-size: 0.76rem;
		line-height: 1.4;
		color: #6b7280;
	}
	.locus-input {
		position: relative;
	}
	.go {
		font: inherit;
		font-weight: 600;
		font-size: 0.9rem;
		padding: 0.42rem 1.1rem;
		border: none;
		border-radius: 7px;
		background: #2563eb;
		color: #fff;
		cursor: pointer;
	}
	.go:hover:not(:disabled) {
		background: #1d4ed8;
	}
	.go:disabled {
		background: #9db8ef;
		cursor: default;
	}

	.ex-lbl {
		font-size: 0.72rem;
		color: #98a0ac;
	}
	.chip {
		font: inherit;
		font-size: 0.8rem;
		font-weight: 600;
		cursor: pointer;
		background: #eef2ff;
		color: #3730a3;
		border: 1px solid #e0e7ff;
		border-radius: 999px;
		padding: 0.2rem 0.6rem;
	}
	.chip:hover:not(:disabled) {
		background: #e0e7ff;
	}
	.chip:disabled {
		opacity: 0.5;
		cursor: default;
	}

	/* suggest dropdown */
	.suggest {
		position: absolute;
		top: calc(100% + 3px);
		left: 0;
		right: 0;
		z-index: 30;
		margin: 0;
		padding: 4px;
		list-style: none;
		background: #fff;
		border: 1px solid #e2e5ea;
		border-radius: 8px;
		box-shadow: 0 8px 24px rgba(16, 24, 40, 0.12);
		max-height: 300px;
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

	/* ---- error banner ---- */
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

	/* ---- workspace ---- */
	.workspace {
		flex: 1;
		min-height: 0;
		display: flex;
		gap: 0.75rem;
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
	.tabs {
		display: flex;
		align-items: center;
		gap: 0.15rem;
		padding: 0.3rem 0.5rem 0;
		border-bottom: 1px solid #e3e7ee;
		background: #fafbfc;
	}
	.tab {
		font: inherit;
		font-size: 0.85rem;
		font-weight: 600;
		cursor: pointer;
		background: none;
		border: none;
		color: #6b7280;
		padding: 0.5rem 0.8rem;
		border-bottom: 2px solid transparent;
		margin-bottom: -1px;
		border-radius: 6px 6px 0 0;
	}
	.tab:hover {
		color: #1f2430;
		background: #f0f2f6;
	}
	.tab.active {
		color: #2563eb;
		border-bottom-color: #2563eb;
	}
	.tabbody {
		flex: 1;
		min-height: 0;
		overflow: auto;
	}
	.tabbody.pad {
		padding: 0.9rem;
	}
	/* the graph view fills the whole tab body */
	.tabbody :global(.wrap) {
		height: 100%;
	}

	/* Arrow linking the query controls to their result box on the right. */

	/* ---- placeholder (empty / loading / oversized) ---- */
	/* Pre-first-query shell: the options panel beside an empty canvas frame. */
	.shell {
		display: flex;
		gap: 0.75rem;
		height: 100%;
		padding: 0.6rem;
	}
	.shell-side {
		flex: 0 0 224px;
	}
	.shell-stage {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		border: 1px solid #eee;
		border-radius: 8px;
		background: #0b0d12;
	}
	.ph-inner {
		color: #7a828f;
		font-size: 0.95rem;
		display: flex;
		align-items: center;
		gap: 0.6rem;
		max-width: 34rem;
		padding: 1.5rem;
		text-align: center;
		line-height: 1.5;
	}
	.ph-inner.light {
		color: #9aa3b2;
	}
	.ph-inner.warn {
		color: #fbbf6b;
	}
	.ph-spinner {
		flex: 0 0 auto;
		width: 18px;
		height: 18px;
		border-radius: 50%;
		border: 2px solid #d3d9e2;
		border-top-color: #2563eb;
		animation: spin 0.7s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	code {
		background: #eef1f5;
		padding: 0 4px;
		border-radius: 4px;
		font-size: 0.9em;
	}

	@media (max-width: 860px) {
		.locus-input input {
			width: 11rem;
		}
	}

	/* Phone header: the tagline, a full-width query pill, and two text links don't
	   fit on one row at ~375px, so "About" used to overflow off the edge. Drop the
	   tagline, shrink the wordmark, and — the real fix — let the pill be the one
	   flexible item, shrinking into whatever space brand + links leave (it already
	   truncates its contents), so the row can never overflow. */
	@media (max-width: 640px) {
		/* The query pill is the flexible middle item in the shared AppBar header —
		   let it shrink into whatever space the wordmark and links leave. */
		.querypill-wrap {
			flex: 1 1 auto;
			min-width: 0;
		}
		.querypill {
			max-width: 100%;
			padding: 0.28rem 0.6rem;
			gap: 0.3rem;
		}

		/* Tighter frame around the workspace so the graph gets the width. */
		.workspace {
			padding: 0.5rem;
			gap: 0.5rem;
		}

		/* Pre-first-query shell: stack the report above the canvas frame instead of
		   sitting beside it, where it squeezed the canvas into a thin vertical strip
		   (matches how the loaded graph view already stacks at this width). */
		.shell {
			flex-direction: column;
		}
		.shell-side {
			flex: 0 0 auto;
		}
		.shell-stage {
			min-height: 240px;
		}
	}
</style>
