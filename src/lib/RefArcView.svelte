<script lang="ts">
	// Reference-anchored arc view.
	// The reference path (GRCh38) is a straight horizontal line, x = reference bp.
	// Non-reference nodes longer than a threshold rise as arcs/lollipops whose
	// height ∝ sequence length. A heatmap strip under the axis shows how many
	// non-reference haplotypes carry each node (yellow=1 → red=all). Click a node
	// to pin its details (with genomic coordinates); double-click anywhere to
	// zoom the x-axis 10×.
	import type { Gfa } from './gfa';
	import {
		computeNonRefNodes,
		classify,
		NET_COLORS,
		NET_LABELS,
		coverageColor,
		type NonRefEvent as Ev
	} from './nonRefNodes';

	let { gfa, referenceSample }: { gfa: Gfa; referenceSample: string } = $props();

	let minLen = $state(5);
	let pinned = $state<Ev | null>(null);
	let hovered = $state<Ev | null>(null);
	let viewWin = $state<{ start: number; end: number } | null>(null);
	let copied = $state(false);

	const W = 1000;
	const H = 250;
	const ML = 10;
	const MR = 10;
	const TOP = 16;
	const baseY = 168;
	const hmY = 176;
	const hmH = 12;

	// Reset zoom/pin when a new subgraph is loaded.
	$effect(() => {
		gfa;
		viewWin = null;
		pinned = null;
	});

	const model = $derived(computeNonRefNodes(gfa, referenceSample, minLen));

	const win = $derived(viewWin ?? { start: 0, end: model?.refLen ?? 1 });
	const zoomFactor = $derived(model ? model.refLen / (win.end - win.start) : 1);

	const color = (ev: Ev): string => NET_COLORS[classify(ev)];
	const heatColor = coverageColor;

	const render = $derived.by(() => {
		if (!model) return null;
		const { events, maxLen } = model;
		const s = win.start;
		const e = win.end;
		const span = Math.max(1, e - s);
		const xs = (bp: number) => ML + ((bp - s) / span) * (W - ML - MR);
		const maxH = baseY - TOP;
		const arcH = (len: number) => Math.max(10, maxH * Math.sqrt(len / maxLen));

		const shapes = events
			.filter((ev) => ev.rightBp >= s && ev.leftBp <= e)
			.map((ev) => {
				const x1 = xs(ev.leftBp);
				const x2 = xs(ev.rightBp);
				const apex = arcH(ev.len);
				const xm = (x1 + x2) / 2;
				const lollipop = x2 - x1 < 4;
				const d = lollipop ? '' : `M ${x1} ${baseY} Q ${xm} ${baseY - 2 * apex} ${x2} ${baseY}`;
				return { ev, x1, x2, xm, apex, lollipop, d, stroke: color(ev), heat: heatColor(ev.cov, model.totalNonRef) };
			});

		const ticks = [];
		for (let i = 0; i <= 5; i++) {
			const bp = s + (i / 5) * span;
			ticks.push({ x: xs(bp), label: Math.round(model.genomicStart + bp).toLocaleString() });
		}
		return { shapes, ticks };
	});

	const active = $derived(pinned ?? hovered);

	function pin(ev: Ev) {
		pinned = ev;
		copied = false;
	}
	function clearPin() {
		pinned = null;
	}
	function onDblClick(ev: MouseEvent) {
		if (!model) return;
		const rect = (ev.currentTarget as SVGElement).getBoundingClientRect();
		const frac = (ev.clientX - rect.left) / rect.width;
		const centerBp = win.start + frac * (win.end - win.start);
		const width = win.end - win.start;
		const nw = Math.max(20, width / 10);
		let start = centerBp - nw / 2;
		start = Math.max(0, Math.min(start, model.refLen - nw));
		viewWin = { start, end: start + nw };
	}
	function resetZoom() {
		viewWin = null;
	}

	function infoText(ev: Ev): string {
		if (!model) return '';
		const g0 = Math.round(model.genomicStart + ev.leftBp);
		const g1 = Math.round(model.genomicStart + ev.rightBp);
		const coord = g0 === g1 ? `${model.contig}:${g0}` : `${model.contig}:${g0}-${g1}`;
		return `node ${ev.id}\tlen ${ev.len} bp\t${coord}\treplaces ${ev.skipped} bp\tnet ${ev.net > 0 ? '+' : ''}${ev.net} bp\t${ev.cov}/${model.totalNonRef} haplotypes`;
	}
	async function copyInfo() {
		if (!active) return;
		try {
			await navigator.clipboard.writeText(infoText(active));
			copied = true;
		} catch {
			copied = false;
		}
	}
	function genomic(bp: number): number {
		return Math.round((model?.genomicStart ?? 0) + bp);
	}
