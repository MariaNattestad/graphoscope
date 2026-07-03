<script lang="ts">
	// Reference-anchored arc view.
	// The reference path (GRCh38) is a straight horizontal line, x = reference bp.
	// Non-reference nodes longer than a threshold rise as arcs/lollipops whose
	// height ∝ sequence length. A heatmap strip under the axis shows how many
	// non-reference haplotypes carry each node (yellow=1 → red=all). Click a node
	// to pin its details (with genomic coordinates); double-click anywhere to
	// zoom the x-axis 10×.
	import type { Gfa } from './gfa';

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

	interface Ev {
		id: string;
		len: number;
		leftBp: number;
		rightBp: number;
		skipped: number;
		net: number;
		cov: number;
	}

	// Reset zoom/pin when a new subgraph is loaded.
	$effect(() => {
		gfa;
		viewWin = null;
		pinned = null;
	});

	const model = $derived.by(() => {
		const ref = gfa.walks.find((w) => w.sample === referenceSample) ?? gfa.walks[0];
		if (!ref) return null;

		const refCoord = new Map<string, { start: number; end: number }>();
		let off = 0;
		for (const s of ref.steps) {
			const len = gfa.segments.get(s.id)?.length ?? 0;
			refCoord.set(s.id, { start: off, end: off + len });
			off += len;
		}
		const refLen = Math.max(1, off);

		const adj = new Map<string, Set<string>>();
		const add = (a: string, b: string) => {
			let s = adj.get(a);
			if (!s) adj.set(a, (s = new Set()));
			s.add(b);
		};
		for (const l of gfa.links) {
			add(l.from, l.to);
			add(l.to, l.from);
		}

		// Coverage: how many non-reference walks traverse each node.
		const nonRefWalks = gfa.walks.filter((w) => w !== ref);
		const cov = new Map<string, number>();
		for (const w of nonRefWalks) {
			for (const step of w.steps) cov.set(step.id, (cov.get(step.id) ?? 0) + 1);
		}
		const totalNonRef = Math.max(1, nonRefWalks.length);

		function nearestRef(startId: string): { start: number; end: number } | null {
			const seen = new Set([startId]);
			let frontier = [startId];
			for (let d = 0; d < 8 && frontier.length; d++) {
				const next: string[] = [];
				for (const id of frontier) {
					for (const nb of adj.get(id) ?? []) {
						const rc = refCoord.get(nb);
						if (rc) return rc;
						if (!seen.has(nb)) {
							seen.add(nb);
							next.push(nb);
						}
					}
				}
				frontier = next;
			}
			return null;
		}

		const events: Ev[] = [];
		for (const seg of gfa.segments.values()) {
			if (refCoord.has(seg.id)) continue;
			if (seg.length <= minLen) continue;
			const refNbrs = [...(adj.get(seg.id) ?? [])]
				.map((n) => refCoord.get(n))
				.filter((c): c is { start: number; end: number } => !!c);

			let leftBp: number, rightBp: number;
			if (refNbrs.length === 1) {
				leftBp = rightBp = refNbrs[0].end;
			} else if (refNbrs.length > 1) {
				refNbrs.sort((a, b) => a.start - b.start);
				leftBp = refNbrs[0].end;
				rightBp = refNbrs[refNbrs.length - 1].start;
				if (rightBp < leftBp) [leftBp, rightBp] = [rightBp, leftBp];
			} else {
				const near = nearestRef(seg.id);
				if (!near) continue;
				leftBp = rightBp = near.end;
			}
			const skipped = Math.max(0, rightBp - leftBp);
			events.push({
				id: seg.id,
				len: seg.length,
				leftBp,
				rightBp,
				skipped,
				net: seg.length - skipped,
				cov: cov.get(seg.id) ?? 0
			});
		}
		events.sort((a, b) => a.leftBp - b.leftBp);
		const maxLen = Math.max(1, ...events.map((e) => e.len));
		return {
			refName: `${ref.sample}#${ref.hapIndex}#${ref.seqId}`,
			contig: ref.seqId,
			refLen,
			events,
			maxLen,
			genomicStart: ref.start,
			totalNonRef
		};
	});

	const win = $derived(viewWin ?? { start: 0, end: model?.refLen ?? 1 });
	const zoomFactor = $derived(model ? model.refLen / (win.end - win.start) : 1);

	function color(ev: Ev): string {
		if (ev.net > 0) return '#2563eb';
		if (ev.net < 0) return '#e11d48';
		return '#6b7280';
	}
	function heatColor(cov: number, total: number): string {
		const t = total <= 1 ? 0 : Math.min(1, Math.max(0, (cov - 1) / (total - 1)));
		return `hsl(${(60 * (1 - t)).toFixed(0)} 95% 50%)`;
	}

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
				<span><span class="sw" style="background:#2563eb"></span> net insertion</span>
				<span><span class="sw" style="background:#e11d48"></span> alt &lt; ref replaced</span>
				<span><span class="sw" style="background:#6b7280"></span> substitution</span>
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
		background: linear-gradient(90deg, hsl(60 95% 50%), hsl(30 95% 50%), hsl(0 95% 50%));
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
