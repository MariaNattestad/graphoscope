//! Reference-guided simplification, structured so no walk is ever retained.
//!
//! The key observation is that nothing which *decides* a collapse needs the
//! walks in memory — only aggregates derived from them:
//!
//!   * pass 1 folds every walk into `Aggregates` (walk-directed adjacency, the
//!     set of walk-confirmed edges, self-loops) — O(nodes + edges);
//!   * `plan_collapse` and `plan_unchop` are then pure graph operations;
//!   * pass 2 replays each walk once, reroutes it, maps it through the unchop
//!     chains, adds its coverage, and drops it.
//!
//! So peak memory is governed by graph topology, not by how many haplotypes
//! traverse it. The algorithm itself is unchanged from the TypeScript original
//! in `src/lib/graph/simplify.ts`:
//!
//! 1. Collapse small reference-anchored superbubbles (SNPs, small indels, MNPs)
//!    onto the reference, rerouting haplotypes that took an alt path. A site
//!    collapses iff its LONGEST entry->exit path is < `max_variant` bp, so a
//!    small deletion skipping a long reference stretch correctly reads as large.
//!    Cycles and inversions fail the DAG check; large SVs fail the size check.
//! 2. Merge maximal co-oriented non-branching chains (`unchop`).
//!
//! Safety invariant: every edge in the output corresponds to an adjacency that
//! existed in the input, and the reference sequence is unchanged.

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet};

use crate::gfa::{Link, NodeId, OutSegment, Segment, SiteRecord, Step};

//-----------------------------------------------------------------------------
// The graph (segments + links), accumulated during pass 1.

#[derive(Default)]
pub struct Graph {
    pub segments: Vec<Segment>,
    pub index: HashMap<NodeId, u32>,
    pub links: Vec<Link>,
}

impl Graph {
    pub fn add_segment(&mut self, seg: Segment) {
        if !self.index.contains_key(&seg.id) {
            self.index.insert(seg.id, self.segments.len() as u32);
            self.segments.push(seg);
        }
    }
    pub fn contains(&self, id: NodeId) -> bool {
        self.index.contains_key(&id)
    }
    pub fn len_of(&self, id: NodeId) -> usize {
        self.index.get(&id).map(|&i| self.segments[i as usize].seq.len()).unwrap_or(0)
    }
}

//-----------------------------------------------------------------------------
// Pass 1: walk-derived aggregates.

#[derive(Default)]
pub struct Aggregates {
    dir_out: HashMap<NodeId, HashSet<NodeId>>,
    dir_in: HashMap<NodeId, HashSet<NodeId>>,
    adj: HashMap<NodeId, HashSet<NodeId>>,
    walk_pairs: HashSet<(NodeId, NodeId)>,
    self_loop: HashSet<NodeId>,
}

fn pair(a: NodeId, b: NodeId) -> (NodeId, NodeId) {
    if a <= b {
        (a, b)
    } else {
        (b, a)
    }
}

impl Aggregates {
    /// Folds one walk in, then forgets it. Only consecutive step pairs matter.
    pub fn observe_walk<I: Iterator<Item = Step>>(&mut self, steps: I) {
        let mut prev: Option<NodeId> = None;
        for s in steps {
            if let Some(a) = prev {
                let b = s.id;
                if a == b {
                    self.self_loop.insert(a);
                } else {
                    self.dir_out.entry(a).or_default().insert(b);
                    self.dir_in.entry(b).or_default().insert(a);
                    self.walk_pairs.insert(pair(a, b));
                }
            }
            prev = Some(s.id);
        }
    }

    /// Undirected link structure; call once the graph's links are all known.
    pub fn observe_links(&mut self, graph: &Graph) {
        for l in &graph.links {
            if !graph.contains(l.from) || !graph.contains(l.to) {
                continue;
            }
            if l.from == l.to {
                self.self_loop.insert(l.from);
                continue;
            }
            self.adj.entry(l.from).or_default().insert(l.to);
            self.adj.entry(l.to).or_default().insert(l.from);
        }
    }

}

// Small helper so the detection code can iterate a possibly-absent neighbour set.
fn neighbours<'a>(
    m: &'a HashMap<NodeId, HashSet<NodeId>>,
    n: NodeId,
) -> impl Iterator<Item = NodeId> + 'a {
    m.get(&n).into_iter().flat_map(|s| s.iter().copied())
}

