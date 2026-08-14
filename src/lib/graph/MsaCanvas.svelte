<script lang="ts">
	// Base-level renderer for the MSA window. Draws the alignment matrix on a 2D
	// canvas: a left gutter of row labels, a top ruler of node ids + reference
	// coordinates, and the cells themselves — one coloured block per base, with the
	// A/C/G/T letters appearing once each base is wide enough (genome-browser style).
	//
	// Zoom/pan is hand-rolled rather than d3-zoom: the axes are independent here
	// (horizontal = bases, vertical = rows scroll), which d3-zoom's uniform model
	// fights. `pxPerBp` is the horizontal scale, `panX` the horizontal offset (px),
	// `scrollY` the vertical row offset (px).
	import { untrack } from 'svelte';
	import { baseThemeDark, baseThemeLight, baseFill, type BaseTheme } from './colors';
	import type { Alignment } from './msa';

	let {
		alignment,
		lightMode = false,
		emphasizeVariants = true,
		simplifiedNames = true,
		onNodeClick
	}: {
		alignment: Alignment;
		lightMode?: boolean;
		/** Dim the shared backbone sequence so the alt-allele columns (the actual
		 * variation) stand out — the node-block equivalent of an MSA's match dots. */
		emphasizeVariants?: boolean;
		/** Label nodes with their short local R1/A1 names instead of raw segment ids. */
		simplifiedNames?: boolean;
		/** A node column was clicked (not dragged); its displayed segment id. */
		onNodeClick?: (segId: string) => void;
	} = $props();

	const theme = $derived<BaseTheme>(lightMode ? baseThemeLight : baseThemeDark);

	// --- geometry ---------------------------------------------------------------
	// Taller ruler when showing raw segment ids, which are long and get drawn on a
	// diagonal to avoid trimming; the short R1/A1 names sit horizontally in a
	// shorter band.
	const RULER_H = $derived(simplifiedNames ? 40 : 56);
	const ROW_H = 20;
	const LETTER_MIN_PX = 7.5; // draw glyphs once a base is at least this wide
	const MIN_PX_PER_BP = 0.02;
	const MAX_PX_PER_BP = 26;

	let canvasEl: HTMLCanvasElement | undefined = $state();
	let width = $state(800);
	let height = $state(360);

	// Left row-label column: narrower on a phone, where it would otherwise swallow
	// half the width, but never so wide it starves the matrix on a small panel.
	const GUTTER_W = $derived(Math.min(width * 0.42, width < 560 ? 104 : 176));

	let pxPerBp = $state(4);
	let panX = $state(0); // px; screenX(bp) = GUTTER_W + panX + bp*pxPerBp
	let scrollY = $state(0); // px; first row top = RULER_H - scrollY
	// While false, the view auto-fits to the container (initial sizing + resizes).
	// The first zoom/pan hands control to the user; the Fit button gives it back.
	let userAdjusted = false;

	const matrixW = $derived(Math.max(10, width - GUTTER_W));
	const contentH = $derived(alignment.rows.length * ROW_H);
	const maxScrollY = $derived(Math.max(0, contentH - (height - RULER_H)));

	interface HoverInfo {
		x: number;
		y: number;
		/** Column (bp offset from window left) and row index, for the crosshair guides. */
		bpCol: number;
		rowIdx: number;
		segId: string;
		nodeName: string;
		isBackbone: boolean;
		rowLabel: string;
		base: string;
		bpInNode: number;
		refPos: number | null;
		contig: string | null;
	}
	let hover = $state<HoverInfo | null>(null);

	function clampPan() {
		// Keep at least a sliver of content on screen; allow a small margin each side.
		const minPanX = matrixW - alignment.totalBp * pxPerBp - 40;
		const maxPanX = 40;
		panX = Math.min(maxPanX, Math.max(minPanX, panX));
		scrollY = Math.min(maxScrollY, Math.max(0, scrollY));
	}

	// The alignment builds a generous window, but the view opens focused on the
	// clicked node: the node fills the width (min 21 bp so a 1 bp SNP is still
	// readable), and zooming out from there reveals the surrounding context.
	const MIN_FOCUS_BP = 21;

	/** Open the view focused on the clicked node (its own length, ≥ 21 bp). */
	export function fit() {
		userAdjusted = false;
		const sel = alignment.blocks.find((b) => b.isSelected);
		const focusBp = Math.max(MIN_FOCUS_BP, sel ? sel.bpLen : Math.min(alignment.totalBp, 200));
		const k = Math.min(MAX_PX_PER_BP, Math.max(MIN_PX_PER_BP, matrixW / focusBp));
		pxPerBp = k;
		const centerBp = sel ? sel.colStart + sel.bpLen / 2 : alignment.totalBp / 2;
		panX = matrixW / 2 - centerBp * k;
		scrollY = 0;
		clampPan();
	}

	export function zoomBy(factor: number, aboutBp?: number) {
		userAdjusted = true;
		const anchorBp = aboutBp ?? (-panX + matrixW / 2) / pxPerBp;
		const before = GUTTER_W + panX + anchorBp * pxPerBp;
		pxPerBp = Math.min(MAX_PX_PER_BP, Math.max(MIN_PX_PER_BP, pxPerBp * factor));
		panX = before - GUTTER_W - anchorBp * pxPerBp;
		clampPan();
	}

	// Refit whenever a new alignment arrives (new node clicked / window changed).
	let lastKey = '';
	$effect(() => {
		const key = `${alignment.selectedSegId}|${alignment.totalBp}|${alignment.blocks.length}`;
		if (key !== lastKey) {
			lastKey = key;
			untrack(() => fit());
		}
	});

	// --- interaction ------------------------------------------------------------
	function onWheel(e: WheelEvent) {
		e.preventDefault();
		if (e.ctrlKey || e.metaKey) {
			const rect = canvasEl!.getBoundingClientRect();
			const px = e.clientX - rect.left;
			const bp = (px - GUTTER_W - panX) / pxPerBp;
			zoomBy(Math.exp(-e.deltaY * 0.002), bp);
		} else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
			userAdjusted = true;
			panX -= e.deltaX || e.deltaY;
			clampPan();
		} else {
			userAdjusted = true;
			scrollY += e.deltaY;
			clampPan();
		}
	}

	let dragging = false;
	let lastX = 0;
	let lastY = 0;
	let downX = 0;
	let downY = 0;
	let dragDist = 0;
	function onPointerDown(e: PointerEvent) {
		dragging = true;
		lastX = e.clientX;
		lastY = e.clientY;
		downX = e.clientX;
		downY = e.clientY;
		dragDist = 0;
		canvasEl?.setPointerCapture(e.pointerId);
	}
	function onPointerMove(e: PointerEvent) {
		const rect = canvasEl!.getBoundingClientRect();
		if (dragging) {
			const dx = e.clientX - lastX;
			const dy = e.clientY - lastY;
			dragDist += Math.abs(dx) + Math.abs(dy);
			if (dragDist > 3) userAdjusted = true;
			panX += dx;
			scrollY -= dy;
			lastX = e.clientX;
			lastY = e.clientY;
			clampPan();
			hover = null;
			return;
		}
		updateHover(e.clientX - rect.left, e.clientY - rect.top);
	}
	function onPointerUp(e: PointerEvent) {
		dragging = false;
		canvasEl?.releasePointerCapture(e.pointerId);
		// A press that didn't drag is a click on a node column → flash it in the graph.
		if (dragDist <= 3 && onNodeClick) {
			const rect = canvasEl!.getBoundingClientRect();
			const segId = segIdAtPointer(e.clientX - rect.left, e.clientY - rect.top);
			if (segId) onNodeClick(segId);
		}
	}
	function onLeave() {
		if (!dragging) hover = null;
	}
	function onDblClick(e: MouseEvent) {
		const rect = canvasEl!.getBoundingClientRect();
		const px = e.clientX - rect.left;
		if (px < GUTTER_W) return;
		const bp = (px - GUTTER_W - panX) / pxPerBp;
		zoomBy(2, bp);
	}
	/** The displayed segment id under a screen point in the matrix, or null. */
	function segIdAtPointer(px: number, py: number): string | null {
		if (px < GUTTER_W || py < RULER_H) return null;
		const bp = (px - GUTTER_W - panX) / pxPerBp;
		const bi = blockAtBp(bp);
		return bi >= 0 ? alignment.blocks[bi].segId : null;
	}

	function blockAtBp(bp: number): number {
		// Binary search blocks by colStart.
		const b = alignment.blocks;
		let lo = 0;
		let hi = b.length - 1;
		let ans = -1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			if (b[mid].colStart <= bp) {
				ans = mid;
				lo = mid + 1;
			} else hi = mid - 1;
		}
		if (ans < 0) return -1;
		const blk = b[ans];
		return bp < blk.colStart + blk.bpLen ? ans : -1;
	}

	function updateHover(px: number, py: number) {
		if (px < GUTTER_W || py < RULER_H || px > width || py > height) {
			hover = null;
			return;
		}
		const bp = (px - GUTTER_W - panX) / pxPerBp;
		const rowIdx = Math.floor((py - RULER_H + scrollY) / ROW_H);
		if (rowIdx < 0 || rowIdx >= alignment.rows.length) {
			hover = null;
			return;
		}
		const bi = blockAtBp(bp);
		if (bi < 0) {
			hover = null;
			return;
		}
		const blk = alignment.blocks[bi];
		const withinNode = Math.floor(bp - blk.colStart);
		const cell = alignment.rows[rowIdx].cells[bi];
		const base = cell == null ? '–' : cell === '' ? '·' : (cell[withinNode] ?? '·');
		hover = {
			x: px,
			y: py,
			bpCol: Math.floor(bp),
			rowIdx,
			segId: blk.segId,
			nodeName: simplifiedNames ? blk.simpleName : blk.segId,
			isBackbone: blk.isBackbone,
			rowLabel: alignment.rows[rowIdx].label,
			base,
			bpInNode: withinNode,
			refPos: blk.refStart != null ? blk.refStart + withinNode : null,
			contig: blk.contig ?? alignment.contig
		};
	}

	// --- drawing ----------------------------------------------------------------
	let raf = 0;
	function schedule() {
		if (raf) return;
		raf = requestAnimationFrame(() => {
			raf = 0;
			draw();
		});
	}

	// Redraw on any visual state change.
	$effect(() => {
		// touch reactive deps
		alignment;
		theme;
		emphasizeVariants;
		simplifiedNames;
		pxPerBp;
		panX;
		scrollY;
		width;
		height;
		hover;
		schedule();
	});

	function draw() {
		if (!canvasEl) return;
		const ctx = canvasEl.getContext('2d');
		if (!ctx) return;
		const dpr = window.devicePixelRatio || 1;
		if (canvasEl.width !== Math.round(width * dpr) || canvasEl.height !== Math.round(height * dpr)) {
			canvasEl.width = Math.round(width * dpr);
			canvasEl.height = Math.round(height * dpr);
		}
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, width, height);
		ctx.fillStyle = theme.background;
		ctx.fillRect(0, 0, width, height);

		const k = pxPerBp;
		const screenX = (bp: number) => GUTTER_W + panX + bp * k;
		const bpLeft = Math.max(0, (-panX) / k);
		const bpRight = Math.min(alignment.totalBp, (matrixW - panX) / k);
		const drawLetters = k >= LETTER_MIN_PX;

		const firstRow = Math.max(0, Math.floor(scrollY / ROW_H));
		const lastRow = Math.min(alignment.rows.length - 1, Math.ceil((scrollY + height - RULER_H) / ROW_H));

		// Clip the matrix region so cells never paint over the gutter/ruler.
		ctx.save();
		ctx.beginPath();
		ctx.rect(GUTTER_W, RULER_H, matrixW, height - RULER_H);
		ctx.clip();

		// 1) node bands (behind cells) + selected highlight + dividers
		for (let i = 0; i < alignment.blocks.length; i++) {
			const blk = alignment.blocks[i];
			if (blk.colStart + blk.bpLen < bpLeft || blk.colStart > bpRight) continue;
			const x0 = screenX(blk.colStart);
			const x1 = screenX(blk.colStart + blk.bpLen);
			ctx.fillStyle = blk.isSelected
				? theme.selectedBand
				: i % 2 === 0
					? theme.nodeBandEven
					: theme.nodeBandOdd;
			ctx.fillRect(x0, RULER_H, x1 - x0, height - RULER_H);
			ctx.strokeStyle = theme.nodeDivider;
			ctx.lineWidth = 1;
			ctx.beginPath();
			ctx.moveTo(Math.round(x0) + 0.5, RULER_H);
			ctx.lineTo(Math.round(x0) + 0.5, height);
			ctx.stroke();
		}

		// 2) cells
		if (drawLetters) {
			ctx.font = `${Math.min(ROW_H - 6, Math.floor(k))}px ui-monospace, SFMono-Regular, Menlo, monospace`;
			ctx.textAlign = 'center';
			ctx.textBaseline = 'middle';
		}
		for (let r = firstRow; r <= lastRow; r++) {
			const row = alignment.rows[r];
			const y0 = RULER_H + r * ROW_H - scrollY;
			for (let i = 0; i < alignment.blocks.length; i++) {
				const blk = alignment.blocks[i];
				if (blk.colStart + blk.bpLen < bpLeft || blk.colStart > bpRight) continue;
				const cell = row.cells[i];
				if (cell === null) {
					// gap (the path skips this node — a deletion relative to it): a thin
					// line through the row centre, the familiar MSA deletion mark.
					const gx0 = screenX(blk.colStart);
					const gw = screenX(blk.colStart + blk.bpLen) - gx0;
					ctx.fillStyle = theme.gap;
					ctx.fillRect(gx0, y0 + ROW_H / 2 - 1, gw, 2);
					continue;
				}
				if (cell === '') {
					// visited, sequence unknown (rGFA): neutral "present" fill
					ctx.fillStyle = theme.other;
					ctx.globalAlpha = 0.5;
					ctx.fillRect(screenX(blk.colStart), y0 + 1, screenX(blk.colStart + blk.bpLen) - screenX(blk.colStart), ROW_H - 2);
					ctx.globalAlpha = 1;
					continue;
				}
				// In emphasize mode the shared backbone sequence is drawn muted (a faint
				// band + grey letters), so the alt-allele columns — the real differences —
				// carry all the colour. The reference row keeps full colour throughout so
				// it stays readable as the thing everything is compared against.
				const muted = emphasizeVariants && blk.isBackbone && !row.isReference;
				const jStart = Math.max(0, Math.floor(bpLeft - blk.colStart));
				const jEnd = Math.min(cell.length, Math.ceil(bpRight - blk.colStart) + 1);
				for (let j = jStart; j < jEnd; j++) {
					const ch = cell[j];
					const bx = screenX(blk.colStart + j);
					const bw = k;
					if (muted) {
						ctx.fillStyle = theme.gap;
						ctx.fillRect(bx, y0 + 1, Math.max(0.5, bw + 0.5), ROW_H - 2);
						if (drawLetters && bw >= LETTER_MIN_PX) {
							ctx.fillStyle = theme.gutterText;
							ctx.fillText(ch, bx + bw / 2, y0 + ROW_H / 2 + 0.5);
						}
					} else {
						ctx.fillStyle = baseFill(ch, theme);
						ctx.fillRect(bx, y0 + 1, Math.max(0.5, bw + 0.5), ROW_H - 2);
						if (drawLetters && bw >= LETTER_MIN_PX) {
							ctx.fillStyle = theme.letter;
							ctx.fillText(ch, bx + bw / 2, y0 + ROW_H / 2 + 0.5);
						}
					}
				}
			}
			// reference row underline for emphasis
			if (row.isReference) {
				ctx.strokeStyle = theme.refRowLabel;
				ctx.globalAlpha = 0.5;
				ctx.beginPath();
				ctx.moveTo(GUTTER_W, y0 + ROW_H - 0.5);
				ctx.lineTo(width, y0 + ROW_H - 0.5);
				ctx.stroke();
				ctx.globalAlpha = 1;
			}
		}

		// crosshair: highlight the hovered row and column, so a base can be traced
		// across the wide matrix (which haplotype / which position).
		if (hover && !dragging) {
			const ry = RULER_H + hover.rowIdx * ROW_H - scrollY;
			ctx.fillStyle = theme.selectedBand;
			ctx.fillRect(GUTTER_W, ry, matrixW, ROW_H);
			const cx0 = screenX(hover.bpCol);
			const cw = Math.max(1.5, pxPerBp);
			ctx.fillStyle = theme.rulerText;
			ctx.globalAlpha = 0.22;
			ctx.fillRect(cx0, RULER_H, cw, height - RULER_H);
			ctx.globalAlpha = 1;
		}
		ctx.restore();

		// 3) top ruler (node ids + reference coords), pans horizontally
		ctx.fillStyle = theme.gutter;
		ctx.fillRect(0, 0, width, RULER_H);
		ctx.save();
		ctx.beginPath();
		ctx.rect(GUTTER_W, 0, matrixW, RULER_H);
		ctx.clip();
		// Node names: kept in view by sticking each to the visible-left of its block
		// (so zooming into a node's right edge doesn't scroll its name off), and drawn
		// on a diagonal when the label is too long to fit horizontally — so a long raw
		// id is never trimmed. `lastRight` skips a name only when it would collide with
		// the previous one (dense zoom-out), keeping the rest readable.
		ctx.textBaseline = 'alphabetic';
		let lastRight = -Infinity;
		for (let i = 0; i < alignment.blocks.length; i++) {
			const blk = alignment.blocks[i];
			if (blk.colStart + blk.bpLen < bpLeft || blk.colStart > bpRight) continue;
			const x0 = screenX(blk.colStart);
			const x1 = screenX(blk.colStart + blk.bpLen);
			const label = simplifiedNames ? blk.simpleName : blk.segId;
			ctx.font = blk.isSelected
				? '600 11px ui-sans-serif, system-ui, sans-serif'
				: '11px ui-sans-serif, system-ui, sans-serif';
			ctx.fillStyle = blk.isSelected ? theme.refRowLabel : theme.gutterText;
			const textW = ctx.measureText(label).width;
			const vis0 = Math.max(x0 + 2, GUTTER_W + 2); // sticky to the visible left edge
			const availPx = Math.min(x1, width) - vis0;
			if (textW + 3 <= availPx && vis0 >= lastRight) {
				// fits horizontally
				ctx.textAlign = 'left';
				ctx.fillText(label, vis0, 14);
				lastRight = vis0 + textW + 6;
			} else if (vis0 >= lastRight - 2) {
				// diagonal so a long id isn't trimmed; rises up-right from the left edge
				ctx.save();
				ctx.translate(vis0, RULER_H - 10);
				ctx.rotate(-Math.PI / 4);
				ctx.textAlign = 'left';
				ctx.fillText(label, 0, 0);
				ctx.restore();
				lastRight = vis0 + 10;
			}
			// backbone coordinate tick + number at the block's left edge (stays put —
			// it marks a genomic position, not the node's identity).
			if (blk.isBackbone && blk.refStart != null && x1 - x0 > 3) {
				ctx.strokeStyle = theme.nodeDivider;
				ctx.beginPath();
				ctx.moveTo(Math.round(x0) + 0.5, RULER_H - 6);
				ctx.lineTo(Math.round(x0) + 0.5, RULER_H);
				ctx.stroke();
				if (x1 - x0 > 46 && x0 > GUTTER_W) {
					ctx.textAlign = 'left';
					ctx.font = '9px ui-monospace, monospace';
					ctx.fillStyle = theme.rulerText;
					ctx.fillText(blk.refStart.toLocaleString(), x0 + 3, RULER_H - 8);
				}
			}
		}
		ctx.restore();

		// 4) left gutter (row labels), scrolls vertically
		ctx.fillStyle = theme.gutter;
		ctx.fillRect(0, 0, GUTTER_W, height);
		ctx.strokeStyle = theme.nodeDivider;
		ctx.beginPath();
		ctx.moveTo(GUTTER_W + 0.5, 0);
		ctx.lineTo(GUTTER_W + 0.5, height);
		ctx.stroke();
		ctx.save();
		ctx.beginPath();
		ctx.rect(0, RULER_H, GUTTER_W, height - RULER_H);
		ctx.clip();
		ctx.textBaseline = 'middle';
		ctx.textAlign = 'left';
		for (let r = firstRow; r <= lastRow; r++) {
			const row = alignment.rows[r];
			const y0 = RULER_H + r * ROW_H - scrollY;
			ctx.font = row.isReference
				? '600 11px ui-sans-serif, system-ui, sans-serif'
				: '11px ui-sans-serif, system-ui, sans-serif';
			ctx.fillStyle = row.isReference ? theme.refRowLabel : theme.rowLabel;
			const maxChars = Math.max(4, Math.floor((GUTTER_W - 46) / 6.3));
			const label = row.label.length > maxChars ? row.label.slice(0, maxChars - 1) + '…' : row.label;
			ctx.fillText(label, 8, y0 + ROW_H / 2);
			// multiplicity + inversion badges, right-aligned in the gutter
			let bx = GUTTER_W - 6;
			ctx.textAlign = 'right';
			if (row.multiplicity > 1) {
				ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
				ctx.fillStyle = theme.gutterText;
				ctx.fillText(`×${row.multiplicity}`, bx, y0 + ROW_H / 2);
				bx -= ctx.measureText(`×${row.multiplicity}`).width + 6;
			}
			if (row.hasInversion) {
				ctx.fillStyle = theme.T;
				ctx.fillText('⇄', bx, y0 + ROW_H / 2);
			}
			ctx.textAlign = 'left';
		}
		ctx.restore();

		// 5) corner (gutter × ruler)
		ctx.fillStyle = theme.gutter;
		ctx.fillRect(0, 0, GUTTER_W, RULER_H);
		ctx.strokeStyle = theme.nodeDivider;
		ctx.beginPath();
		ctx.moveTo(0, RULER_H + 0.5);
		ctx.lineTo(width, RULER_H + 0.5);
		ctx.moveTo(GUTTER_W + 0.5, 0);
		ctx.lineTo(GUTTER_W + 0.5, height);
		ctx.stroke();
		ctx.save();
		ctx.beginPath();
		ctx.rect(0, 0, GUTTER_W - 2, RULER_H);
		ctx.clip();
		ctx.fillStyle = theme.gutterText;
		ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
		ctx.textAlign = 'left';
		ctx.textBaseline = 'middle';
		ctx.fillText(GUTTER_W < 120 ? 'walks ↓' : 'walks ↓ · bases →', 8, RULER_H / 2);
		ctx.restore();

		// 6) vertical scrollbar hint
		if (maxScrollY > 0) {
			const trackH = height - RULER_H;
			const thumbH = Math.max(24, (trackH * trackH) / (contentH || 1));
			const thumbY = RULER_H + (scrollY / maxScrollY) * (trackH - thumbH);
			ctx.fillStyle = theme.nodeDivider;
			ctx.fillRect(width - 4, thumbY, 3, thumbH);
		}
	}

	// Resize tracking. This effect must depend on `canvasEl` ONLY — every reactive
	// read (matrixW/width/alignment via fit()/clampPan()) is wrapped in untrack so
	// the observer is created once, not re-created on every width/alignment change.
	// Without that, a width that flickers (e.g. a scrollbar appearing when the panel
	// opens) would re-run this effect on each flicker and trip Svelte's
	// effect_update_depth guard, freezing the panel.
	$effect(() => {
		const el = canvasEl;
		if (!el) return;
		const parent = el.parentElement;
		if (!parent) return;
		let rafId = 0;
		const apply = () => {
			const w = parent.clientWidth;
			const h = parent.clientHeight;
			// Ignore no-op notifications (the scrollbar-flicker guard): only react to a
			// real size change, so an oscillating width can't drive a redraw storm.
			if (w === width && h === height) return;
			width = w;
			height = h;
			untrack(() => {
				if (userAdjusted) clampPan();
				else fit();
			});
		};
		const ro = new ResizeObserver(() => {
			// Coalesce bursts (rotation/scrollbar) into one measurement per frame.
			if (rafId) return;
			rafId = requestAnimationFrame(() => {
				rafId = 0;
				apply();
			});
		});
		ro.observe(parent);
		untrack(() => {
			width = parent.clientWidth;
			height = parent.clientHeight;
			if (!userAdjusted) fit();
		});
		return () => {
			if (rafId) cancelAnimationFrame(rafId);
			ro.disconnect();
		};
	});
