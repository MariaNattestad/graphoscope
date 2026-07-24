<script lang="ts">
	// Machine-readable query endpoint for AI agents and scripts.
	//
	// Graphoscope is a static site (GitHub Pages) with no backend: the query
	// engine is wasm + HTTP range requests that only runs in a browser. So this
	// can't be a real HTTP JSON endpoint you curl. Instead this page runs the
	// exact same client-side query as the app and renders the result as JSON,
	// which a JS-capable/headless browser (or Claude's browser tools) reads.
	//
	// Contract for a caller:
	//   1. Navigate to  <base>/api?ref=grch38|chm13&locus=<gene or contig:start-end>
	//   2. Poll the root element's  data-status  until it is "done" or "error"
	//      (it starts "loading" while the wasm query runs).
	//   3. Read the JSON from the <pre id="result"> text, or from
	//      window.graphoscopeResult.
	//
	// The JSON shape is ApiReport | ApiError from $lib/apiReport.

	import { onMount } from 'svelte';
	import { GbzClient, parseLocus } from '$lib/gbzClient';
	import { parseGfa } from '$lib/gfa';
	import { resolveGene, geneToLocus } from '$lib/genes';
	import { graphById, MAX_GFA_BYTES } from '$lib/graphs';
	import { graphComplexity, type ApiReport, type ApiError } from '$lib/apiReport';

	type Status = 'loading' | 'done' | 'error';
	let status = $state<Status>('loading');
	let payload = $state<ApiReport | ApiError | null>(null);

	const json = $derived(payload ? JSON.stringify(payload, null, 2) : '');

	function publish(result: ApiReport | ApiError) {
		payload = result;
		status = result.ok ? 'done' : 'error';
		// Also expose on window for callers that evaluate JS rather than scrape
		// the DOM. Typed loosely to avoid leaking app types onto the global.
		(window as unknown as { graphoscopeResult: unknown }).graphoscopeResult = result;
	}

	async function runApiQuery() {
		const p = new URLSearchParams(window.location.search);
		const ref = p.get('ref') ?? 'grch38';
		const input = (p.get('locus') ?? p.get('gene') ?? '').trim();

		const graph = graphById(ref);
		if (!graph) {
			publish({
				ok: false,
				error: `Unknown ref "${ref}". Use ref=grch38 or ref=chm13.`
			} satisfies ApiError);
			return;
		}
		if (!input) {
			publish({
				ok: false,
				error: 'Missing locus. Pass ?locus=<gene symbol or contig:start-end>, e.g. locus=SMN1.',
				query: { graph: graph.id, referenceSample: graph.referenceSample }
			} satisfies ApiError);
			return;
		}

		// Resolve a gene symbol to coordinates, exactly as the interactive app does.
		const looksLikeLocus = /:\s*[\d,]+\s*-\s*[\d,]+\s*$/.test(input);
		let coordText = input;
		let gene: string | null = null;
		try {
			if (!looksLikeLocus) {
				const g = await resolveGene(graph.refKey, input);
				if (!g) {
					publish({
						ok: false,
						error: `"${input}" is neither a contig:start-end locus nor a known gene symbol for ${graph.label}.`,
						query: { graph: graph.id, referenceSample: graph.referenceSample, input }
					} satisfies ApiError);
					return;
				}
				coordText = geneToLocus(g);
				gene = g.name;
			}
			const locus = parseLocus(coordText, graph.referenceSample);
			locus.sample = graph.referenceSample;

			const client = new GbzClient();
			try {
				const result = await client.query({ kind: 'url', url: graph.dbUrl }, locus);
				if (!result.ok) {
					publish({
						ok: false,
						error: `${result.error}\n${result.stderr ?? ''}`.trim(),
						query: {
							graph: graph.id,
							referenceSample: graph.referenceSample,
							input,
							gene,
							contig: locus.contig,
							start: locus.start,
							end: locus.end,
							span: locus.end - locus.start
						}
					} satisfies ApiError);
					return;
				}
				const gfaText = result.gfa ?? '';
				if (gfaText.length > MAX_GFA_BYTES) {
					publish({
						ok: false,
						error: `Reduced graph is ${gfaText.length} bytes, over the ${MAX_GFA_BYTES}-byte ceiling; refusing (the locus is pathologically complex).`,
						query: {
							graph: graph.id,
							referenceSample: graph.referenceSample,
							input,
							gene,
							contig: locus.contig,
							start: locus.start,
							end: locus.end,
							span: locus.end - locus.start
						}
					} satisfies ApiError);
					return;
				}
				const gfa = parseGfa(gfaText);
				publish({
					ok: true,
					query: {
						graph: graph.id,
						referenceSample: graph.referenceSample,
						input,
						gene,
						contig: locus.contig,
						start: locus.start,
						end: locus.end,
						span: locus.end - locus.start
					},
					complexity: graphComplexity(gfa, graph.referenceSample),
					fetch: result.stats
						? {
								requestCount: result.stats.requestCount,
								bytesFetched: result.stats.bytesFetched,
								dbSizeBytes: result.stats.dbSize,
								elapsedMs: result.stats.elapsedMs
							}
						: null
				} satisfies ApiReport);
			} finally {
				client.terminate();
			}
		} catch (e) {
			publish({
				ok: false,
				error: e instanceof Error ? e.message : String(e),
				query: { graph: graph.id, referenceSample: graph.referenceSample, input }
			} satisfies ApiError);
		}
	}

	onMount(() => {
		runApiQuery();
	});
</script>

<svelte:head>
	<title>Graphoscope API — {status}</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<main data-status={status}>
	<p class="note">
		Graphoscope query API. This page runs the pangenome query in your browser and prints the result
		as JSON below. Parameters: <code>ref</code> (grch38 | chm13) and <code>locus</code> (a gene
		symbol or <code>contig:start-end</code>). Wait for <code>data-status="done"</code> on
		<code>&lt;main&gt;</code>, then read <code>#result</code> or
		<code>window.graphoscopeResult</code>.
	</p>
	{#if status === 'loading'}
		<p class="status">Running query…</p>
	{/if}
	<pre id="result">{json}</pre>
</main>

<style>
	main {
		max-width: 820px;
		margin: 2rem auto;
		padding: 0 1rem;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
	}
	.note {
		font-family: system-ui, sans-serif;
		font-size: 0.85rem;
		color: #555;
		line-height: 1.5;
		border-left: 3px solid #dbeafe;
		background: #f8faff;
		padding: 0.6rem 0.9rem;
		border-radius: 0 8px 8px 0;
	}
	.status {
		color: #2563eb;
	}
	pre {
		white-space: pre-wrap;
		word-break: break-word;
		font-size: 0.85rem;
		background: #0b0d12;
		color: #e6ebf5;
		padding: 1rem;
		border-radius: 8px;
		overflow-x: auto;
	}
</style>