/// Longest and shortest walk through a set of nodes, in bases — the deepest and
/// shallowest source→sink path over the directed (walk) edges internal to `comp`,
/// each node contributing its own length. `None` if the induced subgraph has a
/// directed cycle (no topological order), for which the caller falls back to the
/// total interior sequence. Used to size the arc for a feature that isn't a clean
/// superbubble (a dangling insertion or a tangle).
fn component_walk_extremes(
    comp: &HashSet<NodeId>,
    dir_out: &HashMap<NodeId, HashSet<NodeId>>,
    graph: &Graph,
) -> Option<(usize, usize)> {
    let mut indeg: HashMap<NodeId, usize> = comp.iter().map(|&n| (n, 0)).collect();
    let mut outdeg: HashMap<NodeId, usize> = comp.iter().map(|&n| (n, 0)).collect();
    for &u in comp {
        for v in neighbours(dir_out, u) {
            if comp.contains(&v) {
                *indeg.get_mut(&v).unwrap() += 1;
                *outdeg.get_mut(&u).unwrap() += 1;
            }
        }
    }
    // Kahn topological order.
    let mut ready: Vec<NodeId> = comp.iter().copied().filter(|n| indeg[n] == 0).collect();
    let mut order: Vec<NodeId> = Vec::with_capacity(comp.len());
    let mut ind = indeg.clone();
    let mut i = 0;
    while i < ready.len() {
        let u = ready[i];
        i += 1;
        order.push(u);
        for v in neighbours(dir_out, u) {
            if comp.contains(&v) {
                let e = ind.get_mut(&v).unwrap();
                *e -= 1;
                if *e == 0 {
                    ready.push(v);
                }
            }
        }
    }
    if order.len() != comp.len() {
        return None; // cycle
    }
    // Longest/shortest path ending at each node. A source (no internal predecessor)
    // starts a path; a non-source's shortest is INF until relaxed from a source.
    let mut dmax: HashMap<NodeId, usize> =
        comp.iter().map(|&n| (n, if indeg[&n] == 0 { graph.len_of(n) } else { 0 })).collect();
    let mut dmin: HashMap<NodeId, usize> = comp
        .iter()
        .map(|&n| (n, if indeg[&n] == 0 { graph.len_of(n) } else { usize::MAX }))
        .collect();
    for &u in &order {
        for v in neighbours(dir_out, u) {
            if comp.contains(&v) {
                let lv = graph.len_of(v);
                if dmax[&u] + lv > dmax[&v] {
                    dmax.insert(v, dmax[&u] + lv);
                }
                if dmin[&u] != usize::MAX && dmin[&u] + lv < dmin[&v] {
                    dmin.insert(v, dmin[&u] + lv);
                }
            }
        }
    }
    // Extremes over sink nodes (no internal successor) — the walk exits there.
    let mut longest = 0usize;
    let mut shortest = usize::MAX;
    for &n in comp {
        if outdeg[&n] == 0 {
            longest = longest.max(dmax[&n]);
            if dmin[&n] != usize::MAX {
                shortest = shortest.min(dmin[&n]);
            }
        }
    }
    if shortest == usize::MAX {
        shortest = longest;
    }
    Some((longest, shortest))
}

//-----------------------------------------------------------------------------
// Collapse planning (pure graph operation — no walks needed).

pub struct CollapsePlan {
    pub removed_nodes: HashSet<NodeId>,
    /// Collapsed reference spans, ascending by start. `span_max_h` is the
    /// running maximum of the ends, so `span_of` can binary-search (see there).
    span_l: Vec<usize>,
    span_max_h: Vec<usize>,
    ref_index: HashMap<NodeId, usize>,
    ref_steps: Vec<Step>,
    pub sites: usize,
    pub nodes_removed: usize,
    pub snp_count: usize,
    pub bases_removed: usize,
    /// One record per non-reference feature the simplifier could *not* collapse,
    /// with the reason it survived. See [`SiteRecord`].
    pub kept_sites: Vec<SiteRecord>,
}

struct Region {
    exit: NodeId,
    interior_non_ref: Vec<NodeId>,
    snp_count: usize,
    bases_removed: usize,
}

