<script lang="ts">
	// How the algorithms work, drawn on a real locus. Sites (our simplification)
	// and FM³ (the multilevel force layout behind the Reference-free view) both
	// shrink the graph they're given — Sites for good, FM³ only as a scaffold while
	// it lays the graph out — so this page shows what each does with the subgraph's
	// window exits: the loose ends where a haplotype carries on in the full graph.
	//
	// Everything below the schematics is computed here from the C4A fixture: Sites
	// by the real `query.wasm` (as in /playground), FM³ by fm3.ts itself, with the
	// hierarchy captured level by level.
	import { onMount } from 'svelte';
	import { base } from '$app/paths';
	import { parseGfa, type Gfa } from '$lib/gfa';
	import type { ReduceRequest, ReduceResult } from '$lib/gfaReduce.worker';
	import GraphLayoutView from '$lib/graph/GraphLayoutView.svelte';
	import { looseEnds } from '$lib/graph/exitCues';
	import { runFm3, type Fm3Edge, type Fm3LevelSnapshot } from '$lib/graph/fm3';
	import { REAL_FIXTURES } from '$lib/graph/fixtures';

	const fixture = REAL_FIXTURES.find((f) => f.id === 'c4a')!;
	const THRESHOLD = 50;

	// Held raw: the layout worker structured-clones these (see /playground).
	const original: Gfa = parseGfa(fixture.gfaText);
	const exits = looseEnds(original, fixture.referenceSample);
	const exitSet = new Set(exits);

	let sites = $state.raw<Gfa | null>(null);
	let sitesError = $state<string | null>(null);
	onMount(() => {
		const w = new Worker(new URL('$lib/gfaReduce.worker.ts', import.meta.url), { type: 'module' });
		w.onmessage = (ev: MessageEvent<ReduceResult>) => {
			if (ev.data.ok) sites = parseGfa(ev.data.gfa ?? '');
			else sitesError = `${ev.data.error}\n${ev.data.stderr ?? ''}`.trim();
			w.terminate();
		};
		const req: ReduceRequest = { id: 1, gfaText: fixture.gfaText, maxVariant: THRESHOLD, wasmUrl: `${base}/query.wasm` };
		w.postMessage(req);
		return () => w.terminate();
	});

	// Each original exit, and the Sites node that now holds it (its own id or an
	// unchopped node listing it in MB) — still a loose end there, or not.
	const sitesExits = $derived.by(() => {
		if (!sites) return null;
		const loose = new Set(looseEnds(sites, fixture.referenceSample));
		const holder = new Map<string, string>();
		for (const s of sites.segments.values()) for (const m of s.members ?? [s.id]) holder.set(m, s.id);
		return exits.map((id) => {
			const h = holder.get(id);
			return { id, holder: h, kept: !!h && loose.has(h) };
		});
	});

	// FM³ on the original graph, edges sized the way forceLayout sizes them (half
	// of each segment's drawn span plus a gap), keeping every level's snapshot.
	const levels: Fm3LevelSnapshot[] = [];
	{
		const span = (id: string) => 4 * Math.sqrt(original.segments.get(id)?.length ?? 1);
		const seen = new Set<string>();
		const edges: Fm3Edge[] = [];
		for (const l of original.links) {
			if (l.from === l.to) continue;
			const key = l.from < l.to ? `${l.from} ${l.to}` : `${l.to} ${l.from}`;
			if (seen.has(key)) continue;
			seen.add(key);
			edges.push({ a: l.from, b: l.to, len: (span(l.from) + span(l.to)) / 2 + 10 });
		}
		runFm3({ nodes: [...original.segments.keys()], edges, onLevel: (s) => levels.push(s) });
		levels.sort((a, b) => a.depth - b.depth);
	}

	/** How each level treats the exits: alone (a node of nothing but exits) or
	 * absorbed (merged into a node with interior segments). */
	function exitFate(level: Fm3LevelSnapshot) {
		let alone = 0;
		let absorbed = 0;
		for (const members of level.members.values()) {
			const n = members.filter((m) => exitSet.has(m)).length;
			if (!n) continue;
			if (n === members.length) alone += n;
			else absorbed += n;
		}
		return { alone, absorbed };
	}

	// The levels worth a panel: the first two coarsenings (where the exits are
	// swallowed), the middle and the coarsest; then the finished layout.
	const shownDepths = [...new Set([1, 2, Math.floor((levels.length - 1) / 2), levels.length - 1])]
		.filter((d) => d > 0 && d < levels.length)
		.sort((a, b) => a - b);

	const BOX = 260;
	function fit(level: Fm3LevelSnapshot) {
		const xs = [...level.pos.values()].map((p) => p.x);
		const ys = [...level.pos.values()].map((p) => p.y);
		const minX = Math.min(...xs);
		const minY = Math.min(...ys);
		const w = Math.max(1, Math.max(...xs) - minX);
		const h = Math.max(1, Math.max(...ys) - minY);
		const k = (BOX - 24) / Math.max(w, h);
		const ox = (BOX - w * k) / 2;
		const oy = (BOX - h * k) / 2;
		return (id: string) => {
			const p = level.pos.get(id)!;
			return { x: ox + (p.x - minX) * k, y: oy + (p.y - minY) * k };
		};
	}
	function kind(level: Fm3LevelSnapshot, id: string): 'exit' | 'absorbed' | 'interior' {
		const members = level.members.get(id) ?? [id];
		const n = members.filter((m) => exitSet.has(m)).length;
		return n === 0 ? 'interior' : n === members.length ? 'exit' : 'absorbed';
	}
	function radius(level: Fm3LevelSnapshot, id: string) {
		const r = Math.min(9, 1.6 + Math.sqrt(level.members.get(id)?.length ?? 1) * 0.7);
		return kind(level, id) === 'interior' ? r : Math.max(r, 3.5);
	}

	// FM³'s finished drawing: does an exit sit on the outside of the graph, where a
	// strand leaving the window would point? Rank each exit by its distance from
	// the drawing's centre among all nodes.
	const finalLevel = levels[0];
	const exitPlacement = (() => {
		const pts = [...finalLevel.pos.values()];
		const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
		const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
		const dist = (id: string) => Math.hypot(finalLevel.pos.get(id)!.x - cx, finalLevel.pos.get(id)!.y - cy);
		const all = [...finalLevel.pos.keys()].map(dist).sort((a, b) => a - b);
		return exits.map((id) => {
			const d = dist(id);
			const below = all.filter((x) => x < d).length;
			return Math.round((100 * below) / all.length);
		});
	})();
	const outerExits = exitPlacement.filter((p) => p >= 90).length;
