//! Walk aggregation: instead of shipping every haplotype's step list to the
//! browser, count how many distinct walks cross each node and edge, and let the
//! walks themselves be dropped.
//!
//! This is the memory win. On a large or repetitive locus the haplotype walks
//! are ~97% of the GFA bytes (measured on a real 49.8 MB LPA query), and once
//! parsed into per-step objects they dominate the browser's heap. The counts
//! below carry everything the viewer's coverage heatmaps actually need.
//!
//! Counting is per *distinct walk*, once per node — matching `pathCoverage` in
//! `src/lib/graph/forceLayout.ts`, so a walk that revisits a node still counts
//! once. The reference walk is excluded (it is the backbone, not coverage).

use std::collections::{HashMap, HashSet};

use crate::gfa::{pair_key, Gfa};

pub struct Coverage {
    /// Distinct non-reference walks through each node.
    pub node: HashMap<String, usize>,
    /// Distinct non-reference walks across each undirected edge.
    pub edge: HashMap<(String, String), usize>,
    pub non_ref_walks: usize,
}

pub fn compute_coverage(gfa: &Gfa, ref_idx: Option<usize>) -> Coverage {
    let mut node: HashMap<String, usize> = HashMap::new();
    let mut edge: HashMap<(String, String), usize> = HashMap::new();
    let mut non_ref_walks = 0;

    for (wi, w) in gfa.walks.iter().enumerate() {
        if Some(wi) == ref_idx {
            continue;
        }
        non_ref_walks += 1;

        let mut seen: HashSet<&str> = HashSet::new();
        for s in &w.steps {
            if seen.insert(s.id.as_str()) {
                *node.entry(s.id.clone()).or_insert(0) += 1;
            }
        }

        let mut seen_edge: HashSet<(String, String)> = HashSet::new();
        for i in 0..w.steps.len().saturating_sub(1) {
            let a = &w.steps[i].id;
            let b = &w.steps[i + 1].id;
            if a == b {
                continue;
            }
            let k = pair_key(a, b);
            if seen_edge.insert(k.clone()) {
                *edge.entry(k).or_insert(0) += 1;
            }
        }
    }

    Coverage { node, edge, non_ref_walks }
}
