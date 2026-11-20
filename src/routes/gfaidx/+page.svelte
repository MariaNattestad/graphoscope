<script lang="ts">
	// A locus browser over a gfaidx index instead of a GBZ-base database.
	//
	// What it adds to the front page is names. GBZ-base returns a region's
	// haplotypes as anonymous walks ("Walk 3"); gfaidx returns each one as the
	// sample, haplotype and contig it is, with its own coordinates. So here the
	// haplotype panel lists real assemblies, and tracing one follows a person's
	// actual sequence through the graph.
	//
	// Like the front page there is no server. `gfaidx.wasm` (the gfaidx C++ query
	// library, compiled to WebAssembly) reads the index by HTTP range request,
	// then Graphoscope's own Simplify runs over the result.
	//
	// Kept apart from the front page on purpose: this is a side experiment in
	// whether gfaidx is worth adopting, and nothing here touches the GBZ flow.
	import { onMount } from 'svelte';
	import { base } from '$app/paths';
	import AppBar from '$lib/AppBar.svelte';
	import ParamWarnings from '$lib/ParamWarnings.svelte';
	import GfaidxAbout from './GfaidxAbout.svelte';
	import GraphLayoutView from '$lib/graph/GraphLayoutView.svelte';
	import { parseGfa, type Gfa } from '$lib/gfa';
	import { pageTitle } from '$lib/pageTitle';
	import { SITES_DEFAULT } from '$lib/gbzClient';
	import { GfaidxClient } from '$lib/gfaidxClient';
	import { resolveGene, geneToLocus } from '$lib/genes';
	import { limits } from '$lib/limits.svelte';
	import { graphComplexity } from '$lib/apiReport';
	import { initAgentStatus, setAgentStatus, setAgentWarnings, noteFetch, clearFetch } from '$lib/agentStatus';
	import {
		parseTracks,
		pickTrack,
		isReferenceTrack,
		refKeyFor,
		regionArgs,
		toWalkGfa,
		type GfaidxExample,
		type IndexTrack
	} from '$lib/gfaidx';
	import {
		parseParams,
		parseRange,
		applyPatch,
		formatQuery,
		type GraphViewParams,
		type PageParams,
		type ParamPatch
	} from '$lib/urlState';

	// Indexes a link can name with `index=<id>`: chr21, in the public
	// graphoscope-data bucket (3 GB, of which a query reads a few MB). Any other
	// index is opened by its URL. (The offline tests open a small bundled one,
	// static/examples/gfaidx/mlph.gfaidx, by its path.)
	const EXAMPLES: GfaidxExample[] = [
		{
			id: 'chr21',
			label: 'HPRC v2 chr21',
			kind: '242 named haplotypes · PGGB, 120 samples',
			url: 'https://graphoscope-data.s3.us-west-2.amazonaws.com/gfaidx/hprc-v2-pggb-chr21/hprc-v2-pggb.chr21.120samples.gfa.gz',
			locus: 'SOD1'
		}
	];

	const CONTEXT_DEFAULT = 1000;
	// The picker's examples: regions of the chr21 index.
	const LOCI: { locus: string; label: string; kind: string }[] = [
		{ locus: 'SOD1', label: 'SOD1', kind: 'an insertion some haplotypes carry' },
		{ locus: 'TMPRSS2', label: 'TMPRSS2', kind: '45 kb, with large alternative paths' }
	];
	const CHR21 = EXAMPLES[0];
	// A region wider than this is refused before any request: every haplotype's
	// walk through it comes back, and on a fine-grained graph that is too much
	// text to hold.
	const MAX_REGION_BP = 2_000_000;
	// And a result past this many characters is refused once it is back: some
	// short stretches (a centromere, an acrocentric short arm) hold hundreds of
	// thousands of nodes.
	const MAX_RESULT_CHARS = 150_000_000;

	let client: GfaidxClient | null = null;

	// ---- what is open ----------------------------------------------------------
	let indexUrl = $state('');
	let indexText = $state(''); // the URL field, as typed
	let tracks = $state.raw<IndexTrack[]>([]);
	let track = $state.raw<IndexTrack | null>(null);
	let pathText = $state('');
	let locusText = $state('');
	/** Context mode's reach in bp, or null for haplotype-span mode. */
	let contextBp = $state<number | null>(null);
	let contextText = $state(String(CONTEXT_DEFAULT));

	// ---- what came back --------------------------------------------------------
	/** The region as gfaidx returned it: every node, every haplotype a named walk. */
	let full = $state.raw<Gfa | null>(null);
	let fullText = '';
	/** The same region after Simplify, its walks folded into coverage. */
	let reduced = $state.raw<Gfa | null>(null);
	let sitesThreshold = $state(SITES_DEFAULT);
	let sitesLoading = $state(false);
	let showUnsimplified = $state(false);
	let queriedLabel = $state('');
	let askedRange = $state<{ start: number; end: number } | null>(null);
	let fetchInfo = $state<{ requestCount: number; bytesFetched: number; dbSize: number; elapsedMs: number } | null>(
		null
	);

	let opening = $state(false);
	let running = $state(false);
	let error = $state<string | null>(null);
	let pickerOpen = $state(true);
	let aboutOpen = $state(false);

	const referenceSample = $derived(track?.sample ?? '');
	const refKey = $derived(refKeyFor(track));
	const unsimplifiedNodes = $derived(full?.segments.size ?? 0);
	const canShowUnsimplified = $derived(unsimplifiedNodes > 0 && unsimplifiedNodes <= limits.maxUnsimplifiedNodes);
	const displayGfa = $derived(showUnsimplified && full ? full : (reduced ?? full));
	// The picker's suggestions: references first, and never the whole list of a
	// 466-haplotype chromosome (any name can still be typed).
	const suggestions = $derived.by(() => {
		const refs = tracks.filter(isReferenceTrack);
		const rest = tracks.filter((t) => !isReferenceTrack(t)).slice(0, 400 - Math.min(refs.length, 400));
		return [...refs.slice(0, 400), ...rest];
	});
	/** The bundled example an absolute index URL is, if it is one. */
	function exampleOf(url: string): GfaidxExample | undefined {
		if (!url || typeof window === 'undefined') return undefined;
		return EXAMPLES.find((e) => new URL(e.url, window.location.href).href === url);
	}
	const indexName = $derived(
		exampleOf(indexUrl)?.label ??
			decodeURIComponent(indexUrl.split('/').pop() ?? '').replace(/\.(gfa\.gz|gfaidx)$/, '')
	);

	// ---- shareable URL ---------------------------------------------------------
	let graphView = $state<GraphViewParams>({ marks: [] });
	let pageParams = $state<PageParams>({ chrome: true });
	let urlWarnings = $state<string[]>([]);
	let viewWarnings = $state<string[]>([]);
	const warnings = $derived([...urlWarnings, ...viewWarnings]);
	$effect(() => setAgentWarnings(warnings));

	function replaceUrl(p: URLSearchParams) {
		window.history.replaceState(window.history.state, '', `${window.location.pathname}?${formatQuery(p)}`);
	}
	function syncQuery() {
		const example = exampleOf(indexUrl);
		replaceUrl(
			applyPatch(new URLSearchParams(window.location.search), {
				index: example ? example.id : indexUrl || null,
				path: track?.name ?? null,
				locus: locusText.trim() || null,
				context: contextBp == null ? null : String(contextBp),
				simplify: showUnsimplified ? 'off' : sitesThreshold === SITES_DEFAULT ? null : String(sitesThreshold)
			})
		);
	}
	let pendingPatch: ParamPatch = {};
	let patchTimer: ReturnType<typeof setTimeout> | null = null;
	function onGraphParams(patch: ParamPatch) {
		pendingPatch = { ...pendingPatch, ...patch };
		if (patchTimer) return;
		patchTimer = setTimeout(() => {
			patchTimer = null;
			replaceUrl(applyPatch(new URLSearchParams(window.location.search), pendingPatch));
			pendingPatch = {};
		}, 250);
	}
	function onRenderState(stage: 'querying' | 'layout' | 'drawing' | 'done', info: { layoutMs: number }) {
		if (running || opening || error) return;
		setAgentStatus(stage, { layoutMs: info.layoutMs });
	}

	function fail(message: string) {
		error = message;
		setAgentStatus('error', { error: message });
	}

	// ---- opening an index ------------------------------------------------------
	function resolveIndex(value: string): string | null {
		const v = value.trim();
		const example = EXAMPLES.find((e) => e.id === v.toLowerCase());
		if (example) return new URL(example.url, window.location.href).href;
		if (/^https?:\/\//i.test(v)) return v;
		// A path on this site (the offline tests' bundled index).
		if (/^\/[^/]/.test(v)) return new URL(v, window.location.href).href;
		return null;
	}

	/** Open an index and list the paths a region can be asked on. */
	async function openIndex(url: string, wantPath: string | null): Promise<boolean> {
		if (!client) return false;
		error = null;
		opening = true;
		setAgentStatus('querying', { query: { index: url }, complexity: null, layoutMs: null });
		try {
			const result = await client.run(url, 'tracks');
			if (!result.ok) {
				fail(`${result.error ?? 'Could not open the index'}`);
				return false;
			}
			const found = parseTracks(result.out ?? '');
			if (found.length === 0) {
				fail(
					'This index has no paths or walks to ask a region on. It needs its path index (.pdx) and node lengths (.lnx) beside the graph.'
				);
				return false;
			}
			indexUrl = url;
			indexText = exampleOf(url)?.id ?? url;
			tracks = found;
			track = pickTrack(found, wantPath);
			pathText = track?.name ?? '';
			noteFetch('index', result.stats);
			return true;
		} catch (e) {
			fail(e instanceof Error ? e.message : String(e));
			return false;
		} finally {
			opening = false;
		}
	}

	async function openExample(ex: GfaidxExample, locus = ex.locus) {
		const url = new URL(ex.url, window.location.href).href;
		if (url !== indexUrl && !(await openIndex(url, null))) return;
		locusText = locus;
		await runQuery();
	}

	async function openTyped() {
		const url = resolveIndex(indexText);
		if (!url) {
			fail(`"${indexText}" isn't the http(s) URL of a gfaidx-indexed graph, or one of: ${EXAMPLES.map((e) => e.id).join(', ')}.`);
			return;
		}
		if (await openIndex(url, null)) {
			full = null;
			reduced = null;
			syncQuery();
		}
	}

	// ---- the query -------------------------------------------------------------
	/** The locus field → a track and an interval on it. A gene symbol works when
	 * the track is a reference Graphoscope has genes for. */
	async function resolveLocus(): Promise<{ track: IndexTrack; start: number; end: number; label: string } | string> {
		const text = locusText.trim();
		if (!text) return 'Enter a region: contig:start-end, or start-end on the chosen path.';
		const typed = pickTrack(tracks, pathText.trim() || null);
		if (!typed) return `No path named "${pathText}" in this index.`;

		const bare = /^([\d,]+)\s*-\s*([\d,]+)$/.exec(text);
		let range = bare ? parseRange(`${typed.contig}:${text}`) : parseRange(text);
		let label = text;
		if (typeof range === 'string' && /^[A-Za-z][\w.-]*$/.test(text)) {
			const key = refKeyFor(typed);
			const gene = key ? await resolveGene(key, text) : null;
			if (!gene) {
				return key
					? `"${text}" isn't a gene Graphoscope knows on ${typed.sample}, or a contig:start-end region.`
					: `Gene names work on a CHM13 or GRCh38 path. On ${typed.name}, give contig:start-end.`;
			}
			range = parseRange(geneToLocus(gene));
			label = gene.name;
		}
		if (typeof range === 'string') return range;
		// The contig may belong to another path of the same sample (chr2 when the
		// picker says chr1): follow it there.
		const onContig =
			range.contig === typed.contig || range.contig === typed.name
				? typed
				: pickTrack(tracks, typed.sample, range.contig);
		if (!onContig || (onContig.contig !== range.contig && onContig.name !== range.contig)) {
			return `No path of ${typed.sample} is on ${range.contig} in this index.`;
		}
		if (range.end - range.start > MAX_REGION_BP) {
			return `That region is ${Math.round((range.end - range.start) / 1e6)} Mb. Every haplotype's walk through it comes back, so the most this page asks for is ${MAX_REGION_BP / 1e6} Mb.`;
		}
		return { track: onContig, start: range.start, end: range.end, label };
	}

	let queryId = 0;
	async function runQuery() {
		if (!client || !indexUrl) return;
		const id = ++queryId;
		error = null;
		running = true;
		pickerOpen = false;
		clearFetch();
		try {
			const locus = await resolveLocus();
			if (id !== queryId) return;
			if (typeof locus === 'string') {
				fail(locus);
				return;
			}
			track = locus.track;
			pathText = locus.track.name;
			syncQuery();
			setAgentStatus('querying', {
				query: {
					index: indexUrl,
					path: locus.track.name,
					contig: locus.track.contig,
					start: locus.start,
					end: locus.end,
					context: contextBp
				},
				complexity: null,
				layoutMs: null
			});

			const result = await client.run(
				indexUrl,
				'region',
				regionArgs({ track: locus.track, start: locus.start, end: locus.end, context: contextBp })
			);
			if (id !== queryId) return;
			noteFetch('graph', result.stats);
			if (!result.ok) {
				fail(result.error ?? 'The query failed');
				return;
			}
			if ((result.out?.length ?? 0) > MAX_RESULT_CHARS) {
				fail(
					`That region came back as ${Math.round((result.out?.length ?? 0) / 1e6)} MB of graph, too much to draw. Try a narrower one.`
				);
				return;
			}
			const named = toWalkGfa(result.out ?? '', locus.track.sample);
			fullText = named.gfa;
			const parsedFull = parseGfa(named.gfa);
			if (parsedFull.segments.size === 0) {
				fail('Nothing came back for that region.');
				return;
			}
			const simplified = await simplify(named.gfa, sitesThreshold);
			if (id !== queryId) return;

			full = parsedFull;
			reduced = simplified;
			if (!canShowUnsimplified) showUnsimplified = false;
			queriedLabel = locus.label;
			askedRange = { start: locus.start, end: locus.end };
			fetchInfo = result.stats
				? {
						requestCount: result.stats.requestCount,
						bytesFetched: result.stats.bytesFetched,
						dbSize: result.stats.indexSize,
						elapsedMs: result.stats.elapsedMs
					}
				: null;
			setAgentStatus('layout', {
				complexity: { ...graphComplexity(simplified ?? parsedFull, locus.track.sample), namedWalks: named.walks }
			});
		} catch (e) {
			if (id === queryId) fail(e instanceof Error ? e.message : String(e));
		} finally {
			if (id === queryId) running = false;
		}
	}

	/** Graphoscope's Simplify over the named-walk GFA. Null (and a note) when it
	 * fails: the unsimplified graph is still worth showing. */
	async function simplify(gfaText: string, threshold: number): Promise<Gfa | null> {
		if (!client) return null;
		const result = await client.reduce(gfaText, threshold);
		if (!result.ok) {
			viewWarnings = [`Simplify failed, showing every node: ${result.stderr?.trim() || result.error}`];
			return null;
		}
		return parseGfa(result.gfa ?? '');
	}

	let sitesRequest = 0;
	async function setSitesThreshold(t: number) {
		sitesThreshold = t;
		syncQuery();
		if (!fullText) return;
		const id = ++sitesRequest;
		sitesLoading = true;
		try {
			const next = await simplify(fullText, t);
			if (id === sitesRequest && next) reduced = next;
		} finally {
			if (id === sitesRequest) sitesLoading = false;
		}
	}

	function toggleUnsimplified() {
		if (!showUnsimplified && !canShowUnsimplified) return;
		showUnsimplified = !showUnsimplified;
		syncQuery();
	}

	function setMode(context: boolean) {
		if (!context) contextBp = null;
		else {
			const n = Number(contextText.replace(/,/g, ''));
			contextBp = Number.isFinite(n) && n >= 0 ? Math.round(n) : CONTEXT_DEFAULT;
		}
	}

	onMount(() => {
		initAgentStatus(pageTitle('Graphoscope · gfaidx'));
		client = new GfaidxClient();
		const p = new URLSearchParams(window.location.search);
		const parsed = parseParams(p, 'gfaidx');
		graphView = parsed.graph;
		pageParams = parsed.page;
		const problems = [...parsed.warnings];
		if (typeof parsed.page.simplify === 'number') sitesThreshold = parsed.page.simplify;
		if (parsed.page.simplify === 'off') showUnsimplified = true;

		const context = p.get('context')?.trim();
		if (context) {
			const n = Number(context.replace(/,/g, ''));
			if (Number.isFinite(n) && n >= 0) {
				contextBp = Math.round(n);
				contextText = String(contextBp);
			} else problems.push(`Ignored context=${context}: expected a number of bp.`);
		}

		const index = p.get('index')?.trim();
		const example = index ? EXAMPLES.find((e) => e.id === index.toLowerCase()) : undefined;
		const url = index ? resolveIndex(index) : null;
		if (index && !url) {
			problems.push(`Ignored index=${index}: expected an http(s) URL or one of ${EXAMPLES.map((e) => e.id).join(', ')}.`);
		}
		urlWarnings = problems;
		if (url) {
			pickerOpen = false;
			const locus = p.get('locus')?.trim() || p.get('mark')?.split(',')[0]?.trim() || example?.locus || '';
			openIndex(url, p.get('path')?.trim() || null).then((ok) => {
				if (!ok) return;
				locusText = locus;
				if (locus) runQuery();
				else {
					pickerOpen = true;
					setAgentStatus('error', { error: 'No region asked. Pass locus=<contig:start-end>.' });
				}
			});
		} else {
			setAgentStatus('error', {
				error: `No index open. Pass index=<${EXAMPLES.map((e) => e.id).join('|')}> or index=<URL of a gfaidx-indexed .gfa.gz>, and locus=<contig:start-end>.`
			});
		}
		return () => client?.terminate();
	});
</script>

<svelte:head>
	<title>{pageTitle('Graphoscope · gfaidx')}</title>
</svelte:head>

<div
	class="app"
	style={pageParams.size ? `width:${pageParams.size.width}px;height:${pageParams.size.height}px` : undefined}
>
	{#if pageParams.chrome}
		<AppBar tagline="A gfaidx index, read by range request — every haplotype named">
			{#snippet children()}
				<div class="pill-wrap">
					<button
						class="pill"
						class:open={pickerOpen}
						onclick={() => (pickerOpen = !pickerOpen)}
						title="Choose an index and a region"
					>
						{#if indexUrl}
							<span class="pill-index">{indexName}</span>
							{#if locusText}<span class="pill-locus">{queriedLabel || locusText}</span>{/if}
						{:else}
							<span class="pill-placeholder">Open a gfaidx index</span>
						{/if}
						<span class="pill-caret" aria-hidden="true">▾</span>
					</button>

					{#if pickerOpen}
						<div class="pop" role="dialog" aria-label="Choose an index and a region">
							<div class="block">
								<span class="head">Examples · {CHR21.label}, {CHR21.kind}</span>
								<div class="ex-grid">
									{#each LOCI as ex (ex.locus)}
										<button class="ex" onclick={() => openExample(CHR21, ex.locus)} disabled={opening || running}>
											<b>{ex.label}</b>
											<span class="ex-kind">{ex.kind}</span>
										</button>
									{/each}
								</div>
								<span class="head">Or your own index</span>
								<form
									class="row"
									onsubmit={(e) => {
										e.preventDefault();
										openTyped();
									}}
								>
									<input
										class="field grow"
										type="text"
										placeholder="https://…/graph.gfa.gz"
										bind:value={indexText}
										spellcheck="false"
									/>
									<button class="btn" type="submit" disabled={opening || !indexText.trim()}>
										{opening ? 'Opening…' : 'Open'}
									</button>
								</form>
								<p class="hint">
									The URL of a graph indexed with <code>gfaidx index_gfa</code>, with its five index files beside it,
									on a host that allows CORS and range requests.
									<a href="{base}/gfaidx-docs" target="_blank" rel="noopener">How to build and host one →</a>
								</p>
							</div>

							{#if tracks.length > 0}
								<form
									class="block"
									onsubmit={(e) => {
										e.preventDefault();
										runQuery();
									}}
								>
									<span class="head">Region</span>
									<label class="row">
										<span class="lab">On path</span>
										<input class="field grow" type="text" list="gfaidx-paths" bind:value={pathText} spellcheck="false" />
										<datalist id="gfaidx-paths">
											{#each suggestions as t (t.name)}
												<option value={t.name}></option>
											{/each}
										</datalist>
									</label>
									<label class="row">
										<span class="lab">Region</span>
										<input
											class="field grow"
											type="text"
											placeholder={refKey ? 'gene, or contig:start-end' : 'contig:start-end'}
											bind:value={locusText}
											spellcheck="false"
										/>
									</label>
									<div class="row modes">
										<label class="mode">
											<input type="radio" name="mode" checked={contextBp == null} onchange={() => setMode(false)} />
											<span
												><b>Haplotype spans</b> — what each haplotype has between the two ends of the region</span
											>
										</label>
										<label class="mode">
											<input type="radio" name="mode" checked={contextBp != null} onchange={() => setMode(true)} />
											<span
												><b>Context</b> (slower: many more round trips) — everything within
												<input
													class="field bp"
													type="text"
													inputmode="numeric"
													bind:value={contextText}
													oninput={() => contextBp != null && setMode(true)}
												/> bp of the region</span
											>
										</label>
									</div>
									<div class="row end">
										<span class="note">{tracks.length.toLocaleString()} paths in this index</span>
										<button class="btn primary" type="submit" disabled={running || !locusText.trim()}>
											{running ? 'Querying…' : 'Show region'}
										</button>
									</div>
								</form>
							{/if}

							<div class="foot">
								<span
									>Built with <a href="https://github.com/fawaz-dabbaghieh/gfaidx" target="_blank" rel="noopener"
										>gfaidx</a
									>, compiled to WebAssembly.</span
								>
								<a href="{base}/gfaidx-docs">gfaidx docs</a>
								<a href="{base}/" data-sveltekit-reload>Locus browser →</a>
							</div>
						</div>
					{/if}
				</div>
			{/snippet}
		</AppBar>
		<div class="beta-strip" role="note">
			<b>Experimental</b>
			<span
				>Support for gfaidx indexes is experimental. Haplotypes come back named, but a query takes about 10 times
				longer than on the main page: gfaidx is built to read from a local disk, not over the web.</span
			>
			<button class="more" onclick={() => (aboutOpen = true)}>Read more</button>
		</div>
		<GfaidxAbout bind:open={aboutOpen} />
	{/if}

	{#if pickerOpen && pageParams.chrome}
		<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
		<div class="scrim" role="presentation" onclick={() => (pickerOpen = false)}></div>
	{/if}

	{#if error}
		<div class="error-banner"><pre>{error}</pre></div>
	{/if}
	<ParamWarnings {warnings} />

	<div class="workspace">
		{#if displayGfa}
			<section class="mainview">
				<div class="tabbody">
					<GraphLayoutView
						gfa={displayGfa}
						{referenceSample}
						{refKey}
						discoAvailable={full != null}
						discoWalksGfa={full}
						{sitesThreshold}
						{sitesLoading}
						onSitesThreshold={setSitesThreshold}
						showingAllNodes={showUnsimplified && full != null}
						allNodesCount={unsimplifiedNodes}
						allNodesTooMany={unsimplifiedNodes > 0 && !canShowUnsimplified}
						onToggleSimplify={toggleUnsimplified}
						context={contextBp ?? undefined}
						locusLabel={queriedLabel || locusText}
						showHaplotypes={true}
						windowedSubgraph={true}
						{fetchInfo}
						querying={running}
						bare={!pageParams.chrome}
						initialView={graphView}
						{askedRange}
						onParams={onGraphParams}
						{onRenderState}
						onWarnings={(w) => (viewWarnings = w)}
					/>
				</div>
			</section>
		{:else}
			<section class="empty-stage">
				<div class="empty-hint">
					<div class="dz-icon">🧬</div>
					<p>
						{#if opening || running}
							Reading the index…
						{:else}
							No region open —
							<button class="link-inline" onclick={() => (pickerOpen = true)}>choose an index and a region</button>.
						{/if}
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

	/* ---- header pill and its popover (as on the locus browser and /gfa) ---- */
	.pill-wrap {
		position: relative;
		display: flex;
		justify-content: center;
	}
	.pill {
		display: inline-flex;
		align-items: baseline;
		gap: 0.6rem;
		max-width: 52vw;
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
	.pill:hover {
		background: rgba(255, 255, 255, 0.2);
		border-color: rgba(255, 255, 255, 0.4);
	}
	.pill.open {
		background: #fff;
		border-color: #fff;
		color: #2e1065;
	}
	.pill-index {
		font-size: 0.78rem;
		opacity: 0.85;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.pill-locus {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.85rem;
		font-weight: 700;
	}
	.pill-placeholder {
		font-size: 0.85rem;
		font-weight: 600;
	}
	.pill-caret {
		font-size: 0.6rem;
		opacity: 0.8;
	}
	.scrim {
		position: fixed;
		inset: 0;
		z-index: 90;
		background: rgba(16, 24, 40, 0.4);
	}
	.pop {
		position: absolute;
		top: calc(100% + 10px);
		left: 50%;
		transform: translateX(-50%);
		z-index: 101;
		width: min(600px, 94vw);
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
	.block {
		display: flex;
		flex-direction: column;
		gap: 0.55rem;
	}
	.block + .block {
		border-top: 1px solid #f0f2f5;
		padding-top: 0.9rem;
	}
	.head {
		font-size: 0.68rem;
		font-weight: 700;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: #6b7280;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.row.end {
		justify-content: space-between;
	}
	.row.modes {
		flex-direction: column;
		align-items: stretch;
		gap: 0.35rem;
	}
	.lab {
		flex: 0 0 4.2rem;
		font-size: 0.78rem;
		color: #6b7280;
	}
	.field {
		font: inherit;
		font-size: 0.85rem;
		padding: 0.35rem 0.55rem;
		border: 1px solid #cbd2dd;
		border-radius: 7px;
		background: #fff;
		color: #1f2430;
		min-width: 0;
	}
	.field:focus {
		outline: 2px solid #c4b5fd;
		border-color: #7c3aed;
	}
	.field.grow {
		flex: 1;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.8rem;
	}
	.field.bp {
		width: 5.5rem;
		padding: 0.15rem 0.4rem;
		text-align: right;
	}
	.mode {
		display: flex;
		align-items: baseline;
		gap: 0.45rem;
		font-size: 0.8rem;
		color: #4b5563;
		cursor: pointer;
	}
	.mode b {
		color: #1f2430;
	}
	.note {
		font-size: 0.74rem;
		color: #9aa0aa;
	}
	.btn {
		font: inherit;
		font-size: 0.82rem;
		font-weight: 600;
		padding: 0.38rem 0.85rem;
		border-radius: 7px;
		border: 1px solid #cbd2dd;
		background: #f7f8fa;
		color: #1f2430;
		cursor: pointer;
		white-space: nowrap;
	}
	.btn.primary {
		background: #6d28d9;
		border-color: #6d28d9;
		color: #fff;
	}
	.btn:disabled {
		opacity: 0.55;
		cursor: default;
	}
	.ex-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.5rem;
	}
	.ex {
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
	.ex:hover:not(:disabled) {
		background: #f5f0ff;
		border-color: #c7b8ec;
	}
	.ex:disabled {
		opacity: 0.6;
		cursor: default;
	}
	.ex b {
		font-size: 0.82rem;
	}
	.ex-kind {
		font-size: 0.7rem;
		color: #7a828f;
	}
	.foot {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.9rem;
		flex-wrap: wrap;
		font-size: 0.78rem;
		color: #8a94a6;
	}
	.foot a {
		color: #6d28d9;
		font-weight: 600;
		text-decoration: none;
	}
	.foot a:hover {
		text-decoration: underline;
	}

	.beta-strip {
		flex: 0 0 auto;
		padding: 0.3rem 1rem;
		font-size: 0.78rem;
		line-height: 1.4;
		color: #78350f;
		background: #fffbeb;
		border-bottom: 1px solid #fde68a;
	}
	.beta-strip b {
		margin-right: 0.4rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		font-size: 0.7rem;
	}
	.beta-strip .more {
		margin-left: 0.4rem;
		font: inherit;
		color: #6d28d9;
		font-weight: 600;
		background: none;
		border: none;
		padding: 0;
		cursor: pointer;
		white-space: nowrap;
	}
	.beta-strip .more:hover {
		text-decoration: underline;
	}
	.hint {
		margin: 0;
		font-size: 0.74rem;
		line-height: 1.45;
		color: #7a828f;
	}
	.hint code {
		font-size: 0.72rem;
	}
	.hint a {
		color: #6d28d9;
		font-weight: 600;
		text-decoration: none;
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
	.tabbody {
		flex: 1;
		min-height: 0;
		overflow: auto;
	}
	.tabbody :global(.wrap) {
		height: 100%;
	}
	.empty-stage {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		border: 2px dashed #cbd2dd;
		border-radius: 12px;
		background: #fff;
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
		font-weight: 600;
		color: #6d28d9;
		background: none;
		border: none;
		padding: 0;
		cursor: pointer;
		text-decoration: underline;
	}
</style>
