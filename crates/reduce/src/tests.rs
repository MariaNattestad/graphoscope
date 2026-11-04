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

/// Regression: a single haplotype that crosses the locus on the strand opposite
/// the reference — the reference read reverse-complemented, common where a locus
/// sits in an inverted segmental duplication — used to defeat small-variant
/// collapse across the whole backbone. Adjacency was recorded by node id in step
/// order, so the reverse traversal laid down `ref[i] -> ref[i-1]` back-edges that
/// made every downstream bubble look non-forward: nothing collapsed and the
/// reference shattered into single nodes (SMN1 jumped 35 -> 748 nodes when a
/// wider window pulled such a walk in). Adding the walk must not change what
/// collapses.
#[test]
fn a_reverse_strand_copy_of_the_reference_does_not_defeat_collapse() {
    // Backbone 1>2>4>5>7 with a SNP at 2/3 and another at 5/6.
    let base = "\
H\tVN:Z:1.1\tRS:Z:ref
S\t1\tACGTACGTAC
S\t2\tT
S\t3\tA
S\t4\tCCCCGGGGAA
S\t5\tG
S\t6\tC
S\t7\tTTTTGGGGCC
L\t1\t+\t2\t+\t0M
L\t1\t+\t3\t+\t0M
L\t2\t+\t4\t+\t0M
L\t3\t+\t4\t+\t0M
L\t4\t+\t5\t+\t0M
L\t4\t+\t6\t+\t0M
L\t5\t+\t7\t+\t0M
L\t6\t+\t7\t+\t0M
W\tref\t0\tchr1\t0\t32\t>1>2>4>5>7
W\tunknown\t1\tchr1\t0\t32\t>1>3>4>6>7
";
    // The same panel plus one haplotype that reads the whole backbone on the
    // opposite strand — visiting the reference nodes in reverse order.
    let with_rev = format!("{base}W\tunknown\t2\tchr1\t0\t32\t<7<5<4<2<1\n");

    let a = run_reduce(base, 50);
    let b = run_reduce(&with_rev, 50);
    let xa = a.lines().find(|l| l.starts_with("X\t")).expect("stats line");
    let xb = b.lines().find(|l| l.starts_with("X\t")).expect("stats line");

    // Both SNP sites collapse in the base graph (guards against a trivially
    // equal pass where nothing collapses either way)...
    assert_eq!(int_tag(xa, "ST"), Some(2), "base: both SNP sites should collapse");
    // ...and the reverse-strand copy must leave the collapse untouched.
    for tag in ["ST", "NR", "SA"] {
        assert_eq!(
            int_tag(xa, tag),
            int_tag(xb, tag),
            "{}: a reverse-strand copy of the reference changed collapse ({:?} vs {:?})",
            tag,
            int_tag(xa, tag),
            int_tag(xb, tag),
        );
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

//-----------------------------------------------------------------------------
// Locus trim (locus.rs): the reference shown is the locus, context extends only
// into alt alleles, and the reference axis grows just far enough to include
// where something leaving the locus rejoins it.

use crate::locus::LocusQuery;
use crate::reduce::{reduce_locus, write_raw_locus};

fn run_locus(text: &str, interval: std::ops::Range<usize>, frontier: &[(u64, usize)]) -> String {
    let q = LocusQuery { interval, frontier: frontier.iter().copied().collect() };
    let mut out: Vec<u8> = Vec::new();
    // max_variant 0: nothing collapses, so the trim is observed on its own.
    reduce_locus(|w: &mut dyn std::io::Write| w.write_all(text.as_bytes()), 0, Some(&q), &mut out)
        .expect("reduce failed");
    String::from_utf8(out).expect("output is utf-8")
}

/// Every original node id the output stands for (chains expanded via `MB`).
fn output_nodes(gfa: &str) -> HashSet<String> {
    let mut out = HashSet::new();
    for l in gfa.lines().filter(|l| l.starts_with("S\t")) {
        let f: Vec<&str> = l.split('\t').collect();
        match f.iter().find_map(|t| t.strip_prefix("MB:Z:")) {
            Some(m) => out.extend(m.split(',').map(String::from)),
            None => {
                out.insert(f[1].to_string());
            }
        }
    }
    out
}

fn ids(v: &[&str]) -> HashSet<String> {
    v.iter().map(|s| s.to_string()).collect()
}

fn x_tag(gfa: &str, tag: &str) -> u64 {
    let x = gfa.lines().find(|l| l.starts_with("X\t")).expect("stats line");
    int_tag(x, tag).unwrap_or_else(|| panic!("no {} tag on {}", tag, x))
}

/// (start, end) of the reference W line.
fn ref_coords(gfa: &str) -> (u64, u64) {
    let w = gfa.lines().find(|l| l.starts_with("W\t")).expect("reference walk");
    let f: Vec<&str> = w.split('\t').collect();
    (f[4].parse().unwrap(), f[5].parse().unwrap())
}

/// Coverage (`WC`) of the output segment whose id or `MB` members include `id`.
fn wc_of(gfa: &str, id: &str) -> Option<u64> {
    gfa.lines().filter(|l| l.starts_with("S\t")).find_map(|l| {
        let f: Vec<&str> = l.split('\t').collect();
        let hit = f[1] == id
            || f.iter().find_map(|t| t.strip_prefix("MB:Z:")).is_some_and(|m| m.split(',').any(|x| x == id));
        if hit {
            int_tag(l, "WC")
        } else {
            None
        }
    })
}

/// A 9-node reference, 10 bp per node, starting at path offset 1000:
/// node n covers [1000 + 10(n-1), 1000 + 10n). Extra lines add alts/edges.
fn ref9(extra_segments: &str, extra_links: &str, walks: &str) -> String {
    let mut s = String::from("H\tVN:Z:1.1\tRS:Z:ref\n");
    for n in 1..=9 {
        s.push_str(&format!("S\t{}\tACGTACGTAC\n", n));
    }
    s.push_str(extra_segments);
    for n in 1..9 {
        s.push_str(&format!("L\t{}\t+\t{}\t+\t0M\n", n, n + 1));
    }
    s.push_str(extra_links);
    s.push_str("W\tref\t0\tchr1\t1000\t1090\t>1>2>3>4>5>6>7>8>9\n");
    s.push_str(walks);
    s
}

#[test]
fn locus_trim_keeps_only_the_locus_reference_and_its_alts() {
    // Alt 20 sits inside the locus (4 -> 20 -> 5); alt 30 sits outside (1 -> 30 -> 2).
    let g = ref9(
        "S\t20\tGGGG\nS\t30\tTTTT\n",
        "L\t4\t+\t20\t+\t0M\nL\t20\t+\t5\t+\t0M\nL\t1\t+\t30\t+\t0M\nL\t30\t+\t2\t+\t0M\n",
        "W\tunknown\t1\tchr1\t0\t98\t>1>30>2>3>4>20>5>6>7>8>9\n",
    );
    // Partial overlap with nodes 4 and 5: both kept whole.
    let out = run_locus(&g, 1035..1045, &[]);
    assert_eq!(output_nodes(&out), ids(&["4", "5", "20"]));
    assert_eq!(ref_coords(&out), (1030, 1050));
    assert_eq!(x_tag(&out, "FN"), 11);
    assert_eq!(x_tag(&out, "DN"), 8);
    assert_eq!(x_tag(&out, "LR"), 2);
    assert_eq!(x_tag(&out, "KA"), 1);
    assert_eq!((x_tag(&out, "XL"), x_tag(&out, "XR"), x_tag(&out, "RJ")), (0, 0, 0));
    // The haplotype is clipped to the locus, not dropped, and still counted once.
    assert_eq!(x_tag(&out, "NW"), 1);
    assert_eq!(wc_of(&out, "20"), Some(1));
}

#[test]
fn locus_trim_keeps_an_alt_allele_reached_end_to_end() {
    // A long insertion 4 -> 40 -> 41 -> 42 -> 5, all fetched.
    let g = ref9(
        "S\t40\tAAAA\nS\t41\tCCCC\nS\t42\tGGGG\n",
        "L\t4\t+\t40\t+\t0M\nL\t40\t+\t41\t+\t0M\nL\t41\t+\t42\t+\t0M\nL\t42\t+\t5\t+\t0M\n",
        "W\tunknown\t1\tchr1\t0\t102\t>1>2>3>4>40>41>42>5>6>7>8>9\n",
    );
    let out = run_locus(&g, 1030..1050, &[]);
    assert_eq!(output_nodes(&out), ids(&["4", "5", "40", "41", "42"]));
    assert_eq!((x_tag(&out, "EX"), x_tag(&out, "RJ")), (0, 0));
    assert_eq!(wc_of(&out, "41"), Some(1));
}

#[test]
fn locus_trim_reports_an_alt_whose_middle_was_not_fetched_as_an_exit() {
    // 4 -> 40 -> (41, not fetched) -> 42 -> 6. 42 is reachable only through the
    // missing node, so from the locus it is anchored outside: dropped.
    let g = ref9(
        "S\t40\tAAAA\nS\t42\tGGGG\n",
        "L\t4\t+\t40\t+\t0M\nL\t42\t+\t6\t+\t0M\n",
        "W\tunknown\t1\tchr1\t0\t44\t>1>2>3>4>40\nW\tunknown\t2\tchr1\t0\t44\t>42>6>7>8>9\n",
    );
    let out = run_locus(&g, 1030..1050, &[(40, 1), (42, 1)]);
    assert_eq!(output_nodes(&out), ids(&["4", "5", "40"]));
    assert_eq!((x_tag(&out, "EX"), x_tag(&out, "EN")), (1, 1), "only 40's exit counts");
    assert_eq!((x_tag(&out, "XL"), x_tag(&out, "XR")), (0, 0));
    // The second haplotype never touches the locus.
    assert_eq!(x_tag(&out, "NW"), 1);
}

#[test]
fn locus_trim_extends_the_reference_to_where_a_deletion_rejoins() {
    // A deletion edge 5 -> 8 leaves the locus (4..5) and rejoins at 8. Alt 50
    // (6 -> 50 -> 7) is anchored only on the extension: not pulled in.
    let g = ref9(
        "S\t50\tTTTT\n",
        "L\t5\t+\t8\t+\t0M\nL\t6\t+\t50\t+\t0M\nL\t50\t+\t7\t+\t0M\n",
        "W\tunknown\t1\tchr1\t0\t60\t>1>2>3>4>5>8>9\nW\tunknown\t2\tchr1\t0\t94\t>1>2>3>4>5>6>50>7>8>9\n",
    );
    let out = run_locus(&g, 1030..1050, &[]);
    assert_eq!(output_nodes(&out), ids(&["4", "5", "6", "7", "8"]));
    assert_eq!(ref_coords(&out), (1030, 1080));
    assert_eq!((x_tag(&out, "XL"), x_tag(&out, "XR"), x_tag(&out, "RJ")), (0, 30, 1));
    // The deletion edge survives; the extension-only alt's edges do not.
    assert!(out.lines().any(|l| l.starts_with("L\t") && l.contains("u4\t+\t8\t+")), "{}", out); // 4,5 unchop into u4
    assert!(!out.contains("\t50\t"));
    // Haplotype 2 dips into the dropped alt: its two runs count as one walk.
    assert_eq!(x_tag(&out, "NW"), 2);
}

#[test]
fn locus_trim_extends_the_reference_to_where_an_alt_rejoins_on_either_side() {
    // 4 -> 60 -> 7 leaves the locus to the right; 2 -> 80 -> 4 enters it from
    // the left. Both are reached from the locus, so both rejoin points count.
    let g = ref9(
        "S\t60\tAAAA\nS\t80\tCCCC\n",
        "L\t4\t+\t60\t+\t0M\nL\t60\t+\t7\t+\t0M\nL\t2\t+\t80\t+\t0M\nL\t80\t+\t4\t+\t0M\n",
        "",
    );
    let out = run_locus(&g, 1030..1050, &[]);
    assert_eq!(output_nodes(&out), ids(&["2", "3", "4", "5", "6", "7", "60", "80"]));
    assert_eq!(ref_coords(&out), (1010, 1070));
    assert_eq!((x_tag(&out, "XL"), x_tag(&out, "XR"), x_tag(&out, "RJ")), (20, 20, 2));
}

#[test]
fn a_deletion_rejoining_beyond_the_fetched_reference_is_unresolved_until_it_is_fetched() {
    // Small context: the reference walk stops at 6, but the deletion 5 -> 8's
    // far endpoint (1 bp away to GBZ-base) was fetched anyway, with its
    // neighbour 9; past 9 nothing was fetched. 8 and 9 are not on the walk, so
    // they read as non-reference and the search reaches the frontier: an exit.
    let mut small = String::from("H\tVN:Z:1.1\tRS:Z:ref\n");
    for n in [1, 2, 3, 4, 5, 6, 8, 9] {
        small.push_str(&format!("S\t{}\tACGTACGTAC\n", n));
    }
    small.push_str("L\t1\t+\t2\t+\t0M\nL\t2\t+\t3\t+\t0M\nL\t3\t+\t4\t+\t0M\nL\t4\t+\t5\t+\t0M\n");
    small.push_str("L\t5\t+\t6\t+\t0M\nL\t5\t+\t8\t+\t0M\nL\t8\t+\t9\t+\t0M\n");
    small.push_str("W\tref\t0\tchr1\t1000\t1060\t>1>2>3>4>5>6\n");
    small.push_str("W\tunknown\t1\tchr1\t0\t70\t>1>2>3>4>5>8>9\n");
    // 6 continues to unfetched 7; 9 continues to unfetched 10.
    let out = run_locus(&small, 1030..1050, &[(6, 1), (9, 1)]);
    assert_eq!(output_nodes(&out), ids(&["4", "5", "8", "9"]));
    assert_eq!(x_tag(&out, "XR"), 0, "nothing to extend to yet");
    assert_eq!((x_tag(&out, "EX"), x_tag(&out, "EN")), (1, 1), "9's missing edge; 6 is not kept");

    // Larger context: the walk now reaches 8 and 9, the rejoin resolves, and
    // 8 is shown as the reference it is (9 is past the rejoin: dropped).
    let big = ref9("", "L\t5\t+\t8\t+\t0M\n", "W\tunknown\t1\tchr1\t0\t70\t>1>2>3>4>5>8>9\n");
    let out = run_locus(&big, 1030..1050, &[(1, 1), (9, 1)]);
    assert_eq!(output_nodes(&out), ids(&["4", "5", "6", "7", "8"]));
    assert_eq!(x_tag(&out, "XR"), 30);
    assert_eq!(x_tag(&out, "EX"), 0, "the extension's own frontier is not an exit");
}

#[test]
fn locus_trim_drops_an_alt_anchored_entirely_outside() {
    // 7 -> 70 -> 8, and a two-node alt 1 -> 71 -> 72 -> 3: neither touches the locus.
    let g = ref9(
        "S\t70\tAAAA\nS\t71\tCCCC\nS\t72\tGGGG\n",
        "L\t7\t+\t70\t+\t0M\nL\t70\t+\t8\t+\t0M\nL\t1\t+\t71\t+\t0M\nL\t71\t+\t72\t+\t0M\nL\t72\t+\t3\t+\t0M\n",
        "W\tunknown\t1\tchr1\t0\t94\t>1>71>72>3>4>5>6>7>70>8>9\n",
    );
    let out = run_locus(&g, 1030..1050, &[(70, 3), (71, 2)]);
    assert_eq!(output_nodes(&out), ids(&["4", "5"]));
    assert_eq!((x_tag(&out, "EX"), x_tag(&out, "RJ")), (0, 0));
}

#[test]
fn locus_trim_keeps_real_fixtures_consistent() {
    // Trim each real locus to the middle third of its reference walk and check
    // the same invariants the untrimmed output holds to.
    for name in REAL {
        let input = fixture(name);
        let w = input.lines().find(|l| l.starts_with("W\t")).unwrap();
        let f: Vec<&str> = w.split('\t').collect();
        let (s, e): (usize, usize) = (f[4].parse().unwrap(), f[5].parse().unwrap());
        let third = (e - s) / 3;
        let out = run_locus(&input, s + third..e - third, &[]);

        let input_edges = edges(&input);
        let chains: HashSet<String> = chain_members(&out).into_iter().map(|(id, _)| id).collect();
        for (a, b) in edges(&out) {
            if chains.contains(&a) || chains.contains(&b) {
                continue;
            }
            assert!(input_edges.contains(&(a.clone(), b.clone())), "{}: invented edge {}-{}", name, a, b);
        }
        // The kept reference is a contiguous piece of the original, at the
        // coordinates the W line now claims.
        let (rs, re) = ref_coords(&out);
        let full = ref_walk_sequence(&input);
        let kept = ref_walk_sequence(&out);
        assert_eq!(kept.len() as u64, re - rs, "{}: W coordinates disagree with sequence", name);
        assert_eq!(&full[(rs as usize - s)..(re as usize - s)], kept, "{}: reference changed", name);
        assert!(rs as usize <= s + third && re as usize >= e - third, "{}: locus not covered", name);
        assert!(x_tag(&out, "DN") > 0, "{}: nothing trimmed", name);

        let non_ref = x_tag(&out, "NW");
        for line in out.lines().filter(|l| l.starts_with("S\t") || l.starts_with("L\t")) {
            for tag in ["WC", "WS", "WE"] {
                if let Some(v) = int_tag(line, tag) {
                    assert!(v <= non_ref, "{}: {} of {} exceeds {} walks", name, tag, v, non_ref);
                }
            }
        }
    }
}

#[test]
fn trimmed_raw_output_names_only_kept_nodes() {
    let g = ref9(
        "S\t50\tTTTT\nS\t30\tTTTT\n",
        "L\t5\t+\t8\t+\t0M\nL\t6\t+\t50\t+\t0M\nL\t50\t+\t7\t+\t0M\nL\t1\t+\t30\t+\t0M\nL\t30\t+\t2\t+\t0M\n",
        "W\tunknown\t1\tchr1\t0\t94\t>1>30>2>3>4>5>6>50>7>8>9\tWT:i:3\n",
    );
    let q = LocusQuery { interval: 1030..1050, ..Default::default() };
    let mut out: Vec<u8> = Vec::new();
    write_raw_locus(|w: &mut dyn std::io::Write| w.write_all(g.as_bytes()), &q, &mut out).unwrap();
    let out = String::from_utf8(out).unwrap();
    let kept = ids(&["4", "5", "6", "7", "8"]);
    assert_eq!(segments(&out).into_iter().map(|(id, _)| id).collect::<HashSet<_>>(), kept);
    let walks: Vec<&str> = out.lines().filter(|l| l.starts_with("W\t")).collect();
    assert_eq!(walks[0], "W\tref\t0\tchr1\t1030\t1080\t>4>5>6>7>8");
    // The haplotype dips into dropped 50: two runs, each keeping its weight.
    assert_eq!(
        &walks[1..],
        &["W\tunknown\t1\tchr1\t0\t30\t>4>5>6\tWT:i:3", "W\tunknown\t1\tchr1\t0\t20\t>7>8\tWT:i:3"]
    );
    for (a, b) in edges(&out) {
        assert!(kept.contains(&a) && kept.contains(&b));
    }
}
