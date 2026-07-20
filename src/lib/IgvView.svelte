<script lang="ts">
	// IGV.js view. Opens on the reference genome (if it maps to a known IGV
	// genome id) at the queried locus, and shows the large non-reference nodes as
	// two tracks:
	//   1) an annotation track colored by how many haplotypes carry each node
	//      (yellow -> red), name = "<len>bp <cov>/<total>", clickable for details;
	//   2) a bar track whose height = the node's inserted sequence length.
	import { onMount, onDestroy } from 'svelte';
	import type { Gfa } from './gfa';
	import { computeNonRefNodes, classify, coverageRgb, eventSize, NET_CODES, type NonRefModel } from './nonRefNodes';

	let { gfa, referenceSample }: { gfa: Gfa | null; referenceSample: string } = $props();

	// See RefArcView: small variants are collapsed upstream now, so the ones that
	// survive are the structurally awkward ones worth looking at. Default to 0.
	let minLen = $state(0);
	let notice = $state('');
	let loading = $state(false);
	let container = $state<HTMLDivElement | null>(null);

	let ready = $state(false);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let browser: any = null;
	let objectUrls: string[] = [];
	let applyToken = 0;

	const TRACK_NAMES = ['Non-ref nodes (color = # walks)', 'Non-ref node size (bp)'];

	// Map a pangenome reference sample to a hosted IGV genome id. IGV.js's own
	// built-in genome registry uses UCSC ids, not assembly names — CHM13's is
	// `hs1` (UCSC's id for T2T-CHM13v2.0), not `chm13v2.0` (that id doesn't
	// exist in igv.js and fails with "Cannot read properties of undefined
	// (reading 'locus')" as soon as it tries to look up a default locus).
	const GENOMES: Record<string, string> = { GRCh38: 'hg38', CHM13: 'hs1' };
	const genomeId = $derived(GENOMES[referenceSample] ?? null);

	const model = $derived(gfa ? computeNonRefNodes(gfa, referenceSample, minLen) : null);

	// Legible green sequential (shared with the arc view); IGV draws the feature
	// label in this color, so it must be dark enough to read.
	const heatRgb = (cov: number, total: number): string => coverageRgb(cov, total).join(',');

	function blobUrl(text: string): string {
		const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
		objectUrls.push(url);
		return url;
	}

	function locusOf(m: NonRefModel): string {
		return `${m.contig}:${m.genomicStart + 1}-${m.genomicStart + m.refLen}`;
	}

	function buildTracks(m: NonRefModel) {
		const chr = m.contig;

		// BED9 (itemRgb) — one feature per non-reference node, colored by coverage.
		// Label uses the variant "size" (max of inserted/deleted bp) so a deletion
		// (len=0, large skipped) doesn't read as a 0bp event.
		const bed =
			m.events
				.map((ev) => {
					const start = m.genomicStart + ev.leftBp;
					const end = Math.max(m.genomicStart + ev.rightBp, start + 1);
					const name = `${eventSize(ev)}bp_${ev.cov}/${m.totalNonRef}_${NET_CODES[classify(ev)]}`;
					return [chr, start, end, name, Math.min(1000, ev.cov * 10), '.', start, end, heatRgb(ev.cov, m.totalNonRef)].join('\t');
				})
				.join('\n') + '\n';

		// bedGraph — bar height = variant size (max of inserted/deleted bp).
		const bg =
			m.events
				.map((ev) => {
					const start = m.genomicStart + ev.leftBp;
					const end = Math.max(m.genomicStart + ev.rightBp, start + 1);
					return [chr, start, end, eventSize(ev)].join('\t');
				})
				.join('\n') + '\n';

		return [
			{ name: TRACK_NAMES[0], url: blobUrl(bed), format: 'bed', displayMode: 'EXPANDED', height: 130 },
			{ name: TRACK_NAMES[1], url: blobUrl(bg), format: 'bedgraph', height: 120, color: 'rgb(37,99,235)', autoscale: true }
		];
	}

	function revokeUrls() {
		for (const u of objectUrls) URL.revokeObjectURL(u);
		objectUrls = [];
	}

	// Reload our feature tracks + recentre on the locus (browser already exists).
	async function applyTracks(m: NonRefModel) {
		if (!browser) return;
		const token = ++applyToken;
		for (const n of TRACK_NAMES) {
			try {
				browser.removeTrackByName?.(n);
			} catch {
				/* ignore */
			}
		}
		revokeUrls();
		try {
			await browser.search(locusOf(m));
			for (const t of buildTracks(m)) {
				if (token !== applyToken) return; // superseded by a newer query
				await browser.loadTrack(t);
			}
		} catch (e) {
			notice = 'IGV track load failed: ' + (e instanceof Error ? e.message : String(e));
		}
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let igvRef: any = null;
	let createdGenome: string | null = null;
	let destroyed = false;
	let loadedModel: NonRefModel | null = null;

	// Create the browser once, on mount. (Doing this in $effect races its own
	// async cleanup against re-runs, which can remove the freshly-made browser.)
	onMount(async () => {
		if (!genomeId) {
			notice = `IGV view supports GRCh38/CHM13 references (this subgraph's reference is "${referenceSample}").`;
			return;
		}
		loading = true;
		try {
			const igv = (await import('igv')).default;
			igvRef = igv;
			if (destroyed || !container) return;
			const m0 = model;
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const cfg: any = { genome: genomeId };
			if (m0) {
				cfg.locus = locusOf(m0);
				cfg.tracks = buildTracks(m0);
				loadedModel = m0;
			}
			const b = await igv.createBrowser(container, cfg);
			if (destroyed) {
				igv.removeBrowser(b);
				return;
			}
			browser = b;
			createdGenome = genomeId;
			ready = true;
		} catch (e) {
			notice = 'IGV failed to load: ' + (e instanceof Error ? e.message : String(e));
		} finally {
			loading = false;
		}
	});

	// If the reference (genome) changes after mount, rebuild the browser.
	$effect(() => {
		const g = genomeId;
		if (!ready || !browser || !igvRef || !container) return;
		if (g && g !== createdGenome) {
			const old = browser;
			browser = null;
			ready = false;
			try {
				igvRef.removeBrowser(old);
			} catch {
				/* ignore */
			}
			container.innerHTML = '';
			igvRef
				.createBrowser(container, { genome: g })
				.then((nb: unknown) => {
					browser = nb;
					createdGenome = g;
					ready = true;
				})
				.catch((e: unknown) => (notice = 'IGV failed to load: ' + (e instanceof Error ? e.message : String(e))));
		}
	});

	// Reload tracks whenever the data (or threshold) changes and the browser is up.
	// Skip the model already loaded inline at createBrowser time.
	$effect(() => {
		const m = model;
		if (ready && browser && m && m !== loadedModel) {
			loadedModel = m;
			applyTracks(m);
		}
	});

	onDestroy(() => {
		destroyed = true;
		revokeUrls();
		try {
			if (igvRef && browser) igvRef.removeBrowser(browser);
		} catch {
			/* ignore */
		}
		browser = null;
	});
</script>

<div class="igv">
	<div class="head">
		<span class="muted">
			{#if genomeId}
				reference <code>{referenceSample}</code> → IGV genome <code>{genomeId}</code>
			{:else}
				reference <code>{referenceSample}</code>
			{/if}
		</span>
		<label class="thresh">
			hide variants under
			<input type="number" min="1" max="1000" bind:value={minLen} /> bp
		</label>
		{#if model}<span class="muted">{model.events.length} non-reference nodes</span>{/if}
		{#if loading}<span class="muted">loading…</span>{/if}
	</div>

	{#if notice}
		<p class="notice">{notice}</p>
	{/if}
	<div class="container" bind:this={container}></div>
	<div class="legend">
		<span class="muted">“Non-ref nodes” track:</span>
		<span>1</span>
		<span class="grad"></span>
		<span>{model?.totalNonRef ?? ""} walks</span>
		<span class="muted">· label = <code>&lt;size&gt;bp_&lt;cov&gt;/&lt;total&gt;_&lt;ins|ins*|del|sub&gt;</code> (size = max ins/del bp) · lower track: bar height = size</span>
	</div>
</div>

<style>
	.igv {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.head {
		display: flex;
		gap: 1rem;
		align-items: center;
		flex-wrap: wrap;
		font-size: 0.85rem;
	}
	.thresh input {
		width: 4.5rem;
		font: inherit;
		padding: 0.15rem 0.35rem;
		border: 1px solid #ccc;
		border-radius: 5px;
	}
	.container {
		min-height: 320px;
		border: 1px solid #eee;
		border-radius: 8px;
		overflow: hidden;
	}
	.legend {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-wrap: wrap;
		font-size: 0.78rem;
	}
	.legend .grad {
		display: inline-block;
		width: 80px;
		height: 10px;
		border-radius: 3px;
		background: linear-gradient(90deg, rgb(56, 142, 60), rgb(16, 60, 24));
	}
	.legend code {
		background: #f0f0f0;
		padding: 0 4px;
		border-radius: 4px;
	}
	.notice {
		color: #92400e;
		background: #fffbeb;
		border: 1px solid #fde68a;
		padding: 0.5rem 0.7rem;
		border-radius: 6px;
		font-size: 0.85rem;
	}
	.muted {
		color: #888;
	}
	code {
		background: #f0f0f0;
		padding: 0 4px;
		border-radius: 4px;
	}
</style>
