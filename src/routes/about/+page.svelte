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

			<figure>
				<img src="{base}/about/lpa.png" alt="LPA on CHM13 across all 465 HPRC haplotypes, simplified from 27,534 nodes to 123" />
				<figcaption>
					LPA on CHM13 across all 465 HPRC haplotypes, simplified from 27,534 nodes to 123, in the
					browser. The loops and arcs are LPA's KIV-2 repeat: 5.5 kb units whose copy number varies
					widely between people (fewer copies mean higher Lp(a), a heart-disease risk factor).
				</figcaption>
			</figure>

			<h3>Simplify a tangle into its structure</h3>
			<div class="section">
				<p>
					Real loci are dense. Reference-guided simplification pops small variants and merges
					unbranching runs, so the large-scale structure shows. At C4A and C4B, 4,007 nodes become 25.
				</p>
				<div class="pair">
					<figure>
						<img src="{base}/about/c4-simplify-off.png" alt="C4A and C4B with simplification off" />
						<figcaption>Simplify off: 4,007 nodes</figcaption>
					</figure>
					<figure>
						<img src="{base}/about/c4-simplify-on.png" alt="C4A and C4B with simplification on" />
						<figcaption>Simplify on: 25 nodes</figcaption>
					</figure>
				</div>
				<p>
					C4A and C4B sit in tandem RCCX modules, and each C4 gene is long (L) or short (S) depending on
					a HERV-K(C4) retrovirus in intron 9 (Blanchong et al. 2000, <i>J Exp Med</i> 191:2183).
					Graphoscope recovers that known structure, and each walk reads as one of the published
					arrangements.
				</p>
			</div>

			<h3>Trace individual haplotypes</h3>
			<div class="section">
				<figure>
					<img src="{base}/about/trace-walk.png" alt="Hovering one MLPH node traces the single haplotype that carries it" />
				</figure>
				<p>
					Hover a node to trace every walk through it, each in its own colour. This MLPH node is
					carried by one haplotype, whose walk runs the outer ring. Turn on "disco-walks" to flash many
					haplotype walks in rapid succession.
				</p>
			</div>

			<h3>Inspect bubbles</h3>
			<div class="section">
				<figure>
					<img src="{base}/about/inspect-bubble.png" alt="A 6,233 bp LINE-1 insertion next to HLA-A, carried by 6 haplotypes" />
				</figure>
				<p>
					Click a bubble for its size: next to HLA-A, a 6,233 bp LINE-1 insertion carried by 6
					haplotypes. Each bubble shows its longest and shortest paths and its reference span, giving
					an overview of how much variation each locus has.
				</p>
			</div>

			<h3>Drop down to the bases</h3>
			<div class="section">
				<figure>
					<img src="{base}/about/msa.png" alt="Base-level multiple sequence alignment lined up with the graph" />
				</figure>
				<p>
					The MSA view shows individual bases, lined up with the graph above, for detailed comparison
					of haplotypes.
				</p>
			</div>

			<h3>Bring your own graph</h3>
			<div class="section">
				<p>
					Drop any GFA file on the <a href="{base}/gfa">GFA viewer</a>: GFA 1.1 walks, GFA 1.0 paths
					(vg, odgi), minigraph rGFA, or a bare assembly graph. It is parsed in your browser and never
					uploaded.
				</p>
				<div class="pair">
					<figure>
						<img src="{base}/about/fly.png" alt="Cyp6g1 in D. melanogaster across 16 strains" />
						<figcaption>Cyp6g1 across 16 fruit fly strains, with the dm6 reference as the axis.</figcaption>
					</figure>
					<figure>
						<img src="{base}/about/assembly-graph.png" alt="Bandage's plasmid test assembly" />
						<figcaption>Bandage's plasmid test assembly in a reference-free layout.</figcaption>
					</figure>
				</div>
			</div>

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
	figure {
		margin: 1rem 0;
	}
	figure img {
		width: 100%;
		height: auto;
		display: block;
		border: 1px solid #e3e7ee;
		border-radius: 8px;
	}
	figcaption {
		margin-top: 0.4rem;
		font-size: 0.85rem;
		line-height: 1.5;
		color: #666;
	}
	.pair {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1rem;
	}
	.pair figure {
		margin: 0.5rem 0;
	}
	@media (max-width: 560px) {
		.pair {
			grid-template-columns: 1fr;
		}
	}
	code {
		overflow-wrap: anywhere;
		background: #eef1f5;
		padding: 0 4px;
		border-radius: 4px;
		font-size: 0.9em;
	}
</style>
