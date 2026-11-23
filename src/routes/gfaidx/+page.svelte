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
	import { initAgentStatus, setAgentStatus, setAgentWarnings } from '$lib/agentStatus';
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

	// The picker's examples: regions of the chr21 index.
	const LOCI: { locus: string; label: string; kind: string }[] = [
		{ locus: 'SOD1', label: 'SOD1', kind: 'An insertion some haplotypes carry' },
		{ locus: 'TMPRSS2', label: 'TMPRSS2', kind: '45 kb, with large alternative paths' }
	];
	// The same region asked on other paths: in their own coordinates, with that
	// path as the drawing's straight backbone.
	const OTHER_PATHS: { path: string; locus: string; label: string; kind: string }[] = [
		{ path: 'GRCh38', locus: 'SOD1', label: 'SOD1 on GRCh38', kind: 'SOD1 in GRCh38 coordinates (chr21:31.6 Mb)' },
		{
			path: 'HG02486#1#CM088205.1',
			locus: 'CM088205.1:29,322,146-29,342,901',
			label: 'SOD1 on HG02486 hap 1',
			kind: "SOD1 in HG02486 haplotype 1's own coordinates. It carries the insertion, so here the insertion is on the backbone and the haplotypes without it branch around it."
		}
	];
	const CHR21 = EXAMPLES[0];
	const CHR21_BLURB = 'HPRC v2 PGGB graph of chromosome 21: CHM13, GRCh38 and 120 samples, 242 named haplotypes.';
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
	// The Region field's hint follows the path in the "On path" box, not the
	// last one queried: a gene name works only where there are genes.
	const regionPlaceholder = $derived.by(() => {
		const t = pickTrack(tracks, pathText.trim() || null);
		const contig = t?.contig ?? 'contig';
		return t && refKeyFor(t) ? `gene, or ${contig}:start-end` : `${contig}:start-end`;
	});
	const unsimplifiedNodes = $derived(full?.segments.size ?? 0);
	const canShowUnsimplified = $derived(unsimplifiedNodes > 0 && unsimplifiedNodes <= limits.maxUnsimplifiedNodes);
	const displayGfa = $derived(showUnsimplified && full ? full : (reduced ?? full));
	// The path list under the "On path" field: every path, references first,
	// filtered by what is typed (a sample, a contig, any part of the name). While
	// the field still holds the open path's name, nothing is filtered, so the
	// whole list shows. At most PATH_LIST_MAX rows are drawn.
	const PATH_LIST_MAX = 200;
	let pathListOpen = $state(false);
	const pathMatches = $derived.by(() => {
		const typed = pathText.trim().toLowerCase();
		const filter = typed && typed !== track?.name.toLowerCase() ? typed : '';
		const hit = (t: IndexTrack) => !filter || t.name.toLowerCase().includes(filter);
		const all = [...tracks.filter(isReferenceTrack), ...tracks.filter((t) => !isReferenceTrack(t))].filter(hit);
		return { shown: all.slice(0, PATH_LIST_MAX), total: all.length };
	});
	function pickPath(t: IndexTrack) {
		pathText = t.name;
		pathListOpen = false;
		// A region on the old path means nothing on another sample's contig.
		if (track && t.contig !== track.contig && !refKeyFor(t)) locusText = '';
	}
	/** The bundled example an absolute index URL is, if it is one. */
	function exampleOf(url: string): GfaidxExample | undefined {
		if (!url || typeof window === 'undefined') return undefined;
		return EXAMPLES.find((e) => new URL(e.url, window.location.href).href === url);
	}
	const onChr21 = $derived(exampleOf(indexUrl)?.id === CHR21.id);
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
			// The field is for your own index; an example's URL is its placeholder.
			indexText = exampleOf(url) ? '' : url;
			tracks = found;
			track = pickTrack(found, wantPath);
			pathText = track?.name ?? '';
			return true;
		} catch (e) {
			fail(e instanceof Error ? e.message : String(e));
			return false;
		} finally {
			opening = false;
		}
	}

	async function openExample(ex: GfaidxExample, locus = ex.locus, path: string | null = null) {
		const url = new URL(ex.url, window.location.href).href;
		if (url !== indexUrl && !(await openIndex(url, null))) return;
		const on = pickTrack(tracks, path);
		pathText = on?.name ?? '';
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
					end: locus.end
				},
				complexity: null,
				layoutMs: null
			});

			const result = await client.run(
				indexUrl,
				'region',
				regionArgs({ track: locus.track, start: locus.start, end: locus.end })
			);
			if (id !== queryId) return;
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
								<span class="head">Graph</span>
								<div class="graphs" role="group" aria-label="Choose a gfaidx index">
									<button
										class="graph"
										class:active={onChr21}
										onclick={() => !onChr21 && openExample(CHR21)}
										disabled={opening || running}
									>
										<b>{CHR21.label}</b>
										<span class="desc">{CHR21_BLURB}</span>
									</button>
									{#if indexUrl && !onChr21}
										<button class="graph active" disabled={opening || running} title={indexUrl}>
											<b>{indexName}</b>
											<span class="desc">Your own index, opened by URL</span>
										</button>
									{/if}
								</div>
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
										placeholder={CHR21.url}
										aria-label="URL of your own gfaidx index"
										bind:value={indexText}
										spellcheck="false"
									/>
									<button class="btn" type="submit" disabled={opening || !indexText.trim()}>
										{opening ? 'Opening…' : 'Open'}
									</button>
								</form>
								<p class="hint">
									Or open your own: the URL of a graph indexed with <code>gfaidx index_gfa</code>, with its five
									index files beside it, on a host that allows CORS and range requests.
									<a href="{base}/gfaidx-docs" target="_blank" rel="noopener">How to build and host one →</a>
								</p>
							</div>

							<form
								class="block"
								onsubmit={(e) => {
									e.preventDefault();
									runQuery();
								}}
							>
								<span class="head">Region</span>
								{#if !indexUrl || onChr21}
									<div class="examples">
										<span class="ex-lbl">e.g.</span>
										{#each LOCI as ex (ex.label)}
											<button
												type="button"
												class="chip"
												title={ex.kind}
												onclick={() => openExample(CHR21, ex.locus)}
												disabled={opening || running}>{ex.label}</button
											>
										{/each}
									</div>
									<div class="examples">
										<span class="ex-lbl">on another path</span>
										{#each OTHER_PATHS as ex (ex.label)}
											<button
												type="button"
												class="chip"
												title={ex.kind}
												onclick={() => openExample(CHR21, ex.locus, ex.path)}
												disabled={opening || running}>{ex.label}</button
											>
										{/each}
									</div>
								{/if}
								{#if tracks.length > 0}
									<div class="row">
										<label class="lab" for="gfaidx-path">On path</label>
										<div class="path-pick">
											<input
												id="gfaidx-path"
												class="field grow"
												type="text"
												role="combobox"
												aria-expanded={pathListOpen}
												aria-controls="gfaidx-path-list"
												autocomplete="off"
												bind:value={pathText}
												onfocus={(e) => {
													(e.currentTarget as HTMLInputElement).select();
													pathListOpen = true;
												}}
												oninput={() => (pathListOpen = true)}
												onblur={() => setTimeout(() => (pathListOpen = false), 150)}
												onkeydown={(e) => {
													if (e.key === 'Escape') pathListOpen = false;
													if (e.key === 'Enter' && pathListOpen && pathMatches.shown.length > 0) {
														e.preventDefault();
														pickPath(pathMatches.shown[0]);
													}
												}}
												spellcheck="false"
											/>
											{#if pathListOpen}
												<ul class="path-list" id="gfaidx-path-list" role="listbox">
													{#each pathMatches.shown as t (t.name)}
														<!-- svelte-ignore a11y_click_events_have_key_events -->
														<li
															role="option"
															aria-selected={t.name === track?.name}
															class:current={t.name === track?.name}
															onmousedown={(e) => {
																e.preventDefault();
																pickPath(t);
															}}
														>
															<b>{t.sample}</b>
															{#if !isReferenceTrack(t)}<span class="pl-hap">hap {t.haplotype}</span>{/if}
															<span class="pl-contig">{t.contig}</span>
														</li>
													{:else}
														<li class="pl-none">No path matches "{pathText}".</li>
													{/each}
													<li class="pl-count">
														{pathMatches.total > pathMatches.shown.length
															? `${pathMatches.shown.length} of ${pathMatches.total.toLocaleString()} paths: type a sample or contig to narrow`
															: `${pathMatches.total.toLocaleString()} of ${tracks.length.toLocaleString()} paths`}
													</li>
												</ul>
											{/if}
										</div>
									</div>
									<label class="row">
										<span class="lab">Region</span>
										<input
											class="field grow"
											type="text"
											placeholder={regionPlaceholder}
											bind:value={locusText}
											spellcheck="false"
										/>
									</label>
								{/if}
								{#if tracks.length > 0}
									<div class="row end">
										<span class="note">{tracks.length.toLocaleString()} paths in this index</span>
										<button class="btn primary" type="submit" disabled={running || !locusText.trim()}>
											{running ? 'Querying…' : 'Show region'}
										</button>
									</div>
								{/if}
							</form>

							<div class="foot">
								<span
									>Built with <a href="https://github.com/fawaz-dabbaghieh/gfaidx" target="_blank" rel="noopener"
										>gfaidx</a
									>, compiled to WebAssembly and patched to need fewer requests
									(<button class="link-inline" onclick={() => (aboutOpen = true)}>how</button>).</span
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
						locusLabel={queriedLabel || locusText}
						showHaplotypes={true}
						windowedSubgraph={true}
						{fetchInfo}
						querying={running}
						bare={!pageParams.chrome}
						initialView={graphView}
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
	/* the graph boxes and example chips, as on the locus browser's picker */
	.graphs {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.5rem;
	}
	.graph {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		min-width: 0;
		text-align: left;
		font: inherit;
		background: #f7f8fa;
		border: 1px solid #e3e7ee;
		border-radius: 9px;
		padding: 0.5rem 0.6rem;
		cursor: pointer;
	}
	.graph:hover:not(:disabled) {
		background: #eef2ff;
		border-color: #c7d2fe;
	}
	.graph.active {
		background: #f5f0ff;
		border-color: #9333ea;
		box-shadow: inset 0 0 0 1px rgba(147, 51, 234, 0.35);
		cursor: default;
	}
	.graph b {
		font-size: 0.85rem;
		color: #1f2430;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.graph.active b {
		color: #6d28d9;
	}
	.desc {
		font-size: 0.72rem;
		line-height: 1.35;
		color: #7a828f;
	}
	.graph:disabled:not(.active) {
		opacity: 0.6;
		cursor: default;
	}
	.examples {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		flex-wrap: wrap;
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
	.path-pick {
		position: relative;
		flex: 1;
		display: flex;
		min-width: 0;
	}
	.path-list {
		position: absolute;
		top: calc(100% + 3px);
		left: 0;
		right: 0;
		z-index: 30;
		max-height: 260px;
		overflow-y: auto;
		margin: 0;
		padding: 4px;
		list-style: none;
		background: #fff;
		border: 1px solid #e2e5ea;
		border-radius: 8px;
		box-shadow: 0 10px 28px rgba(16, 24, 40, 0.18);
	}
	.path-list li {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		padding: 0.3rem 0.5rem;
		border-radius: 5px;
		font-size: 0.8rem;
		cursor: pointer;
	}
	.path-list li:hover {
		background: #f5f0ff;
	}
	.path-list li.current b {
		color: #6d28d9;
	}
	.pl-hap {
		font-size: 0.72rem;
		color: #9aa0aa;
	}
	.pl-contig {
		margin-left: auto;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.74rem;
		color: #6b7280;
	}
	.path-list li.pl-count,
	.path-list li.pl-none {
		cursor: default;
		font-size: 0.72rem;
		color: #9aa0aa;
	}
	.path-list li.pl-count:hover,
	.path-list li.pl-none:hover {
		background: none;
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