</script>

<div class="arc">
	<div class="head">
		<span>Reference: <code>{model?.refName ?? '—'}</code></span>
		<label class="thresh">
			min node length
			<input type="number" min="1" max="1000" bind:value={minLen} /> bp
		</label>
		<span class="muted">{model?.events.length ?? 0} nodes shown</span>
		<span class="spacer"></span>
		{#if zoomFactor > 1.01}
			<span class="muted">zoom {zoomFactor.toFixed(zoomFactor < 10 ? 1 : 0)}×</span>
			<button class="mini" onclick={resetZoom}>Reset zoom</button>
		{/if}
		<span class="muted hint">double-click to zoom · click a node to pin</span>
	</div>

	{#if render && model}
		<svg viewBox="0 0 {W} {H}" preserveAspectRatio="none" ondblclick={onDblClick} role="img" aria-label="reference arc view">
			<!-- vertical position guides -->
			{#each render.ticks as t (t.label)}
				<line x1={t.x} y1={TOP} x2={t.x} y2={baseY} stroke="#eee" stroke-width="1" />
			{/each}

			<!-- arcs / lollipops -->
			{#each render.shapes as sh (sh.ev.id)}
				{@const emph = pinned === sh.ev || hovered === sh.ev}
				{@const dim = active && !emph}
				{#if sh.lollipop}
					<line x1={sh.xm} y1={baseY} x2={sh.xm} y2={baseY - sh.apex} stroke={sh.stroke} stroke-width={emph ? 2.5 : 1.4} opacity={dim ? 0.2 : 0.9} />
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<circle cx={sh.xm} cy={baseY - sh.apex} r={emph ? 4.5 : 2.6} fill={sh.stroke} opacity={dim ? 0.2 : 1} onmouseenter={() => (hovered = sh.ev)} onmouseleave={() => (hovered = null)} onclick={() => pin(sh.ev)} role="button" tabindex="-1" />
				{:else}
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<path d={sh.d} fill="none" stroke={sh.stroke} stroke-width={emph ? 2.5 : 1.4} opacity={dim ? 0.18 : 0.85} onmouseenter={() => (hovered = sh.ev)} onmouseleave={() => (hovered = null)} onclick={() => pin(sh.ev)} role="button" tabindex="-1" />
				{/if}
			{/each}

			<!-- reference line -->
			<line x1={ML} y1={baseY} x2={W - MR} y2={baseY} stroke="#111" stroke-width="2.5" />

			<!-- coverage heatmap strip -->
			{#each render.shapes as sh (sh.ev.id)}
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<rect
					x={Math.max(ML, sh.xm - 3)}
					y={hmY}
					width="6"
					height={hmH}
					fill={sh.heat}
					stroke={pinned === sh.ev || hovered === sh.ev ? '#111' : 'none'}
					stroke-width="1"
					onmouseenter={() => (hovered = sh.ev)}
					onmouseleave={() => (hovered = null)}
					onclick={() => pin(sh.ev)}
					role="button"
					tabindex="-1"
				/>
			{/each}

			<!-- axis ticks + labels -->
			{#each render.ticks as t (t.label)}
				<line x1={t.x} y1={hmY + hmH} x2={t.x} y2={hmY + hmH + 4} stroke="#999" stroke-width="1" />
				<text x={t.x} y={hmY + hmH + 18} font-size="10" fill="#666" text-anchor="middle">{t.label}</text>
			{/each}
			<text x={(ML + W - MR) / 2} y={H - 6} font-size="10" fill="#999" text-anchor="middle">{model.contig} reference position (bp)</text>
		</svg>

		<div class="legends">
			<div class="legend">
				<span><span class="sw" style="background:{NET_COLORS.insertion}"></span> {NET_LABELS.insertion}</span>
				<span><span class="sw" style="background:{NET_COLORS.expansion}"></span> {NET_LABELS.expansion}</span>
				<span><span class="sw" style="background:{NET_COLORS.contraction}"></span> {NET_LABELS.contraction}</span>
				<span><span class="sw" style="background:{NET_COLORS.substitution}"></span> {NET_LABELS.substitution}</span>
				<span class="muted">arc height ∝ length</span>
			</div>
			<div class="legend">
				<span class="muted">haplotypes through node:</span>
				<span>1</span>
				<span class="grad"></span>
				<span>{model.totalNonRef}</span>
			</div>
		</div>

		<div class="hover" class:pinned={!!pinned}>
			{#if active}
				<span>
					node <code>{active.id}</code> · <b>{active.len.toLocaleString()} bp</b> ·
					<code>{model.contig}:{genomic(active.leftBp).toLocaleString()}{active.leftBp !== active.rightBp
							? '-' + genomic(active.rightBp).toLocaleString()
							: ''}</code>
					· replaces {active.skipped.toLocaleString()} bp · net {active.net > 0 ? '+' : ''}{active.net.toLocaleString()} bp ·
					<b>{active.cov}/{model.totalNonRef}</b> haplotypes
				</span>
				<button class="mini" onclick={copyInfo}>{copied ? 'copied ✓' : 'copy'}</button>
				{#if pinned}<button class="mini ghost" onclick={clearPin}>clear</button>{/if}
			{:else}
				<span class="muted">hover or click a node…</span>
			{/if}
		</div>
	{:else}
		<p class="muted">No reference walk in this subgraph.</p>
	{/if}
</div>

<style>
	.arc {
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
	.head .spacer {
		flex: 1;
	}
	.head .hint {
		font-size: 0.78rem;
	}
	.thresh input {
		width: 4.5rem;
		font: inherit;
		padding: 0.15rem 0.35rem;
		border: 1px solid #ccc;
		border-radius: 5px;
	}
	svg {
		width: 100%;
		height: 250px;
		border: 1px solid #eee;
		border-radius: 8px;
		background: #fbfbfc;
	}
	svg path,
	svg circle,
	svg rect {
		cursor: pointer;
	}
	.legends {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		flex-wrap: wrap;
	}
	.legend {
		display: flex;
		gap: 0.8rem;
		flex-wrap: wrap;
		font-size: 0.78rem;
		align-items: center;
	}
	.legend .sw {
		display: inline-block;
		width: 18px;
		height: 4px;
		border-radius: 2px;
		vertical-align: middle;
		margin-right: 4px;
	}
	.legend .grad {
		display: inline-block;
		width: 90px;
		height: 10px;
		border-radius: 3px;
		background: linear-gradient(90deg, rgb(56, 142, 60), rgb(16, 60, 24));
	}
	.hover {
		font-size: 0.85rem;
		min-height: 1.4em;
		display: flex;
		align-items: center;
		gap: 0.6rem;
		flex-wrap: wrap;
	}
	.hover.pinned {
		background: #f0f6ff;
		border: 1px solid #cfe0ff;
		border-radius: 6px;
		padding: 0.3rem 0.5rem;
	}
	.mini {
		font: inherit;
		font-size: 0.78rem;
		padding: 0.1rem 0.5rem;
		border: 1px solid #cbd5e1;
		background: #fff;
		border-radius: 5px;
		cursor: pointer;
	}
	.mini.ghost {
		color: #888;
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
