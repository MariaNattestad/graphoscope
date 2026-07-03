// Client-only application. No server rendering: the query pipeline (WASM +
// worker + HTTP range requests / local File reads) only exists in the browser.
export const ssr = false;
export const prerender = true;