pub fn plan_collapse(
    graph: &Graph,
    agg: &Aggregates,
    ref_steps: &[Step],
    max_variant: usize,
) -> CollapsePlan {
    let mut ref_index: HashMap<NodeId, usize> = HashMap::new();
    let mut ref_dup: HashSet<NodeId> = HashSet::new();
    let mut ref_node_at: Vec<NodeId> = Vec::with_capacity(ref_steps.len());
    for (i, s) in ref_steps.iter().enumerate() {
        if ref_index.contains_key(&s.id) {
            ref_dup.insert(s.id);
        } else {
            ref_index.insert(s.id, i);
        }
        ref_node_at.push(s.id);
    }
    let ref_set: HashSet<NodeId> = ref_index.keys().copied().collect();
    let idx_of = |id: NodeId| -> usize { ref_index[&id] };

    // Reference-path bp offset before each step, so a region's [entry-end,
    // exit-start) span can be expressed in the same reference bp the viewer uses.
    let mut ref_off: Vec<usize> = Vec::with_capacity(ref_node_at.len());
    let mut acc = 0usize;
    for &id in &ref_node_at {
        ref_off.push(acc);
        acc += graph.len_of(id);
    }

    // Returns `Some(Region)` for a collapsible superbubble; for a feature that is
    // *kept*, it pushes a `SiteRecord` (with the reason) and returns `None`, so the
    // caller's collapse behaviour is exactly as before recording was added.
    let detect = |s_idx: usize, sites: &mut Vec<SiteRecord>| -> Option<Region> {
        let s = ref_node_at[s_idx];
        if agg.dir_out.get(&s).map(|x| x.len()).unwrap_or(0) < 2 {
            return None; // an entry must branch
        }

        // Bounded forward cone: nodes whose min interior-base prefix from s is
        // < max_variant (a <N interior cannot reach further).
        let mut prefix: HashMap<NodeId, usize> = HashMap::new();
        prefix.insert(s, 0);
        let mut cone: HashSet<NodeId> = HashSet::new();
        cone.insert(s);
        // A real min-heap, not a linear scan: `detect` runs at every reference
        // node, so an O(V^2) frontier here dominates everything on a large
        // locus (a 400 kb region spent ~32 s in this loop). Pop order only
        // differs on ties, which cannot change the resulting distances or cone.
        let mut pq: BinaryHeap<Reverse<(usize, NodeId)>> = BinaryHeap::new();
        pq.push(Reverse((0, s)));
        while let Some(Reverse((d, u))) = pq.pop() {
            if d > *prefix.get(&u).unwrap_or(&usize::MAX) {
                continue;
            }
            if u != s && d >= max_variant {
                continue; // too deep to be interior
            }
            for v in neighbours(&agg.dir_out, u) {
                if ref_set.contains(&v) && idx_of(v) < s_idx {
                    return None; // backward edge -> not a forward bubble
                }
                let nd = d + if u == s { 0 } else { graph.len_of(u) };
                if nd < *prefix.get(&v).unwrap_or(&usize::MAX) {
                    prefix.insert(v, nd);
                    cone.insert(v);
                    if cone.len() > 512 {
                        return None;
                    }
                    pq.push(Reverse((nd, v)));
                }
            }
        }

        let mut exits: Vec<NodeId> =
            cone.iter().copied().filter(|x| ref_set.contains(x) && idx_of(*x) > s_idx).collect();
        exits.sort_by_key(|x| idx_of(*x));

        for t in exits {
            // Backward reach from t within the cone.
            let mut back: HashSet<NodeId> = HashSet::new();
            back.insert(t);
            let mut q: Vec<NodeId> = vec![t];
            while let Some(u) = q.pop() {
                for p in neighbours(&agg.dir_in, u) {
                    if cone.contains(&p) && back.insert(p) {
                        q.push(p);
                    }
                }
            }
            let interior: Vec<NodeId> =
                cone.iter().copied().filter(|x| *x != s && *x != t && back.contains(x)).collect();
            let mut region: HashSet<NodeId> = HashSet::new();
            region.insert(s);
            region.insert(t);
            region.extend(interior.iter().copied());

            // Closed? Anything leaving the region means it hasn't reconnected.
            let mut leak = false;
            for &u in &interior {
                for w in neighbours(&agg.adj, u) {
                    if !region.contains(&w) {
                        leak = true;
                    }
                }
            }
            for w in neighbours(&agg.dir_out, s) {
                if !region.contains(&w) {
                    leak = true;
                }
            }
            for w in neighbours(&agg.dir_in, t) {
                if !region.contains(&w) {
                    leak = true;
                }
            }
            if leak {
                continue;
            }

            let interior_non_ref: Vec<NodeId> =
                interior.iter().copied().filter(|x| !ref_set.contains(x)).collect();
            let has_skip = agg.dir_out.get(&s).map(|o| o.contains(&t)).unwrap_or(false)
                && idx_of(t) > s_idx + 1;
            if interior_non_ref.is_empty() && !has_skip {
                continue; // no variation here
            }

            // A closed region with variation that we cannot fold away is a "kept
            // site". Below, every reason it might resist collapse pushes one
            // record (reference span it covers + why) before returning. The
            // reference span, and the interior sequence used as the height proxy
            // for the non-DAG cases, are the same for all of them.
            let span_start = ref_off[s_idx] + graph.len_of(s);
            let span_end = ref_off[idx_of(t)];
            let ref_span = span_end.saturating_sub(span_start);
            let interior_bp: usize = interior_non_ref.iter().map(|&x| graph.len_of(x)).sum();

            // A tandem self-loop anywhere in the region is a cycle.
            if region.iter().any(|n| agg.self_loop.contains(n)) {
                sites.push(SiteRecord {
                    start: span_start,
                    end: span_end,
                    longest: interior_bp.max(ref_span),
                    shortest: ref_span,
                    reason: "cyclic",
                });
                return None;
            }

            // Single-source (s) / single-sink (t) over walk-directed edges.
            let mut indeg: HashMap<NodeId, usize> = region.iter().map(|&n| (n, 0)).collect();
            for &u in &region {
                for v in neighbours(&agg.dir_out, u) {
                    if region.contains(&v) {
                        *indeg.get_mut(&v).unwrap() += 1;
                    }
                }
            }
            let mut ok = true;
            for &n in &region {
                let out = neighbours(&agg.dir_out, n).filter(|v| region.contains(v)).count();
                let inc = indeg[&n];
                if n == s {
                    if inc != 0 {
                        ok = false;
                    }
                } else if inc == 0 {
                    ok = false;
                }
                if n == t {
                    if out != 0 {
                        ok = false;
                    }
                } else if out == 0 {
                    ok = false;
                }
            }
            if !ok {
                sites.push(SiteRecord {
                    start: span_start,
                    end: span_end,
                    longest: interior_bp.max(ref_span),
                    shortest: ref_span,
                    reason: "tangled",
                });
                return None;
            }

            // Acyclic (Kahn) — catches inversions / tandem repeats.
            let mut ind = indeg.clone();
            let mut ready: Vec<NodeId> =
                region.iter().copied().filter(|n| ind[n] == 0).collect();
            let mut topo: Vec<NodeId> = Vec::with_capacity(region.len());
            let mut ri = 0;
            while ri < ready.len() {
                let u = ready[ri];
                ri += 1;
                topo.push(u);
                for v in neighbours(&agg.dir_out, u) {
                    if region.contains(&v) {
                        let e = ind.get_mut(&v).unwrap();
                        *e -= 1;
                        if *e == 0 {
                            ready.push(v);
                        }
                    }
                }
            }
            if topo.len() != region.len() {
                sites.push(SiteRecord {
                    start: span_start,
                    end: span_end,
                    longest: interior_bp.max(ref_span),
                    shortest: ref_span,
                    reason: "cyclic",
                });
                return None;
            }

            // Every graph edge inside the region must be walk-confirmed.
            for &u in &region {
                for w in neighbours(&agg.adj, u) {
                    if region.contains(&w) && u < w && !agg.walk_pairs.contains(&pair(u, w)) {
                        sites.push(SiteRecord {
                            start: span_start,
                            end: span_end,
                            longest: interior_bp.max(ref_span),
                            shortest: ref_span,
                            reason: "unwitnessed",
                        });
                        return None;
                    }
                }
            }

            // Longest and shortest entry->exit path in bases (deepest / shallowest
            // walk through the bubble). The entry contributes 0 and the exit is not
            // counted, so both are measured in alt bases between the anchors.
            let mut dpx: HashMap<NodeId, i64> = region.iter().map(|&n| (n, i64::MIN)).collect();
            let mut dpn: HashMap<NodeId, i64> = region.iter().map(|&n| (n, i64::MAX)).collect();
            dpx.insert(s, 0);
            dpn.insert(s, 0);
            for &u in &topo {
                let (xu, nu) = (dpx[&u], dpn[&u]);
                for v in neighbours(&agg.dir_out, u) {
                    if region.contains(&v) {
                        let w = if v == t { 0 } else { graph.len_of(v) as i64 };
                        if xu != i64::MIN && xu + w > dpx[&v] {
                            dpx.insert(v, xu + w);
                        }
                        if nu != i64::MAX && nu + w < dpn[&v] {
                            dpn.insert(v, nu + w);
                        }
                    }
                }
            }
            let longest = dpx[&t].max(0) as usize;
            if longest >= max_variant {
                let shortest = if dpn[&t] == i64::MAX { longest } else { dpn[&t].max(0) as usize };
                sites.push(SiteRecord {
                    start: span_start,
                    end: span_end,
                    longest,
                    shortest,
                    reason: "large-variant",
                });
                return None;
            }

            return Some(Region {
                exit: t,
                snp_count: interior_non_ref.iter().filter(|&&x| graph.len_of(x) == 1).count(),
                bases_removed: interior_non_ref.iter().map(|&x| graph.len_of(x)).sum(),
                interior_non_ref,
            });
        }
        None
    };

    let mut removed_nodes: HashSet<NodeId> = HashSet::new();
    let mut collapsed_spans: Vec<(usize, usize)> = Vec::new();
    let mut claimed_interior: HashSet<NodeId> = HashSet::new();
    let mut kept_sites: Vec<SiteRecord> = Vec::new();
    let (mut sites, mut nodes_removed, mut snp_count, mut bases_removed) = (0, 0, 0, 0);

    for i in 0..ref_node_at.len() {
        let s = ref_node_at[i];
        if ref_dup.contains(&s) || claimed_interior.contains(&s) {
            continue;
        }
        // `detect` records kept features via `kept_sites` and returns None for them;
        // only a collapse claims interior nodes, so collapse behaviour is unchanged.
        let Some(r) = detect(i, &mut kept_sites) else { continue };
        removed_nodes.extend(r.interior_non_ref.iter().copied());
        let exit_idx = idx_of(r.exit);
        for k in (i + 1)..exit_idx {
            claimed_interior.insert(ref_node_at[k]);
        }
        collapsed_spans.push((i, exit_idx));
        sites += 1;
        nodes_removed += r.interior_non_ref.len();
        snp_count += r.snp_count;
        bases_removed += r.bases_removed;
    }

    // Because kept features don't claim their interior, a complex bubble can be
    // recorded once from its entry and again from interior reference nodes (nested
    // sub-regions). Keep only maximal spans, so one bubble yields one arc. Processed
    // in (start asc, end desc) order, a container is always seen before what it
    // contains.
    kept_sites.sort_by(|a, b| a.start.cmp(&b.start).then(b.end.cmp(&a.end)));
    let mut maximal: Vec<SiteRecord> = Vec::with_capacity(kept_sites.len());
    for site in kept_sites {
        if maximal.iter().any(|m| m.start <= site.start && site.end <= m.end) {
            continue; // nested inside a span we already kept
        }
        maximal.push(site);
    }
    let mut kept_sites = maximal;

    // --- Component pass -----------------------------------------------------
    // The superbubble detector above only marks clean, closed entry→exit bubbles.
    // Every other surviving non-reference node — a one-sided/dangling insertion, a
    // tangle the cone-cap aborted on — still stands in the graph and still "can't be
    // simplified", so it gets a record too. We group the surviving non-reference
    // nodes into connected components (reference nodes are the anchors between them)
    // and emit one record per component, skipping any a clean-bubble record already
    // covers. The feature's size is the longest/shortest walk through it (or its
    // total interior sequence when it's cyclic).
    {
        let survivor: HashSet<NodeId> = graph
            .segments
            .iter()
            .map(|s| s.id)
            .filter(|id| !ref_set.contains(id) && !removed_nodes.contains(id))
            .collect();
        let mut seen: HashSet<NodeId> = HashSet::new();
        for &origin in &survivor {
            if !seen.insert(origin) {
                continue;
            }
            // BFS the component of survivors; collect the reference nodes it touches.
            let mut comp: Vec<NodeId> = Vec::new();
            let mut attach: Vec<usize> = Vec::new();
            let mut stack = vec![origin];
            while let Some(u) = stack.pop() {
                comp.push(u);
                for v in neighbours(&agg.adj, u) {
                    if let Some(&ri) = ref_index.get(&v) {
                        attach.push(ri);
                    } else if survivor.contains(&v) && seen.insert(v) {
                        stack.push(v);
                    }
                }
            }
            if attach.is_empty() {
                continue; // floats free of the reference — nothing to anchor an arc to
            }
            attach.sort_unstable();
            let left = attach[0];
            let right = *attach.last().unwrap();
            let span_start = ref_off[left] + graph.len_of(ref_node_at[left]);
            let span_end = ref_off[right].max(span_start);
            // Skip if a clean-bubble record already spans this feature.
            if kept_sites.iter().any(|k| k.start <= span_start && span_end <= k.end) {
                continue;
            }
            let comp_set: HashSet<NodeId> = comp.iter().copied().collect();
            let interior_bp: usize = comp.iter().map(|&n| graph.len_of(n)).sum();
            let cyclic = comp.iter().any(|n| agg.self_loop.contains(n));
            let (longest, shortest, reason) = if cyclic {
                (interior_bp, interior_bp, "cyclic")
            } else {
                match component_walk_extremes(&comp_set, &agg.dir_out, graph) {
                    Some((lo, sh)) => (lo, sh, "complex"),
                    None => (interior_bp, interior_bp, "cyclic"),
                }
            };
            kept_sites.push(SiteRecord {
                start: span_start,
                end: span_end,
                longest,
                shortest,
                reason,
            });
        }
    }
    kept_sites.sort_by_key(|s| s.start);

    // Spans come out ascending by start; precompute the prefix max of the ends.
    let span_l: Vec<usize> = collapsed_spans.iter().map(|&(l, _)| l).collect();
    let mut span_max_h: Vec<usize> = Vec::with_capacity(collapsed_spans.len());
    let mut running = 0usize;
    for &(_, h) in &collapsed_spans {
        running = running.max(h);
        span_max_h.push(running);
    }

    CollapsePlan {
        removed_nodes,
        span_l,
        span_max_h,
        ref_index,
        ref_steps: ref_steps.to_vec(),
        sites,
        nodes_removed,
        snp_count,
        bases_removed,
        kept_sites,
    }
}

