// The screenshot-ready signal: where the current render is, published three
// ways so any kind of agent can wait on it instead of sleeping blind:
//
//   • <html data-status="…">        for browser tools that wait on a selector
//   • window.graphoscope             for tools that evaluate JS (and `.ready`,
//                                    a promise that settles at done or error)
//   • the tab title ("… · done")     for agents that only see screenshots
//
// Stages, in order: loading → querying → layout → drawing → done, or error at
// any point. A new query starts the sequence over (and `ready` with it).
//
// Only pages that call initAgentStatus publish anything; elsewhere (the
// playground, dev pages) setAgentStatus is a no-op.

export type AgentStage = 'loading' | 'querying' | 'layout' | 'drawing' | 'done' | 'error';

export interface AgentState {
	status: AgentStage;
	error: string | null;
	/** Problems with the URL parameters (unknown names, values that didn't parse). */
	warnings: string[];
	/** What was queried or loaded, once known. */
	query: Record<string, unknown> | null;
	/** Graph size and complexity, once known (the same shape /api returns). */
	complexity: Record<string, unknown> | null;
	/** How long the layout took, in ms. */
	layoutMs: number | null;
	/** Settles with this object when the current render reaches done or error. */
	ready: Promise<AgentState>;
}

let state: AgentState | null = null;
let resolveReady: ((s: AgentState) => void) | null = null;
let titleBase = '';

function freshReady(): Promise<AgentState> {
	return new Promise((resolve) => (resolveReady = resolve));
}

function publish() {
	if (!state || typeof document === 'undefined') return;
	document.documentElement.dataset.status = state.status;
	document.title = `${titleBase} · ${state.status}`;
}

/** Start publishing for this page. `title` is the tab title without a status. */
export function initAgentStatus(title: string): void {
	titleBase = title;
	state = {
		status: 'loading',
		error: null,
		warnings: [],
		query: null,
		complexity: null,
		layoutMs: null,
		ready: freshReady()
	};
	(window as unknown as { graphoscope: AgentState }).graphoscope = state;
	publish();
}

export function setAgentStatus(status: AgentStage, patch: Partial<Omit<AgentState, 'status' | 'ready'>> = {}): void {
	if (!state) return;
	const wasTerminal = state.status === 'done' || state.status === 'error';
	const isTerminal = status === 'done' || status === 'error';
	if (wasTerminal && !isTerminal) state.ready = freshReady();
	Object.assign(state, patch, { status });
	if (status !== 'error') state.error = patch.error ?? null;
	publish();
	if (isTerminal && !wasTerminal) resolveReady?.(state);
}

export function agentStatus(): AgentStage | null {
	return state?.status ?? null;
}

export function setAgentWarnings(warnings: string[]): void {
	if (state) state.warnings = warnings;
}
