<script lang="ts">
	// The "About Graphoscope" modal, shared by every page's top bar (see AppBar).
	// Content is app-wide — how the on-demand querying works, and acknowledgements —
	// so both the locus browser and the standalone GFA viewer show the same story.
	// The one page-specific line ("Currently showing: …") is passed in via `source`.
	import { base } from '$app/paths';

	let { onClose, source = null }: { onClose: () => void; source?: string | null } = $props();
</script>

<svelte:window
	onkeydown={(e) => {
		if (e.key === 'Escape') onClose();
	}}
/>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="modal-backdrop" role="presentation" onclick={onClose}>
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div
		class="modal"
		role="dialog"
		tabindex="-1"
		aria-modal="true"
		aria-label="About Graphoscope"
		onclick={(e) => e.stopPropagation()}
	>
		<div class="modal-head">
			<h2>About Graphoscope</h2>
			<button class="modal-close" onclick={onClose} aria-label="Close">×</button>
		</div>
		<div class="modal-body">
			<p class="lead">
				Graphoscope is a visualization tool for pangenomes, built to make pangenome graphs accessible
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
					<a href="https://github.com/jltsiren/gbz-base" target="_blank" rel="noopener"
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
					alternate alleles are shorter than a <b>collapse threshold</b> (50&nbsp;bp), then merges the
					resulting non-branching runs of nodes into single segments. Crucially, instead of keeping
					every walk it just <b>counts</b> how many pass through each node and edge — that count is
					what the gold&#8202;→&#8202;red colouring shows. The effect on memory is large: a locus
					like LPA drops from hundreds of megabytes of parsed graph to a few.
				</p>
				<p>
					There's also a standalone <a href="{base}/gfa" target="_blank" rel="noopener">GFA viewer</a>
					for dropping in <i>any</i> <code>.gfa</code> file (with W-line walks, P-line paths, rGFA
					tags, or none of those) — parsed entirely in your browser, nothing uploaded.
				</p>
				{#if source}
					<p>
						Currently showing: <code>{source}</code> — the public HPRC v2.1 Minigraph-Cactus graph,
						converted to a GBZ-base <code>.gbz.db</code> (SQLite) and served directly from the public
						HPRC S3 bucket for coordinate range queries.
					</p>
				{/if}
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
		</div>
	</div>
</div>

<style>
	.modal-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(16, 24, 40, 0.45);
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 2rem;
		z-index: 200;
	}
	.modal {
		background: #fff;
		border-radius: 12px;
		width: min(760px, 100%);
		max-height: 85vh;
		display: flex;
		flex-direction: column;
		box-shadow: 0 20px 60px rgba(16, 24, 40, 0.3);
		overflow: hidden;
	}
	.modal-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 1rem 1.3rem;
		border-bottom: 1px solid #e3e7ee;
	}
	.modal-head h2 {
		margin: 0;
		font-size: 1.05rem;
	}
	.modal-close {
		background: none;
		border: none;
		font-size: 1.5rem;
		line-height: 1;
		color: #98a0ac;
		cursor: pointer;
		padding: 0 0.3rem;
	}
	.modal-close:hover {
		color: #1f2430;
	}
	.modal-body {
		padding: 1.1rem 1.3rem;
		overflow-y: auto;
	}
	.modal-body h3 {
		margin: 1.4rem 0 0.5rem;
		font-size: 0.95rem;
		color: #1f2430;
	}
	/* One type scale for the whole body: the lead a touch larger and darker, the
	   explanatory paragraphs at a comfortable reading size, both above the
	   acknowledgements list, and all below the section headings. */
	.lead {
		margin: 0;
		font-size: 0.92rem;
		line-height: 1.55;
		color: #1f2430;
	}
	.section p {
		margin: 0 0 0.7rem;
		font-size: 0.86rem;
		line-height: 1.55;
		color: #444;
	}
	.section p:last-child {
		margin-bottom: 0;
	}
	.ack-list {
		margin: 0.4rem 0 0;
		padding-left: 1.1rem;
		font-size: 0.82rem;
		color: #555;
		line-height: 1.6;
	}
	code {
		/* Long S3 paths in "Currently showing" would otherwise break mid-word
		   at arbitrary points or push the line out. */
		overflow-wrap: anywhere;
		background: #eef1f5;
		padding: 0 4px;
		border-radius: 4px;
		font-size: 0.9em;
	}
</style>
