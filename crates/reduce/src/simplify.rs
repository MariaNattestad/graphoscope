//! Reference-guided simplification: the two phases Graphoscope applies to a
//! locus subgraph before it ever reaches the browser.
//!
//! 1. `pop_small_variants` — collapse small reference-anchored superbubbles
//!    (SNPs, small indels, MNPs) back onto the reference, rerouting the
//!    haplotypes that took an alt path. A site collapses iff its LONGEST
//!    entry->exit path is < `max_variant` bp, so a small deletion that skips a
//!    long reference stretch correctly reads as large and survives. Cycles and
//!    inversions fail the DAG check; large SVs fail the size check.
//! 2. `unchop` — merge maximal co-oriented non-branching node chains.
//!
//! Safety invariant both phases preserve: every edge in the output corresponds
//! to an adjacency that existed in the input (no spurious connections), and the
//! reference sequence is unchanged.

use std::collections::{HashMap, HashSet};

use crate::gfa::{pair_key, Gfa, Link, OrderedSegments, Segment, Step};

fn add_edge(m: &mut HashMap<String, HashSet<String>>, a: &str, b: &str) {
    m.entry(a.to_string()).or_default().insert(b.to_string());
}

// Phase 1: pop small superbubbles.

pub struct CollapsedSite {
    pub interior_non_ref: Vec<String>,
    pub snp_count: usize,
    pub bases_removed: usize,
}

struct Region {
    exit: String,
    interior_non_ref: Vec<String>,
    snp_count: usize,
    bases_removed: usize,
}

pub struct PopResult {
    pub sites: Vec<CollapsedSite>,
    pub nodes_removed: usize,
    pub snp_count: usize,
    pub bases_removed: usize,
}

