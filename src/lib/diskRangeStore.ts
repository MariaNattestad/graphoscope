// Bytes of a remote file kept on disk between visits, for sparseVfs.ts.
//
// A gfaidx query fetches a few MB scattered over a multi-GB index, mostly
// in 4 KiB pieces. Every fetched block is also written here, in the browser's
// origin-private file system, so a second visit, or a second look at the same
// region, reads it from disk instead of asking the host again.
//
// One store per remote file: a flat file of block-sized slots, overwritten
// oldest first, and a small index saying which block each slot holds. The index
// names the remote file's validator (size and ETag, or Last-Modified), so a file
// that changed on the host starts the store over. Everything here is best
// effort: any failure means fetching from the network as before.

/** The block size, and the grain sparseVfs.ts aligns its ranges to. */
export const BLOCK = 4096;
// 16,384 blocks is 64 MiB per remote file: a few dozen regions of the chr21 index.
const MAX_SLOTS = 16_384;
const DIR = 'graphoscope-gfaidx-blocks';

/** The part of FileSystemSyncAccessHandle the store uses (a fake in tests). */
export interface SyncHandle {
	read(buffer: Uint8Array, options: { at: number }): number;
	write(buffer: Uint8Array, options: { at: number }): number;
	getSize(): number;
	truncate(size: number): void;
	flush(): void;
	close(): void;
}

interface Saved {
	url: string;
	validator: string;
	next: number;
	/** Block number in each slot, -1 for none. */
	blocks: number[];
}

export class DiskRangeStore {
	private slotOf = new Map<number, number>();
	private blockAt: number[] = [];
	private next = 0;
	private dirty = false;
	/** Blocks served from disk. */
	hits = 0;

	constructor(
		private data: SyncHandle,
		private index: SyncHandle,
		private url: string,
		private validator: string
	) {
		this.load();
	}

	/** The store for `url`, or null where there is no origin-private file system,
	 * no validator to trust, or another tab holds this file's store. */
	static async open(url: string, validator: string | null): Promise<DiskRangeStore | null> {
		if (!validator) return null;
		try {
			const storage = (globalThis.navigator as Navigator | undefined)?.storage;
			if (!storage?.getDirectory) return null;
			const root = await storage.getDirectory();
			const dir = await root.getDirectoryHandle(DIR, { create: true });
			const name = fileName(url);
			const dataFile = await dir.getFileHandle(`${name}.bin`, { create: true });
			const indexFile = await dir.getFileHandle(`${name}.json`, { create: true });
			// Sync handles exist only in workers, and only one at a time per file:
			// another tab with this index open keeps the store, and this one fetches.
			const data = await dataFile.createSyncAccessHandle();
			let index: SyncHandle;
			try {
				index = await indexFile.createSyncAccessHandle();
			} catch (e) {
				data.close();
				throw e;
			}
			return new DiskRangeStore(data, index, url, validator);
		} catch {
			return null;
		}
	}

	private load() {
		try {
			const size = this.index.getSize();
			if (size === 0) return;
			const buf = new Uint8Array(size);
			this.index.read(buf, { at: 0 });
			const saved = JSON.parse(new TextDecoder().decode(buf)) as Saved;
			// Another file under the same name, or this one changed on the host.
			if (saved.url !== this.url || saved.validator !== this.validator) {
				this.dirty = true; // the next flush writes the empty index over it
				return;
			}
			this.blockAt = saved.blocks;
			this.next = saved.next;
			saved.blocks.forEach((block, slot) => {
				if (block >= 0) this.slotOf.set(block, slot);
			});
		} catch {
			this.slotOf.clear();
			this.blockAt = [];
			this.next = 0;
		}
	}

	has(block: number): boolean {
		return this.slotOf.has(block);
	}

	/** Block `block`'s bytes (`length` of them: the file's last block is short). */
	get(block: number, length: number): Uint8Array | null {
		const slot = this.slotOf.get(block);
		if (slot === undefined) return null;
		try {
			const buf = new Uint8Array(length);
			if (this.data.read(buf, { at: slot * BLOCK }) !== length) return null;
			this.hits++;
			return buf;
		} catch {
			return null;
		}
	}

	put(block: number, bytes: Uint8Array) {
		if (this.slotOf.has(block)) return;
		try {
			const slot = this.next;
			this.next = (this.next + 1) % MAX_SLOTS;
			const evicted = this.blockAt[slot];
			if (evicted !== undefined && evicted >= 0) this.slotOf.delete(evicted);
			this.blockAt[slot] = -1;
			this.data.write(bytes, { at: slot * BLOCK });
			this.blockAt[slot] = block;
			this.slotOf.set(block, slot);
			this.dirty = true;
		} catch {
			// Out of quota, or the handle went away: keep reading what is there.
		}
	}

	/** Write the index, after the blocks it names. Called once a query is done. */
	flush() {
		if (!this.dirty) return;
		try {
			this.data.flush();
			const saved: Saved = { url: this.url, validator: this.validator, next: this.next, blocks: this.blockAt };
			const bytes = new TextEncoder().encode(JSON.stringify(saved));
			this.index.truncate(0);
			this.index.write(bytes, { at: 0 });
			this.index.flush();
			this.dirty = false;
		} catch {
			// Best effort.
		}
	}
}

/** A short, stable, legal file name for a URL (the URL itself is checked on load). */
function fileName(url: string): string {
	let a = 0x811c9dc5;
	let b = 0x01000193;
	for (let i = 0; i < url.length; i++) {
		a = Math.imul(a ^ url.charCodeAt(i), 0x01000193);
		b = Math.imul(b ^ url.charCodeAt(i), 0x5bd1e995);
	}
	return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

/** What identifies this version of a remote file, from a response's headers. */
export function validatorOf(size: number, headers: Headers): string | null {
	const tag = headers.get('ETag') ?? headers.get('Last-Modified');
	return tag ? `${size}:${tag}` : null;
}