impl CollapsePlan {
    fn idx_of(&self, id: NodeId) -> usize {
        self.ref_index[&id]
    }
    fn is_ref(&self, id: NodeId) -> bool {
        self.ref_index.contains_key(&id)
    }
    /// Is the reference stretch between two reference nodes inside a collapsed
    /// span (i.e. does some span `[l,h]` satisfy `l <= lo && hi <= h`)?
    ///
    /// The reroute asks this once per step transition, so a linear scan over
    /// the spans makes the whole pass O(steps x spans) — on a 200 kb locus with
    /// thousands of collapsed sites that alone cost ~55 s. Spans are produced in
    /// ascending `l` order, so binary-searching for the last span with `l <= lo`
    /// and consulting a prefix maximum of `h` answers it in O(log n).
    fn span_of(&self, a: NodeId, b: NodeId) -> bool {
        let (x, y) = (self.idx_of(a), self.idx_of(b));
        let (lo, hi) = if x <= y { (x, y) } else { (y, x) };
        // Rightmost span whose start is <= lo.
        let i = match self.span_l.binary_search(&lo) {
            Ok(i) => i,
            Err(0) => return false,
            Err(i) => i - 1,
        };
        self.span_max_h[i] >= hi
    }
    /// Reference interior steps between two reference nodes.
    fn interior_between(&self, from: NodeId, to: NodeId, out: &mut Vec<Step>) {
        let a = self.idx_of(from);
        let b = self.idx_of(to);
        if a < b {
            out.extend_from_slice(&self.ref_steps[(a + 1)..b]);
        } else {
            for s in self.ref_steps[(b + 1)..a].iter().rev() {
                out.push(Step { id: s.id, rev: !s.rev });
            }
        }
    }

