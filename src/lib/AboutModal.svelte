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
			<h3>How the on-demand querying works</h3>
			<div class="how-body">
				<p>
					The graphs themselves are the <b>HPRC Release 2 Minigraph-Cactus pangenomes</b> — built by
					the Human Pangenome Reference Consortium. Each is distributed as a
					<code>.gbz</code> file of several gigabytes.
				</p>
				<p>
					Querying one by genomic coordinate normally means downloading the whole thing. Instead we
					use <b>GBZ-base</b> (<code>gbz2db</code> / <code>query</code>, part of the
					<a href="https://github.com/jltsiren/gbz-base" target="_blank" rel="noopener"
						>vg / GBZ-base</a
					>
					tooling by Jouni Sirén and colleagues), which stores a graph in a SQLite database that
					<i>can</i> be queried by position.
				</p>
				<p>
					What <b>we</b> added: we compiled GBZ-base's <code>query</code> program to WebAssembly
					(<code>wasm32-wasip1</code>) and wrote a small WASI filesystem shim that backs SQLite's
					page reads with <b>HTTP range requests</b>. So the browser runs the real query engine in a
					Web Worker and pulls only the few megabytes of database pages a locus actually touches —
					served straight from the public HPRC S3 bucket. The
					visualizations (the graph layout, with optional bubble and gene tracks beneath it, and the
					simplification described next) are a few prototypes we built for inspecting a graph's
					complex patterns around a particular reference locus.
				</p>
				<p>
					A raw locus can still be far too tangled to read — and, more to the point, far too heavy to
					hold in a browser tab, since the per-haplotype walks through the graph dominate the data
					(for a repetitive locus like <b>LPA</b> they are the great majority of the bytes). So before
					anything is drawn, Graphoscope runs its own <b>reference-guided simplification</b> — a second
					WebAssembly module we wrote (<code>crates/reduce</code>, independent of GBZ-base) that reads
					the query's output as a stream and never materialises the whole graph. Anchored on the
					reference path, it detects the <i>superbubbles</i> hanging off it and collapses any whose
					alternate alleles are shorter than a <b>collapse threshold</b> (50&nbsp;bp), then merges the
					resulting non-branching runs of nodes into single segments. Crucially, instead of keeping
					every walk it just <b>counts</b> how many pass through each node and edge — that count is
					what the yellow&#8202;→&#8202;red colouring shows. The effect on memory is large: a locus
					like LPA drops from hundreds of megabytes of parsed graph to a few. A standalone
					<a href="{base}/playground" target="_blank" rel="noopener">simplification playground</a>
					(a testing sandbox) lets you tweak the collapse threshold and compare the original and
					simplified graphs side by side.
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
					<b>GBZ-base</b> and the <b>vg</b> toolkit (Jouni Sirén and colleagues) for
					<code>gbz2db</code>/<code>query</code>, which make coordinate queries over a graph
					possible.
				</li>
				<li>
					<b>browser_wasi_shim</b> (@bjorn3) for running the WASI query binary in the browser, and
					the <b>SQLite</b> and <b>Rust</b> projects underneath it.
				</li>
				<li><b>IGV.js</b> and <b>D3</b> for visualization frameworks.</li>
				<li>
					<b>Bandage</b> for the strand-like node rendering style that the reference-anchored graph
					layout draws inspiration from.
				</li>
				<li><b>42basepairs</b> for the range-request idea that this is modelled on.</li>
				<li>Gene coordinates from <b>GENCODE</b> (GRCh38) and the <b>T2T-CHM13v2.0</b> annotation.</li>
			</ul>
		</div>
		<footer class="modal-foot muted small">
			GBZ-base <code>query.wasm</code> · WASI in a Web Worker · SQLite pages served by range requests
		</footer>
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
		margin: 1.3rem 0 0.5rem;
		font-size: 0.9rem;
	}
	.modal-body h3:first-child {
		margin-top: 0;
	}
	.modal-foot {
		padding: 0.7rem 1.3rem;
		border-top: 1px solid #e3e7ee;
	}
	.how-body {
		font-size: 0.85rem;
		padding: 0.6rem 0.9rem;
		border-left: 3px solid #dbeafe;
		background: #f8faff;
		border-radius: 0 8px 8px 0;
		color: #444;
	}
	.how-body p {
		margin: 0 0 0.6rem;
	}
	.how-body p:last-child {
		margin-bottom: 0;
	}
	.ack-list {
		margin: 0.4rem 0 0;
		padding-left: 1.1rem;
		font-size: 0.82rem;
		color: #555;
		line-height: 1.6;
	}
	.muted {
		color: #888;
	}
	.small {
		font-size: 0.8rem;
	}
	code {
		background: #eef1f5;
		padding: 0 4px;
		border-radius: 4px;
		font-size: 0.9em;
	}
</style>
