import { test, expect, exerciseGraphView, waitForLayout } from './helpers';

// Live smoke tests: real locus queries against the HPRC v2.1 graphs on S3, through
// query.wasm in the browser — the locus browser's main path end to end. These
// need the network (and that bucket), so they run separately from the offline
// suite: `npm run test:e2e:live`.

test('API page answers a gene query', async ({ page }) => {
	await page.goto('/api?ref=grch38&locus=C4A');
	await expect(page.locator('main[data-status="done"], main[data-status="error"]')).toBeVisible({
		timeout: 120_000
	});
	const result = JSON.parse(await page.locator('#result').innerText());
	expect(result.ok, JSON.stringify(result).slice(0, 500)).toBe(true);
});

for (const ref of ['grch38', 'chm13']) {
	test(`locus browser: C4A on ${ref}`, async ({ page }) => {
		await page.goto(`/?ref=${ref}&locus=C4A`);
		await waitForLayout(page, 180_000);
		// The header's "<n> n · <l> l · <w> w" counts: a real graph came back.
		await expect(page.getByText(/^\d[\d,]* w$/).first()).toBeVisible();
		// Ends with Load MSA, which on a simplified graph swaps in the full
		// (unsimplified) graph — every haplotype walk — so the alignment has them.
		await exerciseGraphView(page);
		const simplify = page.getByRole('checkbox', { name: /^Simplify/ });
		await expect(simplify).not.toBeChecked({ timeout: 120_000 });
		await expect(page.getByText(/all [\d,]+ nodes shown/)).toBeVisible();
		await waitForLayout(page, 180_000);

		// And Simplify back on returns to the reduced graph.
		await page.locator('label.switch', { has: simplify }).click();
		await expect(simplify).toBeChecked();
		await waitForLayout(page, 180_000);
	});
}
