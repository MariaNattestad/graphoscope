// Dev-only static server with HTTP range support and permissive CORS, for
// serving the (multi-GB) .gbz.db locally the way R2/S3 will in production.
// Usage: node scripts/db-server.mjs /path/to/dir [port]
import { createServer } from 'node:http';
import { stat, open } from 'node:fs/promises';
import { join, normalize } from 'node:path';

const root = process.argv[2] ?? '.';
const port = Number(process.argv[3] ?? 8787);

createServer(async (req, res) => {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');
	res.setHeader('Accept-Ranges', 'bytes');
	if (req.method === 'OPTIONS') {
		res.setHeader('Access-Control-Allow-Headers', 'Range');
		res.writeHead(204).end();
		return;
	}
	try {
		const path = join(root, normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)));
		const info = await stat(path);
		const range = req.headers.range;
		const fh = await open(path, 'r');
		try {
			if (range) {
				const m = /bytes=(\d+)-(\d*)/.exec(range);
				const start = Number(m[1]);
				const end = m[2] ? Number(m[2]) : info.size - 1;
				const len = end - start + 1;
				console.log(`RANGE ${start}-${end} (${len} B)`);
				res.writeHead(206, {
					'Content-Range': `bytes ${start}-${end}/${info.size}`,
					'Content-Length': len,
					'Content-Type': 'application/octet-stream'
				});
				const buf = Buffer.alloc(len);
				await fh.read(buf, 0, len, start);
				res.end(buf);
			} else {
				res.writeHead(200, { 'Content-Length': info.size, 'Content-Type': 'application/octet-stream' });
				const stream = fh.createReadStream();
				stream.pipe(res);
				await new Promise((r) => stream.on('close', r));
			}
		} finally {
			await fh.close();
		}
	} catch (e) {
		res.writeHead(404).end(String(e));
	}
}).listen(port, () => console.log(`db-server: ${root} on http://localhost:${port}`));
