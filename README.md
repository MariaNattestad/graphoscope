# Pangenome locus browser

Interactive, browser-based viewer for HPRC pangenome graphs at the locus level.
It queries a graph by genome coordinates and renders the resulting subgraph — all
in the browser, reading a multi-GB database **on demand via HTTP range requests**,
without ever downloading the whole thing.

## How it works

```
 .gbz  ──gbz2db──▶  .gbz.db (SQLite)  ──host on R2/S3──▶  browser
                                                            │
     query.wasm (GBZ-base `query`, WASI)  ◀── Web Worker ──┘
                                                            │
                        range requests for only the DB pages a query touches
                                                            │
                                   GFA  ──▶  parse  ──▶  visualization
```

- **`gbz2db`** (from [GBZ-base](https://github.com/jltsiren/gbz-base)) converts a
  `.gbz` into a random-access SQLite database (`.gbz.db`). This is a one-time,
  offline step. The `.db` is ~2× the `.gbz` (topology + sequences re-stored so
  they're seekable) — it is the "big BAM"; SQLite's B-tree indexes are the ".bai".
- **`query.wasm`** is GBZ-base's `query` tool compiled to `wasm32-wasip1`. It runs
  in a Web Worker and does the coordinate→subgraph extraction, emitting GFA.
- **`src/lib/vfs.ts`** backs the WASI filesystem with range requests
  (`HttpRangeReader`) or a local `File` (`BlobRangeReader`), with a 64 KiB block
  cache. SQLite only reads the pages it needs, so a locus query transfers a few MB
  regardless of DB size. (Measured: ~2 MiB / 32 reads for the MHC region on a
  5.84 GiB DB.)

The visualization in `src/lib/GfaView.svelte` is an intentionally minimal
placeholder (reference nodes colored by haplotype coverage) — **replace it** with
the real design. Everything it needs is the parsed `Gfa` object from
`src/lib/gfa.ts`.

## Prerequisites: build the database

You need a `.gbz.db`. Build it from a `.gbz` with GBZ-base's `gbz2db` (built at
`../gbz-base/target/release/gbz2db`):

```sh
gbz2db --output hprc-v1.1-mc-grch38.gbz.db hprc-v1.1-mc-grch38.gbz
```

## Run in development

```sh
npm install
npm run dev
```

Then either:

- **Local file:** pick the `.gbz.db` with the file chooser (uses `FileReaderSync`;
  nothing is uploaded), or
- **URL:** serve the `.db` with range + CORS support and paste the URL. A dev
  helper is included:

  ```sh
  node scripts/db-server.mjs /path/to/dir/with/db 8787
  # then use http://localhost:8787/hprc-v1.1-mc-grch38.gbz.db
  ```

## Deploy

`npm run build` emits a static SPA in `build/` (adapter-static). Host it anywhere.
Host the `.gbz.db` on Cloudflare R2 / S3 and point the URL field at it. The bucket
**must**:

- support HTTP range requests (R2/S3 do), and
- send CORS headers allowing the app's origin and **exposing `Content-Range`**:
  - `Access-Control-Allow-Origin: <your site>`
  - `Access-Control-Expose-Headers: Content-Range, Accept-Ranges`

## Rebuilding `query.wasm`

The wasm at `static/query.wasm` is built from GBZ-base with
`../gbz-base/build-wasm-local.sh` (targets `wasm32-wasip1`; patches `simple-sds`
to drop the `libc`/mmap feature and fix 32-bit size constants). Re-run it and copy
the output:

```sh
(cd ../gbz-base && ./build-wasm-local.sh)
cp ../gbz-base/target/wasm32-wasip1/release/query.wasm static/query.wasm
```
