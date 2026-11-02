import { test as base, expect, type Page } from '@playwright/test';

// Every test fails on anything that means "the app broke": an uncaught exception
// (including from a worker's error event surfacing on the page), a console error
// from our own code (Svelte reports effect/render errors there), or one of our own
// files failing to load (a missing query.wasm, a broken chunk). Network errors for
// third-party hosts are left to the individual tests — the live data source is
// checked by what the page ends up showing.
export const test = base.extend<{ appErrors: string[] }>({
	appErrors: [
		async ({ page, baseURL }, use) => {
			const errors: string[] = [];
			const ownOrigin = new URL(baseURL!).origin;
			page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
			page.on('console', (msg) => {
				if (msg.type() !== 'error') return;
				// The browser logs every failed fetch as "Failed to load resource" —
				// own-origin ones are caught below with their URL; the rest are third
				// party (analytics, UCSC gene tracks, aborted S3 range reads).
				if (msg.text().startsWith('Failed to load resource')) return;
				errors.push(`console.error: ${msg.text()}`);
			});
			page.on('response', (r) => {
				if (r.url().startsWith(ownOrigin) && r.status() >= 400)
					errors.push(`HTTP ${r.status()}: ${r.url()}`);
			});
			page.on('requestfailed', (r) => {
				if (r.url().startsWith(ownOrigin))
					errors.push(`request failed: ${r.url()} (${r.failure()?.errorText})`);
			});
			// Keep analytics out of the tests (and out of the site's numbers).
			await page.route(/googletagmanager\.com|google-analytics\.com/, (route) => route.abort());
			await use(errors);
			expect(errors, 'errors raised while the page was in use').toEqual([]);
		},
		{ auto: true }
	]
});
export { expect };

/** Wait for the graph view to finish laying out: a canvas is up and no layout
 * progress indicator is showing. */
export async function waitForLayout(page: Page, timeout = 90_000) {
	await expect(page.locator('canvas').first()).toBeVisible({ timeout });
	await expect(page.getByText(/computing layout…|laying out the graph…/)).toHaveCount(0, {
		timeout
	});
}

/** Sweep the pointer across the graph canvas and click its middle, so hover hit
 * testing, tooltips and the inspector all run against the current layout. */
async function sweepCanvas(page: Page) {
	const canvas = page.locator('canvas').first();
	const box = await canvas.boundingBox();
	if (!box) return;
	for (let fy = 0.2; fy <= 0.8; fy += 0.3) {
		for (let fx = 0.1; fx <= 0.9; fx += 0.2) {
			await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy);
		}
	}
	await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

/** Drive the graph view's main controls: each node-inspector mode with a canvas
 * sweep, the reference-free layout and back, and the MSA panel. */
export async function exerciseGraphView(page: Page) {
	await waitForLayout(page);
	const modes = page.getByRole('radiogroup', { name: 'Node inspector mode' });
	for (const mode of ['Info', 'Bubbles', 'Walks', 'None']) {
		await modes.getByRole('radio', { name: mode }).click();
		await sweepCanvas(page);
	}
	await modes.getByRole('radio', { name: 'Info' }).click();

	const family = page.getByRole('group', { name: 'Layout family' });
	if (await family.isVisible()) {
		await family.getByRole('button', { name: 'Reference-free' }).click();
		await waitForLayout(page);
		await sweepCanvas(page);
		await family.getByRole('button', { name: 'Reference-based' }).click();
		await waitForLayout(page);
	}

	const msa = page.getByRole('button', { name: /Load MSA/ });
	if (await msa.isVisible()) {
		await msa.click();
		await expect(page.getByLabel('Resize the alignment panel')).toBeVisible();
		// With the panel open, a node click builds its alignment.
		await sweepCanvas(page);
	}
}
