<script lang="ts">
	// Simplification playground: every example graph, one per row — the original,
	// what Sites makes of it, and what Fold makes of it — all at one threshold.
	//
	// The simplification here is not a demo reimplementation — it runs the actual
	// `query.wasm`, in its `--gfa` mode, over each fixture. So this page and a live
	// locus query go through the same binary, and the fixtures it shows are the
	// same files `crates/reduce/src/tests.rs` asserts on.
	import { onMount } from 'svelte';
	import { parseGfa, type Gfa } from '$lib/gfa';
	import { ALL_FIXTURES, type Fixture } from '$lib/graph/fixtures';
	import type { ReduceRequest, ReduceResult } from '$lib/gfaReduce.worker';
	import GraphLayoutView from '$lib/graph/GraphLayoutView.svelte';
	import { foldGfa } from '$lib/graph/fold';
	import { base } from '$app/paths';
	import { afterNavigate } from '$app/navigation';

	// `?t=<bp>` sets the threshold and `?fixture=<id>` scrolls to an example, so a
	// link can show exactly the before/after it's talking about.
	const params = typeof location === 'undefined' ? null : new URLSearchParams(location.search);
	// One threshold for both: Sites folds variants under it, Fold folds alleles
	// under it.
	let maxVariant = $state(Number(params?.get('t')) || 50);

	// A row's graphs are only parsed, reduced and laid out once it scrolls near
	// the viewport: the real loci take seconds each, and the page shouldn't pay
	// for rows nobody has looked at.
	let visible = $state.raw<Set<string>>(new Set());
	function whenVisible(node: HTMLElement, id: string) {
		const io = new IntersectionObserver(
			(entries) => {
				if (entries.some((e) => e.isIntersecting)) {
					visible = new Set([...visible, id]);
					io.disconnect();
				}
			},
			{ rootMargin: '600px 0px' }
		);
		io.observe(node);
		return { destroy: () => io.disconnect() };
	}

	// Held raw (not $state/$derived) so parsed graphs stay plain objects: the
	// layout worker structured-clones them, and a deep-proxied graph throws
	// DataCloneError on postMessage — the same reason the main route holds its
	// gfa as $state.raw.
	const parsedCache = new Map<string, Gfa>();
	function original(f: Fixture): Gfa {
		let g = parsedCache.get(f.id);
		if (!g) {
			g = parseGfa(f.gfaText);
			parsedCache.set(f.id, g);
		}
		return g;
	}

	interface Reduced {
		threshold: number;
		gfa?: Gfa;
		error?: string;
		elapsedMs?: number;
	}
	let reduced = $state.raw<Record<string, Reduced>>({});
	// What's been asked of the worker, so a row isn't sent twice per threshold.
	const requested = new Set<string>();

	let worker = $state.raw<Worker | null>(null);
	let nextId = 1;
	const pending = new Map<number, (r: ReduceResult) => void>();

	onMount(() => {
		const w = new Worker(new URL('$lib/gfaReduce.worker.ts', import.meta.url), { type: 'module' });
		w.onmessage = (ev: MessageEvent<ReduceResult>) => {
			const cb = pending.get(ev.data.id);
			if (cb) {
				pending.delete(ev.data.id);
				cb(ev.data);
			}
		};
		worker = w;
		return () => w.terminate();
	});
	// After SvelteKit's own scroll handling, which would otherwise put the page
	// back at the top once it settles.
	afterNavigate(() => {
		const target = params?.get('fixture');
		if (target) setTimeout(() => document.getElementById(target)?.scrollIntoView(), 100);
	});

	// Reduce every visible row at the current threshold. A row keeps showing its
	// previous result until the new one lands, and a result for a threshold that
	// has since changed is dropped.
	$effect(() => {
		const mv = maxVariant;
		const w = worker;
		if (!w) return;
		for (const f of ALL_FIXTURES) {
			const key = `${f.id}:${mv}`;
			if (!visible.has(f.id) || requested.has(key)) continue;
			requested.add(key);
			const id = nextId++;
			const req: ReduceRequest = { id, gfaText: f.gfaText, maxVariant: mv, wasmUrl: `${base}/query.wasm` };
			new Promise<ReduceResult>((resolve) => {
				pending.set(id, resolve);
				w.postMessage(req);
			}).then((result) => {
				requested.delete(key);
				if (mv !== maxVariant) return;
				reduced = {
					...reduced,
					[f.id]: result.ok
						? { threshold: mv, gfa: parseGfa(result.gfa ?? ''), elapsedMs: result.elapsedMs }
						: { threshold: mv, error: `${result.error}\n${result.stderr ?? ''}`.trim() }
				};
			});
		}
	});

	function folded(f: Fixture) {
		return foldGfa(original(f), maxVariant, { referenceSample: f.referenceSample });
	}
</script>

