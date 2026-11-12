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

			<h3>How it works</h3>
			<div class="section">
				<p>
					The graphs are the Human Pangenome Reference Consortium's (HPRC) Release 2 pangenomes, which
					are several gigabytes each. Rather than download one, Graphoscope uses
					<a href="https://github.com/jltsiren/gbz-base">GBZ-base</a>, which stores the graph in a
					database that can be searched by position. A small WebAssembly program runs in your browser
					and fetches only the few megabytes covering the region you asked for, straight from the
					public HPRC bucket. Before drawing, it simplifies the region against the reference path, folding
					small variants together so the larger structure is easy to see. Nothing is uploaded and there
					is no server.
				</p>
				<p>
					There's also a standalone <a href="{base}/gfa">GFA viewer</a> for dropping in any
					<code>.gfa</code> file, parsed entirely in your browser.
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
