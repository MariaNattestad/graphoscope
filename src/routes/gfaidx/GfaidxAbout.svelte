<script lang="ts">
	// The "Read more" behind /gfaidx's experimental strip: why a gfaidx query is
	// slower here than a GBZ-base one, what it took to run gfaidx in a browser at
	// all, and what it gives in return (named haplotypes). Written for anyone,
	// gfaidx's authors included. The full how-to is /gfaidx-docs.
	import { base } from '$app/paths';

	let { open = $bindable(false) }: { open?: boolean } = $props();
	let dialog: HTMLDialogElement | undefined = $state();

	$effect(() => {
		if (!dialog) return;
		if (open && !dialog.open) dialog.showModal();
		if (!open && dialog.open) dialog.close();
	});

	// Where each query's reads land in the index files, drawn as ticks along one
	// strip: GBZ-base's 7 requests sit together; gfaidx's ~660 are spread over
	// the whole 3 GB. Positions are made up but deterministic, the counts real.
	const W = 560;
	const gbzTicks = [0.412, 0.415, 0.417, 0.418, 0.42, 0.61, 0.612].map((f) => f * W);
	const gfaidxTicks = Array.from({ length: 160 }, (_, i) => {
		const x = Math.sin(i * 12.9898) * 43758.5453;
		return (x - Math.floor(x)) * W;
	});
</script>

<dialog
	bind:this={dialog}
	class="about"
	aria-labelledby="gfaidx-about-title"
	onclose={() => (open = false)}
	onclick={(e) => {
		if (e.target === dialog) open = false;
	}}
