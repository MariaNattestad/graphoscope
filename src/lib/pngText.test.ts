import { describe, expect, it } from 'vitest';
import zlib from 'node:zlib';
import { pngWithText, readPngText } from './pngText';

// A valid 1×1 PNG, built here so the test doesn't depend on a fixture file.
function tinyPng(): Uint8Array {
	const chunk = (type: string, data: Uint8Array) => {
		const out = Buffer.alloc(12 + data.length);
		out.writeUInt32BE(data.length, 0);
		out.write(type, 4, 'latin1');
		Buffer.from(data).copy(out, 8);
		out.writeUInt32BE(zlib.crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
		return out;
	};
	const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
	const idat = zlib.deflateSync(Buffer.from([0, 255, 0, 0, 255]));
	return new Uint8Array(
		Buffer.concat([
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			chunk('IHDR', ihdr),
			chunk('IDAT', idat),
			chunk('IEND', new Uint8Array())
		])
	);
}

describe('pngWithText', () => {
	it('embeds text chunks that read back', () => {
		const url = 'https://graphoscope.omgenomics.com/?ref=grch38&locus=SMN1&mark=chr5:100-200,Alu';
		const out = pngWithText(tinyPng(), { Source: url, Software: 'Graphoscope' });
		expect(readPngText(out)).toEqual({ Source: url, Software: 'Graphoscope' });
	});

	it('writes correct chunk CRCs', () => {
		const out = Buffer.from(pngWithText(tinyPng(), { Source: 'x' }));
		let at = 8;
		while (at < out.length) {
			const len = out.readUInt32BE(at);
			expect(out.readUInt32BE(at + 8 + len)).toBe(zlib.crc32(out.subarray(at + 4, at + 8 + len)));
			at += 12 + len;
		}
		expect(at).toBe(out.length);
	});
});
