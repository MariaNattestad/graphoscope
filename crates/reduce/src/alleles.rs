//! Stage 2 of Sites: per-site allele clustering.
//!
//! Stage 1 (`simplify::plan_collapse`) pops small, closed, reference-anchored
//! bubbles. What it can't touch — large variants, sites with a haplotype that
//! leaves the window or ends inside them, small variation nested inside a large
//! allele — is handled here, in terms of haplotypes rather than nodes:
//!
//! 1. **Sites.** Every non-reference connected component attaches to the
//!    reference at some set of nodes; its site is the reference span between
//!    the first and last of them. Deletion links span the reference the same
//!    way. Spans that overlap merge. Each site is closed by construction: only
//!    its two boundary reference nodes connect it to the rest of the graph. A
//!    component hanging off one reference node (a haplotype entering from
//!    outside the window) is a site with a single boundary node.
//! 2. **Alleles.** A haplotype's allele at a site is the exact path it takes
//!    between where it enters and where it leaves. It enters and leaves either
//!    through a boundary node or through a *terminal* — the side of the node
//!    where its walk starts or stops inside the site, because it leaves the
//!    window there or because its path in the pangenome ends.
//! 3. **Clustering.** Alleles only cluster with alleles that enter and leave
//!    through the same places, so no terminal is ever lost. Within such a
//!    group the reference allele is the first representative; the rest, most
//!    carried first, join the first representative that differs from them by
//!    no single variant of `threshold` bp or more, and otherwise become
//!    representatives themselves.
//! 4. **Rebuild.** The site keeps only its representatives' nodes and the links
//!    between consecutive steps of them, and every walk's allele is replaced by
//!    its representative.
//!
//! Hence: the reference is unchanged, every link kept is one a haplotype uses,
//! every haplotype is still a connected path through the same terminals, and a
//! haplotype is only ever moved by variants smaller than `threshold`.

use std::collections::{HashMap, HashSet};

use crate::gfa::{NodeId, Step};
use crate::simplify::Graph;

/// Where an allele enters or leaves its site.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum End {
    /// Through a boundary reference node.
    Bound(NodeId),
    /// A walk starts or stops inside the site: the node, and whether it is the
    /// node's end side (as opposed to its start side) that the walk doesn't
    /// continue through.
    Terminal(NodeId, bool),
}

/// One allele: an exact path through a site, in canonical orientation.
#[derive(Clone, PartialEq, Eq, Hash)]
struct Allele {
    from: End,
    to: End,
    steps: Vec<Step>,
}

#[derive(Default)]
struct Tally {
    weight: usize,
    is_ref: bool,
}

struct Site {
    entry: NodeId,
    exit: NodeId,
    interior: Vec<NodeId>,
    tally: HashMap<Allele, Tally>,
    /// Every allele seen -> its representative.
    rep_of: HashMap<Allele, usize>,
    reps: Vec<Allele>,
}

impl Site {
    fn is_bound(&self, id: NodeId) -> bool {
        id == self.entry || id == self.exit
    }
}

pub struct AllelePlan {
    sites: Vec<Site>,
    /// Interior node -> its site.
    site_of: HashMap<NodeId, u32>,
    /// (entry, exit) and (exit, entry) -> site, for a walk that crosses a site
    /// straight from one boundary to the other.
    bound_pair: HashMap<(NodeId, NodeId), u32>,
    ref_index: HashMap<NodeId, usize>,
    pub allele_sites: usize,
    pub alleles: usize,
    pub alleles_shown: usize,
    pub nodes_removed: usize,
}

/// A walk, cut into the steps it keeps and its alleles at the sites it crosses.
enum Piece {
    Keep(usize),
    /// Steps `[i, j)` are the allele's interior; `i == j` for a walk that
    /// steps straight from one boundary to the other.
    Allele { site: u32, i: usize, j: usize, from: End, to: End },
}

fn find(parent: &mut Vec<usize>, x: usize) -> usize {
    let mut r = x;
    while parent[r] != r {
        r = parent[r];
    }
    let mut x = x;
    while parent[x] != r {
        let next = parent[x];
        parent[x] = r;
        x = next;
    }
    r
}