/// Collapse small reference-anchored superbubbles in `gfa` (mutated in place).
/// `max_variant` is the longest-path bp threshold below which a site collapses.
pub fn pop_small_variants(gfa: &mut Gfa, reference_sample: &str, max_variant: usize) -> PopResult {
    let empty = PopResult {
        sites: Vec::new(),
        nodes_removed: 0,
        snp_count: 0,
        bases_removed: 0,
    };

    // Reference walk: the one whose sample matches, else the first walk.
    let ref_idx = gfa
        .walks
        .iter()
        .position(|w| w.sample == reference_sample)
        .or(if gfa.walks.is_empty() { None } else { Some(0) });
    let ref_idx = match ref_idx {
        Some(i) => i,
        None => return empty,
    };

    // Reference chain + coordinates + duplicate guard.
    let ref_steps: Vec<Step> = gfa.walks[ref_idx].steps.clone();
    let mut ref_index: HashMap<String, usize> = HashMap::new();
    let mut ref_dup: HashSet<String> = HashSet::new();
    let mut ref_node_at: Vec<String> = Vec::with_capacity(ref_steps.len());
    for (i, s) in ref_steps.iter().enumerate() {
        if ref_index.contains_key(&s.id) {
            ref_dup.insert(s.id.clone());
        } else {
            ref_index.insert(s.id.clone(), i);
        }
        ref_node_at.push(s.id.clone());
    }
    let ref_set: HashSet<String> = ref_index.keys().cloned().collect();
    let idx_of = |id: &str| -> usize { ref_index[id] };

    // Directed edges from walks, undirected link structure, walk coverage, loops.
    let mut dir_out: HashMap<String, HashSet<String>> = HashMap::new();
    let mut dir_in: HashMap<String, HashSet<String>> = HashMap::new();
    let mut adj: HashMap<String, HashSet<String>> = HashMap::new();
    let mut walk_pairs: HashSet<(String, String)> = HashSet::new();
    let mut self_loop: HashSet<String> = HashSet::new();

    for w in &gfa.walks {
        for i in 0..w.steps.len().saturating_sub(1) {
            let a = &w.steps[i].id;
            let b = &w.steps[i + 1].id;
            if a == b {
                self_loop.insert(a.clone());
                continue;
            }
            add_edge(&mut dir_out, a, b);
            add_edge(&mut dir_in, b, a);
            walk_pairs.insert(pair_key(a, b));
        }
    }
    for l in &gfa.links {
        if !gfa.segments.contains(&l.from) || !gfa.segments.contains(&l.to) {
            continue;
        }
        if l.from == l.to {
            self_loop.insert(l.from.clone());
            continue;
        }
        add_edge(&mut adj, &l.from, &l.to);
        add_edge(&mut adj, &l.to, &l.from);
    }

    let empty_set: HashSet<String> = HashSet::new();
    let len_of = |id: &str| gfa.segments.len_of(id);

    // Find the smallest superbubble whose entry is reference node at `s_idx`.
    let detect = |s_idx: usize| -> Option<Region> {
        let s = ref_node_at[s_idx].clone();
        if dir_out.get(&s).map(|x| x.len()).unwrap_or(0) < 2 {
            return None; // an entry must branch
        }

        // Bounded forward cone: nodes whose min interior-base prefix from s is < max_variant.
        let mut prefix: HashMap<String, usize> = HashMap::new();
        prefix.insert(s.clone(), 0);
        let mut cone: HashSet<String> = HashSet::new();
        cone.insert(s.clone());
        let mut pq: Vec<(usize, String)> = vec![(0, s.clone())];
        while !pq.is_empty() {
            let mut bi = 0;
            for k in 1..pq.len() {
                if pq[k].0 < pq[bi].0 {
                    bi = k;
                }
            }
            let (d, u) = pq.remove(bi);
            if d > *prefix.get(&u).unwrap_or(&usize::MAX) {
                continue;
            }
            if u != s && d >= max_variant {
                continue; // too deep to be interior
            }
            for v in dir_out.get(&u).unwrap_or(&empty_set) {
                if ref_set.contains(v) && idx_of(v) < s_idx {
                    return None; // backward edge -> not a forward bubble
                }
                let nd = d + if u == s { 0 } else { len_of(&u) };
                if nd < *prefix.get(v).unwrap_or(&usize::MAX) {
                    prefix.insert(v.clone(), nd);
                    cone.insert(v.clone());
                    if cone.len() > 512 {
                        return None;
                    }
                    pq.push((nd, v.clone()));
                }
            }
        }

        let mut exits: Vec<String> = cone
            .iter()
            .filter(|x| ref_set.contains(*x) && idx_of(x) > s_idx)
            .cloned()
            .collect();
        exits.sort_by_key(|x| idx_of(x));

        for t in exits {
            // Backward reach from t within the cone.
            let mut back: HashSet<String> = HashSet::new();
            back.insert(t.clone());
            let mut q: Vec<String> = vec![t.clone()];
            while let Some(u) = q.pop() {
                if let Some(preds) = dir_in.get(&u) {
                    for p in preds {
                        if cone.contains(p) && !back.contains(p) {
                            back.insert(p.clone());
                            q.push(p.clone());
                        }
                    }
                }
            }
            let interior: Vec<String> = cone
                .iter()
                .filter(|x| **x != s && **x != t && back.contains(*x))
                .cloned()
                .collect();
            let mut region: HashSet<String> = HashSet::new();
            region.insert(s.clone());
            region.insert(t.clone());
            for x in &interior {
                region.insert(x.clone());
            }

            // Closed? Any interior neighbour, s out-edge, or t in-edge leaving the region.
            let mut leak = false;
            for u in &interior {
                for w in adj.get(u).unwrap_or(&empty_set) {
                    if !region.contains(w) {
                        leak = true;
                    }
                }
            }
            for w in dir_out.get(&s).unwrap_or(&empty_set) {
                if !region.contains(w) {
                    leak = true;
                }
            }
            for w in dir_in.get(&t).unwrap_or(&empty_set) {
                if !region.contains(w) {
                    leak = true;
                }
            }
            if leak {
                continue;
            }

            // A tandem self-loop anywhere in the region is a cycle — never collapse.
            let mut has_self = false;
            for n in &region {
                if self_loop.contains(n) {
                    has_self = true;
                }
            }
            if has_self {
                return None;
            }

            let interior_non_ref: Vec<String> =
                interior.iter().filter(|x| !ref_set.contains(*x)).cloned().collect();
            let has_skip = dir_out.get(&s).map(|o| o.contains(&t)).unwrap_or(false)
                && idx_of(&t) > s_idx + 1;
            if interior_non_ref.is_empty() && !has_skip {
                continue; // no variation here
            }

            // Single-source (s) / single-sink (t) over walk-directed edges.
            let mut indeg: HashMap<String, usize> = HashMap::new();
            for n in &region {
                indeg.insert(n.clone(), 0);
            }
            for u in &region {
                for v in dir_out.get(u).unwrap_or(&empty_set) {
                    if region.contains(v) {
                        *indeg.get_mut(v).unwrap() += 1;
                    }
                }
            }
            let mut ok = true;
            for n in &region {
                let mut out = 0;
                for v in dir_out.get(n).unwrap_or(&empty_set) {
                    if region.contains(v) {
                        out += 1;
                    }
                }
                let inc = indeg[n];
                if *n == s {
                    if inc != 0 {
                        ok = false;
                    }
                } else if inc == 0 {
                    ok = false;
                }
                if *n == t {
                    if out != 0 {
                        ok = false;
                    }
                } else if out == 0 {
                    ok = false;
                }
            }
            if !ok {
                return None;
            }

            // Acyclic (Kahn) — catches inversions / tandem repeats.
            let mut ind = indeg.clone();
            let mut ready: Vec<String> =
                region.iter().filter(|n| ind[*n] == 0).cloned().collect();
            let mut topo: Vec<String> = Vec::new();
            let mut ri = 0;
            while ri < ready.len() {
                let u = ready[ri].clone();
                ri += 1;
                topo.push(u.clone());
                for v in dir_out.get(&u).unwrap_or(&empty_set) {
                    if region.contains(v) {
                        let e = ind.get_mut(v).unwrap();
                        *e -= 1;
                        if *e == 0 {
                            ready.push(v.clone());
                        }
                    }
                }
            }
            if topo.len() != region.len() {
                return None; // cycle
            }

            // Every graph edge inside the region must be covered by a walk.
            for u in &region {
                for w in adj.get(u).unwrap_or(&empty_set) {
                    if region.contains(w) && u.as_str() < w.as_str() && !walk_pairs.contains(&pair_key(u, w))
                    {
                        return None;
                    }
                }
            }

            // Longest entry->exit path in bases (interior node lengths).
            let mut dp: HashMap<String, i64> = HashMap::new();
            for n in &region {
                dp.insert(n.clone(), i64::MIN);
            }
            dp.insert(s.clone(), 0);
            for u in &topo {
                let du = dp[u];
                if du == i64::MIN {
                    continue;
                }
                for v in dir_out.get(u).unwrap_or(&empty_set) {
                    if region.contains(v) {
                        let cand = du + if *v == t { 0 } else { len_of(v) as i64 };
                        if cand > dp[v] {
                            dp.insert(v.clone(), cand);
                        }
                    }
                }
            }
            let longest = dp[&t];
            if longest >= max_variant as i64 {
                return None; // too big — keep
            }

            return Some(Region {
                exit: t.clone(),
                snp_count: interior_non_ref.iter().filter(|x| len_of(x) == 1).count(),
                bases_removed: interior_non_ref.iter().map(|x| len_of(x)).sum(),
                interior_non_ref,
            });
        }
        None
    };

    let mut removed_nodes: HashSet<String> = HashSet::new();
    let mut collapsed_spans: Vec<(usize, usize)> = Vec::new();
    let mut claimed_interior: HashSet<String> = HashSet::new();
    let mut sites: Vec<CollapsedSite> = Vec::new();

    for i in 0..ref_node_at.len() {
        let s = ref_node_at[i].clone();
        if ref_dup.contains(&s) || claimed_interior.contains(&s) {
            continue;
        }
        let r = match detect(i) {
            Some(r) => r,
            None => continue,
        };
        for n in &r.interior_non_ref {
            removed_nodes.insert(n.clone());
        }
        let exit_idx = idx_of(&r.exit);
        for k in (i + 1)..exit_idx {
            claimed_interior.insert(ref_node_at[k].clone());
        }
        collapsed_spans.push((i, exit_idx));
        sites.push(CollapsedSite {
            interior_non_ref: r.interior_non_ref,
            snp_count: r.snp_count,
            bases_removed: r.bases_removed,
        });
    }

    // Reference interior steps between two reference nodes.
    let interior_between = |from_id: &str, to_id: &str| -> Vec<Step> {
        let a = idx_of(from_id);
        let b = idx_of(to_id);
        if a < b {
            ref_steps[(a + 1)..b].to_vec()
        } else {
            ref_steps[(b + 1)..a]
                .iter()
                .rev()
                .map(|s| Step { id: s.id.clone(), rev: !s.rev })
                .collect()
        }
    };
    let span_of = |a: &str, b: &str| -> i64 {
        let lo = idx_of(a).min(idx_of(b));
        let hi = idx_of(a).max(idx_of(b));
        collapsed_spans
            .iter()
            .position(|(l, h)| *l <= lo && hi <= *h)
            .map(|p| p as i64)
            .unwrap_or(-1)
    };

    // Reroute walks that took a collapsed path back onto the reference.
    for wi in 0..gfa.walks.len() {
        if wi == ref_idx {
            continue;
        }
        let steps = gfa.walks[wi].steps.clone();
        let mut out: Vec<Step> = Vec::new();
        let mut i = 0;
        while i < steps.len() {
            let cur = &steps[i];
            if removed_nodes.contains(&cur.id) {
                let mut j = i;
                while j < steps.len() && removed_nodes.contains(&steps[j].id) {
                    j += 1;
                }
                let from = out.last().map(|s| s.id.clone());
                let to = steps.get(j).map(|s| s.id.clone());
                if let (Some(from), Some(to)) = (from, to) {
                    if ref_set.contains(&from) && ref_set.contains(&to) {
                        for s in interior_between(&from, &to) {
                            out.push(s);
                        }
                    }
                }
                i = j;
            } else {
                let prev = out.last().map(|s| s.id.clone());
                if let Some(prev) = prev {
                    if ref_set.contains(&prev)
                        && ref_set.contains(&cur.id)
                        && (idx_of(&prev) as i64 - idx_of(&cur.id) as i64).abs() >= 2
                        && span_of(&prev, &cur.id) >= 0
                    {
                        for s in interior_between(&prev, &cur.id) {
                            out.push(s);
                        }
                    }
                }
                out.push(cur.clone());
                i += 1;
            }
        }
        gfa.walks[wi].steps = out;
    }

    // Rebuild: drop removed nodes and non-reference edges inside collapsed spans.
    gfa.segments.remove_all(&removed_nodes);
    let collapsed_spans_ref = &collapsed_spans;
    gfa.links.retain(|l| {
        if removed_nodes.contains(&l.from) || removed_nodes.contains(&l.to) {
            return false;
        }
        if l.from != l.to
            && ref_set.contains(&l.from)
            && ref_set.contains(&l.to)
            && (idx_of(&l.from) as i64 - idx_of(&l.to) as i64).abs() >= 2
        {
            let lo = idx_of(&l.from).min(idx_of(&l.to));
            let hi = idx_of(&l.from).max(idx_of(&l.to));
            let in_span = collapsed_spans_ref.iter().any(|(l2, h2)| *l2 <= lo && hi <= *h2);
            if in_span {
                return false;
            }
        }
        true
    });

    let nodes_removed = sites.iter().map(|s| s.interior_non_ref.len()).sum();
    let snp_count = sites.iter().map(|s| s.snp_count).sum();
    let bases_removed = sites.iter().map(|s| s.bases_removed).sum();
    PopResult {
        sites,
        nodes_removed,
        snp_count,
        bases_removed,
    }
}

