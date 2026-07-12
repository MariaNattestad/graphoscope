// Build compact gene-symbol → coordinate maps for the Locus field autocomplete.
//
// Reads a GTF (GENCODE) or GFF3 (RefSeq/CAT-Liftoff) annotation, keeps `gene`
// feature lines on the primary chromosomes, and writes
//   static/genes/genes-<ref>.json   as  { SYMBOL: [contig, start0, end] }
//
// Usage:
//   node scripts/build-genes.mjs <ref> <annotation.gtf|gff3[.gz]>
//     <ref> = grch38 | chm13
//
// The annotation files are large; keep them OUT of the repo (download to a temp
// dir). This script only emits the small JSON. See the app's Acknowledgements
// for data sources.

import fs from 'node:fs';
import zlib from 'node:zlib';
import readline from 'node:readline';
import path from 'node:path';

const [, , ref, annPath] = process.argv;
if (!ref || !annPath) {
	console.error('usage: node scripts/build-genes.mjs <grch38|chm13> <annotation.gtf|gff3[.gz]>');
	process.exit(1);
}

const PRIMARY = new Set(
	Array.from({ length: 22 }, (_, i) => `chr${i + 1}`).concat(['chrX', 'chrY', 'chrM'])
);

// Pull a gene symbol out of either GTF (key "value") or GFF3 (key=value) attrs.
function geneName(attrs) {
	// GTF: gene_name "TP53";
	let m = attrs.match(/gene_name "([^"]+)"/);
	if (m) return m[1];
	// GFF3: ...;gene_name=TP53;  or  ;Name=TP53;  or  ;gene=TP53;
	m = attrs.match(/(?:^|;)gene_name=([^;]+)/);
	if (m) return decodeURIComponent(m[1]);
	m = attrs.match(/(?:^|;)gene=([^;]+)/);
	if (m) return decodeURIComponent(m[1]);
	m = attrs.match(/(?:^|;)Name=([^;]+)/);
	if (m) return decodeURIComponent(m[1]);
	return null;
}

const stream = annPath.endsWith('.gz')
	? fs.createReadStream(annPath).pipe(zlib.createGunzip())
	: fs.createReadStream(annPath);
const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

// Keep the LONGEST span per symbol (a gene may appear split; take the widest).
const out = {};
let genesSeen = 0;
const contigsSkipped = new Set();

for await (const line of rl) {
	if (line[0] === '#') continue;
	const f = line.split('\t');
	if (f.length < 9) continue;
	if (f[2] !== 'gene') continue;
	genesSeen++;
	const contig = f[0];
	if (!PRIMARY.has(contig)) {
		contigsSkipped.add(contig);
		continue;
	}
	const name = geneName(f[8]);
	if (!name) continue;
	const start = Number(f[3]) - 1; // GTF/GFF are 1-based inclusive → 0-based
	const end = Number(f[4]); // half-open
	if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
	const prev = out[name];
	if (!prev || end - start > prev[2] - prev[1]) out[name] = [contig, start, end];
}

const outDir = path.resolve('static/genes');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `genes-${ref}.json`);
fs.writeFileSync(outFile, JSON.stringify(out));
const bytes = fs.statSync(outFile).size;
console.log(
	`wrote ${outFile}: ${Object.keys(out).length} symbols from ${genesSeen} gene lines, ${(bytes / 1024).toFixed(0)} KiB`
);
if (contigsSkipped.size)
	console.log(`skipped non-primary contigs: ${[...contigsSkipped].slice(0, 8).join(', ')}${contigsSkipped.size > 8 ? ' …' : ''}`);