    /// Reroutes one walk onto the reference where it crossed a collapsed site.
    /// Writes into `out` (reused across walks so nothing accumulates).
    pub fn reroute<I: Iterator<Item = Step>>(&self, steps: I, out: &mut Vec<Step>) {
        out.clear();
        let steps: Vec<Step> = steps.collect();
        let mut i = 0;
        while i < steps.len() {
            let cur = steps[i];
            if self.removed_nodes.contains(&cur.id) {
                let mut j = i;
                while j < steps.len() && self.removed_nodes.contains(&steps[j].id) {
                    j += 1;
                }
                let from = out.last().map(|s| s.id);
                let to = steps.get(j).map(|s| s.id);
                if let (Some(from), Some(to)) = (from, to) {
                    if self.is_ref(from) && self.is_ref(to) {
                        self.interior_between(from, to, out);
                    }
                }
                i = j;
            } else {
                if let Some(prev) = out.last().map(|s| s.id) {
                    if self.is_ref(prev)
                        && self.is_ref(cur.id)
                        && (self.idx_of(prev) as i64 - self.idx_of(cur.id) as i64).abs() >= 2
                        && self.span_of(prev, cur.id)
                    {
                        self.interior_between(prev, cur.id, out);
                    }
                }
                out.push(cur);
                i += 1;
            }
        }
    }

