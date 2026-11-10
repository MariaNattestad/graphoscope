import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { test, expect, exerciseGraphView, waitForLayout } from './helpers';

// Offline smoke tests: nothing here leaves localhost (the locus browser's live
// queries are in live.spec.ts), so a failure means the app broke, not the network.

const fixture = (name: string) =>
	readFileSync(new URL(`../src/lib/graph/fixtures/${name}`, import.meta.url), 'utf8');

/** Open a GFA in the /gfa viewer through its file picker, as a user would. */
async function openGfa(page: Page, name: string, text: string) {
	await page.goto('/gfa');
	await page
		.locator('input[type="file"]')
		.setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(text) });
	await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
}

// Tiny graphs for the /gfa page's other backbone paths (no W-lines).
const P_LINES = [
	'H\tVN:Z:1.0',
	'S\t1\tACGTACGTAC',
	'S\t2\tG',
	'S\t3\tT',
	'S\t4\tACGTACGTAC',
	'L\t1\t+\t2\t+\t0M',
	'L\t1\t+\t3\t+\t0M',
	'L\t2\t+\t4\t+\t0M',
	'L\t3\t+\t4\t+\t0M',
	'P\tref\t1+,2+,4+\t*',
	'P\talt\t1+,3+,4+\t*'
].join('\n');
const RGFA = [
	'S\ts1\tACGTACGTAC\tSN:Z:chr1\tSO:i:0\tSR:i:0',
	'S\ts2\tGGGG\tSN:Z:chr1\tSO:i:10\tSR:i:0',
	'S\ts3\tTTTTTTTT\tSN:Z:alt1\tSO:i:0\tSR:i:1',
	'S\ts4\tACGTACGTAC\tSN:Z:chr1\tSO:i:14\tSR:i:0',
	'L\ts1\t+\ts2\t+\t0M',
	'L\ts2\t+\ts4\t+\t0M',
	'L\ts1\t+\ts3\t+\t0M',
	'L\ts3\t+\ts4\t+\t0M'
].join('\n');
const NO_PATHS = [
	'S\ta\tACGTACGTACGTACGTACGT',
	'S\tb\tCCCC',
	'S\tc\tGGGGGGGG',
	'S\td\tACGTACGTACGTACGTACGT',
	'L\ta\t+\tb\t+\t0M',
	'L\ta\t+\tc\t+\t0M',
	'L\tb\t+\td\t+\t0M',
	'L\tc\t+\td\t-\t0M'
].join('\n');

test.describe('every page loads', () => {
	for (const path of ['/gfa', '/playground', '/msa-dev']) {
		test(path, async ({ page }) => {
			await page.goto(path);
			await expect(page.locator('body')).not.toBeEmpty();
		});
	}
});

test.describe('/gfa viewer', () => {
	test('bundled MLPH example', async ({ page }) => {
		await page.goto('/gfa');
		await page.getByRole('button', { name: /MLPH pangenome/ }).click();
		await exerciseGraphView(page);
	});

	const files: [string, () => string][] = [
		['c4a.gfa', () => fixture('c4a.gfa')], // a real HPRC locus, W-lines
		['nested.gfa', () => fixture('nested.gfa')],
		['cyclic.gfa', () => fixture('cyclic.gfa')],
		['p-lines.gfa', () => P_LINES],
		['rgfa.gfa', () => RGFA],
		['no-paths.gfa', () => NO_PATHS]
	];
	for (const [name, text] of files) {
		test(name, async ({ page }) => {
			await openGfa(page, name, text());
			await exerciseGraphView(page);
		});
	}

	test('rejects a file that is not a GFA', async ({ page }) => {
		await page.goto('/gfa');
		await page
			.locator('input[type="file"]')
			.setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
		await expect(page.getByText(/No segments \(S lines\) found/)).toBeVisible();
	});
});

test.describe('/playground', () => {
	test('query.wasm reduces every synthetic fixture, matching the pinned expectations', async ({ page }) => {
		await page.goto('/playground');
		// Each row only reduces once it scrolls near the viewport.
		const rows = page.locator('section.example:not(.real)');
		await expect(rows.first()).toBeAttached();
		const ids = await rows.evaluateAll((els) => els.map((e) => e.id));
		expect(ids.length).toBeGreaterThan(0);
		for (const id of ids) {
			const row = page.locator(`section#${id}`);
			await row.scrollIntoViewIfNeeded();
			await expect(row.locator('.pass'), `${id} matches its expectation`).toBeVisible({ timeout: 30_000 });
			await expect(row.locator('.fail')).toHaveCount(0);
		}
		await waitForLayout(page);
	});
});