/// Decomposes the graph into sites along the reference.
pub fn plan_sites(graph: &Graph, ref_steps: &[Step]) -> AllelePlan {
    let mut ref_index: HashMap<NodeId, usize> = HashMap::new();
    let mut ref_dup: HashSet<NodeId> = HashSet::new();
    for (i, s) in ref_steps.iter().enumerate() {
        if ref_index.insert(s.id, i).is_some() {
            ref_dup.insert(s.id);
        }
    }
    // Keep the first occurrence, as everywhere else.
    for (i, s) in ref_steps.iter().enumerate().rev() {
        ref_index.insert(s.id, i);
    }

    // Non-reference components.
    let n = graph.segments.len();
    let mut parent: Vec<usize> = (0..n).collect();
    let is_ref = |id: NodeId| ref_index.contains_key(&id);
    for l in &graph.links {
        let (Some(&a), Some(&b)) = (graph.index.get(&l.from), graph.index.get(&l.to)) else { continue };
        if !is_ref(l.from) && !is_ref(l.to) {
            let (ra, rb) = (find(&mut parent, a as usize), find(&mut parent, b as usize));
            if ra != rb {
                parent[ra] = rb;
            }
        }
    }
    // Component root -> (lowest, highest) reference index it attaches to.
    let mut attach: HashMap<usize, (usize, usize)> = HashMap::new();
    let mut spans: Vec<(usize, usize)> = Vec::new();
    let mut unsafe_idx: HashSet<usize> = ref_dup.iter().map(|id| ref_index[id]).collect();
    for l in &graph.links {
        let (Some(&a), Some(&b)) = (graph.index.get(&l.from), graph.index.get(&l.to)) else { continue };
        match (ref_index.get(&l.from), ref_index.get(&l.to)) {
            (Some(&x), Some(&y)) => {
                let (lo, hi) = if x <= y { (x, y) } else { (y, x) };
                if hi >= lo + 2 {
                    spans.push((lo, hi));
                } else if hi == lo && l.from_rev != l.to_rev {
                    // A reference node linked to itself inverted: leave its
                    // neighbourhood alone.
                    unsafe_idx.insert(lo);
                }
            }
            (Some(&x), None) | (None, Some(&x)) => {
                let other = if ref_index.contains_key(&l.from) { b } else { a };
                let root = find(&mut parent, other as usize);
                let e = attach.entry(root).or_insert((x, x));
                e.0 = e.0.min(x);
                e.1 = e.1.max(x);
            }
            (None, None) => {}
        }
    }
    spans.extend(attach.values().copied());
    spans.sort();

    // Merge spans whose interiors overlap. Spans that only share a boundary
    // node stay separate sites.
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for (lo, hi) in spans {
        match merged.last_mut() {
            Some(last) if lo < last.1 => last.1 = last.1.max(hi),
            _ => merged.push((lo, hi)),
        }
    }

    // Component root -> its site, by the span the component's attachment lies in.
    let mut site_of_root: HashMap<usize, u32> = HashMap::new();
    let mut sites: Vec<Site> = Vec::new();
    let mut site_of: HashMap<NodeId, u32> = HashMap::new();
    let mut bound_pair: HashMap<(NodeId, NodeId), u32> = HashMap::new();
    let mut span_site: Vec<Option<u32>> = Vec::with_capacity(merged.len());
    for &(lo, hi) in &merged {
        if (lo..=hi).any(|i| unsafe_idx.contains(&i)) {
            span_site.push(None);
            continue;
        }
        let k = sites.len() as u32;
        let interior: Vec<NodeId> = ref_steps[lo + 1..hi.max(lo + 1)].iter().map(|s| s.id).collect();
        for &id in &interior {
            site_of.insert(id, k);
        }
        let (entry, exit) = (ref_steps[lo].id, ref_steps[hi].id);
        if entry != exit {
            bound_pair.insert((entry, exit), k);
            bound_pair.insert((exit, entry), k);
        }
        sites.push(Site {
            entry,
            exit,
            interior,
            tally: HashMap::new(),
            rep_of: HashMap::new(),
            reps: Vec::new(),
        });
        span_site.push(Some(k));
    }
    let span_for = |lo: usize, hi: usize| -> Option<u32> {
        // The merged span containing [lo, hi]: the last one starting at or before lo.
        let i = merged.partition_point(|&(l, _)| l <= lo).checked_sub(1)?;
        let (l, h) = merged[i];
        (l <= lo && hi <= h).then_some(())?;
        span_site[i]
    };
    for (&root, &(lo, hi)) in &attach {
        if let Some(k) = span_for(lo, hi) {
            site_of_root.insert(root, k);
        }
    }
    for seg in &graph.segments {
        if is_ref(seg.id) {
            continue;
        }
        let root = find(&mut parent, graph.index[&seg.id] as usize);
        if let Some(&k) = site_of_root.get(&root) {
            site_of.insert(seg.id, k);
            sites[k as usize].interior.push(seg.id);
        }
    }

    AllelePlan {
        sites,
        site_of,
        bound_pair,
        ref_index,
        allele_sites: 0,
        alleles: 0,
        alleles_shown: 0,
        nodes_removed: 0,
    }
}

