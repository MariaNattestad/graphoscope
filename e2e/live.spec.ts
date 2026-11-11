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
		await exerciseGraphView(page);

		// Simplify: Off loads the full graph (every haplotype walk) and shows every
		// node; Simplify returns to the query's reduced graph.
		const simplify = page.getByRole('group', { name: 'Simplification' });
		await simplify.getByRole('button', { name: 'Off' }).click();
		await expect(page.getByText(/all [\d,]+ nodes shown/)).toBeVisible({ timeout: 120_000 });
		await waitForLayout(page, 180_000);

		await simplify.getByRole('button', { name: 'On', exact: true }).click();
		await expect(simplify.getByRole('button', { name: 'On', exact: true })).toHaveAttribute('aria-pressed', 'true');
		await expect(page.getByText(/alleles shown/)).toBeVisible();
		await waitForLayout(page, 180_000);
	});
}

// A link that sets the query and the view: the gene resolves, Simplify re-runs at
// the linked threshold, and the page reports done with no error or warnings.
test('locus browser: a full link reaches done', async ({ page }) => {
	await page.goto(
		'/?ref=grch38&locus=C4A&simplify=250&theme=light&layout=skyline&genes=0&mark=chr6:31,990,000-31,991,000,test'
	);
	await page.waitForSelector('html[data-status="done"], html[data-status="error"]', { timeout: 180_000 });
	const state = await page.evaluate(() => {
		const g = (window as unknown as { graphoscope: Record<string, unknown> }).graphoscope;
		return { status: g.status, error: g.error, warnings: g.warnings };
	});
	expect(state, JSON.stringify(state)).toEqual({ status: 'done', error: null, warnings: [] });
	await expect(page.locator('.error-banner')).toHaveCount(0);
	await expect
		.poll(() => Object.fromEntries(['simplify', 'layout', 'genes'].map((k) => [k, new URL(page.url()).searchParams.get(k)])))
		.toEqual({ simplify: '250', layout: 'classic', genes: '0' });
});

// simplify=off: the unsimplified graph replaces the reduced one before done.
test('locus browser: simplify=off shows every node', async ({ page }) => {
	await page.goto('/?ref=grch38&locus=C4A&simplify=off');
	await page.waitForSelector('html[data-status="done"], html[data-status="error"]', { timeout: 180_000 });
	await expect(page.locator('html')).toHaveAttribute('data-status', 'done');
	await expect(page.getByText(/all [\d,]+ nodes shown/)).toBeVisible();
	expect(new URL(page.url()).searchParams.get('simplify')).toBe('off');
});
