// Embed text metadata in a PNG, so an exported figure carries the link that
// reproduces it. PNG tEXt chunks (keyword, NUL, Latin-1 text) are read by
// exiftool, ImageMagick's `identify -verbose`, Python's PIL (`img.text`), and
// most image viewers' info panels.

let crcTable: Uint32Array | null = null;

function crc32(bytes: Uint8Array): number {
	if (!crcTable) {
		crcTable = new Uint32Array(256);
		for (let n = 0; n < 256; n++) {
			let c = n;
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
			crcTable[n] = c >>> 0;
		}
	}
	let crc = 0xffffffff;
	for (const b of bytes) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

function textChunk(keyword: string, text: string): Uint8Array {
	// tEXt is Latin-1; anything outside it is replaced rather than mis-encoded.
	const latin1 = (s: string) => Uint8Array.from(s, (ch) => (ch.charCodeAt(0) < 256 ? ch.charCodeAt(0) : 63));
	const data = new Uint8Array([...latin1(keyword), 0, ...latin1(text)]);
	const chunk = new Uint8Array(12 + data.length);
	const view = new DataView(chunk.buffer);
	view.setUint32(0, data.length);
	chunk.set([0x74, 0x45, 0x58, 0x74], 4); // "tEXt"
	chunk.set(data, 8);
	view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
	return chunk;
}

/** The PNG with one tEXt chunk per entry, inserted right after IHDR. */
export function pngWithText(png: Uint8Array, entries: Record<string, string>): Uint8Array {
	// 8-byte signature, then IHDR: 4 length + 4 type + 13 data + 4 CRC.
	const ihdrEnd = 8 + 25;
	const chunks = Object.entries(entries).map(([k, v]) => textChunk(k, v));
	const extra = chunks.reduce((n, c) => n + c.length, 0);
	const out = new Uint8Array(png.length + extra);
	out.set(png.subarray(0, ihdrEnd), 0);
	let at = ihdrEnd;
	for (const c of chunks) {
		out.set(c, at);
		at += c.length;
	}
	out.set(png.subarray(ihdrEnd), at);
	return out;
}

/** Read back the tEXt chunks of a PNG (for tests and debugging). */
export function readPngText(png: Uint8Array): Record<string, string> {
	const out: Record<string, string> = {};
	const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
	let at = 8;
	while (at + 8 <= png.length) {
		const len = view.getUint32(at);
		const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
		if (type === 'tEXt') {
			const data = png.subarray(at + 8, at + 8 + len);
			const nul = data.indexOf(0);
			out[String.fromCharCode(...data.subarray(0, nul))] = String.fromCharCode(...data.subarray(nul + 1));
		}
		if (type === 'IEND') break;
		at += 12 + len;
	}
	return out;
}
