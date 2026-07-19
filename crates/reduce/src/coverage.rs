//! Walk aggregation: instead of shipping every haplotype's step list to the
//! browser, count how many distinct walks cross each node and edge, and let the
//! walks themselves be dropped.
//!
//! This is the memory win. On a large or repetitive locus the haplotype walks
//! are ~97% of the GFA bytes (measured on a real 49.8 MB LPA query), and once
//! parsed into per-step JS objects they dominate the browser's heap. The counts
//! here carry everything the viewer's coverage heatmaps actually need.
//!
//! Counting is per *distinct walk*, once per node — matching `pathCoverage` in
//! `src/lib/graph/forceLayout.ts`, so a walk revisiting a node still counts
//! once. The reference walk is excluded (it is the backbone, not coverage).
//!
//! Walks are folded in one at a time and discarded, so this holds O(nodes +
//! edges), never O(total steps).

use std::collections::{HashMap, HashSet};

use crate::gfa::edge_key;

pub struct Coverage {
    /// Distinct non-reference walks through each output segment, by index.
    pub node: Vec<u32>,
    /// Distinct non-reference walks across each undirected output edge.
    pub edge: HashMap<(u32, u32), u32>,
    pub non_ref_walks: usize,
    // Scratch reused across walks so counting allocates nothing per walk.
    seen_nodes: HashSet<u32>,
    seen_edges: HashSet<(u32, u32)>,
}

impl Coverage {
    pub fn new(segment_count: usize) -> Self {
        Coverage {
            node: vec![0; segment_count],
            edge: HashMap::new(),
            non_ref_walks: 0,
            seen_nodes: HashSet::new(),
            seen_edges: HashSet::new(),
        }
    }

    /// Folds one non-reference walk (already rerouted and chain-mapped) in.
    pub fn observe(&mut self, steps: &[(u32, bool)]) {
        self.non_ref_walks += 1;

        self.seen_nodes.clear();
        for &(idx, _) in steps {
            if self.seen_nodes.insert(idx) {
                if let Some(c) = self.node.get_mut(idx as usize) {
                    *c += 1;
                }
            }
        }

        self.seen_edges.clear();
        for w in steps.windows(2) {
            let (a, b) = (w[0].0, w[1].0);
            if a == b {
                continue;
            }
            let k = edge_key(a, b);
            if self.seen_edges.insert(k) {
                *self.edge.entry(k).or_insert(0) += 1;
            }
        }
    }
}
