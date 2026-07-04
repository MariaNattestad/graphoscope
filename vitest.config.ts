import { defineConfig } from 'vitest/config';

// Plain TS module tests (no Svelte components), but we import fixture .gfa files
// with ?raw, which Vitest's Vite pipeline handles out of the box.
export default defineConfig({
	test: {
		include: ['src/**/*.test.ts'],
		environment: 'node'
	}
});
