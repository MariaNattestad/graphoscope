//! Locus trim: decide which of the nodes GBZ-base fetched belong on screen.
//!
//! GBZ-base's `--context` grows the subgraph by a bp radius in *every*
//! direction, reference included, so the reference axis comes back padded by
//! `context` bp on each side and every alt allele anchored in that padding comes
//! with it. What a locus query should show is narrower:
//!
//! 1. The reference is the locus itself — the reference-walk nodes overlapping
//!    the query interval, kept whole (sequences are never trimmed).
//! 2. Context only extends into alt alleles: non-reference nodes reachable from
//!    an in-locus reference node without stepping onto an out-of-locus
//!    reference node.
//! 3. Exception: when such an alt allele, or a deletion edge leaving an in-locus
//!    reference node, rejoins the reference *outside* the locus, the reference
//!    axis is extended just far enough to include the farthest rejoin point. A
//!    tangle of "alt" nodes that is really the reference beyond a deletion's far
//!    endpoint then reads as reference again. Alts anchored only on that
//!    extension are not pulled in.
//!
//! The reference walk GBZ-base emits is the contiguous fragment of the reference
//! path through the fetched nodes, so a rejoin that lands on it is resolved by
//! construction (every reference node between the locus and the rejoin was
//! fetched). A rejoin beyond the fetched reference — typically a deletion edge's
//! far endpoint, which is 1 bp away in GBZ-base's distance and so fetched even
//! at a small context while the reference leading to it is not — is not on the
//! walk: its node reads as non-reference, the search walks on through it, and
//! sooner or later reaches a node with edges GBZ-base did not fetch. Those
//! edges are the *exits* reported here, so an unresolved extension always shows
//! up as exits > 0, which is what the app escalates on.

use std::collections::{HashMap, HashSet, VecDeque};
use std::ops::Range;

use crate::gfa::{NodeId, RefWalk, Step};
use crate::simplify::Graph;

/// What the caller knows about the locus query beyond the GFA itself.
#[derive(Default, Clone)]
pub struct LocusQuery {
    /// The half-open query interval on the reference path.
    pub interval: Range<usize>,
    /// Fetched nodes with edges (in the full graph) to nodes GBZ-base did not
    /// fetch, and how many such edges each has. Empty when unknown (e.g. when
    /// reducing a GFA file), in which case no exits are reported.
    pub frontier: HashMap<NodeId, usize>,
}

/// Counts describing the trim, carried on the reduced GFA's `X` line.
#[derive(Default, Clone, Debug, PartialEq, Eq)]
pub struct LocusStats {
    /// Nodes GBZ-base fetched (before the trim).
    pub fetched_nodes: usize,
    /// Fetched nodes the trim dropped.
    pub dropped_nodes: usize,
    /// Reference nodes overlapping the query interval.
    pub locus_ref_nodes: usize,
    /// Non-reference nodes kept (reachable from the locus).
    pub kept_alt_nodes: usize,
    /// Reference bp added on each side by rejoin extension.
    pub ext_left_bp: usize,
    pub ext_right_bp: usize,
    /// Distinct edges from the kept component onto out-of-locus reference.
    pub rejoins: usize,
    /// Edges from kept alt / in-locus reference nodes to nodes that were not
    /// fetched, and the number of kept nodes carrying at least one.
    pub exit_edges: usize,
    pub exit_nodes: usize,
}

pub struct Trim {
    pub keep: HashSet<NodeId>,
    /// The kept reference walk: steps and new path coordinates.
    pub ref_steps: Vec<Step>,
    pub ref_start: usize,
    pub ref_end: usize,
    pub stats: LocusStats,
}

impl Trim {
    pub fn keeps(&self, id: NodeId) -> bool {
        self.keep.contains(&id)
    }
}

