//! Graphoscope's locus query: extract a pangenome subgraph, simplify it, and
//! aggregate its haplotype walks into per-node/edge counts — emitting a
//! "reduced" GFA small enough for a browser to hold.
//!
//! Compiled to `wasm32-wasip1` and run in a Web Worker over an HTTP
//! range-request VFS (see `src/lib/query.worker.ts` and `src/lib/vfs.ts`), so a
//! multi-GB `.gbz.db` is queried without downloading it.
//!
//! GBZ-base is used unmodified, as a published dependency, for what it is for:
//! indexed retrieval of the locus. Everything after that — the simplification
//! and the walk aggregation, i.e. the part that makes a large locus renderable
//! at all — is implemented here.
//!
//! One seam worth knowing about: GBZ-base does not expose a subgraph's walks
//! through its public API (`Subgraph::paths()` returns only a count), and the
//! walks are exactly what both phases need. So we ask it to serialize the
//! subgraph to GFA in memory and parse that back. It costs a round trip inside
//! wasm, which the browser never pays for, and keeps this crate free of any
//! fork of or patch to GBZ-base.

mod coverage;
mod gfa;
mod simplify;

use std::env;
use std::io::{self, Write};
use std::ops::Range;
use std::process;

use gbz_base::{GBZBase, GraphInterface, Subgraph, SubgraphQuery};
use gbz::FullPathName;
use getopts::Options;

use crate::gfa::ReduceStats;

// Longest-path bp threshold below which a superbubble collapses to the
// reference. Matches the default in the TypeScript implementation.
const DEFAULT_MAX_VARIANT: usize = 50;
const DEFAULT_CONTEXT: usize = 100;

fn main() {
    if let Err(e) = run() {
        eprintln!("Error: {}", e);
        process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let config = Config::parse()?;

    // 1. Indexed retrieval (GBZ-base).
    let database = GBZBase::open(&config.filename)?;
    let mut graph = GraphInterface::new(&database)?;
    let mut subgraph = Subgraph::new();
    subgraph.from_db(&mut graph, &config.query)?;

    // 2. Bridge: serialize the subgraph to GFA in memory, then parse it back so
    //    we have the walks (see the module comment for why this hop exists).
    let mut buf: Vec<u8> = Vec::new();
    subgraph.write_gfa(&mut buf, false).map_err(|e| e.to_string())?;
    let text = String::from_utf8(buf).map_err(|e| e.to_string())?;
    let mut parsed = gfa::parse_gfa(&text);
    drop(text);

    // 3. Reduce: simplify, then aggregate walks into counts.
    let reference_sample = parsed.reference_samples.first().cloned().unwrap_or_default();
    let segments_before = parsed.segments.len();
    let links_before = parsed.links.len();
    let total_walks = parsed.walks.len();
    let samples = parsed
        .walks
        .iter()
        .map(|w| w.sample.as_str())
        .collect::<std::collections::HashSet<_>>()
        .len();

    let pop = simplify::pop_small_variants(&mut parsed, &reference_sample, config.max_variant);
    let unchop_merges = simplify::unchop(&mut parsed);

    let ref_idx = parsed.walks.iter().position(|w| w.is_ref);
    let cov = coverage::compute_coverage(&parsed, ref_idx);

    let stats = ReduceStats {
        segments_before,
        segments_after: parsed.segments.len(),
        links_before,
        links_after: parsed.links.len(),
        sites: pop.sites.len(),
        nodes_removed: pop.nodes_removed,
        snp_count: pop.snp_count,
        bases_removed: pop.bases_removed,
        unchop_merges,
        total_walks,
        non_ref_walks: cov.non_ref_walks,
        samples,
        total_sequence_bp: parsed.segments.iter().map(|s| s.length).sum(),
    };

    // 4. Emit.
    let stdout = io::stdout();
    let mut out = io::BufWriter::new(stdout.lock());
    gfa::write_reduced(&parsed, &stats, &cov.node, &cov.edge, ref_idx, &mut out)
        .map_err(|e| e.to_string())?;
    out.flush().map_err(|e| e.to_string())?;

    Ok(())
}

struct Config {
    filename: String,
    query: SubgraphQuery,
    max_variant: usize,
}

impl Config {
    fn parse() -> Result<Config, String> {
        let args: Vec<String> = env::args().collect();
        let program = args.first().cloned().unwrap_or_else(|| "graphoscope-reduce".to_string());

        let mut opts = Options::new();
        opts.optflag("h", "help", "print this help");
        opts.optopt("", "sample", "reference sample name (e.g. GRCh38)", "STR");
        opts.optopt("", "contig", "contig name (e.g. chr5)", "STR");
        opts.optopt("i", "interval", "half-open sequence interval", "INT..INT");
        opts.optopt("", "context", "context length in bp", "INT");
        opts.optopt(
            "",
            "max-variant",
            "longest-path bp threshold for collapsing a small variant",
            "INT",
        );
        let matches = opts.parse(&args[1..]).map_err(|x| x.to_string())?;

        let header = format!(
            "Usage: {} --sample STR --contig STR -i INT..INT [options] graph.gbz.db",
            program
        );
        if matches.opt_present("help") {
            eprint!("{}", opts.usage(&header));
            process::exit(0);
        }

        let filename = matches
            .free
            .first()
            .cloned()
            .ok_or_else(|| format!("{}\n\nMissing database path", opts.usage(&header)))?;

        let sample = matches
            .opt_str("sample")
            .ok_or_else(|| String::from("--sample is required"))?;
        let contig = matches
            .opt_str("contig")
            .ok_or_else(|| String::from("--contig is required"))?;
        let interval = matches
            .opt_str("interval")
            .ok_or_else(|| String::from("--interval is required"))?;
        let interval = parse_interval(&interval)?;

        let context = match matches.opt_str("context") {
            Some(s) => s.parse().map_err(|e| format!("Failed to parse --context: {}", e))?,
            None => DEFAULT_CONTEXT,
        };
        let max_variant = match matches.opt_str("max-variant") {
            Some(s) => s.parse().map_err(|e| format!("Failed to parse --max-variant: {}", e))?,
            None => DEFAULT_MAX_VARIANT,
        };

        let path_name = FullPathName::reference(&sample, &contig);
        let query = SubgraphQuery::path_interval(&path_name, interval).with_context(context);

        Ok(Config { filename, query, max_variant })
    }
}

fn parse_interval(s: &str) -> Result<Range<usize>, String> {
    let mut parts = s.split("..");
    let start = parts.next().ok_or_else(|| format!("Invalid interval: {}", s))?;
    let start = start.parse::<usize>().map_err(|e| format!("Invalid interval start: {}", e))?;
    let end = parts.next().ok_or_else(|| format!("Invalid interval: {}", s))?;
    let end = end.parse::<usize>().map_err(|e| format!("Invalid interval end: {}", e))?;
    if parts.next().is_some() {
        return Err(format!("Invalid interval: {}", s));
    }
    Ok(start..end)
}