impl AllelePlan {
    fn rank(&self, e: &End) -> (u8, u64, bool) {
        match *e {
            End::Bound(id) => (0, self.ref_index[&id] as u64, false),
            End::Terminal(id, side) => (1, id, side),
        }
    }

    fn scan(&self, steps: &[Step], mut f: impl FnMut(Piece)) {
        let n = steps.len();
        let mut i = 0;
        while i < n {
            if let Some(&k) = self.site_of.get(&steps[i].id) {
                let mut j = i;
                while j < n && self.site_of.get(&steps[j].id) == Some(&k) {
                    j += 1;
                }
                let site = &self.sites[k as usize];
                // A walk's first step inside a site enters through its start
                // side when read forward; its last step leaves through its end.
                let from = match i.checked_sub(1).map(|p| steps[p].id) {
                    Some(b) if site.is_bound(b) => End::Bound(b),
                    _ => End::Terminal(steps[i].id, steps[i].rev),
                };
                let to = match steps.get(j).map(|s| s.id) {
                    Some(b) if site.is_bound(b) => End::Bound(b),
                    _ => End::Terminal(steps[j - 1].id, !steps[j - 1].rev),
                };
                f(Piece::Allele { site: k, i, j, from, to });
                i = j;
            } else {
                f(Piece::Keep(i));
                if let Some(next) = steps.get(i + 1) {
                    if let Some(&k) = self.bound_pair.get(&(steps[i].id, next.id)) {
                        f(Piece::Allele {
                            site: k,
                            i: i + 1,
                            j: i + 1,
                            from: End::Bound(steps[i].id),
                            to: End::Bound(next.id),
                        });
                    }
                }
                i += 1;
            }
        }
    }

    /// The allele in canonical orientation, and whether the walk read it reversed.
    fn canonical(&self, from: End, to: End, steps: &[Step]) -> (Allele, bool) {
        if self.rank(&to) < self.rank(&from) {
            let steps = steps.iter().rev().map(|s| Step { id: s.id, rev: !s.rev }).collect();
            (Allele { from: to, to: from, steps }, true)
        } else {
            (Allele { from, to, steps: steps.to_vec() }, false)
        }
    }

    /// Counts one walk's alleles. `steps` is the walk after stage 1.
    pub fn observe(&mut self, steps: &[Step], weight: usize, is_ref: bool) {
        let mut found: Vec<(u32, Allele)> = Vec::new();
        self.scan(steps, |p| {
            if let Piece::Allele { site, i, j, from, to } = p {
                found.push((site, self.canonical(from, to, &steps[i..j]).0));
            }
        });
        for (k, a) in found {
            let t = self.sites[k as usize].tally.entry(a).or_default();
            t.weight += weight;
            t.is_ref |= is_ref;
        }
    }

