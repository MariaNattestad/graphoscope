import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, type Plugin } from 'vite';

// Dev-only tab labelling: `import { devBranch } from 'virtual:dev-branch'` is the
// current git branch while `vite dev` is running, and '' in any real build, so
// page titles can distinguish several localhost tabs. Watching .git keeps it
// honest across `git checkout` without restarting the dev server.
const VIRTUAL_ID = 'virtual:dev-branch';
const RESOLVED_ID = '\0' + VIRTUAL_ID;

function currentBranch(): string {
	try {
		const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore']
		}).trim();
		// Detached HEAD reports "HEAD"; show the short sha instead.
		if (branch !== 'HEAD') return branch;
		return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore']
		}).trim();
	} catch {
		return '';
	}
}

function devBranchPlugin(): Plugin {
	let isDev = false;
	return {
		name: 'graphoscope-dev-branch',
		config(_config, { command }) {
			isDev = command === 'serve';
		},
		resolveId(id) {
			return id === VIRTUAL_ID ? RESOLVED_ID : undefined;
		},
		load(id) {
			if (id !== RESOLVED_ID) return;
			return `export const devBranch = ${JSON.stringify(isDev ? currentBranch() : '')};\n`;
		},
		configureServer(server) {
			const gitDir = path.resolve('.git');
			if (!fs.existsSync(gitDir) || !fs.statSync(gitDir).isDirectory()) return;
			// Watch the directory, not HEAD itself: git swaps the file on checkout.
			const watcher = fs.watch(gitDir, (_event, filename) => {
				if (filename !== 'HEAD') return;
				const mod = server.moduleGraph.getModuleById(RESOLVED_ID);
				if (mod) server.moduleGraph.invalidateModule(mod);
				(server.hot ?? server.ws).send({ type: 'full-reload' });
			});
			server.httpServer?.on('close', () => watcher.close());
		}
	};
}

// GitHub Pages serves this repo at /graphoscope/, not domain root. Only the
// Pages build workflow sets BASE_PATH; local dev/build stay at root so
// `npm run dev`/`npm run build` behave exactly as before.
const rawBase = process.env.BASE_PATH;
if (rawBase && !rawBase.startsWith('/')) {
	throw new Error(`BASE_PATH must start with "/" (got "${rawBase}")`);
}
const base: '' | `/${string}` = (rawBase as `/${string}` | undefined) ?? '';

export default defineConfig({
	server: {
		// Honor a PORT assigned by the harness/preview so its proxy finds us.
		port: process.env.PORT ? Number(process.env.PORT) : 5173,
		strictPort: !!process.env.PORT
	},
	plugins: [
		devBranchPlugin(),
		sveltekit({
			compilerOptions: {
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			// Client-only SPA: WASM, the query worker, and range requests all run in
			// the browser, so we emit a static shell and fall back to it for all routes.
			adapter: adapter({ fallback: 'index.html', strict: false }),
			paths: { base }
		})
	]
});
