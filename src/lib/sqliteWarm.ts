// Prefetch the parts of a GBZ-base SQLite DB that every locus query reads.
//
// A query's range requests are strictly serial: SQLite asks for one page,
// decides what to read next from its contents, and blocks on that read. With
// ~300 ms to first byte from S3, the round trips — not the bytes — set the
// fetch time. Most of them used to go to work that doesn't depend on the locus:
// GBZ-base finds the reference path with
//   SELECT * FROM Paths WHERE sample = ? AND contig = ? AND haplotype = ? …
// and `Paths` has no index on those columns, so SQLite scans the whole table
// (~2.8 MB on the HPRC v2.1 graphs) on every query, which readahead could only
// cover in ~9 growing requests.
//
// Here we read the schema out of the already-fetched first page and pull the
// full-scanned table in before the query starts, so its scan is all cache hits.
// Everything is located from the file itself, so there are no hard-coded
// offsets to go stale if the DB is rebuilt. Purely an optimization: any failure
// is ignored and the query just fetches on demand as before.

import type { RangeReader } from './vfs';

/** Tables the GBZ-base query scans in full (no usable index for its WHERE). */
const FULL_SCAN_TABLES = ['Paths'];

/** Don't prefetch a full-scan table bigger than this — it's no longer cheap. */
const MAX_TABLE_BYTES = 16 * 1024 * 1024;

const SQLITE_MAGIC = 'SQLite format 3\0';
const INTERIOR_TABLE = 0x05;
const LEAF_TABLE = 0x0d;

function readVarint(buf: Uint8Array, pos: number): [value: number, next: number] {
	let v = 0;
	for (let i = 0; i < 8; i++) {
		const b = buf[pos + i];
		v = v * 128 + (b & 0x7f);
		if (b < 0x80) return [v, pos + i + 1];
	}
	return [v * 256 + buf[pos + 8], pos + 9];
}

function u16(buf: Uint8Array, pos: number) {
	return (buf[pos] << 8) | buf[pos + 1];
}
function u32(buf: Uint8Array, pos: number) {
	return ((buf[pos] << 24) >>> 0) + (buf[pos + 1] << 16) + (buf[pos + 2] << 8) + buf[pos + 3];
}

interface BtreePage {
	type: number;
	/** Byte offsets of each cell within the page. */
	cells: number[];
	/** Interior pages only: the right-most child page number. */
	rightChild?: number;
}

function parsePage(page: Uint8Array, headerOffset: number): BtreePage {
	const type = page[headerOffset];
	const count = u16(page, headerOffset + 3);
	const interior = type === INTERIOR_TABLE || type === 0x02;
	const ptrs = headerOffset + (interior ? 12 : 8);
	const cells = Array.from({ length: count }, (_, i) => u16(page, ptrs + 2 * i));
	return { type, cells, rightChild: interior ? u32(page, headerOffset + 8) : undefined };
}

/** Child page numbers of an interior table page, in key order. */
function interiorChildren(page: Uint8Array, p: BtreePage): number[] {
	return [...p.cells.map((c) => u32(page, c)), p.rightChild!];
}

/** name → root page for every table and index in `sqlite_master` (page 1).
 * Handles only the common case of a schema that fits in one leaf page with no
 * overflow — true for GBZ-base's handful of tables; anything else returns
 * empty and warming is skipped. */
export function readSchema(page1: Uint8Array, pageSize: number): Map<string, number> {
	const roots = new Map<string, number>();
	const p = parsePage(page1, 100);
	if (p.type !== LEAF_TABLE) return roots;
	const maxLocal = pageSize - 35;
	for (const cell of p.cells) {
		let [payload, pos] = readVarint(page1, cell);
		if (payload > maxLocal) continue; // spills to overflow pages; skip it
		[, pos] = readVarint(page1, pos); // rowid
		const recordStart = pos;
		const [headerLen, afterLen] = readVarint(page1, pos);
		const types: number[] = [];
		for (pos = afterLen; pos < recordStart + headerLen; ) {
			let t;
			[t, pos] = readVarint(page1, pos);
			types.push(t);
		}
		// Columns: type, name, tbl_name, rootpage, sql.
		const values: (string | number | null)[] = [];
		for (const t of types.slice(0, 4)) {
			if (t >= 13 && t % 2 === 1) {
				const n = (t - 13) / 2;
				values.push(new TextDecoder().decode(page1.subarray(pos, pos + n)));
				pos += n;
			} else if (t >= 1 && t <= 6) {
				const n = [0, 1, 2, 3, 4, 6, 8][t];
				let v = 0;
				for (let i = 0; i < n; i++) v = v * 256 + page1[pos + i];
				values.push(v);
				pos += n;
			} else if (t === 8 || t === 9) {
				values.push(t - 8);
			} else if (t === 0) {
				values.push(null);
			} else {
				break; // float/blob in the first four columns: not a schema row we know
			}
		}
		const [, name, , root] = values;
		if (typeof name === 'string' && typeof root === 'number' && root > 0) roots.set(name, root);
	}
	return roots;
}

/** Warms `reader` for a GBZ-base query: the header block, then each
 * full-scan table in one request. Serial round trips are what cost (S3 speaks
 * only HTTP/1.1, so parallel requests each pay for a fresh connection), so
 * rather than walking the B-tree level by level we fetch the table's likely
 * extent in one go: a table filled in one pass right after its CREATE occupies
 * the pages from its root up to the next object's root — on the HPRC graphs,
 * `Paths` then `ReferenceIndex`. The level walk afterwards confirms it from the
 * cache, and fetches whatever a differently laid-out file kept elsewhere. */
export async function warmGbzDb(reader: RangeReader): Promise<void> {
	await reader.prefetch(0, 100);
	const header = reader.readRange(0, 100);
	if (new TextDecoder().decode(header.subarray(0, 16)) !== SQLITE_MAGIC) return;
	const rawSize = u16(header, 16);
	const pageSize = rawSize === 1 ? 65536 : rawSize;
	const reserved = header[20];
	await reader.prefetch(0, pageSize);
	const page = (n: number) => reader.readRange((n - 1) * pageSize, pageSize - reserved);

	const roots = readSchema(page(1), pageSize - reserved);
	const sortedRoots = [...new Set(roots.values())].sort((a, b) => a - b);

	for (const table of FULL_SCAN_TABLES) {
		const root = roots.get(table);
		if (root === undefined) continue;
		let budget = MAX_TABLE_BYTES;

		// One request for the guessed extent, through the next object's root page
		// (which every query reads anyway).
		const next = sortedRoots.find((n) => n > root);
		if (next !== undefined && (next - root + 1) * pageSize <= budget) {
			await reader.prefetch((root - 1) * pageSize, (next - root + 1) * pageSize);
			budget -= (next - root + 1) * pageSize;
		}

		// Walk interior levels down to the leaves; each level is one span request
		// for whatever the guess above didn't already cover.
		let level = [root];
		for (let depth = 0; depth < 4; depth++) {
			await Promise.all(level.map((n) => reader.prefetch((n - 1) * pageSize, pageSize)));
			const children = level.flatMap((n) => {
				const pg = page(n);
				const p = parsePage(pg, n === 1 ? 100 : 0);
				return p.type === INTERIOR_TABLE ? interiorChildren(pg, p) : [];
			});
			if (children.length === 0) break; // reached the leaves
			const lo = Math.min(...children);
			const hi = Math.max(...children);
			const bytes = (hi - lo + 1) * pageSize;
			if (bytes > budget) break;
			budget -= bytes;
			await reader.prefetch((lo - 1) * pageSize, bytes);
			level = children;
		}
	}
}
