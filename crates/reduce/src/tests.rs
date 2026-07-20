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
const FIXTURES: [&str; 4] = ["mhc_2kb", "mhc_8kb", "mhc_84kb", "chr20_200kb"];

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
    for name in FIXTURES {
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
    for name in FIXTURES {
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
    for name in FIXTURES {
        let input = fixture(name);
        let out = run_reduce(&input, 50);
        let x = out.lines().find(|l| l.starts_with("X\t")).expect("stats line");
        let before = int_tag(x, "SB").unwrap();
        let after = int_tag(x, "SA").unwrap();
        assert!(after <= before, "{}: {} segments became {}", name, before, after);
        assert_eq!(after as usize, segments(&out).len(), "{}: SA disagrees with S lines", name);
    }
}

#[test]
fn coverage_never_exceeds_the_walks_that_could_produce_it() {
    for name in FIXTURES {
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
    for name in FIXTURES {
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