</script>

<svelte:head>
	<title>How it works · Graphoscope</title>
</svelte:head>

<main>
	<header>
		<a class="back" href="{base}/" data-sveltekit-reload>← back to the browser</a>
		<h1>How it works</h1>
		<p class="lede">
			Graphoscope shows a <b>window</b> cut from a pangenome graph. Inside it, every loose end of a
			haplotype strand is one of two things: a <b>window exit</b>, where the haplotype carries on in the
			full graph outside the window, or (rarely) a real <b>path end</b>. Either way it marks where this view
			of the graph is incomplete. This page shows how our simplification, <b>Sites</b>, keeps every one
			of them, and what <b>FM³</b>, the multilevel force layout behind the Reference-free view, does with
			them instead.
		</p>
	</header>

	<section>
		<h2>Sites: fold alleles, keep the exits</h2>
		<p>
			Sites works per <b>variant site</b>: a stretch of the reference that non-reference nodes leave and
			rejoin. At each site, every haplotype contributes one <b>allele</b>, its path across the site. Alleles
			are compared by their largest difference; each folds into the nearest kept allele within the
			threshold, and the kept alleles are all that stay. A haplotype that leaves the window inside a site
			has an allele that <b>ends</b> there. Alleles only fold into alleles that end in the same place, so an
			exit is never folded into a path that carries on, and its loose end stays exactly where it was.
		</p>
		<svg class="schematic" viewBox="0 0 680 250" role="img" aria-labelledby="sites-schematic-title">
			<title id="sites-schematic-title">Sites before and after on one site with an exit</title>
			<g>
				<text x="20" y="22" class="panel">Before</text>
				<rect x="20" y="34" width="300" height="196" class="window" />
				<text x="28" y="52" class="note">window</text>
				<line x1="20" y1="200" x2="320" y2="200" class="ref" />
				<path d="M70 200 C 90 80, 230 80, 250 200" class="allele" />
				<path d="M76 200 C 98 96, 222 96, 244 200" class="allele thin" />
				<circle cx="160" cy="103" r="4" class="snp" />
				<path d="M262 200 C 266 160, 280 110, 292 70" class="allele exit" />
				<line x1="292" y1="70" x2="296" y2="34" class="cue" />
				<text x="276" y="64" class="note" text-anchor="end">exit</text>
				<text x="160" y="140" class="note" text-anchor="middle">1 bp apart</text>
			</g>
			<text x="340" y="132" class="arrow" text-anchor="middle">→</text>
			<g>
				<text x="360" y="22" class="panel">After Sites</text>
				<rect x="360" y="34" width="300" height="196" class="window" />
				<line x1="360" y1="200" x2="660" y2="200" class="ref" />
				<path d="M410 200 C 430 80, 570 80, 590 200" class="allele" />
				<path d="M602 200 C 606 160, 620 110, 632 70" class="allele exit" />
				<line x1="632" y1="70" x2="636" y2="34" class="cue" />
				<text x="616" y="64" class="note" text-anchor="end">exit kept</text>
				<text x="500" y="140" class="note" text-anchor="middle">folded into one</text>
			</g>
		</svg>

		<h3>On a real locus: C4A, {original.segments.size.toLocaleString()} nodes, {THRESHOLD} bp</h3>
		<p>
			The C4 genes vary in copy number, so many haplotypes leave this window through extra copies that
			sit outside it: the graph has <b>{exits.length} window exits</b>. Dashed lines mark them.
		</p>
		<div class="compare">
			<div class="pane">
				<span class="pane-label">Original · {original.segments.size.toLocaleString()} nodes · {exits.length} exits</span>
				<div class="graph-embed">
					<GraphLayoutView gfa={original} referenceSample={fixture.referenceSample} windowedSubgraph bare />
				</div>
			</div>
			<div class="pane">
				<span class="pane-label">
					Sites
					{#if sitesError}<span class="fail">{sitesError}</span>{:else if sites && sitesExits}
						· {sites.segments.size} nodes · {sitesExits.filter((e) => e.kept).length} of {exits.length} exits kept
					{:else}<span class="muted">· reducing…</span>{/if}
				</span>
				<div class="graph-embed">
					{#if sites}
						<GraphLayoutView gfa={sites} referenceSample={fixture.referenceSample} windowedSubgraph bare />
					{/if}
				</div>
			</div>
		</div>
		{#if sitesExits}
			<table>
				<thead><tr><th>Exit node</th><th>bp</th><th>In the Sites graph</th></tr></thead>
				<tbody>
					{#each sitesExits as e (e.id)}
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
		<h2>FM³: coarsen, lay out, refine</h2>
		<p>
			FM³ (Hachul &amp; Jünger's Fast Multipole Multilevel Method) is a force-directed layout, not a
			simplification: its final drawing has every node. To get there it builds a hierarchy of ever
			smaller graphs. Each round picks <b>suns</b>, gives each sun its neighbours as <b>planets</b> and
			theirs as <b>moons</b>, and collapses each such solar system to one node. The smallest graph is laid
			out first; then each level is placed around its parent's position and relaxed. The input is only
			nodes and edges. Nothing in it says a node is a window exit, so an exit is just a node with one
			neighbour: coarsening merges it into a solar system with interior nodes, and from then on it
			doesn't exist as anything of its own.
		</p>
		<svg class="schematic" viewBox="0 0 680 220" role="img" aria-labelledby="fm3-schematic-title">
			<title id="fm3-schematic-title">FM³ absorbing an exit into a solar system</title>
			<text x="20" y="22" class="panel">Input</text>
			<line x1="30" y1="150" x2="190" y2="150" class="ref" />
			<path d="M70 150 Q 90 90 110 70" class="allele exit" />
			<circle cx="110" cy="70" r="5" class="exit-node" />
			<circle cx="70" cy="150" r="5" class="node" />
			<circle cx="130" cy="150" r="5" class="node" />
			<circle cx="190" cy="150" r="5" class="node" />
			<text x="120" y="66" class="note">exit</text>
			<text x="230" y="120" class="arrow" text-anchor="middle">→</text>

			<text x="260" y="22" class="panel">Solar systems</text>
			<circle cx="330" cy="130" r="58" class="system" />
			<circle cx="330" cy="150" r="7" class="sun" />
			<circle cx="290" cy="150" r="5" class="node" />
			<circle cx="370" cy="150" r="5" class="node" />
			<circle cx="310" cy="90" r="5" class="exit-node" />
			<text x="330" y="208" class="note" text-anchor="middle">sun, planets, moons</text>
			<text x="445" y="120" class="arrow" text-anchor="middle">→</text>

			<text x="475" y="22" class="panel">Coarser graph</text>
			<circle cx="515" cy="130" r="12" class="node" />
			<text x="475" y="208" class="note">one node: the exit is gone</text>
			<text x="545" y="110" class="note">then laid out and</text>
			<text x="545" y="126" class="note">refined back down:</text>
			<text x="545" y="142" class="note">the exit returns at</text>
			<text x="545" y="158" class="note">a random angle</text>
		</svg>

		<h3>On the same C4A graph</h3>
		<p>
			Below are the levels fm3.ts builds from it, coarsening left to right and then laid out back down
			to every node, with exits in <span class="key exit">red</span>, and a
			node that has absorbed an exit together with interior nodes in
			<span class="key absorbed">pink</span>.
		</p>
		<div class="levels">
			{#each [...shownDepths, 0] as d (d)}
				{@const level = levels[d]}
				{@const at = fit(level)}
				{@const fate = exitFate(level)}
				<figure>
					<svg viewBox="0 0 {BOX} {BOX}" class="level">
						{#each level.edges as [a, b] (a + ' ' + b)}
							{@const p = at(a)}
							{@const q = at(b)}
							<line x1={p.x} y1={p.y} x2={q.x} y2={q.y} class="edge" />
						{/each}
						{#each level.nodes as id (id)}
							{@const p = at(id)}
							<circle cx={p.x} cy={p.y} r={radius(level, id)} class={kind(level, id)} />
						{/each}
					</svg>
					<figcaption>
						<b>{d === 0 ? 'Final layout' : d === levels.length - 1 ? `Level ${d}, the coarsest` : `Level ${d}`}</b> · {level.nodes.length.toLocaleString()} nodes<br />
						{#if d === 0}
							{outerExits} of {exits.length} exits on the outside of the drawing
						{:else}
							{fate.alone} of {exits.length} exits still on their own · {fate.absorbed} absorbed
						{/if}
					</figcaption>
				</figure>
			{/each}
		</div>
		<p>
			Every node comes back in the final layout, but the drawing places each exit wherever its forces
			settle: the {exits.length} exits sit at
			{exitPlacement.map((p) => `${p}%`).join(', ')} of the way out from the centre (as percentiles of all
			nodes), so nothing in the picture distinguishes a strand that leaves the window from any other tip.
			Graphoscope draws its exit cues on top of every layout from the graph itself, not from FM³.
		</p>
	</section>

	<section>
		<h2>Side by side</h2>
		<table class="summary">
			<thead><tr><th></th><th>Sites</th><th>FM³</th></tr></thead>
			<tbody>
				<tr><th>What it is</th><td>Simplification: a smaller graph</td><td>Layout: positions for every node</td></tr>
				<tr><th>What it shrinks</th><td>Alleles within the threshold of a kept allele</td><td>Solar systems, temporarily, while it lays out</td></tr>
				<tr><th>Knows about the reference</th><td>Yes: sites are reference spans</td><td>No</td></tr>
				<tr><th>Knows about window exits</th><td>Yes: an allele that ends is only folded with alleles ending at the same node</td><td>No: an exit is a node with one neighbour</td></tr>
				<tr><th>What happens to an exit</th><td>Kept as its own loose end</td><td>Absorbed into a neighbour's system at the first coarsening; back at the end, placed like any tip</td></tr>
			</tbody>
		</table>
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
		margin: 0.4rem 0 0.4rem;
		font-size: 1.6rem;
	}
	h2 {
		margin: 2.4rem 0 0.6rem;
		font-size: 1.25rem;
	}
	h3 {
		margin: 1.6rem 0 0.4rem;
		font-size: 1rem;
	}
	p {
		max-width: 75ch;
	}
	.lede {
		color: #333;
	}
	.back,
	a {
		color: #2563eb;
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
	.schematic .arrow {
		font-size: 28px;
		fill: #888;
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
	.schematic .allele {
		fill: none;
		stroke: #f59e0b;
		stroke-width: 5;
		stroke-linecap: round;
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
	.schematic .node {
		fill: #9ca3af;
	}
	.schematic .sun {
		fill: #4b5563;
	}
	.schematic .exit-node {
		fill: #dc2626;
	}
	.schematic .system {
		fill: #f3f4f6;
		stroke: #d1d5db;
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
		height: 480px;
	}
	table {
		border-collapse: collapse;
		margin: 1rem 0;
		font-size: 0.85rem;
	}
	th,
	td {
		text-align: left;
		padding: 0.3rem 0.8rem 0.3rem 0;
		border-bottom: 1px solid #eee;
		vertical-align: top;
	}
	.summary tbody th {
		color: #555;
		font-weight: 500;
	}
	.levels {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
		gap: 0.8rem;
	}
	figure {
		margin: 0;
	}
	.level {
		width: 100%;
		background: #0d1117;
		border-radius: 8px;
	}
	.level .edge {
		stroke: #4b5563;
		stroke-width: 0.6;
	}
	.level .interior {
		fill: #9ca3af;
	}
	.level .exit {
		fill: #ef4444;
	}
	.level .absorbed {
		fill: #f9a8d4;
	}
	figcaption {
		font-size: 0.8rem;
		color: #555;
		margin-top: 0.3rem;
	}
	.key {
		padding: 0 4px;
		border-radius: 4px;
		color: #fff;
	}
	.key.exit {
		background: #ef4444;
	}
	.key.absorbed {
		background: #f9a8d4;
		color: #831843;
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
		.compare {
			grid-template-columns: 1fr;
		}
	}
</style>