>
	<div class="body">
		<header>
			<h2 id="gfaidx-about-title">gfaidx in Graphoscope <span class="tag">Experimental</span></h2>
			<button class="x" onclick={() => (open = false)} aria-label="Close">×</button>
		</header>

		<p>
			<a href="https://github.com/fawaz-dabbaghieh/gfaidx" target="_blank" rel="noopener">gfaidx</a>
			(<a href="https://doi.org/10.64898/2026.11.15.766357" target="_blank" rel="noopener"
				>Dabbaghie &amp; Steinegger, 2026</a
			>) indexes a GFA so a gene-sized region, with every haplotype through it, can be pulled out of a
			chromosome-scale graph without loading the graph. It splits the graph into communities of nodes, each
			its own gzip block, with small sidecar indexes beside it. Its companion viewer, gfaidx-viz, runs these
			queries on a server next to the index.
		</p>
		<p>
			Graphoscope has no server: your browser reads every file straight from a storage bucket by HTTP range
			request. This page asks whether gfaidx can work that way too. It can: we compiled gfaidx's C++ query
			library to WebAssembly, so the query you see runs in this tab.
		</p>

		<h3>What it gives: haplotypes with names</h3>
		<p>
			The main locus browser reads a GBZ-base database, which returns a region's haplotypes as anonymous walks:
			you see "Walk 3". gfaidx returns each haplotype as the sample, haplotype and contig it is
			(<code>HG00621#1#…</code>), with its own coordinates. So the haplotype panel here lists real assemblies,
			tracing one follows that person's sequence, and you can ask for a region in any haplotype's own
			coordinates, not only the reference's.
		</p>

		<h3>What it costs: many small requests</h3>
		<p>
			gfaidx is built for an index on a local disk, where a small read takes microseconds. The paper's
			benchmarks run on an NVMe drive, and gfaidx-viz extracts on a server. In a browser, every read is an
			HTTP request with a round trip of a few hundred milliseconds. A gfaidx query makes hundreds of small reads,
			a few for each haplotype, spread across a 3 GB index. A GBZ-base query reads a handful of database pages
			that sit together.
		</p>

		<figure class="ticks">
			<svg viewBox="0 0 {W + 150} 96" role="img" aria-labelledby="ticks-title">
				<title id="ticks-title"
					>Where one SOD1 query reads from its index: GBZ-base makes 7 requests close together; gfaidx makes about
					660, spread over the whole file</title
				>
				<text x="0" y="24" class="lab">GBZ-base</text>
				<rect x="140" y="12" width={W} height="18" rx="3" class="strip" />
				{#each gbzTicks as x, i (i)}<rect x={140 + x} y="12" width="2" height="18" class="tick gbz" />{/each}
				<text x="0" y="66" class="lab">gfaidx</text>
				<rect x="140" y="54" width={W} height="18" rx="3" class="strip" />
				{#each gfaidxTicks as x, i (i)}<rect x={140 + x} y="54" width="1.5" height="18" class="tick gfx" />{/each}
				<text x="140" y="90" class="cap">start of the index files</text>
				<text x={140 + W} y="90" class="cap" text-anchor="end">end (3 GB)</text>
			</svg>
			<figcaption>Where one query reads in its index. Each tick is a request (gfaidx's are thinned to fit).</figcaption>
		</figure>

		<table>
			<caption>SOD1 on chromosome 21, opened from our bucket in Chrome</caption>
			<thead>
				<tr><th></th><th>Requests</th><th>Downloaded</th><th>Time</th><th>Haplotypes</th></tr>
			</thead>
			<tbody>
				<tr><td>GBZ-base (main page)</td><td>7</td><td>0.45 MB</td><td>about 3 s</td><td>464, anonymous</td></tr>
				<tr><td>gfaidx (this page)</td><td>~660</td><td>7.1 MB</td><td>about 30 s</td><td>242, named</td></tr>
			</tbody>
		</table>
		<p class="small">
			The two are different graphs: HPRC v2's Minigraph-Cactus graph on the main page, and its PGGB graph of
			120 samples here. gfaidx takes either kind of graph
			(<a href="{base}/gfaidx-docs#graphs" target="_blank" rel="noopener">which graphs work</a>).
		</p>

		<h3>How we made it work</h3>
		<p>
			First, a planner. gfaidx's query runs once with any bytes we don't have yet read as zeros, and we note
			everything it asked for. All of that is fetched at once, in parallel, and the query runs again, until a run
			asks for nothing new. Reads that depend on each other still take one round each, so the wait is a few round
			trips, not hundreds.
		</p>
		<p>Then three small changes to gfaidx, each measured on the SOD1 query:</p>
		<table>
			<thead>
				<tr><th>What's changed</th><th>Rounds</th><th>Downloaded</th></tr>
			</thead>
			<tbody>
				<tr>
					<td>
						<b>File reading.</b> Required: WebAssembly can't memory-map a file, so three sidecars are read in 4 KiB
						pages.
					</td><td>36</td><td>39 MB</td>
				</tr>
				<tr>
					<td>
						<b>Read hints.</b> Before a loop starts, gfaidx says what it will read, so it all comes in one round.
					</td><td>8</td><td>28 MB</td>
				</tr>
				<tr>
					<td>
						<b>Checkpoint lookup.</b> A region is found from the coordinate checkpoints gfaidx already stores,
						instead of by reading the path from its start.
					</td><td><b>8</b></td><td><b>7.1 MB</b></td>
				</tr>
			</tbody>
		</table>
		<p class="small">
			Each row includes the changes above it. Before any of this the same query was 442 requests one after
			another and 67 MB. Every version returns byte-for-byte what unpatched gfaidx returns.
		</p>

		<h3>What could make it faster</h3>
		<p>
			Most of the remaining 30 seconds is waiting in line: our bucket speaks HTTP/1.1, so a browser opens only 6
			connections to it. A CDN that speaks HTTP/2 would let a round's requests share one connection; we haven't
			tried it yet. gfaidx's design suits this well already. Each query reads only a few MB of a 3 GB index, so
			a version that keeps a region's records close together could make it quick from any static host.
		</p>

		<footer>
			<a class="primary" href="{base}/gfaidx-docs">Open your own gfaidx index: how to build and host one →</a>
			<span
				>Thanks to Fawaz Dabbaghie and Martin Steinegger for gfaidx. <a
					href="https://doi.org/10.64898/2026.11.15.766357"
					target="_blank"
					rel="noopener">Read the paper</a
				>.</span
			>
		</footer>
	</div>
</dialog>

<style>
	.about {
		width: min(720px, calc(100vw - 32px));
		max-height: calc(100vh - 48px);
		padding: 0;
		border: 1px solid #e3e7ee;
		border-radius: 12px;
		box-shadow: 0 24px 60px rgba(16, 24, 40, 0.35);
		color: #1f2430;
	}
	.about::backdrop {
		background: rgba(16, 24, 40, 0.45);
	}
	.body {
		padding: 1.1rem 1.4rem 1.3rem;
		font-size: 0.88rem;
		line-height: 1.55;
	}
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}
	h2 {
		margin: 0;
		font-size: 1.15rem;
	}
	h3 {
		margin: 1.3rem 0 0.3rem;
		font-size: 0.95rem;
	}
	p {
		margin: 0.5rem 0;
	}
	.small {
		font-size: 0.78rem;
		color: #6b7280;
	}
	.tag {
		vertical-align: middle;
		font-size: 0.65rem;
		font-weight: 700;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: #4c1d95;
		background: #fde68a;
		border-radius: 999px;
		padding: 0.15rem 0.55rem;
	}
	.x {
		font-size: 1.4rem;
		line-height: 1;
		background: none;
		border: none;
		color: #6b7280;
		cursor: pointer;
		padding: 0.2rem 0.4rem;
	}
	a {
		color: #6d28d9;
	}
	code {
		font-size: 0.8rem;
		background: #f3f4f6;
		padding: 0.05rem 0.3rem;
		border-radius: 4px;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		margin: 0.6rem 0 0.2rem;
		font-size: 0.8rem;
	}
	caption {
		text-align: left;
		font-size: 0.75rem;
		color: #6b7280;
		padding-bottom: 0.25rem;
	}
	th,
	td {
		text-align: left;
		padding: 0.35rem 0.5rem;
		border-bottom: 1px solid #eef0f3;
		vertical-align: top;
	}
	th {
		font-size: 0.72rem;
		color: #6b7280;
		font-weight: 600;
	}
	td:not(:first-child),
	th:not(:first-child) {
		white-space: nowrap;
	}
	figure {
		margin: 0.8rem 0 0.4rem;
	}
	figure svg {
		width: 100%;
		height: auto;
		display: block;
	}
	figcaption {
		font-size: 0.75rem;
		color: #6b7280;
	}
	.lab {
		font-size: 13px;
		font-weight: 600;
		fill: #1f2430;
	}
	.cap {
		font-size: 11px;
		fill: #9aa0aa;
	}
	.strip {
		fill: #f3f4f6;
		stroke: #e3e7ee;
	}
	.tick.gbz {
		fill: #0e7490;
	}
	.tick.gfx {
		fill: #6d28d9;
		opacity: 0.75;
	}
	footer {
		margin-top: 1.2rem;
		padding-top: 0.8rem;
		border-top: 1px solid #eef0f3;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		font-size: 0.8rem;
		color: #6b7280;
	}
	footer .primary {
		font-weight: 600;
		font-size: 0.88rem;
		text-decoration: none;
	}
</style>
