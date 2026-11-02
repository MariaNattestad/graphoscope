import { defineConfig, devices } from '@playwright/test';

// Browser smoke tests against the production build (`vite build` + `vite preview`),
// so they exercise what GitHub Pages actually serves: the workers, query.wasm and
// the canvas, not just the TS modules the vitest suite covers.
//
//  - `offline` (npm run test:e2e): every page, and the /gfa viewer driven with the
//    repo's own fixtures. No network beyond localhost, so it should never flake.
//  - `live` (npm run test:e2e:live): real locus queries against the HPRC graphs on
//    S3 — the app's main feature, but dependent on the network and that bucket.
export default defineConfig({
	testDir: 'e2e',
	timeout: 120_000,
	expect: { timeout: 30_000 },
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
	use: {
		baseURL: 'http://localhost:4173',
		trace: 'retain-on-failure',
		...devices['Desktop Chrome']
	},
	projects: [
		{ name: 'offline', testIgnore: /live\.spec\.ts/ },
		{ name: 'live', testMatch: /live\.spec\.ts/, timeout: 240_000 }
	],
	webServer: {
		command: 'npm run build && npm run preview -- --port 4173 --strictPort',
		url: 'http://localhost:4173',
		reuseExistingServer: !process.env.CI,
		timeout: 240_000
	}
});
