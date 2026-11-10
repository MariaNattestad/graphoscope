<script lang="ts">
	// How Sites works, drawn on a real locus, and what the Bandage-based views do
	// with the same window. The point throughout is a window's loose ends: where
	// a haplotype leaves the subgraph, which is the only record inside it of where
	// the full graph goes on.
	//
	// Sites runs here in the real `query.wasm` (as in /playground). bandage-core is
	// GPL, so none of it is in Graphoscope: its numbers below were measured once,
	// outside this repository, by running its fold on the same C4A window.
	import { onMount } from 'svelte';
	import { base } from '$app/paths';
	import { parseGfa, type Gfa } from '$lib/gfa';
	import type { ReduceRequest, ReduceResult } from '$lib/gfaReduce.worker';
	import GraphLayoutView from '$lib/graph/GraphLayoutView.svelte';
	import { looseEnds } from '$lib/graph/exitCues';
	import { REAL_FIXTURES } from '$lib/graph/fixtures';

	const fixture = REAL_FIXTURES.find((f) => f.id === 'c4a')!;
	// C4A's 41,121 bp window fit to 1,000 px is ~41 bp/px, and JBrowse folds
	// variants under ten pixels.
	const JBROWSE_FOLD = 410;
	const THRESHOLDS = [50, 200, JBROWSE_FOLD, 1000, 10000];

	// bandage-core 13.1.0's foldVariants(graph without paths, bp, { cut: true }) on
	// this window, as JBrowse's graph track calls it: segments, and loose ends left.
	const BANDAGE_FOLD: Record<number, { nodes: number; exits: number }> = {
		50: { nodes: 17, exits: 8 },
		200: { nodes: 13, exits: 4 },
		410: { nodes: 7, exits: 2 },
		1000: { nodes: 3, exits: 0 },
		10000: { nodes: 1, exits: 0 }
	};

	// Held raw: the layout worker structured-clones these (see /playground).
	const original: Gfa = parseGfa(fixture.gfaText);
	const exits = looseEnds(original, fixture.referenceSample);

	let sites = $state.raw<Record<number, Gfa>>({});
	let sitesError = $state<string | null>(null);
	onMount(() => {
		const w = new Worker(new URL('$lib/gfaReduce.worker.ts', import.meta.url), { type: 'module' });
		w.onmessage = (ev: MessageEvent<ReduceResult>) => {
			const t = THRESHOLDS[ev.data.id];
			if (ev.data.ok) sites = { ...sites, [t]: parseGfa(ev.data.gfa ?? '') };
			else sitesError = `${ev.data.error}\n${ev.data.stderr ?? ''}`.trim();
		};
		THRESHOLDS.forEach((t, id) => {
			const req: ReduceRequest = { id, gfaText: fixture.gfaText, maxVariant: t, wasmUrl: `${base}/query.wasm` };
			w.postMessage(req);
		});
		return () => w.terminate();
	});

	const shown = $derived(sites[JBROWSE_FOLD]);

	// Each original loose end, and the Sites node that now holds it (its own id
	// or an unchopped node listing it in MB): still a loose end there, or not.
	function exitsIn(g: Gfa) {
		const loose = new Set(looseEnds(g, fixture.referenceSample));
		const holder = new Map<string, string>();
		for (const s of g.segments.values()) for (const m of s.members ?? [s.id]) holder.set(m, s.id);
		return exits.map((id) => {
			const h = holder.get(id);
			return { id, holder: h, kept: !!h && loose.has(h) };
		});
	}
	const shownExits = $derived(shown ? exitsIn(shown) : null);
	const keptAt = (t: number) => (sites[t] ? exitsIn(sites[t]).filter((e) => e.kept).length : null);
</script>

<svelte:head>
	<title>How it works · Graphoscope</title>
</svelte:head>