    /// Picks each site's representatives.
    pub fn cluster(&mut self, graph: &Graph, threshold: usize) {
        let len = |id: NodeId| graph.len_of(id);
        for site in &mut self.sites {
            let mut alleles: Vec<(&Allele, &Tally)> = site.tally.iter().collect();
            // Reference first, then most carried; ties broken by path so the
            // result never depends on the order walks arrived in.
            alleles.sort_by(|a, b| {
                b.1.is_ref
                    .cmp(&a.1.is_ref)
                    .then(b.1.weight.cmp(&a.1.weight))
                    .then_with(|| a.0.steps.cmp(&b.0.steps))
            });
            self.alleles += alleles.len();
            if alleles.len() > 1 {
                self.allele_sites += 1;
            }
            // A representative is kept for its large variants. The small ones it
            // happens to carry are snapped to the representatives before it —
            // the reference first — wherever that keeps it within the threshold
            // of the allele it stands for, so they show up once, not once per
            // representative. Snapping happens before anything is compared
            // against it, so no member ever ends up further from it than the
            // threshold either.
            let mut reps: Vec<Allele> = Vec::new();
            let mut indexed: Vec<Indexed> = Vec::new();
            let mut rep_of: HashMap<Allele, usize> = HashMap::new();
            for (a, t) in alleles {
                // A reference allele is never moved, nor snapped.
                let ia = (!t.is_ref).then(|| Indexed::new(&a.steps, len));
                let joins = ia.as_ref().and_then(|ia| {
                    reps.iter().zip(&indexed).position(|(r, ir)| {
                        r.from == a.from && r.to == a.to && ia.within(ir, threshold)
                    })
                });
                let k = joins.unwrap_or_else(|| {
                    let mut rep = a.clone();
                    let mut ri = ia.clone().unwrap_or_else(|| Indexed::new(&a.steps, len));
                    if let Some(ia) = &ia {
                        for (r, fi) in reps.iter().zip(&indexed) {
                            let Some(steps) = snap(&rep, &ri, r, fi, threshold) else { continue };
                            let si = Indexed::new(&steps, len);
                            if ia.within(&si, threshold) {
                                rep.steps = steps;
                                ri = si;
                            }
                        }
                    }
                    indexed.push(ri);
                    reps.push(rep);
                    reps.len() - 1
                });
                rep_of.insert(a.clone(), k);
            }
            self.alleles_shown += reps.len();
            site.reps = reps;
            site.rep_of = rep_of;
            site.tally = HashMap::new();
        }
    }

    /// Keeps only the representatives' nodes, and only the links between
    /// consecutive steps of a representative, inside each site.
    pub fn apply_to_graph(&mut self, graph: &mut Graph) {
        let mut kept_nodes: HashSet<NodeId> = HashSet::new();
        let mut kept_links: HashSet<(NodeId, NodeId)> = HashSet::new();
        let mut walked: HashSet<u32> = HashSet::new();
        for (k, site) in self.sites.iter().enumerate() {
            if site.reps.is_empty() {
                continue; // no walk crossed it: leave it as it is
            }
            walked.insert(k as u32);
            for r in &site.reps {
                let mut ids: Vec<NodeId> = Vec::with_capacity(r.steps.len() + 2);
                if let End::Bound(b) = r.from {
                    ids.push(b);
                }
                ids.extend(r.steps.iter().map(|s| s.id));
                if let End::Bound(b) = r.to {
                    ids.push(b);
                }
                kept_nodes.extend(r.steps.iter().map(|s| s.id));
                for w in ids.windows(2) {
                    kept_links.insert(pair(w[0], w[1]));
                }
            }
        }
        let in_walked_site = |id: NodeId| self.site_of.get(&id).is_some_and(|k| walked.contains(k));
        let before = graph.segments.len();
        graph.segments.retain(|s| !in_walked_site(s.id) || kept_nodes.contains(&s.id));
        self.nodes_removed = before - graph.segments.len();
        graph.links.retain(|l| {
            let inside = in_walked_site(l.from)
                || in_walked_site(l.to)
                || self.bound_pair.get(&(l.from, l.to)).is_some_and(|k| walked.contains(k));
            !inside || kept_links.contains(&pair(l.from, l.to))
        });
        graph.index.clear();
        for (i, s) in graph.segments.iter().enumerate() {
            graph.index.insert(s.id, i as u32);
        }
    }

