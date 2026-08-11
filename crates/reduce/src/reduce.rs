//! The reduce pipeline itself, decoupled from where the GFA comes from.
//!
//! `serialize` is whatever can write a subgraph as GFA — in production that is
//! GBZ-base's `Subgraph::write_gfa`, and in tests it is a fixture's text. It is
//! called twice, once per pass, and its output is consumed a line at a time and
//! dropped, so nothing here scales with the number of haplotype walks.

use std::collections::HashMap;
use std::io::{self, Write};

use crate::coverage::Coverage;
use crate::gfa::{self, LineSink, NodeId, ReduceStats, RefWalk, Step, StepIter};
use crate::simplify::{self, Aggregates, Graph};

/// Whether a walk crosses the reference nodes predominantly in *decreasing*
/// reference order — the signature of the locus read on the strand opposite the
/// reference. Only consecutive reference-node transitions vote (non-reference
/// nodes between them are skipped, so an allele that dips off the backbone
/// doesn't count); a walk that is forward with a local inversion still nets
/// increasing and is left as read. Ties and walks touching <2 reference nodes
/// are not reversed.
fn reverse_strand_of_reference(steps: &[Step], ref_idx: &HashMap<NodeId, usize>) -> bool {
    let (mut inc, mut dec) = (0usize, 0usize);
    let mut prev: Option<usize> = None;
    for s in steps {
        let Some(&idx) = ref_idx.get(&s.id) else { continue };
        if let Some(p) = prev {
            if idx > p {
                inc += 1;
            } else if idx < p {
                dec += 1;
            }
        }
        prev = Some(idx);
    }
    dec > inc
}

/// Runs both simplification phases and the walk aggregation, writing the
/// reduced GFA to `out`.
pub fn reduce<S>(serialize: S, max_variant: usize, out: &mut impl Write) -> io::Result<()>
where
    S: Fn(&mut dyn Write) -> io::Result<()>,
{
    // ---- Pass 1: graph structure + walk-derived aggregates ------------------
    let mut graph = Graph::default();
    let mut agg = Aggregates::default();
    let mut reference_samples: Vec<String> = Vec::new();
    let mut ref_walk: Option<RefWalk> = None;
    // Reference node -> its position on the reference path. Built from the
    // reference walk, which GBZ-base emits first, and used to spot (and reverse)
    // haplotypes that cross the locus on the strand opposite the reference — see
    // `reverse_strand_of_reference`. A reused step buffer avoids per-walk
    // allocation while keeping peak memory O(one walk).
    let mut ref_idx: HashMap<NodeId, usize> = HashMap::new();
    let mut buf: Vec<Step> = Vec::new();
    let mut total_walks = 0usize;
    let mut walk_records = 0usize;
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
                // `WT` counts the haplotypes collapsed into this record (1 when
                // absent). Counting records instead would count traversal
                // fragments, which at repetitive loci run into the tens of
                // thousands — see `walk_weight`.
                total_walks += gfa::walk_weight(line);
                walk_records += 1;
                let sample = gfa::walk_sample(line);
                samples.insert(String::from_utf8_lossy(sample).into_owned());
                let is_ref = ref_walk.is_none()
                    && reference_samples.iter().any(|rs| rs.as_bytes() == sample);
                let field = gfa::walk_field(line);
                if is_ref {
                    // The reference defines "forward": record each node's position
                    // so later walks can be oriented against it.
                    let steps: Vec<Step> = StepIter::new(field).collect();
                    for (i, s) in steps.iter().enumerate() {
                        ref_idx.entry(s.id).or_insert(i);
                    }
                    agg.observe_walk(steps.iter().copied());
                    if let Some((sample, hap, seq_id, start, end)) = gfa::parse_walk_meta(line) {
                        ref_walk = Some(RefWalk { sample, hap, seq_id, start, end, steps });
                    }
                } else {
                    // A haplotype that crosses the reference nodes predominantly in
                    // decreasing reference order is the locus read on the opposite
                    // strand (common where the locus sits in an inverted segmental
                    // duplication). Fold it in reversed, so its backbone edges point
                    // forward like every other walk's instead of laying down a chain
                    // of spurious `ref[i] -> ref[i-1]` back-edges that make every
                    // downstream bubble look non-forward and defeat collapse. A walk
                    // that is merely forward with a local inversion stays as read.
                    buf.clear();
                    buf.extend(StepIter::new(field));
                    if reverse_strand_of_reference(&buf, &ref_idx) {
                        agg.observe_walk(buf.iter().rev().copied());
                    } else {
                        agg.observe_walk(buf.iter().copied());
                    }
                }
            }
            _ => {}
        });
        serialize(&mut sink)?;
        sink.finish();
    }
    agg.observe_links(&graph);

    let segments_before = graph.segments.len();
    let links_before = graph.links.len();

    // ---- Planning: pure graph operations, no walks needed -------------------
    let ref_steps: Vec<Step> = ref_walk.as_ref().map(|w| w.steps.clone()).unwrap_or_default();
    let plan = simplify::plan_collapse(&graph, &agg, &ref_steps, max_variant);
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
            cov.observe(&mapped, gfa::walk_weight(line));
        });
        serialize(&mut sink)?;
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
        walk_records,
        total_sequence_bp: unchop.segments.iter().map(|s| s.length).sum(),
    };

    gfa::write_reduced(
        &reference_samples,
        &stats,
        &unchop.segments,
        &unchop.links,
        &cov.node,
        &cov.starts,
        &cov.ends,
        &cov.edge,
        ref_walk.as_ref(),
        &ref_steps_out,
        out,
    )
}
