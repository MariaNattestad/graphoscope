// Runs the force-directed backbone layout off the main thread so a dense
// pangenome subgraph (thousands of tiny SNP nodes) never freezes the UI.
// The GfaGraph and the LayoutResult (Maps/Sets/arrays of plain objects) are
// all structured-cloneable, so they cross the worker boundary directly.
import { buildAndRunLayout, type LayoutResult, type LayoutOptions } from './forceLayout';
import type { GfaGraph } from './types';

export interface LayoutRequest {
	id: number;
	graph: GfaGraph;
	options?: LayoutOptions;
}

export interface LayoutResponse {
	id: number;
	layout: LayoutResult;
	ms: number;
}

self.onmessage = (ev: MessageEvent<LayoutRequest>) => {
	const { id, graph, options } = ev.data;
	const t0 = performance.now();
	const layout = buildAndRunLayout(graph, options);
	const ms = Math.round(performance.now() - t0);
	(self as unknown as Worker).postMessage({ id, layout, ms } satisfies LayoutResponse);
};