    /// Replaces each of a walk's alleles with its representative.
    pub fn reroute(&self, steps: &[Step], out: &mut Vec<Step>) {
        out.clear();
        self.scan(steps, |p| match p {
            Piece::Keep(i) => out.push(steps[i]),
            Piece::Allele { site, i, j, from, to } => {
                let s = &self.sites[site as usize];
                let (a, flipped) = self.canonical(from, to, &steps[i..j]);
                match s.rep_of.get(&a).map(|&k| &s.reps[k]) {
                    Some(r) if flipped => out.extend(r.steps.iter().rev().map(|s| Step { id: s.id, rev: !s.rev })),
                    Some(r) => out.extend_from_slice(&r.steps),
                    None => out.extend_from_slice(&steps[i..j]),
                }
            }
        });
    }
}

fn pair(a: NodeId, b: NodeId) -> (NodeId, NodeId) {
    if a <= b {
        (a, b)
    } else {
        (b, a)
    }
}

/// The largest single variant between two paths through the same site.
///
/// The paths are aligned on the steps they share (each occurring once in both,
/// in the same order — the longest such chain); between consecutive shared
/// steps each path takes its own detour, and that variant's size is the larger
/// of the two detours in bp. A deletion against an insertion reads as the
/// insertion's size; two long alleles that differ only by scattered SNPs read
/// as 1 bp, not as the sum of the SNPs.
#[cfg(test)]
pub fn largest_variant(a: &[Step], b: &[Step], len: impl Fn(NodeId) -> usize) -> usize {
    let (pa, pb) = (prefix_bp(a, &len), prefix_bp(b, &len));
    let mut worst = 0;
    let mut prev = (0usize, 0usize); // first index after the previous anchor
    for &(i, j) in shared_steps(a, b).iter().chain(std::iter::once(&(a.len(), b.len()))) {
        worst = worst.max((pa[i] - pa[prev.0]).max(pb[j] - pb[prev.1]));
        prev = (i + 1, j + 1);
    }
    worst
}

/// `rep` with every variant against `reference` (another representative)
/// smaller than `threshold` replaced by the reference's path. Only variants between two shared steps
/// are touched — or between a shared step and a boundary both enter or leave
/// through — so the terminals a representative ends at stay where they are.
/// `None` when there is nothing to snap.
fn snap(rep: &Allele, ri: &Indexed, reference: &Allele, fi: &Indexed, threshold: usize) -> Option<Vec<Step>> {
    let (a, b) = (&rep.steps, &reference.steps);
    let (pa, pb) = (&ri.prefix, &fi.prefix);
    let mut out: Vec<Step> = Vec::with_capacity(a.len());
    let mut prev = (0usize, 0usize);
    let mut first = true;
    let mut changed = false;
    for &(i, j) in ri.anchors(fi).iter().chain(std::iter::once(&(a.len(), b.len()))) {
        let last = i == a.len();
        // The stretch before the first shared step is bounded by the walk's
        // entry, and the one after the last by its exit: only snap those when
        // both alleles share that entry or exit.
        let bounded = (!first || rep.from == reference.from) && (!last || rep.to == reference.to);
        let small = (pa[i] - pa[prev.0]).max(pb[j] - pb[prev.1]) < threshold;
        if bounded && small && a[prev.0..i] != b[prev.1..j] {
            out.extend_from_slice(&b[prev.1..j]);
            changed = true;
        } else {
            out.extend_from_slice(&a[prev.0..i]);
        }
        if !last {
            out.push(a[i]);
        }
        prev = (i + 1, j + 1);
        first = false;
    }
    changed.then_some(out)
}

fn prefix_bp(p: &[Step], len: &impl Fn(NodeId) -> usize) -> Vec<usize> {
    let mut v = Vec::with_capacity(p.len() + 1);
    v.push(0);
    for s in p {
        v.push(v.last().unwrap() + len(s.id));
    }
    v
}

/// The longest chain of steps two paths share — each occurring once in both,
/// in the same order — as (index in a, index in b).
#[cfg(test)]
fn shared_steps(a: &[Step], b: &[Step]) -> Vec<(usize, usize)> {
    let mut count: HashMap<Step, (u32, u32, usize)> = HashMap::new();
    for s in a {
        count.entry(*s).or_default().0 += 1;
    }
    for (j, s) in b.iter().enumerate() {
        let e = count.entry(*s).or_default();
        e.1 += 1;
        e.2 = j;
    }
    // Shared steps in a's order, with their position in b.
    let shared: Vec<(usize, usize)> = a
        .iter()
        .enumerate()
        .filter_map(|(i, s)| {
            let &(ca, cb, j) = &count[s];
            (ca == 1 && cb == 1).then_some((i, j))
        })
        .collect();
    longest_increasing(&shared)
}