//-----------------------------------------------------------------------------
// Phase 2: unchop (merge co-oriented non-branching chains).

/// Merge maximal co-oriented non-branching chains in `gfa` (mutated in place).
/// Returns the number of merges performed.
pub fn unchop(gfa: &mut Gfa) -> usize {
    // End-usage counts + co-oriented forward links.
    let mut l_end: HashMap<String, usize> = HashMap::new();
    let mut r_end: HashMap<String, usize> = HashMap::new();
    let mut fwd_out: HashMap<String, String> = HashMap::new();
    let mut fwd_out_count: HashMap<String, usize> = HashMap::new();
    let mut fwd_in_count: HashMap<String, usize> = HashMap::new();
    let bump = |m: &mut HashMap<String, usize>, id: &str| {
        *m.entry(id.to_string()).or_insert(0) += 1;
    };
    for l in &gfa.links {
        if !gfa.segments.contains(&l.from) || !gfa.segments.contains(&l.to) {
            continue;
        }
        if !l.from_rev {
            bump(&mut r_end, &l.from);
        } else {
            bump(&mut l_end, &l.from);
        }
        if !l.to_rev {
            bump(&mut l_end, &l.to);
        } else {
            bump(&mut r_end, &l.to);
        }
        if l.from != l.to && !l.from_rev && !l.to_rev {
            fwd_out.insert(l.from.clone(), l.to.clone());
            bump(&mut fwd_out_count, &l.from);
            bump(&mut fwd_in_count, &l.to);
        }
    }

    // x merges forward into y iff the only thing on x's right end and y's left end
    // is the single co-oriented x->y link.
    let mut merge_next: HashMap<String, String> = HashMap::new();
    for (x, y) in &fwd_out {
        if *fwd_out_count.get(x).unwrap_or(&0) == 1
            && *r_end.get(x).unwrap_or(&0) == 1
            && *l_end.get(y).unwrap_or(&0) == 1
            && *fwd_in_count.get(y).unwrap_or(&0) == 1
        {
            merge_next.insert(x.clone(), y.clone());
        }
    }
    let has_prev: HashSet<String> = merge_next.values().cloned().collect();

    // Build chains starting from nodes that aren't a merge target.
    struct ChainRef {
        id: String,
        index: usize,
    }
    let mut chain_of: HashMap<String, ChainRef> = HashMap::new();
    let mut merges = 0;
    let mut new_segments = OrderedSegments::new();
    let mut consumed: HashSet<String> = HashSet::new();

    let start_ids: Vec<String> = gfa.segments.keys().cloned().collect();
    for start_id in &start_ids {
        if consumed.contains(start_id) || has_prev.contains(start_id) {
            continue;
        }
        let mut members: Vec<String> = vec![start_id.clone()];
        let mut cur = start_id.clone();
        while let Some(next) = merge_next.get(&cur) {
            cur = next.clone();
            members.push(cur.clone());
        }
        for m in &members {
            consumed.insert(m.clone());
        }
        if members.len() == 1 {
            let seg = gfa.segments.get(start_id).unwrap().clone();
            new_segments.insert(seg);
            continue;
        }
        merges += members.len() - 1;
        let chain_id = format!("u{}", members[0]);
        let mut seq_parts: Vec<u8> = Vec::new();
        let mut length = 0;
        let mut has_seq = true;
        for m in &members {
            let seg = gfa.segments.get(m).unwrap();
            length += seg.length;
            if !seg.seq.is_empty() {
                seq_parts.extend_from_slice(&seg.seq);
            } else {
                has_seq = false;
            }
        }
        new_segments.insert(Segment {
            id: chain_id.clone(),
            seq: if has_seq { seq_parts } else { Vec::new() },
            length,
        });
        for (index, m) in members.iter().enumerate() {
            chain_of.insert(m.clone(), ChainRef { id: chain_id.clone(), index });
        }
    }

    // Rewrite links: drop internal chain links; remap external endpoints.
    let mut links: Vec<Link> = Vec::new();
    for l in &gfa.links {
        if !gfa.segments.contains(&l.from) || !gfa.segments.contains(&l.to) {
            continue;
        }
        let cf = chain_of.get(&l.from);
        let ct = chain_of.get(&l.to);
        if let (Some(cf), Some(ct)) = (cf, ct) {
            if cf.id == ct.id && ct.index == cf.index + 1 {
                continue; // internal forward chain link
            }
        }
        links.push(Link {
            from: cf.map(|c| c.id.clone()).unwrap_or_else(|| l.from.clone()),
            from_rev: l.from_rev,
            to: ct.map(|c| c.id.clone()).unwrap_or_else(|| l.to.clone()),
            to_rev: l.to_rev,
        });
    }

    // Materialize non-chain segments untouched.
    for id in &start_ids {
        if !chain_of.contains_key(id) && !new_segments.contains(id) {
            new_segments.insert(gfa.segments.get(id).unwrap().clone());
        }
    }

    // Rewrite walks: collapse consecutive same-chain runs into one step.
    for w in &mut gfa.walks {
        let mut out: Vec<Step> = Vec::new();
        let mut i = 0;
        while i < w.steps.len() {
            match chain_of.get(&w.steps[i].id) {
                None => {
                    out.push(w.steps[i].clone());
                    i += 1;
                }
                Some(c) => {
                    let orient = w.steps[i].rev;
                    let mut j = i + 1;
                    while j < w.steps.len()
                        && chain_of.get(&w.steps[j].id).map(|c2| &c2.id) == Some(&c.id)
                    {
                        j += 1;
                    }
                    out.push(Step { id: c.id.clone(), rev: orient });
                    i = j;
                }
            }
        }
        w.steps = out;
    }

    gfa.segments = new_segments;
    gfa.links = links;
    merges
}

//-----------------------------------------------------------------------------
// Walk aggregation + stats.
