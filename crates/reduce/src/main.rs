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
mod simplify;

use std::env;
use std::io::{self, Write};
use std::ops::Range;
use std::process;

use gbz::FullPathName;
use gbz_base::{GBZBase, GraphInterface, Subgraph, SubgraphQuery};
use getopts::Options;

use crate::coverage::Coverage;
use crate::gfa::{LineSink, ReduceStats, RefWalk, Step, StepIter};
use crate::simplify::{Aggregates, Graph};

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

    // Indexed retrieval (GBZ-base).
    let database = GBZBase::open(&config.filename)?;
    let mut graph_if = GraphInterface::new(&database)?;
    let mut subgraph = Subgraph::new();
    subgraph.from_db(&mut graph_if, &config.query)?;

    // ---- Pass 1: graph structure + walk-derived aggregates ------------------
    let mut graph = Graph::default();
    let mut agg = Aggregates::default();
    let mut reference_samples: Vec<String> = Vec::new();
    let mut ref_walk: Option<RefWalk> = None;
    let mut total_walks = 0usize;
    let mut samples: std::collections::HashSet<String> = std::collections::HashSet::new();

    {
        let mut sink = LineSink::new(|line: &[u8]| match gfa::line_type(line) {
            b'H' => {
                if let Some(rs) = gfa::parse_reference_samples(line) {
                    reference_samples = rs;
                }
            }
            b'S' => {
                if let Some(seg) = gfa::parse_segment(line) {
                    graph.add_segment(seg);
                }
            }
            b'L' => {
                if let Some(l) = gfa::parse_link(line) {
                    graph.links.push(l);
                }
            }
            b'W' => {
                total_walks += 1;
                let sample = gfa::walk_sample(line);
                samples.insert(String::from_utf8_lossy(sample).into_owned());
                let is_ref = ref_walk.is_none()
                    && reference_samples.iter().any(|rs| rs.as_bytes() == sample);
                let field = gfa::walk_field(line);
                agg.observe_walk(StepIter::new(field));
                if is_ref {
                    if let Some((sample, hap, seq_id, start, end)) = gfa::parse_walk_meta(line) {
                        ref_walk = Some(RefWalk {
                            sample,
                            hap,
                            seq_id,
                            start,
                            end,
                            steps: StepIter::new(field).collect(),
                        });
                    }
                }
            }
            _ => {}
        });
        subgraph.write_gfa(&mut sink, false).map_err(|e| e.to_string())?;
        sink.finish();
    }
    agg.observe_links(&graph);

    let segments_before = graph.segments.len();
    let links_before = graph.links.len();

    // ---- Planning: pure graph operations, no walks needed -------------------
    let ref_steps: Vec<Step> = ref_walk.as_ref().map(|w| w.steps.clone()).unwrap_or_default();
    let plan = simplify::plan_collapse(&graph, &agg, &ref_steps, config.max_variant);
    drop(agg); // the aggregates are no longer needed
    plan.apply_to_graph(&mut graph);
    let unchop = simplify::plan_unchop(&graph);

    // ---- Pass 2: replay each walk, reroute, map, count, discard -------------
    let mut cov = Coverage::new(unchop.segments.len());
    {
        let mut rerouted: Vec<Step> = Vec::new();
        let mut mapped: Vec<(u32, bool)> = Vec::new();
        let mut seen_ref = false;
        let ref_sample: Option<String> = ref_walk.as_ref().map(|w| w.sample.clone());
        let mut sink = LineSink::new(|line: &[u8]| {
            if gfa::line_type(line) != b'W' {
                return;
            }
            // Skip the reference walk itself — it is the backbone, not coverage.
            if !seen_ref
                && ref_sample.as_deref().map(str::as_bytes) == Some(gfa::walk_sample(line))
            {
                seen_ref = true;
                return;
            }
            plan.reroute(StepIter::new(gfa::walk_field(line)), &mut rerouted);
            unchop.map_walk(&rerouted, &mut mapped);
            cov.observe(&mapped);
        });
        subgraph.write_gfa(&mut sink, false).map_err(|e| e.to_string())?;
        sink.finish();
    }

    // The reference walk is mapped through the chains for output.
    let mut ref_steps_out: Vec<(u32, bool)> = Vec::new();
    if let Some(w) = ref_walk.as_ref() {
        unchop.map_walk(&w.steps, &mut ref_steps_out);
    }

    let stats = ReduceStats {
        segments_before,
        segments_after: unchop.segments.len(),
        links_before,
        links_after: unchop.links.len(),
        sites: plan.sites,
        nodes_removed: plan.nodes_removed,
        snp_count: plan.snp_count,
        bases_removed: plan.bases_removed,
        unchop_merges: unchop.merges,
        total_walks,
        non_ref_walks: cov.non_ref_walks,
        samples: samples.len(),
        total_sequence_bp: unchop.segments.iter().map(|s| s.length).sum(),
    };

    let stdout = io::stdout();
    let mut out = io::BufWriter::new(stdout.lock());
    gfa::write_reduced(
        &reference_samples,
        &stats,
        &unchop.segments,
        &unchop.links,
        &cov.node,
        &cov.edge,
        ref_walk.as_ref(),
        &ref_steps_out,
        &mut out,
    )
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
