<script lang="ts">
	// Everything about /gfaidx in one place: what a gfaidx index is, how to build
	// and host your own, the link that opens it, and what to expect (it is
	// experimental and slower than the GBZ-base locus browser). Linked from
	// /gfaidx's experimental strip, its picker and its "Read more" dialog.
	import { base } from '$app/paths';
	import { pageTitle } from '$lib/pageTitle';

	const chr21 = `${base}/gfaidx?index=chr21&locus=SOD1&pin=HG02486%231&pin=HG00321%231`;
	const UPLOAD = `for f in graph.indexed.gfa.gz{,.idx,.ndx,.lnx,.pdx,.pcx}; do
  aws s3 cp --content-type application/octet-stream "$f" s3://my-bucket/graphs/"$f"
done`;
	const CORS = `[{"AllowedOrigins": ["*"], "AllowedMethods": ["GET", "HEAD"], "AllowedHeaders": ["Range"],
  "ExposeHeaders": ["Content-Range", "Content-Length", "ETag"]}]`;
</script>

<svelte:head>
	<title>{pageTitle('Open a gfaidx index in Graphoscope · Graphoscope')}</title>
	<meta
		name="description"
		content="How to build, host and open your own gfaidx index in Graphoscope's experimental /gfaidx page: named haplotypes from a pangenome graph, read in the browser by HTTP range request."
	/>
</svelte:head>