</script>

<div class="msa-canvas-wrap">
	<canvas
		bind:this={canvasEl}
		style="width:{width}px;height:{height}px"
		onwheel={onWheel}
		onpointerdown={onPointerDown}
		onpointermove={onPointerMove}
		onpointerup={onPointerUp}
		onpointerleave={onLeave}
		ondblclick={onDblClick}
	></canvas>

	<div class="zoom-controls">
		<button title="Zoom in" onclick={() => zoomBy(1.4)}>+</button>
		<button title="Zoom out" onclick={() => zoomBy(1 / 1.4)}>−</button>
		<button title="Fit window" onclick={() => fit()}>⤢</button>
	</div>

	{#if hover}
		<div
			class="msa-tip"
			class:light={lightMode}
			style="left:{Math.min(hover.x + 14, width - 220)}px; top:{Math.min(hover.y + 14, height - 70)}px"
		>
			<div class="tip-base"><b>{hover.base}</b></div>
			<div>
				{hover.isBackbone ? 'ref node' : 'alt node'} <b>{hover.nodeName}</b>
				{#if hover.nodeName !== hover.segId}<span class="tip-dim">({hover.segId})</span>{/if}
			</div>
			{#if hover.refPos != null}
				<div class="tip-dim">{hover.contig}:{hover.refPos.toLocaleString()}</div>
			{/if}
			<div class="tip-dim">{hover.rowLabel}</div>
		</div>
	{/if}
</div>

<style>
	.msa-canvas-wrap {
		position: relative;
		width: 100%;
		height: 100%;
		overflow: hidden;
	}
	canvas {
		display: block;
		cursor: grab;
		touch-action: none;
	}
	canvas:active {
		cursor: grabbing;
	}
	.zoom-controls {
		position: absolute;
		right: 12px;
		bottom: 12px;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.zoom-controls button {
		width: 30px;
		height: 30px;
		border-radius: 7px;
		border: 1px solid rgba(140, 155, 180, 0.4);
		background: rgba(20, 24, 32, 0.72);
		color: #e0e6f5;
		font-size: 1rem;
		line-height: 1;
		cursor: pointer;
		backdrop-filter: blur(4px);
	}
	.zoom-controls button:hover {
		background: rgba(40, 46, 60, 0.9);
	}
	.msa-tip {
		position: absolute;
		pointer-events: none;
		background: rgba(15, 18, 26, 0.94);
		color: #e6ebf5;
		border: 1px solid rgba(140, 155, 180, 0.3);
		border-radius: 7px;
		padding: 6px 9px;
		font-size: 0.72rem;
		line-height: 1.35;
		z-index: 5;
		max-width: 220px;
	}
	.msa-tip.light {
		background: rgba(255, 255, 255, 0.97);
		color: #1e293b;
		border-color: rgba(100, 116, 139, 0.3);
	}
	.tip-base b {
		font-size: 0.95rem;
		font-family: ui-monospace, monospace;
	}
	.tip-dim {
		opacity: 0.7;
	}
</style>
