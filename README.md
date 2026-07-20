# Graphoscope

Explore an HPRC human pangenome graph at any locus. We indexed the graphs so you don't have to. Pick a region to see the subgraph for that locus, visualized with a few early prototypes designed to highlight major graph patterns relative to the reference.

Two HPRC **Release 2 (v2.0)** Minigraph-Cactus graphs are built in, switchable in
the UI:

- **GRCh38-based** (`hprc-v2.0-mc-grch38.gbz.db`, reference `GRCh38`)
- **CHM13-based / T2T** (`hprc-v2.0-mc-chm13.gbz.db`, reference `CHM13`)

## How it works

- **`gbz2db`** (from [GBZ-base](https://github.com/jltsiren/gbz-base)) converts a
  `.gbz` into a random-access SQLite database (`.gbz.db`). This is a one-time,
  offline step. The `.db` is ~2× the `.gbz` (topology + sequences re-stored so
  they're seekable).
- **`query.wasm`** is GBZ-base's `query` tool compiled to `wasm32-wasip1`. It runs
  in a Web Worker and does the coordinate→subgraph extraction, emitting GFA.
- **`src/lib/vfs.ts`** backs the WASI filesystem with range requests
  (`HttpRangeReader`) or a local `File` (`BlobRangeReader`), with a 64 KiB block
  cache plus **adaptive readahead**: because SQLite's page access is clustered,
  a run of sequential block misses is coalesced into one larger range request
  (growing 1→2→…→32 blocks), which collapses round-trips to a remote host where
  latency dominates. SQLite only reads the pages it needs, so a locus query
  transfers a few MB regardless of DB size. (Measured on R2: the MHC region went
  from ~73 range round-trips to ~23 — ~16.6 s → ~1.1 s — fetching ~4.8 MiB of a
  ~9.2 GiB DB.)

## Visualizations

The parsed `Gfa` (from `src/lib/gfa.ts`) drives several views:

- **Reference-anchored graph layout** (`src/lib/graph/`) — a deterministic,
  reference-pinned force layout, with optional reference-guided simplification
  (small-variant popping + unchop) and reference genomic coordinates drawn along
  the backbone.
- **Large non-reference nodes** (`src/lib/RefArcView.svelte`) — arc/lollipop view
  of insertions/deletions/substitutions on a reference coordinate axis.
- **Genome browser** (`src/lib/IgvView.svelte`) — an IGV.js track (hg38 / hs1,
  IGV's built-in id for T2T-CHM13v2.0) of the non-reference nodes.
- **Raw data** (`src/lib/RawDataView.svelte`) — walks / segments / links / raw GFA.

### Simplification playground

[`/playground`](https://marianattestad.github.io/graphoscope/playground) is a
standalone sandbox for the reference-guided simplification algorithm behind the
graph layout: pick a fixture (synthetic edge cases or real HPRC loci), tweak the
collapse threshold, and see the original graph and its simplified form side by
side through the same layout widget. It's where the simplification approach
gets prototyped and stress-tested independently of the main query flow — the
exact fixtures it uses are also what the unit tests assert on
(`src/lib/graph/simplify.test.ts`).

## Gene-name lookup

The Locus field accepts a gene symbol (e.g. `HLA-A`) and resolves it to
coordinates. Lookups use compact per-assembly maps shipped as static assets
(`static/genes/genes-{grch38,chm13}.json`), loaded lazily. Regenerate them with:

```sh
node scripts/build-genes.mjs grch38 gencode.v46.basic.annotation.gtf.gz
node scripts/build-genes.mjs chm13  chm13v2.0_RefSeq_Liftoff_v5.2.gff3.gz
```

(GRCh38 from GENCODE; CHM13 from the T2T-CHM13v2.0 RefSeq Liftoff annotation.)

## Data hosting

The app points at the two `.gbz.db` files on Cloudflare R2 (see `R2_BASE` in
`src/routes/+page.svelte`). To rebuild the databases from the public source graphs:

```sh
# public HPRC Release 2 graphs (~5.4 GB each)
aws s3 cp --no-sign-request \
  s3://human-pangenomics/pangenomes/freeze/release2/minigraph-cactus/hprc-v2.0-mc-grch38.gbz .
../gbz-base/target/release/gbz2db hprc-v2.0-mc-grch38.gbz   # → hprc-v2.0-mc-grch38.gbz.db
```

Host each `.gbz.db` on Cloudflare R2 / S3. The bucket **must**:

- support HTTP range requests (R2/S3 do), and
- send CORS headers **exposing `Content-Range`**, e.g.
  `Access-Control-Allow-Origin: *` and
  `Access-Control-Expose-Headers: Content-Range, Accept-Ranges, Content-Length`.

## Run in development

```sh
npm install
npm run dev
```

The app auto-loads the default locus from R2 on open. To develop against a local
`.gbz.db` instead (no network), serve it with the included range+CORS helper and
point `R2_BASE` at it temporarily:

```sh
node scripts/db-server.mjs /path/to/dir/with/db 8787
# then set R2_BASE = 'http://localhost:8787' in src/routes/+page.svelte
```

## Analytics

Google Analytics (GA4) lives in `src/lib/analytics.ts`. It records coarse product 
usage — which widgets are used and which genomic
coordinates are queried (e.g. `chr6:31972046-32055647`) — and nothing else. That
coordinate is data about the pangenome graph, not about the visitor: no personal
data (name, email, IP-derived location, etc.) is attached to it. It also runs
**cookieless** (GA4 Consent Mode defaults to denied + `client_storage: 'none'`),
so it never writes a cookie or other device storage — see the comments in
`analytics.ts` for the specific flags and the consent-banner reasoning.

## Deploy

`npm run build` emits a static SPA in `build/` (adapter-static). Host it anywhere;
it needs no server of its own — only the `.gbz.db` files on R2/S3 as above.

### GitHub Pages

`.github/workflows/deploy-pages.yml` builds and deploys on every push to `main`.

## The locus query (`crates/reduce`)

The wasm at `static/query.wasm` is built from **`crates/reduce`**, this repo's own
Rust crate. It does three things per query:

1. **Retrieve** the locus subgraph, using
   [GBZ-base](https://github.com/jltsiren/gbz-base) unmodified as a crates.io
   dependency — that's what it's for, and it's the only thing it does here.
2. **Simplify** the subgraph (`src/simplify.rs`): collapse small reference-anchored
   superbubbles onto the reference, then merge non-branching chains. A site
   collapses only if its *longest* entry→exit path is under the threshold, so a
   small deletion spanning a long reference stretch correctly survives.
3. **Aggregate the walks** (`src/coverage.rs`): count how many distinct haplotype
   walks cross each node and edge, emit those as `WC` tags, and drop the walks.

Step 3 is the reason large loci render at all. Haplotype walks are ~97% of a GFA's
bytes on a repetitive locus (measured: 48.5 MB of a 49.8 MB LPA query), and once
parsed into per-step JS objects they dominate the browser's heap. Counting them
here instead means what the browser holds is governed by graph topology, not
haplotype count — for LPA, 404 MB of parsed heap becomes 7.6 MB.

The output is a "reduced" GFA: segments and links carrying `WC:i:<n>` coverage
tags, an `X` line of locus-level counts, and only the reference `W` line.

```sh
scripts/build-wasm.sh     # → static/query.wasm
```

`static/query.wasm` is checked in deliberately, so a clone builds and deploys with
no Rust toolchain and the Pages workflow stays a plain static build. Rebuild it
(and commit the result) only when `crates/reduce` changes.

The script fetches a pinned `simple-sds` and applies
`scripts/simple-sds-wasm32.patch` — it doesn't build for 32-bit wasm as published
(it defaults to a `libc`/mmap feature wasm lacks, and two size constants overflow a
32-bit `usize`). Tested on Apple Silicon; for another host change `WASI_SDK_ARCH`
near the top of the script (e.g. `x86_64-linux`).

You can also run it natively, which is useful for debugging a locus:

```sh
cd crates/reduce && cargo build --release
./target/release/graphoscope-reduce --sample GRCh38 --contig chr5 \
  -i 70925029..70953942 /path/to/hprc-v2.0-mc-grch38.gbz.db
```