<main>
	<p class="back"><a href="{base}/gfaidx">← Back to /gfaidx</a></p>
	<h1>Open a gfaidx index <span class="beta">Experimental</span></h1>
	<p class="beta-note">
		<b>This is experimental.</b> Graphoscope's main locus browser reads GBZ-base databases, and that is the
		path we recommend. <code>/gfaidx</code> shows that a
		<a href="https://github.com/fawaz-dabbaghieh/gfaidx" target="_blank" rel="noopener">gfaidx</a> index can be
		read in the browser with no server. Its haplotypes come back named, but a query takes about ten times as
		long (<a href="#speed">why</a>).
	</p>
	<p class="lead">
		gfaidx (<a href="https://doi.org/10.64898/2026.11.15.766357" target="_blank" rel="noopener"
			>Dabbaghie &amp; Steinegger, 2026</a
		>) splits a GFA into gzip blocks, one per community of nodes, and writes small index files beside it. With
		those six files on any static host, <code>/gfaidx</code> can pull a region out of a chromosome-scale graph,
		with every haplotype through it named by sample, haplotype and contig.
	</p>
	<p>Try it on HPRC v2 chromosome 21: <a href={chr21}>two haplotypes through an insertion in SOD1</a>.</p>

	<h2>1. Build the index</h2>
	<p>
		Install gfaidx (<code>conda install -c conda-forge -c bioconda gfaidx</code>, or build it from
		<a href="https://github.com/fawaz-dabbaghieh/gfaidx" target="_blank" rel="noopener">its repository</a>),
		then index the graph:
	</p>
	<pre>gfaidx index_gfa graph.gfa.gz graph.indexed.gfa.gz \
  --threads 8 --tmp_dir /scratch \
  --max_chunk_nodes 10000 --min_chunk_nodes 1000 \
  --checkpoint_steps 1024</pre>
	<p>That writes the indexed graph and five sidecar files beside it, all six needed:</p>
	<table>
		<thead><tr><th>File</th><th>What it holds</th></tr></thead>
		<tbody>
			<tr><td><code>graph.indexed.gfa.gz</code></td><td>The graph, one gzip block per community of nodes</td></tr>
			<tr><td><code>.idx</code></td><td>Where each block starts</td></tr>
			<tr><td><code>.ndx</code></td><td>Which block each node is in</td></tr>
			<tr><td><code>.lnx</code></td><td>Each node's length</td></tr>
			<tr><td><code>.pdx</code></td><td>Every path's and walk's steps</td></tr>
			<tr><td><code>.pcx</code></td><td>Coordinate checkpoints along each path</td></tr>
		</tbody>
	</table>
	<ul>
		<li>
			Any GFA with <code>W</code> walks (Minigraph-Cactus) or <code>P</code> paths (PGGB, odgi) works. Haplotype
			names come from them, so name paths <code>sample#haplotype#contig</code> to have the page group them.
		</li>
		<li>
			<code>--checkpoint_steps 1024</code> (the default is 4096) stores coordinates more often, so a query reads
			fewer steps to find where a region starts. The checkpoints add little to the index.
		</li>
		<li>
			The smaller blocks from <code>--max_chunk_nodes 10000</code> mean less to download per query.
		</li>
		<li>
			Indexing needs disk more than memory. Temporary files take some 12 to 20 bytes per path step: HPRC v2's
			PGGB chromosome 21, at 1.7 billion steps, wrote 31 GB of them.
		</li>
		<li>
			Skip <code>gfaidx index_coordinates</code>. The page doesn't fetch a <code>.cdx</code>: it finds regions
			from the <code>.pcx</code> checkpoints, which were cheaper over HTTP. That also means an rGFA from
			minigraph, which needs a <code>.cdx</code> for region queries, is not supported here.
		</li>
	</ul>

	<h2>2. Put it on a static host</h2>
	<p>Any host works if it:</p>
	<ul>
		<li>serves byte ranges (<code>Range</code> requests answered with <code>206</code>),</li>
		<li>allows CORS from the page's origin, and exposes <code>Content-Range</code> and <code>Content-Length</code>,</li>
		<li>
			does <b>not</b> send <code>Content-Encoding: gzip</code> for the graph. Some hosts do for a
			<code>.gz</code> name, and the browser then refuses a byte range of it. Serve it as
			<code>application/octet-stream</code>, or give it another extension (the name doesn't matter, as long as
			the sidecars share it).
		</li>
	</ul>
	<p>On S3, for example:</p>
	<pre>{UPLOAD}</pre>
	<p>with a CORS rule on the bucket like:</p>
	<pre>{CORS}</pre>
	<p class="note">
		A query reads only a few MB however big the index is: for chromosome 21, 7 MB of a 3 GB index. It reads them
		in many small requests, so a host that speaks HTTP/2 (most CDNs, CloudFront in front of S3) should be
		faster than plain S3, which allows a browser only 6 connections at a time.
	</p>

	<h2>3. Open it</h2>
	<p>
		Paste the graph's URL into the box under "Or your own index" on <a href="{base}/gfaidx">/gfaidx</a>, or link
		straight to a region:
	</p>
	<pre>https://graphoscope.omgenomics.com/gfaidx?index=https://my-bucket.s3.amazonaws.com/graphs/graph.indexed.gfa.gz&amp;path=CHM13%230%23chr21&amp;locus=chr21:25,880,000-25,900,000</pre>
	<p class="small-note">
		A <code>#</code> in a path name is written <code>%23</code> in a link.
	</p>
	<table>
		<thead><tr><th>Parameter</th><th>What it does</th></tr></thead>
		<tbody>
			<tr><td><code>index</code></td><td>The graph's URL, or <code>chr21</code> for the hosted example</td></tr>
			<tr>
				<td><code>path</code></td><td
					>The path or walk whose coordinates <code>locus</code> is in. Any haplotype works, not only a reference.
					Default: a reference path.</td
				>
			</tr>
			<tr>
				<td><code>locus</code></td><td
					><code>contig:start-end</code>, or a gene symbol when the path is a CHM13 or GRCh38 one. Up to 2 Mb.</td
				>
			</tr>
			<tr>
				<td><code>context</code></td><td
					>Off by default: each haplotype is cut where it crosses the region's two ends. A number of bp instead
					takes everything within that distance of the region, as the locus browser does. That is much slower
					here, because it follows the graph one node at a time.</td
				>
			</tr>
			<tr><td><code>pin</code></td><td>Trace a haplotype by name, e.g. <code>pin=HG00621%231</code></td></tr>
		</tbody>
	</table>
	<p>
		Every other view setting (layout, simplify, colours, marks, size) works as on the locus browser; the full list
		is in <a href="{base}/llms.txt">llms.txt</a>.
	</p>

	<h2 id="speed">What to expect</h2>
	<p>Measured on SOD1, opened from our S3 bucket in Chrome:</p>
	<table>
		<thead><tr><th></th><th>Requests</th><th>Downloaded</th><th>Time</th><th>Haplotypes</th></tr></thead>
		<tbody>
			<tr><td>Locus browser (GBZ-base)</td><td>7</td><td>0.45 MB</td><td>about 3 s</td><td>464, anonymous</td></tr>
			<tr><td><code>/gfaidx</code></td><td>~660</td><td>7.1 MB</td><td>about 30 s</td><td>242, named</td></tr>
		</tbody>
	</table>
	<p>
		They are different graphs: HPRC v2's Minigraph-Cactus graph on the locus browser, its PGGB graph of 120
		samples here. The same gfaidx query from a server on this machine takes 2.4 s, so the time is almost all
		request round trips.
	</p>
	<p>
		gfaidx is built for an index on a local disk, where its many small reads are nearly free. The paper's
		benchmarks run on an NVMe drive, and its viewer, gfaidx-viz, runs queries on a server. Over the web each
		read becomes an HTTP request. GBZ-base packs a region into a few database pages that sit together, so it
		needs only a handful.
	</p>

	<h2>How it runs in the browser</h2>
	<p>
		gfaidx's C++ query library (not its indexer, and nothing of gfaidx-viz) is compiled to WebAssembly and runs in
		a worker in your tab, reading each index file by range request. The region it returns becomes named
		<code>W</code> lines and goes through the same Simplify as every other graph in Graphoscope.
	</p>
	<p>
		To keep the round trips down, a planner runs the query with any bytes not yet downloaded read as zeros, then
		fetches everything that run asked for at once, in parallel, and runs it again until nothing is missing. On
		top of that, gfaidx is patched in three places, each measured on the SOD1 query:
	</p>
	<table>
		<thead><tr><th>Change</th><th>Rounds</th><th>Downloaded</th></tr></thead>
		<tbody>
			<tr>
				<td
					><b>File reading.</b> Required to run at all: WebAssembly can't memory-map a file, so the
					<code>.ndx</code>, <code>.lnx</code> and <code>.pcx</code> are read in 4 KiB pages.</td
				><td>36</td><td>39 MB</td>
			</tr>
			<tr>
				<td
					><b>Read hints.</b> Loops that read one thing after another (the graph's blocks, each haplotype's walk)
					say first what they will read, so it comes in one round.</td
				><td>8</td><td>28 MB</td>
			</tr>
			<tr>
				<td
					><b>Checkpoint lookup.</b> A region is found from the path's <code>.pcx</code> checkpoints instead of by
					reading the path from its start.</td
				><td><b>8</b></td><td><b>7.1 MB</b></td>
			</tr>
		</tbody>
	</table>
	<p>
		Each row includes the ones above it. Before the planner and the patches the same query was 442 requests one
		after another and 67 MB. The patched query returns byte-for-byte what gfaidx itself returns: we checked twelve
		chromosome 21 queries, the repetitive short arm included.
	</p>

	<h2>Credit</h2>
	<p>
		gfaidx and gfaidx-viz are by Fawaz Dabbaghie and Martin Steinegger: <i
			>Efficient genome graphs indexing, querying and visualization with gfaidx and gfaidx-viz</i
		>, bioRxiv (2026),
		<a href="https://doi.org/10.64898/2026.11.15.766357" target="_blank" rel="noopener"
			>doi:10.64898/2026.11.15.766357</a
		>. Code at
		<a href="https://github.com/fawaz-dabbaghieh/gfaidx" target="_blank" rel="noopener"
			>github.com/fawaz-dabbaghieh/gfaidx</a
		>.
	</p>