    /// Drops collapsed nodes and the non-reference edges inside collapsed spans.
    pub fn apply_to_graph(&self, graph: &mut Graph) {
        let removed = &self.removed_nodes;
        graph.links.retain(|l| {
            if removed.contains(&l.from) || removed.contains(&l.to) {
                return false;
            }
            if l.from != l.to
                && self.is_ref(l.from)
                && self.is_ref(l.to)
                && (self.idx_of(l.from) as i64 - self.idx_of(l.to) as i64).abs() >= 2
                && self.span_of(l.from, l.to)
            {
                return false;
            }
            true
        });
        graph.segments.retain(|s| !removed.contains(&s.id));
        graph.index.clear();
        for (i, s) in graph.segments.iter().enumerate() {
            graph.index.insert(s.id, i as u32);
        }
    }
}

//-----------------------------------------------------------------------------
// Unchop planning (pure graph operation).

pub struct UnchopPlan {
    /// Original node id -> index of the output segment that absorbed it.
    pub out_of: HashMap<NodeId, u32>,
    pub segments: Vec<OutSegment>,
    pub links: Vec<(u32, bool, u32, bool)>,
    pub merges: usize,
}

/// A link read as a forward chain step `a+ -> b+`, if it is one.
///
/// GFA stores each node in an orientation the assembler picked arbitrarily, so
/// the same non-branching run appears as `+/+` links or as `-/-` links
/// depending on which strand the nodes happen to be stored on. Both are chain
/// steps; `-/-` is just the reverse-complement reading of the `+/+` edge
/// between the same two nodes, with the endpoints swapped. Everything
/// downstream works in the forward reading, so that is what this returns.
fn canonical_chain_step(l: &Link) -> Option<(NodeId, NodeId)> {
    if l.from == l.to || l.from_rev != l.to_rev {
        return None;
    }
    Some(if l.from_rev { (l.to, l.from) } else { (l.from, l.to) })
}