/// A path indexed once so it can be compared against many others: where each
/// step occurs (when it occurs once) and the bp before each step.
#[derive(Clone)]
struct Indexed {
    steps: Vec<Step>,
    unique: HashMap<Step, usize, FastHash>,
    prefix: Vec<usize>,
}

impl Indexed {
    fn new(steps: &[Step], len: impl Fn(NodeId) -> usize) -> Self {
        let mut unique: HashMap<Step, usize, FastHash> = HashMap::with_capacity_and_hasher(steps.len(), FastHash);
        let mut repeated: HashSet<Step, FastHash> = HashSet::with_hasher(FastHash);
        for (i, s) in steps.iter().enumerate() {
            if unique.insert(*s, i).is_some() {
                repeated.insert(*s);
            }
        }
        for s in &repeated {
            unique.remove(s);
        }
        Indexed { steps: steps.to_vec(), unique, prefix: prefix_bp(steps, &len) }
    }

    /// `shared_steps(self, other)`, from the indexes.
    fn anchors(&self, other: &Indexed) -> Vec<(usize, usize)> {
        let shared: Vec<(usize, usize)> = self
            .steps
            .iter()
            .enumerate()
            .filter_map(|(i, s)| {
                let j = *other.unique.get(s)?;
                self.unique.contains_key(s).then_some((i, j))
            })
            .collect();
        longest_increasing(&shared)
    }

    /// `largest_variant(self, other) < threshold`, stopping at the first
    /// variant that isn't.
    fn within(&self, other: &Indexed, threshold: usize) -> bool {
        let (pa, pb) = (&self.prefix, &other.prefix);
        let mut prev = (0usize, 0usize);
        for &(i, j) in self.anchors(other).iter().chain(std::iter::once(&(self.steps.len(), other.steps.len()))) {
            if (pa[i] - pa[prev.0]).max(pb[j] - pb[prev.1]) >= threshold {
                return false;
            }
            prev = (i + 1, j + 1);
        }
        true
    }
}

/// Steps are small integers that need no protection against crafted
/// collisions, and comparing alleles is all hash lookups: std's SipHash
/// dominates the time on a site with hundreds of long alleles.
#[derive(Clone, Copy, Default)]
struct FastHash;

#[derive(Default)]
struct FastHasher(u64);

impl std::hash::BuildHasher for FastHash {
    type Hasher = FastHasher;
    fn build_hasher(&self) -> FastHasher {
        FastHasher(0)
    }
}

impl std::hash::Hasher for FastHasher {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.write_u64(b as u64);
        }
    }
    fn write_u64(&mut self, n: u64) {
        self.0 = (self.0.rotate_left(5) ^ n).wrapping_mul(0x51_7c_c1_b7_27_22_0a_95);
    }
    fn write_u8(&mut self, n: u8) {
        self.write_u64(n as u64);
    }
}

/// The longest subsequence of `pairs` (already increasing in .0) that is also
/// increasing in .1.
fn longest_increasing(pairs: &[(usize, usize)]) -> Vec<(usize, usize)> {
    let mut tails: Vec<usize> = Vec::new(); // index into pairs of the best tail per length
    let mut back: Vec<Option<usize>> = vec![None; pairs.len()];
    for (k, &(_, j)) in pairs.iter().enumerate() {
        let pos = tails.partition_point(|&t| pairs[t].1 < j);
        back[k] = pos.checked_sub(1).map(|p| tails[p]);
        if pos == tails.len() {
            tails.push(k);
        } else {
            tails[pos] = k;
        }
    }
    let mut out = Vec::with_capacity(tails.len());
    let mut cur = tails.last().copied();
    while let Some(k) = cur {
        out.push(pairs[k]);
        cur = back[k];
    }
    out.reverse();
    out
}
