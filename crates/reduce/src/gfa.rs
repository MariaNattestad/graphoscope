//! GFA model, parser, and the reduced-GFA writer.
//!
//! The model mirrors the parsed `Gfa` in the browser's `src/lib/gfa.ts`, so the
//! simplification here and the (still-used, for the playground) TypeScript
//! implementation stay directly comparable. Node identity is the segment id
//! string, orientation-independent; orientation rides on each step/link as
//! `rev` (true = `-`).

use std::collections::HashMap;
use std::io::{self, Write};

#[derive(Clone)]
pub struct Segment {
    pub id: String,
    pub seq: Vec<u8>,
    pub length: usize,
}

#[derive(Clone)]
pub struct Link {
    pub from: String,
    pub from_rev: bool,
    pub to: String,
    pub to_rev: bool,
}

#[derive(Clone)]
pub struct Step {
    pub id: String,
    pub rev: bool,
}

#[derive(Clone)]
pub struct Walk {
    pub sample: String,
    pub hap: usize,
    pub seq_id: String,
    pub start: usize,
    pub end: usize,
    pub steps: Vec<Step>,
    pub is_ref: bool,
}

/// Insertion-ordered segment map, matching the iteration semantics of the JS
/// `Map` the TypeScript implementation uses (segments are emitted in the order
/// they arrived, not sorted).
#[derive(Clone, Default)]
pub struct OrderedSegments {
    order: Vec<String>,
    map: HashMap<String, Segment>,
}

impl OrderedSegments {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn insert(&mut self, seg: Segment) {
        if !self.map.contains_key(&seg.id) {
            self.order.push(seg.id.clone());
        }
        self.map.insert(seg.id.clone(), seg);
    }
    pub fn get(&self, id: &str) -> Option<&Segment> {
        self.map.get(id)
    }
    pub fn contains(&self, id: &str) -> bool {
        self.map.contains_key(id)
    }
    /// Bulk removal in one pass — removing ids one at a time would be O(n) each.
    pub fn remove_all(&mut self, ids: &std::collections::HashSet<String>) {
        self.order.retain(|id| !ids.contains(id));
        for id in ids {
            self.map.remove(id);
        }
    }
    pub fn len(&self) -> usize {
        self.map.len()
    }
    pub fn len_of(&self, id: &str) -> usize {
        self.map.get(id).map(|s| s.length).unwrap_or(0)
    }
    pub fn iter(&self) -> impl Iterator<Item = &Segment> {
        self.order.iter().map(move |id| &self.map[id])
    }
    pub fn keys(&self) -> impl Iterator<Item = &String> {
        self.order.iter()
    }
}

pub struct Gfa {
    pub segments: OrderedSegments,
    pub links: Vec<Link>,
    pub walks: Vec<Walk>,
    pub reference_samples: Vec<String>,
}

/// Parses the GFA that GBZ-base's `Subgraph::write_gfa` emits.
///
/// Only the record types that one produces are handled (`H`, `S`, `L`, `W`);
/// anything else is ignored. The reference walk is the one whose sample matches
/// the header's `RS:Z:` tag — GBZ-base writes it first and gives the rest the
/// sample name `unknown`.
pub fn parse_gfa(text: &str) -> Gfa {
    let mut segments = OrderedSegments::new();
    let mut links: Vec<Link> = Vec::new();
    let mut walks: Vec<Walk> = Vec::new();
    let mut reference_samples: Vec<String> = Vec::new();

    for line in text.lines() {
        if line.is_empty() {
            continue;
        }
        let mut f = line.split('\t');
        match f.next() {
            Some("H") => {
                for tag in f {
                    if let Some(rest) = tag.strip_prefix("RS:Z:") {
                        reference_samples =
                            rest.split(' ').filter(|s| !s.is_empty()).map(String::from).collect();
                    }
                }
            }
            Some("S") => {
                let id = f.next().unwrap_or_default().to_string();
                let seq = f.next().unwrap_or_default().as_bytes().to_vec();
                let length = seq.len();
                segments.insert(Segment { id, seq, length });
            }
            Some("L") => {
                let from = f.next().unwrap_or_default().to_string();
                let from_rev = f.next() == Some("-");
                let to = f.next().unwrap_or_default().to_string();
                let to_rev = f.next() == Some("-");
                links.push(Link { from, from_rev, to, to_rev });
            }
            Some("W") => {
                let sample = f.next().unwrap_or_default().to_string();
                let hap = f.next().unwrap_or_default().parse().unwrap_or(0);
                let seq_id = f.next().unwrap_or_default().to_string();
                let start = f.next().unwrap_or_default().parse().unwrap_or(0);
                let end = f.next().unwrap_or_default().parse().unwrap_or(0);
                let steps = parse_steps(f.next().unwrap_or_default());
                walks.push(Walk { sample, hap, seq_id, start, end, steps, is_ref: false });
            }
            _ => {}
        }
    }

    // Mark the reference walk (first one matching a declared reference sample).
    if let Some(rs) = reference_samples.first() {
        if let Some(w) = walks.iter_mut().find(|w| &w.sample == rs) {
            w.is_ref = true;
        }
    }

    Gfa { segments, links, walks, reference_samples }
}

