<script lang="ts">
	import { zoom, zoomIdentity, zoomTransform, type ZoomTransform } from 'd3-zoom';
	import { select } from 'd3-selection';
	import { untrack } from 'svelte';
	import type { LayoutResult } from './forceLayout';
	import { heatmapColor, darkTheme, lightTheme } from './colors';
	import type { Transcript } from '../geneTrack';
	import { trackEvent } from '../analytics';

	interface RefCoord {
		contig: string;
		start: number;
		end: number;
	}

	interface DiscoStep {
		id: string;
		orient: '+' | '-';
	}

	let {
		layout,
		refCoords,
		genes = [],
		strokeWidth = 3,
		onSelectSegment,
		discoPath = null,
		discoColor = '#ff3ce0',
		discoActive = false,
		lightMode = false,
		onReady
	}: {
		layout: LayoutResult;
		refCoords?: Map<string, RefCoord>;
		genes?: Transcript[];
		strokeWidth?: number;
		onSelectSegment?: (segId: string | null) => void;
		/** Steps of the walk currently being spotlit by disco-walks, or null. */
		discoPath?: DiscoStep[] | null;
		/** Cycling glow color for the current disco walk. */
		discoColor?: string;
		/** When true, dim the base graph so the spotlit walk pops. */
		discoActive?: boolean;
		/** Render on a light (figure-friendly) theme instead of the dark screen one. */
		lightMode?: boolean;
		/** Hands the parent a small API (currently just PNG export) once mounted. */
		onReady?: (api: { exportImage: (filename: string) => void }) => void;
	} = $props();

	const theme = $derived(lightMode ? lightTheme : darkTheme);

	// segId -> its chain, for tracing a walk's polyline through the layout.
	const chainBySeg = $derived(new Map(layout.chains.map((c) => [c.segId, c])));

	// Reserved bottom bands, in screen (CSS) px. The coordinate axis sits directly
	// under the backbone; the gene track (only when there are genes to show) sits
	// below that, in the space the one-sided layout keeps clear. fitToView fits the
	// graph into the height above both, so the backbone never overlaps them.
	const AXIS_BAND = 22;
	const GENE_BAND = 84;
	const GENE_ROW = 15;
	const GENE_MAX_ROWS = 4;
	const geneBand = $derived(genes.length > 0 ? GENE_BAND : 0);

	let canvasEl: HTMLCanvasElement | undefined = $state();
	let containerEl: HTMLDivElement | undefined = $state();
	let transform: ZoomTransform = zoomIdentity;
	let zoomBehavior = zoom<HTMLCanvasElement, unknown>().scaleExtent([0.02, 40]);
	// Non-null only during a PNG export, when draw() renders at this pixel ratio.
	let exportScale: number | null = null;

	// Render the current view to a PNG at a higher pixel ratio (for figures), then
	// restore the on-screen render. Both draws are synchronous, so the user never
	// sees the high-res frame — the browser only paints the restored one.
	function exportImage(filename: string) {
		if (!canvasEl) return;
		exportScale = 4;
		draw();
		const url = canvasEl.toDataURL('image/png');
		exportScale = null;
		draw();
		const a = document.createElement('a');
		a.href = url;
		a.download = filename;
		a.click();
		trackEvent('widget_interact', { widget: 'graph_layout', action: 'export_png' });
	}

	// EXPERIMENT: zoom is horizontal-only. A pangenome bubble is wide and thin —
	// the interesting structure is variation *along* the reference, while the
	// vertical axis is just stacking room for alternate paths. Zooming both axes
	// together means pulling two crowded strands apart horizontally also grows
	// the pile vertically until it leaves the viewport. So x scales with the
	// zoom and y stays pinned at whatever fits the graph in the canvas.
	//
	// Consequences, both deliberate:
	//  - the two axes fit independently, so the layout fills the vertical space
	//    instead of being letterboxed by the (much larger) horizontal extent;
	//  - d3-zoom's own transform.y is ignored. It assumes uniform scaling, so
	//    its y drifts while zooming toward a point. We track vertical panning
	//    ourselves in `panY` and only move it when k *didn't* change.
	let baseScaleY = 1;
	let panY = 0;
	let prevK = 1;
	let prevY = 0;

	// World -> screen (CSS px). x rides the zoom, y rides the fixed fit.
	const toScreenX = (wx: number) => transform.x + wx * transform.k;
	const toScreenY = (wy: number) => panY + wy * baseScaleY;

	let hoveredSegment: string | null = $state(null);
	let hoverPos: { x: number; y: number } = $state({ x: 0, y: 0 });
	let hoverLabel: string | null = $state(null);

	// Exon hit regions in screen space, rebuilt each draw so a pointer move can
	// resolve which exon it's over without re-deriving geometry.
	interface ExonHit {
		x0: number;
		x1: number;
		yTop: number;
		yBot: number;
		label: string;
	}
	let exonHits: ExonHit[] = [];
	// Flip the tooltip above the cursor near the bottom of the stage (the gene
	// track lives there, and a tooltip below would clip against the frame).
	const tooltipAbove = $derived(hoverPos.y > 360);

	function setHovered(segId: string | null) {
		hoveredSegment = segId;
		if (!segId) {
			hoverLabel = null;
			return;
		}
		const length = layout.segmentLengths.get(segId);
		const coord = refCoords?.get(segId);
		const coordStr = coord
			? ` · ${coord.contig}:${coord.start.toLocaleString()}–${coord.end.toLocaleString()}`
			: '';
		hoverLabel = `${segId} — ${(length ?? 0).toLocaleString()} bp${coordStr}`;
	}

	function colorForChain(segId: string): string {
		if (layout.backboneSegIds.has(segId)) return theme.backbone;
		const coverage = layout.pathCoverage.get(segId) ?? 0;
		const ratio = layout.maxPathCoverage > 0 ? coverage / layout.maxPathCoverage : 0;
		return heatmapColor(ratio, theme.heatmapLow, theme.heatmapHigh);
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
		const cx = (minX + maxX) / 2;
		const cy = (minY + maxY) / 2;

		// Fit the graph into the height above the reserved bottom bands, so the
		// backbone and its coordinate axis clear the gene track. The axis band is
		// only reserved when there are reference coordinates to draw (the
		// playground graphs have none), and the gene band only when there are genes.
		const axisBand = refCoords && refCoords.size > 0 ? AXIS_BAND : 0;
		const fitH = Math.max(1, height - axisBand - geneBand);
		const scaleX = Math.min((width / graphWidth) * padding, 8);
		baseScaleY = Math.min((fitH / graphHeight) * padding, 8);
		panY = fitH / 2 - cy * baseScaleY;

		// Horizontal centering is baked directly into the transform (not added
		// separately in draw()) so it matches exactly what d3-zoom assumes when
		// it keeps the point under the cursor fixed during wheel/dblclick zoom.
		const next = zoomIdentity.translate(width / 2 - cx * scaleX, 0).scale(scaleX);
		prevK = scaleX;
		prevY = 0;
		select(canvasEl).call(zoomBehavior.transform, next);
	}

	function draw() {
		if (!canvasEl) return;
		const ctx = canvasEl.getContext('2d');
		if (!ctx) return;

		// During a PNG export we temporarily render the canvas backing store at a
		// higher pixel ratio, so the exported image is crisp at figure resolution
		// while the on-screen size (fixed by CSS) is unchanged.
		const dpr = exportScale ?? (window.devicePixelRatio || 1);
		const width = canvasEl.clientWidth;
		const height = canvasEl.clientHeight;
		if (canvasEl.width !== width * dpr || canvasEl.height !== height * dpr) {
			canvasEl.width = width * dpr;
			canvasEl.height = height * dpr;
		}

		ctx.save();
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, width, height);
		ctx.fillStyle = theme.background;
		ctx.fillRect(0, 0, width, height);

		// Points are projected to screen coordinates individually rather than by
		// setting a canvas transform, because the transform is now anisotropic:
		// ctx.scale(kx, ky) would stretch every stroke into an ellipse, making
		// line width depend on a segment's direction. Projecting by hand keeps
		// stroke widths honest screen pixels and drops the old `/transform.k`
		// compensation everywhere.

		// structural links first, underneath strands. Drawn as a curve through the
		// (invisible) bend node so a link between two backbone-pinned points —
		// e.g. a deletion skip edge — doesn't lie exactly on top of the backbone
		// and disappear against it.
		ctx.strokeStyle = theme.structuralLink;
		ctx.lineWidth = 1;
		for (const link of layout.structuralLinkPaths) {
			const a = layout.nodesById.get(link.fromNode);
			const b = layout.nodesById.get(link.toNode);
			const m = layout.nodesById.get(link.bendNode);
			if (!a || !b) continue;
			ctx.beginPath();
			ctx.moveTo(toScreenX(a.x), toScreenY(a.y));
			if (m)
				ctx.quadraticCurveTo(
					toScreenX(m.x),
					toScreenY(m.y),
					toScreenX(b.x),
					toScreenY(b.y)
				);
			else ctx.lineTo(toScreenX(b.x), toScreenY(b.y));
			ctx.stroke();
		}

		// strands
		ctx.lineJoin = 'round';
		ctx.lineCap = 'round';
		for (const chain of layout.chains) {
			const pts = chain.nodeIds.map((id) => layout.nodesById.get(id)!);
			if (pts.length === 0) continue;
			ctx.beginPath();
			ctx.moveTo(toScreenX(pts[0].x), toScreenY(pts[0].y));
			for (let i = 1; i < pts.length; i++) ctx.lineTo(toScreenX(pts[i].x), toScreenY(pts[i].y));
			ctx.strokeStyle = colorForChain(chain.segId);
			ctx.lineWidth = chain.segId === hoveredSegment ? strokeWidth * 1.6 : strokeWidth;
			ctx.stroke();
		}

		// Spotlight overlay: the current disco walk, traced through its segments'
		// chains and stroked as a glowing line over the full-brightness base graph.
		drawDiscoWalk(ctx);

		ctx.restore();

		// Reference-coordinate labels along the backbone, drawn in SCREEN space so
		// the font stays a constant size regardless of zoom. Each reference node
		// gets its start coordinate; the last also gets its end. Labels are skipped
		// when they'd collide with the previous one, but the first and last are
		// always kept. ctx.restore() above dropped back to the identity transform
		// (physical device pixels), but toScreenX/Y below compute CSS-pixel
		// coordinates — reapply the DPR scale so they still land in the right spot.
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		drawRefCoordLabels(ctx, width, height);
		drawGeneTrack(ctx, width, height);
	}

	// Bounds (world) of each reference segment's chain, so we can anchor genomic
	// coordinates to on-screen positions — used by both the coordinate axis and
	// the gene track. Sorted by minX, which (since the backbone is monotonic) is
	// also sorted by genomic start.
	interface RefAnchor {
		segId: string;
		minX: number;
		maxX: number;
		y: number;
		coord: RefCoord;
	}
	function buildRefAnchors(): RefAnchor[] {
		if (!refCoords || refCoords.size === 0) return [];
		const anchors: RefAnchor[] = [];
		for (const chain of layout.chains) {
			const coord = refCoords.get(chain.segId);
			if (!coord) continue;
			let minX = Infinity,
				maxX = -Infinity,
				y = 0;
			for (const id of chain.nodeIds) {
				const n = layout.nodesById.get(id);
				if (!n) continue;
				if (n.x < minX) minX = n.x;
				if (n.x > maxX) maxX = n.x;
				y = n.y;
			}
			if (!Number.isFinite(minX)) continue;
			anchors.push({ segId: chain.segId, minX, maxX, y, coord });
		}
		anchors.sort((a, b) => a.minX - b.minX);
		return anchors;
	}

	// A genomic position -> screen x, piecewise-linear through the reference
	// anchors (so it respects each segment's own on-screen length), with linear
	// extrapolation past the first/last segment for genes that overrun the window.
	function genomicToScreenX(bp: number, anchors: RefAnchor[]): number {
		const first = anchors[0];
		if (bp <= first.coord.start) {
			const span = Math.max(1, first.coord.end - first.coord.start);
			const scale = (toScreenX(first.maxX) - toScreenX(first.minX)) / span;
			return toScreenX(first.minX) + (bp - first.coord.start) * scale;
		}
		for (const a of anchors) {
			if (bp <= a.coord.end) {
				const f = (bp - a.coord.start) / Math.max(1, a.coord.end - a.coord.start);
				return toScreenX(a.minX) + f * (toScreenX(a.maxX) - toScreenX(a.minX));
			}
		}
		const last = anchors[anchors.length - 1];
		const span = Math.max(1, last.coord.end - last.coord.start);
		const scale = (toScreenX(last.maxX) - toScreenX(last.minX)) / span;
		return toScreenX(last.maxX) + (bp - last.coord.end) * scale;
	}

	// Guards for the two assumptions the coordinate mapping makes. Neither should
	// ever fire for a normal reference path — they exist to catch it loudly (and
	// in telemetry) if a locus ever violates them, since it would silently corrupt
	// the axis and gene-track positions rather than crash.
	function checkRefInvariants() {
		const anchors = buildRefAnchors();
		if (anchors.length === 0) return;

		// Anchors are sorted by on-screen position (minX). Genomic starts must
		// ascend in that same order, or "left-to-right = increasing bp" — which the
		// axis and the gene track both rely on — is false.
		for (let i = 1; i < anchors.length; i++) {
			if (anchors[i].coord.start < anchors[i - 1].coord.start) {
				console.error(
					`GraphCanvas: reference is not monotonically increasing — segment ${anchors[i].segId} ` +
						`is drawn right of ${anchors[i - 1].segId} but has a smaller genomic start ` +
						`(${anchors[i].coord.start} < ${anchors[i - 1].coord.start}). The coordinate axis and ` +
						`gene-track bp→x mapping are unreliable for this locus.`
				);
				trackEvent('ref_invariant_violation', {
					kind: 'non_monotonic',
					seg: anchors[i].segId,
					contig: anchors[i].coord.contig
				});
				break;
			}
		}

		// A reference segment drawn right-to-left (its chain's last node sits left of
		// its first). The mapping treats each segment's left edge as its genomic
		// start, so bp within a reversed segment would be mirrored on the axis and
		// gene track.
		const reversed: string[] = [];
		for (const chain of layout.chains) {
			if (!refCoords?.has(chain.segId) || chain.nodeIds.length < 2) continue;
			const first = layout.nodesById.get(chain.nodeIds[0]);
			const last = layout.nodesById.get(chain.nodeIds[chain.nodeIds.length - 1]);
			if (first && last && last.x < first.x) reversed.push(chain.segId);
		}
		if (reversed.length > 0) {
			console.warn(
				`GraphCanvas: ${reversed.length} reference segment(s) drawn in reverse orientation ` +
					`(${reversed.slice(0, 6).join(', ')}${reversed.length > 6 ? '…' : ''}). Coordinates within ` +
					`these segments may be mirrored on the axis and gene track.`
			);
			trackEvent('ref_invariant_violation', {
				kind: 'reverse_orientation',
				count: reversed.length
			});
		}
	}

	function drawRefCoordLabels(ctx: CanvasRenderingContext2D, width: number, height: number) {
		const anchors = buildRefAnchors();
		if (anchors.length === 0) return;

		ctx.save();
		ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
		ctx.textBaseline = 'top';
		const MIN_GAP = 64; // px between labels
		const fmt = (n: number) => n.toLocaleString();

		let lastLabelRight = -Infinity;
		const drawTick = (sx: number, sy: number, text: string, align: CanvasTextAlign) => {
			ctx.strokeStyle = theme.tick;
			ctx.lineWidth = 1;
			ctx.beginPath();
			ctx.moveTo(sx, sy);
			ctx.lineTo(sx, sy + 6);
			ctx.stroke();
			ctx.textAlign = align;
			// text background pill for legibility over strands
			const w = ctx.measureText(text).width;
			const tx = align === 'center' ? sx - w / 2 : align === 'right' ? sx - w : sx;
			ctx.fillStyle = theme.coordPill;
			ctx.fillRect(tx - 2, sy + 7, w + 4, 13);
			ctx.fillStyle = theme.coordText;
			ctx.fillText(text, sx, sy + 8);
		};

		// The end coordinate of the last anchor, pinned to the far right — always
		// shown since it bounds the view. Reserve its left edge so no start label to
		// its left is allowed to run into it (the source of the right-side overlap:
		// the last segment's start tick used to be force-drawn regardless of gap).
		const last = anchors[anchors.length - 1];
		const endX = toScreenX(last.maxX);
		const endText = fmt(last.coord.end);
		const endLeft = endX - ctx.measureText(endText).width;
		const endVisible = endX >= -40 && endX <= width + 40;

		for (let i = 0; i < anchors.length; i++) {
			const a = anchors[i];
			const sx = toScreenX(a.minX);
			const sy = toScreenY(a.y);
			if (sx < -40 || sx > width + 40) continue; // off-screen
			const isFirst = i === 0;
			const textW = ctx.measureText(fmt(a.coord.start)).width;
			// A centered start label spans [sx - w/2, sx + w/2].
			const clearsPrev = isFirst || sx - lastLabelRight >= MIN_GAP;
			const clearsEnd = !endVisible || sx + textW / 2 < endLeft - 8;
			if (clearsPrev && clearsEnd) {
				drawTick(sx, sy, fmt(a.coord.start), 'center');
				lastLabelRight = sx + textW / 2;
			}
		}
		if (endVisible) drawTick(endX, toScreenY(last.y), endText, 'right');
		// Contig label, once, at the far left.
		ctx.textAlign = 'left';
		ctx.fillStyle = theme.contigLabel;
		ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
		ctx.fillText(anchors[0].coord.contig, 8, Math.max(4, toScreenY(anchors[0].y) - 18));
		ctx.restore();
	}

	// Gene models drawn in the reserved bottom band: intron line + strand arrows,
	// exon boxes (taller where coding), one representative transcript per gene,
	// packed into rows. Positioned by genomic coordinate through the same anchors
	// as the axis, so it tracks the backbone under pan/zoom. Display-only — the
	// arc view is where genes are interactive.
	function drawGeneTrack(ctx: CanvasRenderingContext2D, width: number, height: number) {
		exonHits = [];
		if (genes.length === 0) return;
		const anchors = buildRefAnchors();
		if (anchors.length === 0) return;
		const gx = (bp: number) => genomicToScreenX(bp, anchors);
		const contig = anchors[0].coord.contig;

		const bandTop = height - GENE_BAND;
		ctx.save();
		// clip to the band so nothing bleeds up into the graph
		ctx.beginPath();
		ctx.rect(0, bandTop, width, GENE_BAND);
		ctx.clip();
		ctx.strokeStyle = theme.geneBandLine;
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.moveTo(0, bandTop + 0.5);
		ctx.lineTo(width, bandTop + 0.5);
		ctx.stroke();

		ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
		ctx.textBaseline = 'middle';

		interface Placed {
			g: Transcript;
			x1: number;
			x2: number;
			labelEnd: number;
		}
		const rows: Placed[][] = [];
		const sorted = [...genes].sort((a, b) => a.start - b.start);
		for (const g of sorted) {
			const x1 = gx(g.start);
			const x2 = gx(g.end);
			if (Math.max(x1, x2) < -20 || Math.min(x1, x2) > width + 20) continue; // off-screen
			const labelEnd = Math.max(x1, x2) + 6 + ctx.measureText(g.symbol).width;
			const p: Placed = { g, x1, x2, labelEnd };
			const row = rows.find((r) => r.length === 0 || r[r.length - 1].labelEnd + 6 < x1);
			if (row) row.push(p);
			else if (rows.length < GENE_MAX_ROWS) rows.push([p]);
		}

		for (let ri = 0; ri < rows.length; ri++) {
			const y = bandTop + 12 + ri * GENE_ROW;
			for (const { g } of rows[ri]) {
				const lo = Math.max(-2, Math.min(gx(g.start), gx(g.end)));
				const hi = Math.min(width + 2, Math.max(gx(g.start), gx(g.end)));

				// intron line
				ctx.strokeStyle = theme.geneIntron;
				ctx.lineWidth = 1;
				ctx.beginPath();
				ctx.moveTo(lo, y);
				ctx.lineTo(hi, y);
				ctx.stroke();

				// strand direction chevrons
				const dir = g.strand === '-' ? -1 : 1;
				ctx.strokeStyle = theme.geneChevron;
				for (let ax = lo + 10; ax < hi - 3; ax += 24) {
					ctx.beginPath();
					ctx.moveTo(ax - dir * 3, y - 3);
					ctx.lineTo(ax, y);
					ctx.lineTo(ax - dir * 3, y + 3);
					ctx.stroke();
				}

				// exons: coding boxes taller than UTR. Exon numbering follows the
				// transcript's direction, so exon 1 is the first one transcribed.
				const nExons = g.exons.length;
				for (let ei = 0; ei < nExons; ei++) {
					const ex = g.exons[ei];
					const exNum = g.strand === '-' ? nExons - ei : ei + 1;
					const cs = Math.max(ex.start, g.cdsStart);
					const ce = Math.min(ex.end, g.cdsEnd);
					const segs: [number, number, boolean][] = [];
					if (cs < ce) {
						if (ex.start < cs) segs.push([ex.start, cs, false]);
						segs.push([cs, ce, true]);
						if (ce < ex.end) segs.push([ce, ex.end, false]);
					} else {
						segs.push([ex.start, ex.end, false]);
					}
					for (const [a, b, coding] of segs) {
						const bx = Math.max(0, Math.min(gx(a), gx(b)));
						const bw = Math.min(width, Math.max(gx(a), gx(b))) - bx;
						if (bw <= 0) continue;
						const h = coding ? 7 : 4;
						ctx.fillStyle = coding ? theme.geneExonCoding : theme.geneExonUtr;
						ctx.fillRect(bx, y - h / 2, Math.max(0.8, bw), h);
					}
					// one hover region per exon, spanning its whole extent
					const ex0 = Math.max(0, Math.min(gx(ex.start), gx(ex.end)));
					const ex1 = Math.min(width, Math.max(gx(ex.start), gx(ex.end)));
					if (ex1 > ex0) {
						exonHits.push({
							x0: ex0,
							x1: ex1,
							yTop: y - 6,
							yBot: y + 6,
							label:
								`${g.symbol} · exon ${exNum}/${nExons} · ` +
								`${contig}:${ex.start.toLocaleString()}–${ex.end.toLocaleString()} · ` +
								`${(ex.end - ex.start).toLocaleString()} bp · ${g.name}`
						});
					}
				}

				// label just past the gene, clamped into view
				const tw = ctx.measureText(g.symbol).width;
				const labelX = Math.min(hi + 5, width - tw - 2);
				ctx.fillStyle = theme.geneLabel;
				ctx.textAlign = 'left';
				ctx.fillText(g.symbol, Math.max(2, labelX), y);
			}
		}
		ctx.restore();
	}

	// Trace the current disco walk as a single polyline through the layout: for each
	// step, append its chain's nodes (reversed when the walk traverses the segment
	// backwards). Its two kinds of segment are drawn at the base graph's own
	// widths, just with a colored glow added: each segment's node-strand at full
	// strand thickness (with a bright white core), and the link connectors between
	// consecutive segments as thin as a normal link.
	function drawDiscoWalk(ctx: CanvasRenderingContext2D) {
		if (!discoActive || !discoPath || discoPath.length === 0) return;

		// Split the walk into per-segment node-strands and the link connectors that
		// join them, so the two can be stroked at different widths (a single merged
		// polyline can't tell "inside a node" from "hopping between nodes").
		const strands: { x: number; y: number }[][] = [];
		const links: [{ x: number; y: number }, { x: number; y: number }][] = [];
		let prevEnd: { x: number; y: number } | null = null;
		for (const step of discoPath) {
			const chain = chainBySeg.get(step.id);
			if (!chain) continue;
			const ids = step.orient === '-' ? [...chain.nodeIds].reverse() : chain.nodeIds;
			const pts: { x: number; y: number }[] = [];
			for (const id of ids) {
				const n = layout.nodesById.get(id);
				if (n) pts.push({ x: toScreenX(n.x), y: toScreenY(n.y) });
			}
			if (pts.length === 0) continue;
			if (prevEnd) links.push([prevEnd, pts[0]]);
			strands.push(pts);
			prevEnd = pts[pts.length - 1];
		}
		if (strands.length === 0) return;

		// Collect all the links into one path and all the strands into another (each
		// polyline is its own subpath, so they still render separately), then stroke
		// each path in a single call. This keeps the walk to a fixed 3 strokes no
		// matter how many segments it spans — which matters because the glow uses
		// shadowBlur, and shadowBlur is very expensive *per stroke*: a long walk (the
		// reference path spans the whole backbone) stroked segment-by-segment was
		// hundreds of shadowed strokes every frame, 10× a second.
		const linkPath = new Path2D();
		for (const [a, b] of links) {
			linkPath.moveTo(a.x, a.y);
			linkPath.lineTo(b.x, b.y);
		}
		const strandPath = new Path2D();
		for (const pts of strands) {
			strandPath.moveTo(pts[0].x, pts[0].y);
			for (let i = 1; i < pts.length; i++) strandPath.lineTo(pts[i].x, pts[i].y);
		}

		ctx.save();
		ctx.lineJoin = 'round';
		ctx.lineCap = 'round';
		ctx.shadowColor = discoColor;
		ctx.shadowBlur = 18;
		ctx.strokeStyle = discoColor;
		ctx.globalAlpha = 0.9;

		// link connectors: thin, matching the base graph's 1px links, glow only
		ctx.lineWidth = 1;
		ctx.stroke(linkPath);

		// node strands: full strand thickness, glow
		ctx.lineWidth = strokeWidth;
		ctx.stroke(strandPath);

		// bright core down the node strands only, no glow
		ctx.shadowBlur = 0;
		ctx.strokeStyle = theme.discoCore;
		ctx.lineWidth = Math.max(1, strokeWidth * 0.5);
		ctx.globalAlpha = 0.95;
		ctx.stroke(strandPath);
		ctx.restore();
	}

	function findSegmentAt(px: number, py: number): string | null {
		if (!canvasEl) return null;
		// Hit-testing happens in screen space: with x and y on different scales
		// there is no single world-space tolerance that means "6 pixels away".
		const tolerance = 6;

		let best: { segId: string; dist: number } | null = null;
		for (const chain of layout.chains) {
			const pts = chain.nodeIds.map((id) => layout.nodesById.get(id)!);
			for (let i = 0; i < pts.length - 1; i++) {
				const dist = distToSegment(
					px,
					py,
					toScreenX(pts[i].x),
					toScreenY(pts[i].y),
					toScreenX(pts[i + 1].x),
					toScreenY(pts[i + 1].y)
				);
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

	function findExonAt(px: number, py: number): string | null {
		for (const h of exonHits) {
			if (px >= h.x0 && px <= h.x1 && py >= h.yTop && py <= h.yBot) return h.label;
		}
		return null;
	}

	$effect(() => {
		// re-fit and re-draw whenever a new layout is loaded — untrack the body so
		// that reads of hoveredSegment/transform inside draw()/fitToView() don't
		// turn every hover/pan into an implicit dependency of this effect (which
		// was resetting the zoom back to the fitted view on every hover change).
		// Also re-runs when genes load, since that changes the reserved band height
		// and so the vertical fit.
		layout;
		genes;
		untrack(() => {
			setHovered(null);
			fitToView();
			draw();
		});
	});

	$effect(() => {
		// Redraw whenever the disco-walks spotlight changes (a new walk in the cycle,
		// a new glow color, or disco turning on/off) or the theme flips. Untracked so
		// draw()'s internal reads don't make this effect depend on hover/transform state.
		discoPath;
		discoColor;
		discoActive;
		theme;
		untrack(() => draw());
	});

	$effect(() => {
		// Hand the parent the export API once the canvas exists.
		if (canvasEl) onReady?.({ exportImage });
	});

	$effect(() => {
		// Verify the reference-coordinate assumptions once per layout/coords change,
		// outside the hot draw path.
		layout;
		refCoords;
		untrack(() => checkRefInvariants());
	});

	$effect(() => {
		if (!canvasEl) return;
		const sel = select(canvasEl);
		zoomBehavior.on('zoom', (event) => {
			const t = event.transform;
			// A gesture that changed k is a zoom, and zoom must not move the graph
			// vertically. Anything else is a pan, and d3's y delta there is already
			// in screen pixels, so it carries over to panY as-is.
			if (t.k === prevK) panY += t.y - prevY;
			prevK = t.k;
			prevY = t.y;
			transform = t;
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
			hoverPos = { x: px, y: py };

			// Exons win: they live in the bottom band, clear of the strands.
			const exon = findExonAt(px, py);
			if (exon) {
				if (hoveredSegment !== null) {
					setHovered(null);
					draw();
				}
				hoverLabel = exon;
				canvasEl!.style.cursor = 'default';
				return;
			}

			const segId = findSegmentAt(px, py);
			if (segId !== hoveredSegment) {
				setHovered(segId);
				canvasEl!.style.cursor = segId ? 'pointer' : 'grab';
				draw();
			} else if (hoveredSegment === null && hoverLabel !== null) {
				// moved off an exon into empty space — clear the lingering label
				hoverLabel = null;
				canvasEl!.style.cursor = 'grab';
			}
		}
		function onPointerLeave() {
			const wasStrand = hoveredSegment !== null;
			setHovered(null); // also clears hoverLabel
			canvasEl!.style.cursor = 'grab';
			if (wasStrand) draw();
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
		<div
			class="tooltip"
			class:above={tooltipAbove}
			style="left: {hoverPos.x + 14}px; top: {tooltipAbove ? hoverPos.y - 10 : hoverPos.y + 14}px"
		>
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
	.tooltip.above {
		transform: translateY(-100%);
	}
</style>
