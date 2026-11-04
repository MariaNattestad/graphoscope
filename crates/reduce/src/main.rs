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
//! ## Why the subgraph is serialized twice
//!
//! GBZ-base does not expose a subgraph's walks through its public API
//! (`Subgraph::paths()` returns only a count), and the walks are exactly what
//! both phases need. So we ask it to serialize to GFA and read the walks back
//! out of that stream.
//!
//! Crucially the stream is never *stored*: `LineSink` hands us one line at a
//! time, and each walk is folded into aggregates (pass 1) or counted (pass 2)
//! and immediately dropped. Serializing twice costs CPU proportional to the
//! output, but holds nothing, so peak memory is O(nodes + edges) rather than
//! O(total steps) — on a repetitive locus that is the difference between tens
//! of megabytes of transient wasm heap and a few hundred kilobytes.

mod coverage;
mod gfa;
mod locus;
mod reduce;
mod simplify;

#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::env;
use std::io::{self, Write};
use std::ops::Range;
use std::process;

use gbz::{FullPathName, Orientation};
use gbz_base::{GBZBase, GraphInterface, Subgraph, SubgraphQuery};
use getopts::Options;

use crate::locus::LocusQuery;

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

    // `--gfa` reduces a GFA file directly, skipping GBZ-base entirely. This is
    // how /playground runs the real pipeline over its fixture graphs, and how
    // the tests in src/tests.rs drive it — so what the playground shows and what
    // CI asserts are the same code path the app uses on a live locus.
    if let Some(path) = &config.gfa_input {
        let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {}", path, e))?;
        let stdout = io::stdout();
        let mut out = io::BufWriter::new(stdout.lock());
        // With `--interval`, trim to that locus too (no exits are known here:
        // a GFA file says nothing about nodes it does not contain).
        let query = config.trim.then(|| LocusQuery { interval: config.interval.clone(), ..Default::default() });
        reduce::reduce_locus(
            |w: &mut dyn Write| w.write_all(text.as_bytes()),
            config.max_variant,
            query.as_ref(),
            &mut out,
        )
        .map_err(|e| e.to_string())?;
        return out.flush().map_err(|e| e.to_string());
    }

    // Indexed retrieval (GBZ-base).
    let database = GBZBase::open(&config.filename)?;
    let mut graph_if = GraphInterface::new(&database)?;
    let mut subgraph = Subgraph::new();
    subgraph.from_db(&mut graph_if, &config.query)?;

    // The locus trim (see locus.rs) needs the interval and, to report exits,
    // which fetched nodes have edges GBZ-base did not follow. `--no-trim` keeps
    // GBZ-base's whole context-padded subgraph, as before.
    let query = config.trim.then(|| LocusQuery {
        interval: config.interval.clone(),
        frontier: frontier(&subgraph),
    });

    // `--raw` short-circuits everything below: emit the subgraph with every
    // haplotype walk included (trimmed to the locus unless `--no-trim`). This
    // is what the viewer offers as a download for anyone who wants the
    // unsimplified graph.
    let stdout = io::stdout();
    let mut out = io::BufWriter::new(stdout.lock());
    let serialize = |mut w: &mut dyn Write| subgraph.write_gfa(&mut w, false);
    if config.raw {
        match query.as_ref() {
            Some(q) => reduce::write_raw_locus(serialize, q, &mut out),
            None => serialize(&mut out),
        }
        .map_err(|e| e.to_string())?;
        return out.flush().map_err(|e| e.to_string());
    }

    reduce::reduce_locus(serialize, config.max_variant, query.as_ref(), &mut out)
        .map_err(|e| e.to_string())?;
    out.flush().map_err(|e| e.to_string())
}

/// Fetched nodes with edges, in the full graph, to nodes the subgraph does not
/// contain — and how many such edges each has.
fn frontier(subgraph: &Subgraph) -> HashMap<u64, usize> {
    let mut out = HashMap::new();
    for id in subgraph.node_iter() {
        let mut missing = 0;
        for o in [Orientation::Forward, Orientation::Reverse] {
            if let Some(it) = subgraph.supergraph_successors(id, o) {
                missing += it.filter(|&(n, _)| !subgraph.has_node(n)).count();
            }
        }
        if missing > 0 {
            out.insert(id as u64, missing);
        }
    }
    out
}

struct Config {
    filename: String,
    query: SubgraphQuery,
    max_variant: usize,
    /// Emit the unsimplified subgraph (all walks) instead of the reduced GFA.
    raw: bool,
    /// Reduce this GFA file directly, instead of querying a database.
    gfa_input: Option<String>,
    /// The query interval, and whether to trim the subgraph to it.
    interval: Range<usize>,
    trim: bool,
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
        opts.optflag("", "raw", "emit the unsimplified subgraph, with every haplotype walk");
        opts.optopt("", "gfa", "reduce this GFA file instead of querying a database", "FILE");
        opts.optflag(
            "",
            "no-trim",
            "keep the whole context-padded subgraph instead of trimming it to the locus",
        );
        let matches = opts.parse(&args[1..]).map_err(|x| x.to_string())?;

        let header = format!(
            "Usage: {} --sample STR --contig STR -i INT..INT [options] graph.gbz.db\n   or: {} --gfa FILE [--max-variant INT]",
            program, program
        );
        if matches.opt_present("help") {
            eprint!("{}", opts.usage(&header));
            process::exit(0);
        }

        let max_variant_of = |m: &getopts::Matches| -> Result<usize, String> {
            match m.opt_str("max-variant") {
                Some(s) => s.parse().map_err(|e| format!("Failed to parse --max-variant: {}", e)),
                None => Ok(DEFAULT_MAX_VARIANT),
            }
        };

        // GFA input needs none of the query arguments; `--interval` is optional
        // there and, if given, trims to that locus of the reference walk.
        if let Some(gfa) = matches.opt_str("gfa") {
            let interval = matches.opt_str("interval").map(|s| parse_interval(&s)).transpose()?;
            return Ok(Config {
                filename: String::new(),
                query: SubgraphQuery::path_interval(&FullPathName::reference("", ""), 0..0),
                max_variant: max_variant_of(&matches)?,
                raw: false,
                gfa_input: Some(gfa),
                trim: interval.is_some() && !matches.opt_present("no-trim"),
                interval: interval.unwrap_or(0..0),
            });
        }

        let filename = matches
            .free
            .first()
            .cloned()
            .ok_or_else(|| format!("{}\n\nMissing database path", opts.usage(&header)))?;
        let sample =
            matches.opt_str("sample").ok_or_else(|| String::from("--sample is required"))?;
        let contig =
            matches.opt_str("contig").ok_or_else(|| String::from("--contig is required"))?;
        let interval =
            matches.opt_str("interval").ok_or_else(|| String::from("--interval is required"))?;
        let interval = parse_interval(&interval)?;

        let context = match matches.opt_str("context") {
            Some(s) => s.parse().map_err(|e| format!("Failed to parse --context: {}", e))?,
            None => DEFAULT_CONTEXT,
        };
        let max_variant = max_variant_of(&matches)?;

        let path_name = FullPathName::reference(&sample, &contig);
        let query = SubgraphQuery::path_interval(&path_name, interval.clone()).with_context(context);

        Ok(Config {
            filename,
            query,
            max_variant,
            raw: matches.opt_present("raw"),
            gfa_input: None,
            interval,
            trim: !matches.opt_present("no-trim"),
        })
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