pub fn plan_unchop(graph: &Graph) -> UnchopPlan {
    let mut l_end: HashMap<NodeId, usize> = HashMap::new();
    let mut r_end: HashMap<NodeId, usize> = HashMap::new();
    let mut fwd_out: HashMap<NodeId, NodeId> = HashMap::new();
    let mut fwd_out_count: HashMap<NodeId, usize> = HashMap::new();
    let mut fwd_in_count: HashMap<NodeId, usize> = HashMap::new();

    for l in &graph.links {
        if !graph.contains(l.from) || !graph.contains(l.to) {
            continue;
        }
        *if l.from_rev { &mut l_end } else { &mut r_end }.entry(l.from).or_insert(0) += 1;
        *if l.to_rev { &mut r_end } else { &mut l_end }.entry(l.to).or_insert(0) += 1;
        // A chain step is any *co-oriented* link. `a- -> b-` is the same
        // bidirected edge as `b+ -> a+` (it leaves a's left end and enters b's
        // right end), so canonicalising it to the forward reading lets one
        // rule cover both. Reading it in canonical order also means chain
        // members come out in forward orientation, so the sequence
        // concatenation below stays correct without reverse-complementing.
        //
        // `+-` and `-+` links are inversions, not chain steps: the two nodes
        // are not traversed in a consistent direction, so they can never be
        // merged and are skipped here.
        if let Some((a, b)) = canonical_chain_step(l) {
            fwd_out.insert(a, b);
            *fwd_out_count.entry(a).or_insert(0) += 1;
            *fwd_in_count.entry(b).or_insert(0) += 1;
        }
    }

    // x merges forward into y iff the only thing on x's right end and y's left
    // end is the single co-oriented x->y link.
    let mut merge_next: HashMap<NodeId, NodeId> = HashMap::new();
    for (&x, &y) in &fwd_out {
        if *fwd_out_count.get(&x).unwrap_or(&0) == 1
            && *r_end.get(&x).unwrap_or(&0) == 1
            && *l_end.get(&y).unwrap_or(&0) == 1
            && *fwd_in_count.get(&y).unwrap_or(&0) == 1
        {
            merge_next.insert(x, y);
        }
    }
    let has_prev: HashSet<NodeId> = merge_next.values().copied().collect();

    let mut out_of: HashMap<NodeId, u32> = HashMap::new();
    let mut segments: Vec<OutSegment> = Vec::new();
    let mut merges = 0;
    let mut consumed: HashSet<NodeId> = HashSet::new();

    for seg in &graph.segments {
        let start = seg.id;
        if consumed.contains(&start) || has_prev.contains(&start) {
            continue;
        }
        let mut members: Vec<NodeId> = vec![start];
        let mut cur = start;
        while let Some(&next) = merge_next.get(&cur) {
            cur = next;
            members.push(cur);
        }
        consumed.extend(members.iter().copied());
        let idx = segments.len() as u32;
        let mut seq: Vec<u8> = Vec::new();
        let mut has_seq = true;
        let mut length = 0;
        for &m in &members {
            let s = &graph.segments[graph.index[&m] as usize];
            length += s.seq.len();
            if s.seq.is_empty() {
                has_seq = false;
            } else {
                seq.extend_from_slice(&s.seq);
            }
            out_of.insert(m, idx);
        }
        if members.len() > 1 {
            merges += members.len() - 1;
        }
        segments.push(OutSegment {
            members,
            seq: if has_seq { seq } else { Vec::new() },
            length,
        });
    }

    // Any segment not reached above (shouldn't happen, but keep it total).
    for seg in &graph.segments {
        if !out_of.contains_key(&seg.id) {
            let idx = segments.len() as u32;
            out_of.insert(seg.id, idx);
            segments.push(OutSegment {
                members: vec![seg.id],
                seq: seg.seq.clone(),
                length: seg.seq.len(),
            });
        }
    }

    // Rewrite links: drop links internal to a chain, remap the rest.
    let mut links: Vec<(u32, bool, u32, bool)> = Vec::new();
    for l in &graph.links {
        if !graph.contains(l.from) || !graph.contains(l.to) {
            continue;
        }
        let (Some(&cf), Some(&ct)) = (out_of.get(&l.from), out_of.get(&l.to)) else {
            continue;
        };
        // An internal chain link is the co-oriented step between consecutive
        // members of the same output segment — in whichever orientation the
        // link happens to be stored, hence the same canonicalisation used to
        // build the chains.
        if cf == ct
            && canonical_chain_step(l).is_some_and(|(a, b)| merge_next.get(&a) == Some(&b))
        {
            continue;
        }
        links.push((cf, l.from_rev, ct, l.to_rev));
    }

    UnchopPlan { out_of, segments, links, merges }
}

impl UnchopPlan {
    /// Maps a rerouted walk onto output segment indices, collapsing consecutive
    /// steps that landed in the same chain.
    pub fn map_walk(&self, steps: &[Step], out: &mut Vec<(u32, bool)>) {
        out.clear();
        for s in steps {
            let Some(&idx) = self.out_of.get(&s.id) else { continue };
            if out.last().map(|&(i, _)| i) == Some(idx) {
                continue;
            }
            out.push((idx, s.rev));
        }
    }
}
