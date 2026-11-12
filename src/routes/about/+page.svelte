<script lang="ts">
	import { base } from '$app/paths';
	import { pageTitle } from '$lib/pageTitle';

	const GENES = [
		['LPA', 'KIV-2 repeat copy number, tied to lipoprotein(a) and heart-disease risk'],
		['C4A', 'tandem RCCX modules with long and short C4 genes'],
		['AMY1A', 'salivary amylase copy-number variation'],
		['SMN1', 'spinal muscular atrophy locus in a segmental duplication'],
		['HLA-A', 'the hypervariable MHC region'],
		['CYP2D6', 'pharmacogenomics and common structural variation'],
		['MUC5B', 'a long, repetitive mucin gene'],
		['MLPH', 'the bundled example on the GFA page']
	];
</script>

<svelte:head>
	<title>{pageTitle('What is a pangenome graph? About Graphoscope')}</title>
	<meta
		name="description"
		content="What a human pangenome graph is, how to read bubbles and haplotype paths, and how Graphoscope draws HPRC pangenome graphs by gene in your browser. By Maria Nattestad."
	/>
</svelte:head>

<main>
	<p><a href="{base}/">← Open Graphoscope</a></p>
	<h1>What is a pangenome graph?</h1>
	<p>
		A single reference genome is one person's sequence, so it cannot show how people differ. A
		<b>pangenome graph</b> stores many genomes together. Stretches of DNA that people share become one
		<b>node</b>. Where people differ, the graph forks into a <b>bubble</b>, with one branch per allele. Each
		person's haplotype is a <b>walk</b> through the graph, taking one branch at every bubble.
	</p>
	<p>
		The Human Pangenome Reference Consortium (HPRC) has published graphs built from hundreds of
		haplotype-resolved human genomes. They capture structural variants, repeats and copy-number
		differences that are hard to see against one reference.
	</p>

	<h2>What Graphoscope does</h2>
	<p>
		Graphoscope, by <a href="https://github.com/MariaNattestad">Maria Nattestad</a>, draws a region of
		the HPRC human pangenome in your browser. Type a gene or a locus and it fetches only that region,
		simplifies it against the reference so the large-scale structure shows, and lays it out along the
		reference path. Click a node, bubble or edge to see which haplotypes pass through it. You can also drop in
		any <a href="{base}/gfa">GFA file</a>. Nothing is installed and no server is involved.
	</p>

	<h2>Genes worth trying</h2>
	<ul>
		{#each GENES as [gene, why] (gene)}
			<li><a href="{base}/?ref=grch38&locus={gene}">{gene}</a>: {why}</li>
		{/each}
	</ul>

	<h2>How to read the picture</h2>
	<ul>
		<li>The reference path runs straight through the middle; bubbles hang above and below it.</li>
		<li>Colour shows how many haplotypes use a node or edge, from gold (few) to red (many).</li>
		<li>A loop is a repeat that some haplotypes traverse more than once.</li>
		<li>Simplification collapses small variants (under 50 bp by default) so structural variation stands out.</li>
	</ul>

	<h2>For scripts and AI agents</h2>
	<p>
		Every view is a URL. See <a href="{base}/llms.txt">llms.txt</a> for the parameter reference, or the
		<a href="https://github.com/MariaNattestad/graphoscope">source code on GitHub</a>.
	</p>
</main>

<style>
	main {
		max-width: 44rem;
		margin: 0 auto;
		padding: 2rem 16px 4rem;
		line-height: 1.6;
		font-family: system-ui, sans-serif;
	}
	h1 {
		font-size: 1.8rem;
	}
	h2 {
		margin-top: 2rem;
	}
</style>