<main>
	<header>
		<a href="{base}/" data-sveltekit-reload>← back to the browser</a>
		<h1>How it works</h1>
		<p class="lede">
			Graphoscope shows a <b>window</b> cut from a pangenome graph. Wherever a haplotype's path leaves the
			window, the subgraph has a <b>loose end</b>: the only sign, inside the window, that the graph goes on.
			(A path can also really end there; inside the window the two look the same, and either way the view is
			incomplete at that point.) <b>Sites</b> is how Graphoscope simplifies a window, and it is built to keep
			every one of those ends.
		</p>
	</header>

	<section>
		<h2>Sites, step by step</h2>
		<svg class="schematic" viewBox="0 0 680 256" role="img" aria-labelledby="steps-title">
			<title id="steps-title">The three steps of Sites on one site with a loose end</title>
			{#each [0, 1, 2] as p (p)}
				{@const x = 10 + p * 228}
				<text {x} y="20" class="panel">{['1 · Find the site', '2 · Read the alleles', '3 · Fold'][p]}</text>
				<rect {x} y="32" width="200" height="200" class="window" />
				<line x1={x} y1="200" x2={x + 200} y2="200" class="ref" />
				{#if p === 0}
					<path d="M{x + 30} 200 C {x + 45} 90, {x + 135} 90, {x + 150} 200" class="allele grey" />
					<path d="M{x + 162} 200 C {x + 165} 160, {x + 172} 110, {x + 180} 76" class="allele grey" />
					<path d="M{x + 30} 210 L {x + 30} 216 L {x + 162} 216 L {x + 162} 210" class="bracket" />
					<text x={x + 96} y="250" class="note" text-anchor="middle">one site</text>
				{:else}
					<path d="M{x + 30} 200 C {x + 45} 90, {x + 135} 90, {x + 150} 200" class="allele" />
					{#if p === 1}
						<path d="M{x + 36} 200 C {x + 52} 104, {x + 128} 104, {x + 144} 200" class="allele thin" />
						<circle cx={x + 90} cy="112" r="4" class="snp" />
						<text x={x + 90} y="74" class="note" text-anchor="middle">3 haplotypes</text>
						<text x={x + 90} y="178" class="note" text-anchor="middle">1, a SNP apart</text>
					{:else}
						<text x={x + 90} y="74" class="note" text-anchor="middle">4 haplotypes</text>
					{/if}
					<path d="M{x + 162} 200 C {x + 165} 160, {x + 172} 110, {x + 180} 76" class="allele exit" />
					<line x1={x + 180} y1="76" x2={x + 183} y2="34" class="cue" />
					<text x={x + 172} y="58" class="note" text-anchor="end">2 end</text>
				{/if}
			{/each}
		</svg>
		<ol class="steps">
			<li>
				<b>Find the sites.</b> Non-reference nodes that connect to each other form a site, spanning the reference
				from the first place they attach to the last. That includes paths that leave the reference and don't
				come back inside the window. Bubbles under 50 bp are popped onto the reference first.
			</li>
			<li>
				<b>Read each haplotype's allele</b> at every site: its path from where it leaves the reference to where it
				rejoins, or to where the path stops if it leaves the window inside the site.
			</li>
			<li>
				<b>Fold.</b> Alleles that start and end in the same places are compared, and each folds into the nearest
				kept allele whose largest single difference from it is under the threshold; its haplotype is rerouted
				onto that allele. Only the kept alleles' nodes stay. An allele that ends inside the window is only ever
				compared with alleles ending on the same node, so <b>no loose end is folded away</b>. Unbranched runs are
				then merged into single nodes.
			</li>
		</ol>
	</section>

	<section>
		<h2>On a real locus: C4A</h2>
		<p>
			The C4 genes vary in copy number, so in this {original.segments.size.toLocaleString()}-node window many
			haplotypes leave through extra copies that lie outside it: the window has <b>{exits.length} loose ends</b>.
			Dashed lines mark them. This is Sites at {JBROWSE_FOLD} bp, the threshold JBrowse would fold this window
			at (below).
		</p>
		<div class="compare">
			<div class="pane">
				<span class="pane-label">Original · {original.segments.size.toLocaleString()} nodes · {exits.length} loose ends</span>
				<div class="graph-embed">
					<GraphLayoutView gfa={original} referenceSample={fixture.referenceSample} windowedSubgraph bare />
				</div>
			</div>
			<div class="pane">
				<span class="pane-label">
					Sites, {JBROWSE_FOLD} bp
					{#if sitesError}<span class="fail">{sitesError}</span>{:else if shown && shownExits}
						· {shown.segments.size} nodes · {shownExits.filter((e) => e.kept).length} of {exits.length} loose ends kept
					{:else}<span class="muted">· reducing…</span>{/if}
				</span>
				<div class="graph-embed">
					{#if shown}
						<GraphLayoutView gfa={shown} referenceSample={fixture.referenceSample} windowedSubgraph bare />
					{/if}
				</div>
			</div>
		</div>
		{#if shownExits}
			<table>
				<thead><tr><th>Loose end</th><th>bp</th><th>In the Sites graph</th></tr></thead>
				<tbody>
					{#each shownExits as e (e.id)}
						<tr>
							<td><code>{e.id}</code></td>
							<td>{original.segments.get(e.id)?.length.toLocaleString()}</td>
							<td class={e.kept ? 'pass' : 'fail'}>
								{e.kept ? 'still a loose end' : 'connected over'}{e.holder && e.holder !== e.id ? ` (inside ${e.holder})` : ''}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
	</section>

	<section>
		<h2>What the Bandage-based views lose</h2>
		<p>
			<a href="https://github.com/rrwick/Bandage">Bandage</a> was built for assembly graphs, where a dead end is
			usually a gap in the assembly. It is also how many people look at pangenome loci: on its own, and inside
			JBrowse's graph genome view, which draws with Bandage's layout and folds with
			<a href="https://github.com/GMOD/bandage-core">bandage-core</a>.
		</p>
		<div class="cards">
			<div class="card">
				<h3>Bandage</h3>
				<ul>
					<li>Draws every node; the only reduction is merging unbranched runs, on request.</li>
					<li>
						Reads a GFA's segments and links but not its P or W lines, so it never learns where a haplotype goes
						or stops. (The BandageNG fork reads them, for highlighting and scope.)
					</li>
					<li>
						A loose end is a "dead end": counted under Graph information and selectable from a menu, but drawn
						like any other node end, whether a haplotype leaves the window there or the graph really stops.
					</li>
				</ul>
			</div>
			<div class="card">
				<h3>JBrowse graph genome view</h3>
				<ul>
					<li>
						Draws a link only when both ends are inside the cut. Reference that runs past the window gets a
						triangle; a haplotype strand that leaves it gets nothing.
					</li>
					<li>
						Zoomed out, it folds every variant under ten pixels. An allele's size is its own length or the
						reference it replaces. A strand that leaves the window replaces none, and the window cut it short, so
						a whole extra C4 copy is sized by the few hundred bp inside the window, and folds away with its loose
						end.
					</li>
					<li>
						Its <i>walk rows</i> view does record, per haplotype, whether a walk stops or carries on past the
						window. The graph drawing doesn't.
					</li>
				</ul>
			</div>
		</div>

		<h3>The same C4A window, folded by Sites and by bandage-core</h3>
		<div class="scroll">
			<table>
				<thead>
					<tr>
						<th>Fold below</th>
						{#each THRESHOLDS as t (t)}<th>{t.toLocaleString()} bp</th>{/each}
					</tr>
				</thead>
				<tbody>
					<tr>
						<th>Sites</th>
						{#each THRESHOLDS as t (t)}
							{@const k = keptAt(t)}
							<td>
								{k == null ? '…' : `${k} of ${exits.length}`}
								<span class="muted">· {sites[t]?.segments.size ?? '…'} nodes</span>
							</td>
						{/each}
					</tr>
					<tr>
						<th>bandage-core</th>
						{#each THRESHOLDS as t (t)}
							<td>
								{BANDAGE_FOLD[t].exits} of {exits.length}
								<span class="muted">· {BANDAGE_FOLD[t].nodes} nodes</span>
							</td>
						{/each}
					</tr>
				</tbody>
			</table>
		</div>
		<p class="small">Loose ends kept, and nodes left, on the C4A window at each threshold.</p>
	</section>

	<section>
		<h2>Side by side</h2>
		<div class="scroll">
			<table>
				<thead><tr><th></th><th>Sites</th><th>Bandage</th><th>JBrowse graph view</th></tr></thead>
				<tbody>
					<tr>
						<th>Simplifies the graph</th>
						<td>Yes: per site, haplotype allele by allele</td>
						<td>No: merges unbranched runs on request</td>
						<td>Zoomed out: folds variants under ten pixels</td>
					</tr>
					<tr>
						<th>Uses haplotype paths</th>
						<td>Yes: they define the alleles</td>
						<td>No (BandageNG: to highlight)</td>
						<td>In walk rows and tube maps; not in the fold</td>
					</tr>
					<tr>
						<th>C4A loose ends at {JBROWSE_FOLD} bp</th>
						<td>{keptAt(JBROWSE_FOLD) ?? '…'} of {exits.length} kept</td>
						<td>{exits.length} of {exits.length} drawn (nothing removed)</td>
						<td>{BANDAGE_FOLD[JBROWSE_FOLD].exits} of {exits.length} kept</td>
					</tr>
					<tr>
						<th>Loose end marked in the drawing</th>
						<td>Yes: a dashed line</td>
						<td>No</td>
						<td>Reference only</td>
					</tr>
				</tbody>
			</table>
		</div>
	</section>

	<section class="sources">
		<h2>Sources</h2>
		<ul>
			<li>
				Bandage at <a href="https://github.com/rrwick/Bandage/tree/c89b9cf">c89b9cf</a>: GFA reading in
				<code>graph/assemblygraph.cpp</code>, dead ends in <code>graph/debruijnnode.cpp</code> and
				<code>ui/mainwindow.cpp</code>. BandageNG at
				<a href="https://github.com/asl/BandageNG/tree/5004d97">5004d97</a>.
			</li>
			<li>
				bandage-core at <a href="https://github.com/GMOD/bandage-core/tree/d1bbc26">d1bbc26</a> (npm 13.1.0):
				<code>src/foldVariants.ts</code>. JBrowse's
				<a href="https://github.com/GMOD/jbrowse-plugin-graphgenomeviewer/tree/5d5b9a1"
					>graph genome view plugin at 5d5b9a1</a
				>
				calls it as <code>foldVariants(anchored, foldBelowBp, {'{'} cut: true {'}'})</code>, with
				<code>foldBelowBp</code> ten times the view's bp per pixel. The
				<a href="https://jbrowse.org/jb2/docs/user_guides/graph_genome_view/">graph genome view docs</a> describe
				the link and triangle rules.
			</li>
			<li>
				The bandage-core numbers come from running its <code>foldVariants</code> on the C4A window outside this
				repository, the way the plugin calls it; bandage-core is GPL and no part of it is in Graphoscope. Sites
				runs live in this page.
			</li>
		</ul>
	</section>
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
		padding: 2rem 1rem 4rem;
		line-height: 1.55;
	}
	h1 {
		margin: 0.4rem 0;
		font-size: 1.6rem;
	}
	h2 {
		margin: 2.4rem 0 0.6rem;
		font-size: 1.25rem;
	}
	h3 {
		margin: 1.4rem 0 0.4rem;
		font-size: 1rem;
	}
	p,
	.steps {
		max-width: 75ch;
	}
	.lede {
		color: #333;
	}
	a {
		color: #2563eb;
	}
	.steps li {
		margin-bottom: 0.5rem;
	}
	.schematic {
		width: 100%;
		max-width: 680px;
		display: block;
		margin: 1rem 0;
	}
	.schematic .panel {
		font-size: 14px;
		font-weight: 600;
		fill: #1a1a1a;
	}
	.schematic .note {
		font-size: 12px;
		fill: #555;
	}
	.schematic .window {
		fill: none;
		stroke: #9ca3af;
		stroke-dasharray: 5 4;
	}
	.schematic .ref {
		stroke: #6b7280;
		stroke-width: 4;
	}
	.schematic .bracket {
		fill: none;
		stroke: #6b7280;
		stroke-width: 1.5;
	}
	.schematic .allele {
		fill: none;
		stroke: #f59e0b;
		stroke-width: 5;
		stroke-linecap: round;
	}
	.schematic .allele.grey {
		stroke: #9ca3af;
	}
	.schematic .allele.thin {
		stroke-width: 3;
		stroke: #fbbf24;
	}
	.schematic .allele.exit {
		stroke: #dc2626;
	}
	.schematic .snp {
		fill: #b45309;
	}
	.schematic .cue {
		stroke: #dc2626;
		stroke-width: 2;
		stroke-dasharray: 3 3;
	}
	.compare {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.8rem;
	}
	.pane {
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	.pane-label {
		font-size: 0.8rem;
		color: #555;
		min-height: 2.6em;
	}
	.graph-embed {
		height: 440px;
	}
	.cards {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.8rem;
	}
	.card {
		border: 1px solid #e5e7eb;
		border-radius: 10px;
		padding: 0.2rem 1rem 0.6rem;
		font-size: 0.9rem;
	}
	.card ul {
		padding-left: 1.1rem;
		margin: 0.4rem 0 0;
	}
	.card li {
		margin-bottom: 0.4rem;
	}
	.scroll {
		overflow-x: auto;
	}
	table {
		border-collapse: collapse;
		margin: 1rem 0 0.3rem;
		font-size: 0.85rem;
	}
	th,
	td {
		text-align: left;
		padding: 0.3rem 0.8rem 0.3rem 0;
		border-bottom: 1px solid #eee;
		vertical-align: top;
	}
	tbody th {
		color: #555;
		font-weight: 500;
	}
	.small {
		font-size: 0.8rem;
		color: #666;
		margin-top: 0;
	}
	.sources {
		font-size: 0.85rem;
		color: #444;
	}
	.sources li {
		margin-bottom: 0.4rem;
	}
	.pass {
		color: #15803d;
	}
	.fail {
		color: #b91c1c;
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
	@media (max-width: 700px) {
		.compare,
		.cards {
			grid-template-columns: 1fr;
		}
	}
</style>