</main>

<style>
	:global(body) {
		margin: 0;
		background: #fff;
	}
	main {
		max-width: 800px;
		margin: 0 auto;
		padding: 1.5rem 16px 4rem;
		font-family: system-ui, sans-serif;
		color: #444;
		line-height: 1.6;
	}
	h1 {
		font-size: 1.5rem;
		color: #1f2430;
		margin: 0.2rem 0 0.8rem;
	}
	h2 {
		margin: 2rem 0 0.6rem;
		font-size: 1.15rem;
		color: #1f2430;
	}
	.beta {
		vertical-align: middle;
		font-size: 0.7rem;
		font-weight: 700;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: #4c1d95;
		background: #fde68a;
		border-radius: 999px;
		padding: 0.15rem 0.55rem;
	}
	.beta-note {
		color: #78350f;
		background: #fffbeb;
		border: 1px solid #fde68a;
		border-radius: 8px;
		padding: 0.6rem 0.8rem;
	}
	.back {
		margin: 0 0 1rem;
		font-size: 0.9rem;
	}
	.lead {
		font-size: 1rem;
		color: #1f2430;
	}
	p,
	td,
	li {
		font-size: 0.93rem;
	}
	li {
		margin-bottom: 0.35rem;
	}
	a {
		color: #6d28d9;
	}
	.small-note {
		margin-top: 0;
		font-size: 0.82rem;
		color: #6b7280;
	}
	.note {
		color: #5b6270;
		background: #f6f4fb;
		border-left: 3px solid #a78bfa;
		padding: 0.5rem 0.75rem;
		border-radius: 0 6px 6px 0;
	}
	code {
		font-size: 0.85em;
		background: #f1f2f5;
		padding: 0.05em 0.3em;
		border-radius: 4px;
	}
	pre {
		margin: 0.5rem 0;
		padding: 0.6rem 0.75rem;
		background: #14171f;
		color: #e5e7eb;
		border-radius: 8px;
		overflow-x: auto;
		font-size: 0.8rem;
		line-height: 1.5;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		margin: 1rem 0;
	}
	th {
		text-align: left;
		font-size: 0.78rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: #6b7280;
	}
	th,
	td {
		padding: 0.5rem 0.6rem;
		border-bottom: 1px solid #e5e7eb;
		vertical-align: top;
	}
</style>
