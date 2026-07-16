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

## Rebuilding `query.wasm`

The wasm at `static/query.wasm` is [GBZ-base](https://github.com/jltsiren/gbz-base)'s
`query` binary, compiled to `wasm32-wasip1`. GBZ-base itself doesn't build for wasm
out of the box — its own `build-wasm.sh` targets the removed `wasm32-wasi`, and its
dependency `simple-sds` doesn't compile for 32-bit wasm without a small patch (drops
the `libc`/mmap feature, which wasm lacks, and fixes two size constants that overflow
32-bit `usize`).

`scripts/build-wasm.sh` (checked into this repo) handles all of that: it clones a
pinned `simple-sds`, applies `scripts/simple-sds-wasm32.patch`, wires it into
GBZ-base via a local `[patch.crates-io]`, builds, and copies the result into
`static/`. It needs a GBZ-base checkout to build against:

```sh
git clone https://github.com/jltsiren/gbz-base ../gbz-base
scripts/build-wasm.sh          # defaults to ../gbz-base
# or: scripts/build-wasm.sh /path/to/gbz-base
```

Tested on Apple Silicon (arm64 WASI SDK). On another host architecture, change
`WASI_SDK_ARCH` near the top of the script (e.g. `x86_64-linux`).
