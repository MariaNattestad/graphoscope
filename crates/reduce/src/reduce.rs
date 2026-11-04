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
use crate::locus::{self, LocusQuery, Trim};
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
/// reduced GFA to `out`. No locus trim: every fetched node is kept.
#[cfg(test)]
pub fn reduce<S>(serialize: S, max_variant: usize, out: &mut impl Write) -> io::Result<()>
where
    S: Fn(&mut dyn Write) -> io::Result<()>,
{
    reduce_locus(serialize, max_variant, None, out)
}

/// Applies the locus trim (see `locus.rs`) to the reference walk the first time
/// it is seen, replacing its steps and coordinates with the kept range.
fn trim_ref_walk(graph: &Graph, w: &mut RefWalk, query: Option<&LocusQuery>) -> Option<Trim> {
    let t = locus::plan_trim(graph, w, query?)?;
    w.steps = t.ref_steps.clone();
    w.start = t.ref_start;
    w.end = t.ref_end;
    Some(t)
}

/// As `reduce`, but when `query` is given, first trims the fetched subgraph to
/// the locus (see `locus.rs`): nodes outside the kept set are dropped, and
/// every walk is clipped to its runs through kept nodes.
pub fn reduce_locus<S>(
    serialize: S,
    max_variant: usize,
    query: Option<&LocusQuery>,
    out: &mut impl Write,
) -> io::Result<()>
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
    // Planned when the reference walk arrives — by then every S and L line has
    // been read, since GBZ-base writes walks last.
    let mut trim: Option<Trim> = None;

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
                let sample = gfa::walk_sample(line);
                let is_ref = ref_walk.is_none()
                    && reference_samples.iter().any(|rs| rs.as_bytes() == sample);
                let field = gfa::walk_field(line);
                buf.clear();
                buf.extend(StepIter::new(field));
                if is_ref {
                    let Some((sample, hap, seq_id, start, end)) = gfa::parse_walk_meta(line) else {
                        return;
                    };
                    let mut w =
                        RefWalk { sample, hap, seq_id, start, end, steps: std::mem::take(&mut buf) };
                    trim = trim_ref_walk(&graph, &mut w, query);
                    // The reference defines "forward": record each node's position
                    // so later walks can be oriented against it.
                    for (i, s) in w.steps.iter().enumerate() {
                        ref_idx.entry(s.id).or_insert(i);
                    }
                    agg.observe_walk(w.steps.iter().copied());
                    ref_walk = Some(w);
                } else {
                    // A walk that never touches a kept node is not part of the locus.
                    if let Some(t) = trim.as_ref() {
                        if !buf.iter().any(|s| t.keeps(s.id)) {
                            return;
                        }
                    }
                    // A haplotype that crosses the reference nodes predominantly in
                    // decreasing reference order is the locus read on the opposite
                    // strand (common where the locus sits in an inverted segmental
                    // duplication). Fold it in reversed, so its backbone edges point
                    // forward like every other walk's instead of laying down a chain
                    // of spurious `ref[i] -> ref[i-1]` back-edges that make every
                    // downstream bubble look non-forward and defeat collapse. A walk
                    // that is merely forward with a local inversion stays as read.
                    if reverse_strand_of_reference(&buf, &ref_idx) {
                        buf.reverse();
                    }
                    // Each run through kept nodes is folded in on its own, so no
                    // adjacency is invented across a dropped stretch.
                    locus::for_each_fragment(&buf, trim.as_ref(), |frag| {
                        agg.observe_walk(frag.iter().copied())
                    });
                }
                // `WT` counts the haplotypes collapsed into this record (1 when
                // absent). Counting records instead would count traversal
                // fragments, which at repetitive loci run into the tens of
                // thousands — see `walk_weight`.
                total_walks += gfa::walk_weight(line);
                walk_records += 1;
                samples.insert(String::from_utf8_lossy(sample).into_owned());
            }
            _ => {}
        });
        serialize(&mut sink)?;
        sink.finish();
    }
    // Drop what the trim did not keep, before anything looks at the structure.
    if let Some(t) = trim.as_ref() {
        graph.segments.retain(|s| t.keeps(s.id));
        graph.links.retain(|l| t.keeps(l.from) && t.keeps(l.to));
        graph.index.clear();
        for (i, s) in graph.segments.iter().enumerate() {
            graph.index.insert(s.id, i as u32);
        }
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
        let mut walk: Vec<(u32, bool)> = Vec::new();
        let mut breaks: Vec<usize> = Vec::new();
        let mut steps: Vec<Step> = Vec::new();
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
            steps.clear();
            steps.extend(StepIter::new(gfa::walk_field(line)));
            if let Some(t) = trim.as_ref() {
                if !steps.iter().any(|s| t.keeps(s.id)) {
                    return; // not counted in pass 1 either
                }
            }
            // Reroute and map each kept run separately; `breaks` marks where one
            // run ends and the next begins, so no edge is counted across a gap.
            walk.clear();
            breaks.clear();
            locus::for_each_fragment(&steps, trim.as_ref(), |frag| {
                plan.reroute(frag.iter().copied(), &mut rerouted);
                unchop.map_walk(&rerouted, &mut mapped);
                if !walk.is_empty() {
                    breaks.push(walk.len());
                }
                walk.extend_from_slice(&mapped);
            });
            cov.observe_split(&walk, &breaks, gfa::walk_weight(line));
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
        locus: trim.as_ref().map(|t| (query.map(|q| q.interval.clone()).unwrap_or_default(), t.stats.clone())),
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

/// The unsimplified subgraph with the locus trim applied: every haplotype walk
/// kept, but only the nodes the reduced view shows, so "show all nodes" and the
/// raw download describe the same locus as the simplified graph. Walks are
/// split into one `W` record per kept run (as GBZ-base itself does at the
/// subgraph boundary), and the reference walk's coordinates are narrowed to the
/// kept reference range.
pub fn write_raw_locus<S>(serialize: S, query: &LocusQuery, out: &mut impl Write) -> io::Result<()>
where
    S: Fn(&mut dyn Write) -> io::Result<()>,
{
    // Pass 1: structure and the reference walk, to plan the trim.
    let mut graph = Graph::default();
    let mut reference_samples: Vec<String> = Vec::new();
    let mut ref_walk: Option<RefWalk> = None;
    let mut trim: Option<Trim> = None;
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
            b'W' if ref_walk.is_none() => {
                let sample = gfa::walk_sample(line);
                if !reference_samples.iter().any(|rs| rs.as_bytes() == sample) {
                    return;
                }
                if let Some((sample, hap, seq_id, start, end)) = gfa::parse_walk_meta(line) {
                    let steps: Vec<Step> = StepIter::new(gfa::walk_field(line)).collect();
                    let mut w = RefWalk { sample, hap, seq_id, start, end, steps };
                    trim = trim_ref_walk(&graph, &mut w, Some(query));
                    ref_walk = Some(w);
                }
            }
            _ => {}
        });
        serialize(&mut sink)?;
        sink.finish();
    }
    let Some(t) = trim else {
        // Nothing to trim against: pass the subgraph through unchanged.
        return serialize(out);
    };
    let ref_walk = ref_walk.expect("a trim implies a reference walk");

    // Pass 2: filter line by line.
    let mut err: Option<io::Error> = None;
    let mut seen_ref = false;
    let mut steps: Vec<Step> = Vec::new();
    {
        let mut emit = |line: &[u8], out: &mut dyn Write| -> io::Result<()> {
            match gfa::line_type(line) {
                b'S' => match gfa::parse_segment(line) {
                    Some(seg) if !t.keeps(seg.id) => Ok(()),
                    _ => writeln_bytes(out, line),
                },
                b'L' => match gfa::parse_link(line) {
                    Some(l) if !(t.keeps(l.from) && t.keeps(l.to)) => Ok(()),
                    _ => writeln_bytes(out, line),
                },
                b'W' => {
                    let fields: Vec<&[u8]> = line.split(|&b| b == b'\t').collect();
                    if fields.len() < 7 {
                        return writeln_bytes(out, line);
                    }
                    if !seen_ref && fields[1] == ref_walk.sample.as_bytes() {
                        seen_ref = true;
                        write!(out, "W\t{}\t{}\t{}\t{}\t{}\t", ref_walk.sample, ref_walk.hap, ref_walk.seq_id, ref_walk.start, ref_walk.end)?;
                        write_steps(out, &ref_walk.steps)?;
                        write_tags(out, &fields[7..])?;
                        return out.write_all(b"\n");
                    }
                    steps.clear();
                    steps.extend(StepIter::new(fields[6]));
                    let mut res = Ok(());
                    locus::for_each_fragment(&steps, Some(&t), |frag| {
                        if res.is_err() {
                            return;
                        }
                        let len: usize = frag.iter().map(|s| graph.len_of(s.id)).sum();
                        res = (|| {
                            out.write_all(b"W\t")?;
                            out.write_all(fields[1])?;
                            out.write_all(b"\t")?;
                            out.write_all(fields[2])?;
                            out.write_all(b"\t")?;
                            out.write_all(fields[3])?;
                            write!(out, "\t0\t{}\t", len)?;
                            write_steps(out, frag)?;
                            write_tags(out, &fields[7..])?;
                            out.write_all(b"\n")
                        })();
                    });
                    res
                }
                _ => writeln_bytes(out, line),
            }
        };
        let mut sink = LineSink::new(|line: &[u8]| {
            if err.is_none() {
                if let Err(e) = emit(line, out) {
                    err = Some(e);
                }
            }
        });
        serialize(&mut sink)?;
        sink.finish();
    }
    match err {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

fn writeln_bytes(out: &mut dyn Write, line: &[u8]) -> io::Result<()> {
    out.write_all(line)?;
    out.write_all(b"\n")
}

fn write_steps(out: &mut dyn Write, steps: &[Step]) -> io::Result<()> {
    for s in steps {
        write!(out, "{}{}", if s.rev { '<' } else { '>' }, s.id)?;
    }
    Ok(())
}

fn write_tags(out: &mut dyn Write, tags: &[&[u8]]) -> io::Result<()> {
    for t in tags {
        out.write_all(b"\t")?;
        out.write_all(t)?;
    }
    Ok(())
}
