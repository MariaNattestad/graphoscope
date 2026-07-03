import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	server: {
		// Honor a PORT assigned by the harness/preview so its proxy finds us.
		port: process.env.PORT ? Number(process.env.PORT) : 5173,
		strictPort: !!process.env.PORT
	},
	plugins: [
		sveltekit({
			compilerOptions: {
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			// Client-only SPA: WASM, the query worker, and range requests all run in
			// the browser, so we emit a static shell and fall back to it for all routes.
			adapter: adapter({ fallback: 'index.html', strict: false })
		})
	]
});
