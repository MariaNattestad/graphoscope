<script lang="ts">
	// The About page: the same text the old modal showed, as a real page so it is
	// linkable and indexable. The top bar's About link opens it in a new tab.
	import { base } from '$app/paths';
	import { pageTitle } from '$lib/pageTitle';
</script>

<svelte:head>
	<title>{pageTitle('About Graphoscope: HPRC pangenome graph viewer')}</title>
	<meta
		name="description"
		content="About Graphoscope, a browser-based viewer for the HPRC human pangenome graph by Maria Nattestad: how on-demand queries, reference-guided simplification and the graph layout work."
	/>
</svelte:head>

<main>
	<p class="back"><a href="{base}/">← Back to Graphoscope</a></p>
	<h1>About Graphoscope</h1>
<p class="lead">
				<b>Graphoscope</b>, by <a href="https://github.com/MariaNattestad">Maria Nattestad</a>, is a visualization tool for pangenomes, built to make pangenome graphs accessible
				to everyone who works with human genomes. It uses a reference-anchored layout to show the pangenome graph
				structure, and has tons of features for exploring the graph and inspecting all the underlying data.
			</p>

			<h3>How the on-demand querying works</h3>
			<div class="section">
				<p>
					The graphs themselves are the <b>HPRC Release 2 Minigraph-Cactus pangenomes</b> — built by
					the Human Pangenome Reference Consortium. Each is distributed as a
					<code>.gbz</code> file of several gigabytes.
				</p>
				<p>
					Querying one by genomic coordinate normally means downloading the whole thing. Instead we
					build on <b>GBZ-base</b> (part of the
					<a href="https://github.com/jltsiren/gbz-base" 
						>vg / GBZ-base</a
					>
					tooling by Jouni Sirén and colleagues), which stores a graph in a SQLite database
					(<code>.gbz.db</code>) that <i>can</i> be queried by position. The HPRC publishes these
					databases alongside the v2.1 graphs.
				</p>
				<p>
					We added a small Rust program that uses the GBZ-base library, unmodified, for
					the coordinate lookup, compiled to WebAssembly (<code>wasm32-wasip1</code>), plus a WASI
					filesystem shim that backs SQLite's page reads with <b>HTTP range requests</b>. So the
					browser runs the real query engine in a Web Worker and pulls only the few megabytes of
					database pages a locus actually touches — served straight from the public HPRC S3 bucket.
				</p>
				<p>
					A raw locus can still be far too tangled to read — and, more to the point, far too heavy to
					hold in a browser tab, since the per-haplotype walks through the graph dominate the data
					(for a repetitive locus like <b>LPA</b> they are the great majority of the bytes). So before
					anything is drawn, the same WebAssembly module runs Graphoscope's own
					<b>reference-guided simplification</b> (<code>crates/reduce</code>; this part is independent
					of GBZ-base), reading the extracted walks as a stream and keeping only per-node and per-edge
					aggregates rather than the walks themselves. Anchored on the
					reference path, it detects the <i>superbubbles</i> hanging off it and collapses any whose
					alternate alleles are shorter than a <b>collapse threshold</b> (50&nbsp;bp). Then, at every
					variant site, it folds each haplotype's allele into the nearest kept allele that differs from it
					by less than the threshold, keeping every place a haplotype leaves the window, and merges the
					resulting non-branching runs of nodes into single segments. Crucially, instead of keeping
					every walk it just <b>counts</b> how many pass through each node and edge — that count is
					what the gold&#8202;→&#8202;red colouring shows. The effect on memory is large: a locus
					like LPA drops from hundreds of megabytes of parsed graph to a few.
				</p>
				<p>
					There's also a standalone <a href="{base}/gfa" >GFA viewer</a>
					for dropping in <i>any</i> <code>.gfa</code> file (with W-line walks, P-line paths, rGFA
					tags, or none of those) — parsed entirely in your browser, nothing uploaded.
				</p>
			</div>

			<h3>Acknowledgements</h3>
			<ul class="ack-list">
				<li>
					<b>The Human Pangenome Reference Consortium (HPRC)</b> and the
					<b>Minigraph-Cactus</b> team for building and openly releasing the pangenome graphs shown
					here.
				</li>
				<li>
					<b>GBZ-base</b> and the <b>vg</b> toolkit (Jouni Sirén and colleagues) for the
					<code>.gbz.db</code> format and the library that makes coordinate queries over a graph
					possible.
				</li>
				<li>
					<b>browser_wasi_shim</b> (@bjorn3) for running the WASI query binary in the browser.
				</li>
				<li>
					<b>Bandage</b> for the strand-like node rendering style that the reference-anchored graph
					layout draws inspiration from.
				</li>
				<li><b>42basepairs</b> for the range-request idea that this is modelled on.</li>
				<li>Gene coordinates from <b>GENCODE</b> (GRCh38) and the <b>T2T-CHM13v2.0</b> annotation.</li>
			</ul>
</main>

<style>
	main {
		max-width: 760px;
		margin: 0 auto;
		padding: 1.5rem 16px 4rem;
		font-family: system-ui, sans-serif;
		color: #444;
	}
	h1 {
		font-size: 1.5rem;
		color: #1f2430;
	}
	h3 {
		margin: 1.6rem 0 0.5rem;
		font-size: 1.05rem;
		color: #1f2430;
	}
	.back {
		margin: 0 0 1rem;
		font-size: 0.9rem;
	}
	.lead {
		margin: 0;
		font-size: 1rem;
		line-height: 1.6;
		color: #1f2430;
	}
	.section p {
		margin: 0 0 0.8rem;
		font-size: 0.95rem;
		line-height: 1.6;
	}
	.ack-list {
		margin: 0.4rem 0 0;
		padding-left: 1.1rem;
		font-size: 0.9rem;
		line-height: 1.7;
	}
	code {
		overflow-wrap: anywhere;
		background: #eef1f5;
		padding: 0 4px;
		border-radius: 4px;
		font-size: 0.9em;
	}
</style>