/// Splits a GFA walk field (`>12<34>56`) into oriented steps.
fn parse_steps(walk: &str) -> Vec<Step> {
    let mut steps = Vec::new();
    let bytes = walk.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let rev = match bytes[i] {
            b'>' => false,
            b'<' => true,
            _ => {
                i += 1;
                continue;
            }
        };
        let start = i + 1;
        let mut j = start;
        while j < bytes.len() && bytes[j] != b'>' && bytes[j] != b'<' {
            j += 1;
        }
        if j > start {
            steps.push(Step { id: walk[start..j].to_string(), rev });
        }
        i = j;
    }
    steps
}

/// Locus-level counts carried on the reduced GFA's `X` line, so the viewer can
/// report walk/collapse totals without ever seeing the dropped walks.
pub struct ReduceStats {
    pub segments_before: usize,
    pub segments_after: usize,
    pub links_before: usize,
    pub links_after: usize,
    pub sites: usize,
    pub nodes_removed: usize,
    pub snp_count: usize,
    pub bases_removed: usize,
    pub unchop_merges: usize,
    pub total_walks: usize,
    pub non_ref_walks: usize,
    pub samples: usize,
    pub total_sequence_bp: usize,
}

/// Writes the reduced GFA: header, an `X` stats line, segments and links each
/// carrying a `WC` walk-coverage tag, and only the reference `W` line.
pub fn write_reduced<W: Write>(
    gfa: &Gfa,
    stats: &ReduceStats,
    node_cov: &HashMap<String, usize>,
    edge_cov: &HashMap<(String, String), usize>,
    ref_idx: Option<usize>,
    output: &mut W,
) -> io::Result<()> {
    if gfa.reference_samples.is_empty() {
        output.write_all(b"H\tVN:Z:1.1\n")?;
    } else {
        writeln!(output, "H\tVN:Z:1.1\tRS:Z:{}", gfa.reference_samples.join(" "))?;
    }

    writeln!(
        output,
        "X\tSB:i:{}\tSA:i:{}\tLB:i:{}\tLA:i:{}\tST:i:{}\tNR:i:{}\tSN:i:{}\tBR:i:{}\tUM:i:{}\tTW:i:{}\tNW:i:{}\tNS:i:{}\tTS:i:{}",
        stats.segments_before,
        stats.segments_after,
        stats.links_before,
        stats.links_after,
        stats.sites,
        stats.nodes_removed,
        stats.snp_count,
        stats.bases_removed,
        stats.unchop_merges,
        stats.total_walks,
        stats.non_ref_walks,
        stats.samples,
        stats.total_sequence_bp,
    )?;

    for seg in gfa.segments.iter() {
        let wc = node_cov.get(&seg.id).copied().unwrap_or(0);
        output.write_all(b"S\t")?;
        output.write_all(seg.id.as_bytes())?;
        output.write_all(b"\t")?;
        output.write_all(&seg.seq)?;
        writeln!(output, "\tWC:i:{}", wc)?;
    }

    for l in &gfa.links {
        let wc = edge_cov.get(&pair_key(&l.from, &l.to)).copied().unwrap_or(0);
        writeln!(
            output,
            "L\t{}\t{}\t{}\t{}\t0M\tWC:i:{}",
            l.from,
            if l.from_rev { '-' } else { '+' },
            l.to,
            if l.to_rev { '-' } else { '+' },
            wc,
        )?;
    }

    if let Some(ri) = ref_idx {
        let w = &gfa.walks[ri];
        output.write_all(b"W\t")?;
        output.write_all(w.sample.as_bytes())?;
        write!(output, "\t{}\t", w.hap)?;
        output.write_all(w.seq_id.as_bytes())?;
        write!(output, "\t{}\t{}\t", w.start, w.end)?;
        let mut walk = Vec::with_capacity(w.steps.len() * 4);
        for s in &w.steps {
            walk.push(if s.rev { b'<' } else { b'>' });
            walk.extend_from_slice(s.id.as_bytes());
        }
        output.write_all(&walk)?;
        output.write_all(b"\n")?;
    }

    Ok(())
}

/// Canonical (order-independent) key for an undirected node pair.
pub fn pair_key(a: &str, b: &str) -> (String, String) {
    if a < b {
        (a.to_string(), b.to_string())
    } else {
        (b.to_string(), a.to_string())
    }
}
