//! Safety invariants for the reduce pipeline, checked against the same real
//! HPRC fixtures the TypeScript implementation is tested on
//! (`src/lib/graph/fixtures/`).
//!
//! These assert properties rather than hardcoded per-fixture numbers, so they
//! stay meaningful as the algorithm is tuned. The properties are the ones that
//! would make a simplified graph *wrong* rather than merely different:
//!
//!   * no edge appears in the output that wasn't an adjacency in the input —
//!     simplification must never invent a connection that no haplotype supports;
//!   * the reference path's sequence is unchanged, base for base;
//!   * the graph never grows;
//!   * coverage counts never exceed the number of walks that could produce them.

use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;

use crate::reduce::reduce;

const FIXTURE_DIR: &str = "../../src/lib/graph/fixtures";

/// The constructed graphs /playground demonstrates, each isolating one thing the
/// algorithm has to get right. Expectations are the same ones the TypeScript
/// suite asserts, so the two implementations are pinned to identical behaviour.
const SYNTHETIC: [Expected; 11] = [
    // A 1 bp substitution: collapses, and the whole graph unchops to one node.
    Expected::new("snp", 1, 1, 1, 1).after(1).removed(&["20"]),
    // A 4 bp insertion: small enough to collapse.
    Expected::new("small_ins", 1, 1, 0, 4).after(1).removed(&["20"]),
    // A large insertion must survive — this is the case a naive "shortest
    // allele" rule gets wrong.
    Expected::new("large_ins", 0, 0, 0, 0),
    // A large deletion must survive too. Its alt allele is a near-zero skip
    // edge, so sizing a site by any single allele would wrongly collapse it;
    // the longest-path bound is what keeps it.
    Expected::new("large_del", 0, 0, 0, 0),
    // A small deletion is a pure skip edge with no alt node, so nothing is
    // removed even though a site is collapsed.
    Expected::new("small_del", 1, 0, 0, 0).after(1),
    // Two alternative alleles at one site collapse together.
    Expected::new("multiallelic", 1, 2, 2, 2).after(1).removed(&["20", "21"]),
    // A small variant next to a large one: only the small half collapses.
    Expected::new("mixed", 1, 1, 1, 1).removed(&["20"]),
    // Adjacent substitutions (an MNP) collapse as a single site.
    Expected::new("mnp", 1, 2, 2, 2).after(1).removed(&["20", "21"]),
    // Nested complexity is left alone rather than guessed at.
    Expected::new("nested", 0, 0, 0, 0),
    // A cycle must never be collapsed — the DAG check catches it.
    Expected::new("cyclic", 0, 0, 0, 0),
    // No variation at all: nothing to pop, but unchop merges the run.
    Expected::new("long_run", 0, 0, 0, 0).after(1),
];

const REAL: [&str; 3] = ["c4a", "smn1", "chr20_200kb"];

/// Every fixture, for the invariant checks.
fn all_fixtures() -> Vec<&'static str> {
    SYNTHETIC.iter().map(|e| e.id).chain(REAL).collect()
}

/// What the pop pass should do to one constructed graph.
struct Expected {
    id: &'static str,
    sites: u64,
    nodes_removed: u64,
    snp_count: u64,
    bases_removed: u64,
    /// Segment count after the full reduce (pop + unchop), where pinned.
    segments_after: Option<u64>,
    /// Segment ids that must be gone.
    removed_nodes: &'static [&'static str],
}

impl Expected {
    const fn new(
        id: &'static str,
        sites: u64,
        nodes_removed: u64,
        snp_count: u64,
        bases_removed: u64,
    ) -> Self {
        Expected {
            id,
            sites,
            nodes_removed,
            snp_count,
            bases_removed,
            segments_after: None,
            removed_nodes: &[],
        }
    }
    const fn after(mut self, n: u64) -> Self {
        self.segments_after = Some(n);
        self
    }
    const fn removed(mut self, ids: &'static [&'static str]) -> Self {
        self.removed_nodes = ids;
        self
    }
}

fn fixture(name: &str) -> String {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.push(FIXTURE_DIR);
    p.push(format!("{}.gfa", name));
    fs::read_to_string(&p).unwrap_or_else(|e| panic!("reading {}: {}", p.display(), e))
}

fn run_reduce(text: &str, max_variant: usize) -> String {
    let mut out: Vec<u8> = Vec::new();
    reduce(|w: &mut dyn std::io::Write| w.write_all(text.as_bytes()), max_variant, &mut out)
        .expect("reduce failed");
    String::from_utf8(out).expect("output is utf-8")
}

