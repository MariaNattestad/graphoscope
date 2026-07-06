<script lang="ts">
	import { zoom, zoomIdentity, zoomTransform, type ZoomTransform } from 'd3-zoom';
	import { select } from 'd3-selection';
	import { untrack } from 'svelte';
	import type { LayoutResult } from './forceLayout';
	import { BACKBONE_COLOR, heatmapColor } from './colors';

	let {
		layout,
		strokeWidth = 3,
		onSelectSegment
	}: {
		layout: LayoutResult;
		strokeWidth?: number;
		onSelectSegment?: (segId: string | null) => void;
	} = $props();

	let canvasEl: HTMLCanvasElement | undefined = $state();
	let containerEl: HTMLDivElement | undefined = $state();
	let transform: ZoomTransform = zoomIdentity;
	let zoomBehavior = zoom<HTMLCanvasElement, unknown>().scaleExtent([0.02, 40]);

	let hoveredSegment: string | null = $state(null);
	let hoverPos: { x: number; y: number } = $state({ x: 0, y: 0 });
	let hoverLabel: string | null = $state(null);

	function setHovered(segId: string | null) {
		hoveredSegment = segId;
		if (!segId) {
			hoverLabel = null;
			return;
		}
		const length = layout.segmentLengths.get(segId);
		hoverLabel = `${segId} — ${(length ?? 0).toLocaleString()} bp`;
	}

	function colorForChain(segId: string): string {
		if (layout.backboneSegIds.has(segId)) return BACKBONE_COLOR;
		const coverage = layout.pathCoverage.get(segId) ?? 0;
		const ratio = layout.maxPathCoverage > 0 ? coverage / layout.maxPathCoverage : 0;
		return heatmapColor(ratio);
	}

	function fitToView(retriesLeft = 5) {
		if (!canvasEl) return;

		// The canvas may not have been sized by the browser's layout pass yet
		// (e.g. right after initial mount) — retry on the next frame rather
		// than fitting against a bogus 0x0/1x1 viewport.
		if ((canvasEl.clientWidth < 2 || canvasEl.clientHeight < 2) && retriesLeft > 0) {
			requestAnimationFrame(() => fitToView(retriesLeft - 1));
			return;
		}

		let minX = Infinity,
			minY = Infinity,
			maxX = -Infinity,
			maxY = -Infinity;
		for (const node of layout.nodesById.values()) {
			if (node.x < minX) minX = node.x;
			if (node.x > maxX) maxX = node.x;
			if (node.y < minY) minY = node.y;
			if (node.y > maxY) maxY = node.y;
		}
		if (!Number.isFinite(minX)) return;

		const width = canvasEl.clientWidth || 1;
		const height = canvasEl.clientHeight || 1;
		const graphWidth = Math.max(1, maxX - minX);
		const graphHeight = Math.max(1, maxY - minY);
		const padding = 0.9;
		const scale = Math.min((width / graphWidth) * padding, (height / graphHeight) * padding, 8);
		const cx = (minX + maxX) / 2;
		const cy = (minY + maxY) / 2;

		// Centering is baked directly into the transform (not added separately
		// in draw()) so it matches exactly what d3-zoom assumes when it keeps
		// the point under the cursor fixed during wheel/dblclick zoom.
		const next = zoomIdentity.translate(width / 2 - cx * scale, height / 2 - cy * scale).scale(scale);
		select(canvasEl).call(zoomBehavior.transform, next);
	}

	function draw() {
		if (!canvasEl) return;
		const ctx = canvasEl.getContext('2d');
		if (!ctx) return;

		const dpr = window.devicePixelRatio || 1;
		const width = canvasEl.clientWidth;
		const height = canvasEl.clientHeight;
		if (canvasEl.width !== width * dpr || canvasEl.height !== height * dpr) {
			canvasEl.width = width * dpr;
			canvasEl.height = height * dpr;
		}

		ctx.save();
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, width, height);
		ctx.fillStyle = '#0b0d12';
		ctx.fillRect(0, 0, width, height);

		ctx.translate(transform.x, transform.y);
		ctx.scale(transform.k, transform.k);

		// structural links first, underneath strands. Drawn as a curve through the
		// (invisible) bend node so a link between two backbone-pinned points —
		// e.g. a deletion skip edge — doesn't lie exactly on top of the backbone
		// and disappear against it.
		ctx.strokeStyle = 'rgba(200, 210, 230, 0.35)';
		ctx.lineWidth = 1 / transform.k;
		for (const link of layout.structuralLinkPaths) {
			const a = layout.nodesById.get(link.fromNode);
			const b = layout.nodesById.get(link.toNode);
			const m = layout.nodesById.get(link.bendNode);
			if (!a || !b) continue;
			ctx.beginPath();
			ctx.moveTo(a.x, a.y);
			if (m) ctx.quadraticCurveTo(m.x, m.y, b.x, b.y);
			else ctx.lineTo(b.x, b.y);
			ctx.stroke();
		}

		// strands
		ctx.lineJoin = 'round';
		ctx.lineCap = 'round';
		for (const chain of layout.chains) {
			const pts = chain.nodeIds.map((id) => layout.nodesById.get(id)!);
			if (pts.length === 0) continue;
			ctx.beginPath();
			ctx.moveTo(pts[0].x, pts[0].y);
			for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
			ctx.strokeStyle = colorForChain(chain.segId);
			ctx.lineWidth = (chain.segId === hoveredSegment ? strokeWidth * 1.6 : strokeWidth) / transform.k;
			ctx.stroke();
		}

		ctx.restore();
	}

	function findSegmentAt(px: number, py: number): string | null {
		if (!canvasEl) return null;
		const x = (px - transform.x) / transform.k;
		const y = (py - transform.y) / transform.k;
		const tolerance = 6 / transform.k;

		let best: { segId: string; dist: number } | null = null;
		for (const chain of layout.chains) {
			const pts = chain.nodeIds.map((id) => layout.nodesById.get(id)!);
			for (let i = 0; i < pts.length - 1; i++) {
				const dist = distToSegment(x, y, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
				if (dist < tolerance && (!best || dist < best.dist)) {
					best = { segId: chain.segId, dist };
				}
			}
		}
		return best?.segId ?? null;
	}

	function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
		const dx = bx - ax;
		const dy = by - ay;
		const lenSq = dx * dx + dy * dy;
		let t = lenSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lenSq;
		t = Math.max(0, Math.min(1, t));
		const cx = ax + t * dx;
		const cy = ay + t * dy;
		return Math.hypot(px - cx, py - cy);
	}

	$effect(() => {
		// re-fit and re-draw whenever a new layout is loaded — untrack the body so
		// that reads of hoveredSegment/transform inside draw()/fitToView() don't
		// turn every hover/pan into an implicit dependency of this effect (which
		// was resetting the zoom back to the fitted view on every hover change).
		layout;
		untrack(() => {
			setHovered(null);
			fitToView();
			draw();
		});
	});

	$effect(() => {
		if (!canvasEl) return;
		const sel = select(canvasEl);
		zoomBehavior.on('zoom', (event) => {
			transform = event.transform;
			draw();
		});
		// Plain two-finger trackpad scrolling and mouse-wheel scrolling both show
		// up as identical "wheel" events, indistinguishable from each other, and
		// browsers keep sending residual "momentum" wheel events for a second or
		// two after the gesture ends. If those all drive zoom (the default),
		// residual momentum can visibly drift the zoom level back down on its
		// own. So: plain wheel pans instead, and only a pinch gesture (which
		// browsers report as wheel+ctrlKey) or ctrl/cmd+wheel zooms.
		zoomBehavior.filter((event) => {
			if (event.type === 'wheel') return event.ctrlKey || event.metaKey;
			return !event.button;
		});
		sel.call(zoomBehavior);
		// fitToView() synchronously triggers d3-zoom's 'zoom' callback above, which
		// calls draw() — and draw() reads hoveredSegment. Left untracked, that read
		// would make this whole mount-time effect implicitly depend on
		// hoveredSegment, causing it to re-run (and re-fit/reset zoom) on every
		// hover change. untrack() keeps this effect's only real dependency explicit
		// (canvasEl, checked above).
		untrack(() => fitToView());

		function onWheelPan(e: WheelEvent) {
			if (e.ctrlKey || e.metaKey) return; // let zoomBehavior handle pinch/ctrl+wheel
			e.preventDefault();
			const current = zoomTransform(canvasEl!);
			const next = current.translate(-e.deltaX / current.k, -e.deltaY / current.k);
			sel.call(zoomBehavior.transform, next);
		}

		let clickStart: { x: number; y: number } | null = null;
		function onPointerDown(e: PointerEvent) {
			clickStart = { x: e.clientX, y: e.clientY };
		}
		function onPointerUp(e: PointerEvent) {
			if (!clickStart) return;
			const moved = Math.hypot(e.clientX - clickStart.x, e.clientY - clickStart.y);
			clickStart = null;
			if (moved > 4) return;
			const rect = canvasEl!.getBoundingClientRect();
			const segId = findSegmentAt(e.clientX - rect.left, e.clientY - rect.top);
			onSelectSegment?.(segId);
		}
		function onPointerMove(e: PointerEvent) {
			const rect = canvasEl!.getBoundingClientRect();
			const px = e.clientX - rect.left;
			const py = e.clientY - rect.top;
			const segId = findSegmentAt(px, py);
			if (segId !== hoveredSegment) {
				setHovered(segId);
				canvasEl!.style.cursor = segId ? 'pointer' : 'grab';
				draw();
			}
			hoverPos = { x: px, y: py };
		}
		function onPointerLeave() {
			if (hoveredSegment !== null) {
				setHovered(null);
				canvasEl!.style.cursor = 'grab';
				draw();
			}
		}
		canvasEl.addEventListener('wheel', onWheelPan, { passive: false });
		canvasEl.addEventListener('pointerdown', onPointerDown);
		canvasEl.addEventListener('pointerup', onPointerUp);
		canvasEl.addEventListener('pointermove', onPointerMove);
		canvasEl.addEventListener('pointerleave', onPointerLeave);

		const ro = new ResizeObserver(() => draw());
		if (containerEl) ro.observe(containerEl);

		return () => {
			sel.on('.zoom', null);
			canvasEl?.removeEventListener('wheel', onWheelPan);
			canvasEl?.removeEventListener('pointerdown', onPointerDown);
			canvasEl?.removeEventListener('pointerup', onPointerUp);
			canvasEl?.removeEventListener('pointermove', onPointerMove);
			canvasEl?.removeEventListener('pointerleave', onPointerLeave);
			ro.disconnect();
		};
	});
</script>

<div class="canvas-container" bind:this={containerEl}>
	<canvas bind:this={canvasEl}></canvas>
	{#if hoverLabel}
		<div class="tooltip" style="left: {hoverPos.x + 14}px; top: {hoverPos.y + 14}px">
			{hoverLabel}
		</div>
	{/if}
</div>

<style>
	.canvas-container {
		width: 100%;
		height: 100%;
		position: relative;
	}
	canvas {
		width: 100%;
		height: 100%;
		display: block;
		cursor: grab;
	}
	canvas:active {
		cursor: grabbing;
	}
	.tooltip {
		position: absolute;
		pointer-events: none;
		background: rgba(18, 21, 28, 0.92);
		border: 1px solid #2a3140;
		color: #e6e8ee;
		font-size: 0.75rem;
		padding: 0.25rem 0.5rem;
		border-radius: 4px;
		white-space: nowrap;
		z-index: 10;
	}
</style>