/// Plans the trim. Needs every segment and link already in `graph` (GBZ-base
/// writes S and L lines before any W line). Returns `None` when the reference
/// walk does not overlap the interval, in which case nothing is trimmed.
pub fn plan_trim(graph: &Graph, ref_walk: &RefWalk, q: &LocusQuery) -> Option<Trim> {
    let steps = &ref_walk.steps;
    if steps.is_empty() {
        return None;
    }
    let qs = q.interval.start;
    let qe = q.interval.end.max(qs + 1);

    // Path offset of each reference step.
    let mut pos = Vec::with_capacity(steps.len() + 1);
    let mut p = ref_walk.start;
    for s in steps {
        pos.push(p);
        p += graph.len_of(s.id);
    }
    pos.push(p);

    let overlaps = |i: usize| pos[i] < qe && pos[i + 1] > qs;
    let a = (0..steps.len()).find(|&i| overlaps(i))?;
    let b = (0..steps.len()).rev().find(|&i| overlaps(i))?;

    let mut ref_index: HashMap<NodeId, Vec<usize>> = HashMap::new();
    for (i, s) in steps.iter().enumerate() {
        ref_index.entry(s.id).or_default().push(i);
    }
    let in_locus = |id: NodeId| ref_index.get(&id).is_some_and(|v| v.iter().any(|&i| a <= i && i <= b));

    let mut adj: HashMap<NodeId, Vec<NodeId>> = HashMap::new();
    for l in &graph.links {
        if l.from == l.to || !graph.contains(l.from) || !graph.contains(l.to) {
            continue;
        }
        adj.entry(l.from).or_default().push(l.to);
        adj.entry(l.to).or_default().push(l.from);
    }

    // Search outward from the locus reference, through non-reference nodes only.
    let mut keep: HashSet<NodeId> = HashSet::new();
    let mut queue: VecDeque<NodeId> = VecDeque::new();
    for s in &steps[a..=b] {
        if keep.insert(s.id) {
            queue.push_back(s.id);
        }
    }
    let locus_ref_nodes = keep.len();
    let (mut lo, mut hi) = (a, b);
    let mut rejoins: HashSet<(NodeId, NodeId)> = HashSet::new();
    while let Some(u) = queue.pop_front() {
        let Some(ns) = adj.get(&u) else { continue };
        for &v in ns {
            if keep.contains(&v) {
                continue;
            }
            match ref_index.get(&v) {
                None => {
                    keep.insert(v);
                    queue.push_back(v);
                }
                Some(vi) => {
                    // `v` is reference outside the locus. The backbone edge from
                    // the locus's own end node is just the reference continuing;
                    // anything else rejoins outside and extends the axis.
                    let backbone = ref_index
                        .get(&u)
                        .is_some_and(|ui| ui.iter().any(|&i| vi.iter().any(|&j| i.abs_diff(j) == 1)));
                    if backbone {
                        continue;
                    }
                    rejoins.insert(if u <= v { (u, v) } else { (v, u) });
                    // The occurrence nearest the locus is the minimal extension.
                    let j = *vi
                        .iter()
                        .min_by_key(|&&j| if j < a { a - j } else { j.saturating_sub(b) })
                        .unwrap();
                    if j < a {
                        lo = lo.min(j);
                    } else {
                        hi = hi.max(j);
                    }
                }
            }
        }
    }
    let kept_alt_nodes = keep.len() - locus_ref_nodes;

    // Exits: only from what the locus itself reaches (alts and in-locus
    // reference), not from the extension, whose own alts are not shown.
    let (mut exit_edges, mut exit_nodes) = (0, 0);
    for &id in &keep {
        if let Some(&n) = q.frontier.get(&id) {
            if n > 0 && (!ref_index.contains_key(&id) || in_locus(id)) {
                exit_edges += n;
                exit_nodes += 1;
            }
        }
    }

    for s in &steps[lo..=hi] {
        keep.insert(s.id);
    }
    // Restrict to nodes that exist (the walk only names fetched nodes, but be safe).
    keep.retain(|id| graph.contains(*id));

    let stats = LocusStats {
        fetched_nodes: graph.segments.len(),
        dropped_nodes: graph.segments.len() - keep.len(),
        locus_ref_nodes,
        kept_alt_nodes,
        ext_left_bp: pos[a] - pos[lo],
        ext_right_bp: pos[hi + 1] - pos[b + 1],
        rejoins: rejoins.len(),
        exit_edges,
        exit_nodes,
    };
    Some(Trim {
        keep,
        ref_steps: steps[lo..=hi].to_vec(),
        ref_start: pos[lo],
        ref_end: pos[hi + 1],
        stats,
    })
}

/// Calls `f` on each maximal run of kept steps. With no trim, the whole walk
/// is one run.
pub fn for_each_fragment(steps: &[Step], trim: Option<&Trim>, mut f: impl FnMut(&[Step])) {
    let Some(t) = trim else {
        f(steps);
        return;
    };
    let mut i = 0;
    while i < steps.len() {
        if !t.keeps(steps[i].id) {
            i += 1;
            continue;
        }
        let mut j = i;
        while j < steps.len() && t.keeps(steps[j].id) {
            j += 1;
        }
        f(&steps[i..j]);
        i = j;
    }
}