<main>
	<header>
		<h1>Simplification playground</h1>
		<p class="sub">
			Each example graph as it comes in, then what each simplification makes of it. <b>Sites</b> pops
			small bubbles onto the reference, then folds each haplotype's allele at every site into the nearest
			kept allele; it runs in the same <code>query.wasm</code> the locus browser uses. <b>Fold</b>
			(<code>src/lib/graph/fold.ts</code>) groups nodes into alleles by the first walk that visits them,
			keeps the alleles at least the threshold in size and the shortest route from each back to the
			reference, and folds the rest. The synthetic examples are the ones
			<code>crates/reduce/src/tests.rs</code> asserts on.
			<a href="{base}/" data-sveltekit-reload>← back to the browser</a>
		</p>
	</header>
	<div class="controls">
		<label>
			threshold
			<input type="number" min="1" max="10000" bind:value={maxVariant} /> bp
		</label>
		<span class="muted">Sites: variants under it fold · Fold: alleles under it fold</span>
	</div>

	{#each ALL_FIXTURES as f (f.id)}
		{@const shown = visible.has(f.id)}
		{@const r = reduced[f.id]}
		{@const fold = shown ? folded(f) : null}
		{@const stats = r?.gfa?.reduced}
		<section class="example" class:real={f.kind === 'real'} id={f.id} use:whenVisible={f.id}>
			<div class="ex-head">
				<h2>{f.label}</h2>
				<p class="desc">{f.description}</p>
			</div>
			<div class="compare">
				<div class="pane">
					<span class="pane-label"
						>Original{#if shown}{' · '}{original(f).segments.size.toLocaleString()} nodes{/if}</span
					>
					<div class="graph-embed">
						{#if shown}
							<GraphLayoutView gfa={original(f)} referenceSample={f.referenceSample} initialFold={false} bare />
						{/if}
					</div>
				</div>
				<div class="pane">
					<span class="pane-label">
						Sites
						{#if r?.error}
							<span class="fail">{r.error}</span>
						{:else if stats}
							· {stats.segmentsAfter.toLocaleString()} nodes
							{#if stats.alleles}· {stats.allelesShown} of {stats.alleles} alleles shown{/if}
							{#if r && r.threshold !== maxVariant}<span class="muted"> · updating…</span>{/if}
							{#if f.expect && r && r.threshold === 50}
								{@const e = f.expect}
								{@const ok =
									stats.sites === e.sites &&
									stats.nodesRemoved === e.nodesRemoved &&
									stats.snpCount === e.snpCount &&
									stats.basesRemoved === e.basesRemoved &&
									(e.segmentsAfterSimplify == null || stats.segmentsAfter === e.segmentsAfterSimplify)}
								· <span class={ok ? 'pass' : 'fail'}>{ok ? '✓ as pinned' : '✗ differs from the tests'}</span>
							{/if}
						{:else if shown}
							<span class="muted">· reducing…</span>
						{/if}
					</span>
					<div class="graph-embed">
						{#if r?.gfa}
							<GraphLayoutView gfa={r.gfa} referenceSample={f.referenceSample} initialFold={false} bare />
						{/if}
					</div>
				</div>
				<div class="pane">
					<span class="pane-label">
						Fold
						{#if fold}
							· {fold.stats.segmentsAfter.toLocaleString()} nodes · {fold.stats.keptAlleles} of {fold.stats
								.alleles} alleles kept
						{/if}
					</span>
					<div class="graph-embed">
						{#if fold}
							<GraphLayoutView gfa={fold.gfa} referenceSample={f.referenceSample} initialFold={false} bare />
						{/if}
					</div>
				</div>
			</div>
		</section>
	{/each}
</main>

<style>
	:global(body) {
		margin: 0;
		font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
		color: #1a1a1a;
		background: #fff;
	}
	main {
		max-width: 1400px;
		margin: 0 auto;
		padding: 2rem 1.5rem 4rem;
	}
	.controls {
		position: sticky;
		top: 0;
		z-index: 2;
		background: #fff;
		padding: 0.6rem 0;
		border-bottom: 1px solid #e6e6e6;
	}
	h1 {
		margin: 0 0 0.2rem;
		font-size: 1.5rem;
	}
	h2 {
		margin: 0;
		font-size: 1rem;
	}
	.sub {
		margin: 0 0 0.8rem;
		color: #555;
	}
	.controls {
		display: flex;
		gap: 1.2rem;
		align-items: center;
		flex-wrap: wrap;
	}
	label {
		font-size: 0.9rem;
	}
	input[type='number'] {
		font: inherit;
		padding: 0.3rem 0.45rem;
		border: 1px solid #ccc;
		border-radius: 6px;
	}
	input[type='number'] {
		width: 5rem;
	}
	.example {
		padding: 1.2rem 0;
		border-bottom: 1px solid #eee;
		scroll-margin-top: 3.5rem;
	}
	.ex-head {
		margin-bottom: 0.6rem;
	}
	.desc {
		margin: 0.25rem 0 0;
		color: #555;
		font-size: 0.88rem;
		max-width: 75ch;
	}
	.compare {
		display: grid;
		grid-template-columns: 1fr 1fr 1fr;
		gap: 0.8rem;
	}
	.pane {
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	.pane-label {
		font-size: 0.78rem;
		color: #555;
		font-variant-numeric: tabular-nums;
		/* Room for two lines, so a long label doesn't push its graph below its
		   neighbours'. */
		min-height: 2.6em;
	}
	/* Height-bounded box so the embedded GraphLayoutView's height:100% resolves.
	   The synthetic graphs are a handful of nodes; the real loci need room. */
	.graph-embed {
		height: 280px;
	}
	.real .graph-embed {
		height: 520px;
	}
	.pass {
		color: #15803d;
		font-weight: 600;
	}
	.fail {
		color: #b91c1c;
		font-weight: 600;
		white-space: pre-wrap;
	}
	.muted {
		color: #888;
	}
	code {
		background: #f0f0f0;
		padding: 0 4px;
		border-radius: 4px;
	}
	a {
		color: #2563eb;
	}
</style>