/// Rewrites a GFA so every node is stored in the opposite orientation: each
/// segment's sequence is reverse-complemented and every reference to it flips
/// its orientation flag. The graph this produces is the *same* bidirected
/// graph — same nodes, same adjacencies, same haplotypes — written the other
/// way round, which is a choice the assembler makes arbitrarily per node.
/// Simplification must therefore be blind to it.
fn flip_orientation(gfa: &str) -> String {
    fn revcomp(s: &str) -> String {
        s.chars()
            .rev()
            .map(|c| match c {
                'A' => 'T',
                'C' => 'G',
                'G' => 'C',
                'T' => 'A',
                'a' => 't',
                'c' => 'g',
                'g' => 'c',
                't' => 'a',
                other => other,
            })
            .collect()
    }
    let flip = |o: &str| if o == "+" { "-" } else { "+" };

    gfa.lines()
        .map(|line| {
            let f: Vec<&str> = line.split('\t').collect();
            match f.first() {
                // S <id> <seq> [tags]: store the other strand.
                Some(&"S") if f.len() >= 3 => {
                    let mut o = vec![f[0].to_string(), f[1].to_string(), revcomp(f[2])];
                    o.extend(f[3..].iter().map(|s| s.to_string()));
                    o.join("\t")
                }
                // L <a> <oa> <b> <ob> ...: the adjacency is unchanged, but both
                // endpoints are now named in the opposite orientation.
                Some(&"L") if f.len() >= 5 => {
                    let mut o = vec![
                        f[0].to_string(),
                        f[1].to_string(),
                        flip(f[2]).to_string(),
                        f[3].to_string(),
                        flip(f[4]).to_string(),
                    ];
                    o.extend(f[5..].iter().map(|s| s.to_string()));
                    o.join("\t")
                }
                // W ... <walk>: same steps in the same order, each flipped.
                Some(&"W") if f.len() >= 7 => {
                    let walk: String = f[6]
                        .chars()
                        .map(|c| match c {
                            '>' => '<',
                            '<' => '>',
                            other => other,
                        })
                        .collect();
                    let mut o: Vec<String> = f[..6].iter().map(|s| s.to_string()).collect();
                    o.push(walk);
                    o.extend(f[7..].iter().map(|s| s.to_string()));
                    o.join("\t")
                }
                _ => line.to_string(),
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
        + "\n"
}

/// Undirected adjacencies (by node id, orientation-independent) in a GFA's L lines.
fn edges(gfa: &str) -> HashSet<(String, String)> {
    let mut out = HashSet::new();
    for line in gfa.lines() {
        let f: Vec<&str> = line.split('\t').collect();
        if f.first() != Some(&"L") || f.len() < 5 {
            continue;
        }
        let (a, b) = (f[1].to_string(), f[3].to_string());
        out.insert(if a <= b { (a, b) } else { (b, a) });
    }
    out
}

/// Every node id an unchopped chain absorbed, so output edges can be compared
/// against input adjacencies: a chain `u7` stands for its member nodes.
fn chain_members(gfa: &str) -> Vec<(String, Vec<String>)> {
    // The reduced output does not list a chain's members, but a chain's own id
    // is `u<first member>` and its sequence is the concatenation — for the
    // purposes of edge checking we only need to map `u<n>` back to `<n>`.
    gfa.lines()
        .filter(|l| l.starts_with("S\t"))
        .filter_map(|l| l.split('\t').nth(1))
        .filter(|id| id.starts_with('u'))
        .map(|id| (id.to_string(), vec![id[1..].to_string()]))
        .collect()
}

fn segments(gfa: &str) -> Vec<(String, String)> {
    gfa.lines()
        .filter(|l| l.starts_with("S\t"))
        .filter_map(|l| {
            let mut f = l.split('\t');
            f.next();
            Some((f.next()?.to_string(), f.next()?.to_string()))
        })
        .collect()
}

fn ref_walk_sequence(gfa: &str) -> String {
    let seqs: std::collections::HashMap<String, String> = segments(gfa).into_iter().collect();
    let walk = gfa
        .lines()
        .find(|l| l.starts_with("W\t"))
        .and_then(|l| l.split('\t').nth(6).map(String::from))
        .unwrap_or_default();
    let mut out = String::new();
    let mut chars = walk.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '>' && c != '<' {
            continue;
        }
        let mut id = String::new();
        while let Some(&n) = chars.peek() {
            if n == '>' || n == '<' {
                break;
            }
            id.push(n);
            chars.next();
        }
        // Only forward steps are concatenated directly; the reference path is
        // canonical (forward) in these fixtures, which the assertion relies on.
        assert_eq!(c, '>', "reference walk step {} is reversed", id);
        out.push_str(seqs.get(&id).map(String::as_str).unwrap_or(""));
    }
    out
}

fn int_tag(line: &str, tag: &str) -> Option<u64> {
    line.split('\t')
        .find_map(|f| f.strip_prefix(&format!("{}:i:", tag)))
        .and_then(|v| v.parse().ok())
}

#[test]
fn output_edges_existed_in_the_input() {
    for name in all_fixtures() {
        let input = fixture(name);
        let out = run_reduce(&input, 50);
        let input_edges = edges(&input);
        let chains: std::collections::HashMap<String, String> =
            chain_members(&out).into_iter().map(|(id, m)| (id, m[0].clone())).collect();

        for (a, b) in edges(&out) {
            // A chain's endpoints are its members; the id names the first one,
            // so an edge touching a chain may legitimately not match by name.
            // Skip those rather than assert on information the output omits.
            if chains.contains_key(&a) || chains.contains_key(&b) {
                continue;
            }
            assert!(
                input_edges.contains(&(a.clone(), b.clone())),
                "{}: output edge {}-{} was not an input adjacency",
                name,
                a,
                b
            );
        }
    }
}

#[test]
fn reference_sequence_is_unchanged() {
    for name in all_fixtures() {
        let input = fixture(name);
        let out = run_reduce(&input, 50);
        assert_eq!(
            ref_walk_sequence(&input),
            ref_walk_sequence(&out),
            "{}: reference sequence changed",
            name
        );
    }
}

#[test]
fn the_graph_never_grows() {
    for name in all_fixtures() {
        let input = fixture(name);
        let out = run_reduce(&input, 50);
        let x = out.lines().find(|l| l.starts_with("X\t")).expect("stats line");
        let before = int_tag(x, "SB").unwrap();
        let after = int_tag(x, "SA").unwrap();
        assert!(after <= before, "{}: {} segments became {}", name, before, after);
        assert_eq!(after as usize, segments(&out).len(), "{}: SA disagrees with S lines", name);
    }
}

/// A `W` record carrying `WT:i:k` stands for k haplotypes that took the same
/// route — GBZ-base emits that form when asked for distinct haplotypes. Counting
/// records instead of summing weights would undercount haplotypes, and the
/// counts on the `X` line are shown to the user as "haplotypes", so weighting
/// one deduplicated record by k must give exactly what k separate records give.
#[test]
fn a_weighted_walk_counts_as_many_haplotypes_as_it_stands_for() {
    // Two haplotypes taking the same route through a bubble, written both ways.
    let separate = "\
H\tVN:Z:1.1\tRS:Z:ref
S\t1\tACGTACGTAC
S\t2\tT
S\t3\tG
S\t4\tCATGCATGCA
L\t1\t+\t2\t+\t0M
L\t1\t+\t3\t+\t0M
L\t2\t+\t4\t+\t0M
L\t3\t+\t4\t+\t0M
W\tref\t0\tchr1\t0\t21\t>1>2>4
W\tunknown\t1\tchr1\t0\t21\t>1>3>4
W\tunknown\t2\tchr1\t0\t21\t>1>3>4
W\tunknown\t3\tchr1\t0\t21\t>1>3>4
";
    // The same panel as GBZ-base would emit it under `HaplotypeOutput::Distinct`.
    let weighted = "\
H\tVN:Z:1.1\tRS:Z:ref
S\t1\tACGTACGTAC
S\t2\tT
S\t3\tG
S\t4\tCATGCATGCA
L\t1\t+\t2\t+\t0M
L\t1\t+\t3\t+\t0M
L\t2\t+\t4\t+\t0M
L\t3\t+\t4\t+\t0M
W\tref\t0\tchr1\t0\t21\t>1>2>4\tWT:i:1
W\tunknown\t1\tchr1\t0\t21\t>1>3>4\tWT:i:3
";
    let a = run_reduce(separate, 50);
    let b = run_reduce(weighted, 50);
    let xa = a.lines().find(|l| l.starts_with("X\t")).expect("stats line");
    let xb = b.lines().find(|l| l.starts_with("X\t")).expect("stats line");

    for tag in ["TW", "NW"] {
        assert_eq!(
            int_tag(xa, tag),
            int_tag(xb, tag),
            "{}: weighted form gave {:?}, separate records gave {:?}",
            tag,
            int_tag(xb, tag),
            int_tag(xa, tag),
        );
    }
    assert_eq!(int_tag(xa, "TW"), Some(4), "4 haplotypes in the panel");
    // WR counts records, so it is the one tag that must differ.
    assert_eq!(int_tag(xa, "WR"), Some(4));
    assert_eq!(int_tag(xb, "WR"), Some(2));

    // Per-node coverage must weight identically, or the S-line tags would
    // disagree with the totals on the X line.
    let cov = |out: &str, id: &str| -> Option<u64> {
        out.lines()
            .filter(|l| l.starts_with("S\t"))
            .find(|l| l.split('\t').nth(1) == Some(id))
            .and_then(|l| int_tag(l, "WC"))
    };
    for id in ["1", "2", "3", "4"] {
        assert_eq!(cov(&a, id), cov(&b, id), "node {}: WC disagrees", id);
    }
}

#[test]
fn coverage_never_exceeds_the_walks_that_could_produce_it() {
    for name in all_fixtures() {
        let input = fixture(name);
        let out = run_reduce(&input, 50);
        let x = out.lines().find(|l| l.starts_with("X\t")).expect("stats line");
        let non_ref = int_tag(x, "NW").unwrap();
        for line in out.lines().filter(|l| l.starts_with("S\t")) {
            for tag in ["WC", "WS", "WE"] {
                if let Some(v) = int_tag(line, tag) {
                    assert!(v <= non_ref, "{}: {} of {} exceeds {} walks", name, tag, v, non_ref);
                }
            }
        }
    }
}

#[test]
fn a_higher_threshold_never_keeps_more_nodes() {
    // Collapsing is monotone in the threshold: raising it can only merge more.
    for name in all_fixtures() {
        let input = fixture(name);
        let mut previous = usize::MAX;
        for threshold in [10, 50, 250] {
            let out = run_reduce(&input, threshold);
            let count = segments(&out).len();
            assert!(
                count <= previous,
                "{}: threshold {} kept {} nodes, more than the previous {}",
                name,
                threshold,
                count,
                previous
            );
            previous = count;
        }
    }
}

#[test]
fn simplification_is_blind_to_stored_node_orientation() {
    // Regression: `plan_unchop` originally built its merge-candidate set from
    // `!from_rev && !to_rev`, so a non-branching chain stored in reverse
    // orientation — a run of `-/-` links, topologically identical to a `+/+`
    // run — was never merged. In HPRC v1.1 this left 13.6% of 50 kb windows
    // with UM=0 and ~33% node reduction instead of ~99%, which the atlas then
    // read as biological complexity.
    for name in all_fixtures() {
        let input = fixture(name);
        let flipped = flip_orientation(&input);

        let a = run_reduce(&input, 50);
        let b = run_reduce(&flipped, 50);

        let xa = a.lines().find(|l| l.starts_with("X\t")).expect("stats line");
        let xb = b.lines().find(|l| l.starts_with("X\t")).expect("stats line");

        for tag in ["SB", "SA", "UM", "ST", "NR"] {
            assert_eq!(
                int_tag(xa, tag),
                int_tag(xb, tag),
                "{}: {} differs between a graph and the same graph stored \
                 in reverse orientation ({} vs {})",
                name,
                tag,
                int_tag(xa, tag).unwrap_or(0),
                int_tag(xb, tag).unwrap_or(0)
            );
        }
    }
}

#[test]
fn constructed_graphs_collapse_exactly_as_specified() {
    for e in &SYNTHETIC {
        let out = run_reduce(&fixture(e.id), 50);
        let x = out.lines().find(|l| l.starts_with("X\t")).expect("stats line");
        let got = |tag: &str| int_tag(x, tag).unwrap_or_else(|| panic!("{}: no {}", e.id, tag));

        assert_eq!(got("ST"), e.sites, "{}: sites", e.id);
        assert_eq!(got("NR"), e.nodes_removed, "{}: nodesRemoved", e.id);
        assert_eq!(got("SN"), e.snp_count, "{}: snpCount", e.id);
        assert_eq!(got("BR"), e.bases_removed, "{}: basesRemoved", e.id);
        if let Some(n) = e.segments_after {
            assert_eq!(got("SA"), n, "{}: segments after simplify", e.id);
        }

        // A removed node must not appear in the output — neither as a segment of
        // its own nor as the name of a chain that absorbed it.
        let ids: HashSet<String> = segments(&out).into_iter().map(|(id, _)| id).collect();
        for gone in e.removed_nodes {
            assert!(
                !ids.contains(*gone) && !ids.contains(&format!("u{}", gone)),
                "{}: node {} survived",
                e.id,
                gone
            );
        }
    }
}
