//! GFA plumbing: a streaming line sink, zero-allocation line/step parsing, and
//! the reduced-GFA writer.
//!
//! Nothing here ever holds the whole GFA. `LineSink` implements `Write` so
//! GBZ-base can serialize a subgraph straight through it, dispatching one
//! complete line at a time; walks are consumed as they stream past and dropped.
//! Node ids are `u64` throughout — they arrive numeric from GBZ-base, and only
//! become strings at output (where unchopped chains print as `u<first>`).

use std::collections::HashMap;
use std::io::{self, Write};

pub type NodeId = u64;

#[derive(Clone)]
pub struct Segment {
    pub id: NodeId,
    pub seq: Vec<u8>,
}

#[derive(Clone, Copy)]
pub struct Link {
    pub from: NodeId,
    pub from_rev: bool,
    pub to: NodeId,
    pub to_rev: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub struct Step {
    pub id: NodeId,
    pub rev: bool,
}

/// The reference walk — the only walk we keep, since it anchors the layout and
/// is the one `W` line the output carries.
#[derive(Clone, Default)]
pub struct RefWalk {
    pub sample: String,
    pub hap: usize,
    pub seq_id: String,
    pub start: usize,
    pub end: usize,
    pub steps: Vec<Step>,
}

//-----------------------------------------------------------------------------
// Streaming sink.

/// A `Write` that splits its input into lines and hands each complete line to a
/// callback. Only a single line is ever buffered, so serializing a subgraph
/// through it costs O(longest line) rather than O(whole GFA).
pub struct LineSink<F: FnMut(&[u8])> {
    buf: Vec<u8>,
    on_line: F,
}

impl<F: FnMut(&[u8])> LineSink<F> {
    pub fn new(on_line: F) -> Self {
        LineSink { buf: Vec::with_capacity(4096), on_line }
    }
    /// Flush any trailing line that wasn't newline-terminated.
    pub fn finish(mut self) {
        if !self.buf.is_empty() {
            (self.on_line)(&self.buf);
            self.buf.clear();
        }
    }
}

impl<F: FnMut(&[u8])> Write for LineSink<F> {
    fn write(&mut self, mut data: &[u8]) -> io::Result<usize> {
        let total = data.len();
        while let Some(nl) = data.iter().position(|&b| b == b'\n') {
            if self.buf.is_empty() {
                (self.on_line)(&data[..nl]);
            } else {
                self.buf.extend_from_slice(&data[..nl]);
                // Take the buffer out so the callback can borrow self freely.
                let line = std::mem::take(&mut self.buf);
                (self.on_line)(&line);
                self.buf = line;
                self.buf.clear();
            }
            data = &data[nl + 1..];
        }
        self.buf.extend_from_slice(data);
        Ok(total)
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

//-----------------------------------------------------------------------------
// Line parsing (borrowing, no allocation except where a value is kept).

fn field(line: &[u8], n: usize) -> Option<&[u8]> {
    line.split(|&b| b == b'\t').nth(n)
}

fn parse_u64(b: &[u8]) -> Option<u64> {
    if b.is_empty() {
        return None;
    }
    let mut v: u64 = 0;
    for &c in b {
        if !c.is_ascii_digit() {
            return None;
        }
        v = v.checked_mul(10)?.checked_add((c - b'0') as u64)?;
    }
    Some(v)
}

pub fn line_type(line: &[u8]) -> u8 {
    *line.first().unwrap_or(&0)
}

/// `S <id> <seq>`
pub fn parse_segment(line: &[u8]) -> Option<Segment> {
    let id = parse_u64(field(line, 1)?)?;
    let seq = field(line, 2).unwrap_or_default().to_vec();
    Some(Segment { id, seq })
}

/// `L <from> <+-> <to> <+-> <overlap>`
pub fn parse_link(line: &[u8]) -> Option<Link> {
    let from = parse_u64(field(line, 1)?)?;
    let from_rev = field(line, 2) == Some(b"-");
    let to = parse_u64(field(line, 3)?)?;
    let to_rev = field(line, 4) == Some(b"-");
    Some(Link { from, from_rev, to, to_rev })
}

/// Reference-sample names from an `H` line's `RS:Z:` tag.
pub fn parse_reference_samples(line: &[u8]) -> Option<Vec<String>> {
    for f in line.split(|&b| b == b'\t') {
        if let Some(rest) = f.strip_prefix(b"RS:Z:") {
            return Some(
                String::from_utf8_lossy(rest)
                    .split(' ')
                    .filter(|s| !s.is_empty())
                    .map(String::from)
                    .collect(),
            );
        }
    }
    None
}

/// The sample name of a `W` line, without copying.
pub fn walk_sample(line: &[u8]) -> &[u8] {
    field(line, 1).unwrap_or_default()
}

/// `W <sample> <hap> <contig> <start> <end> <walk>` — metadata only.
pub fn parse_walk_meta(line: &[u8]) -> Option<(String, usize, String, usize, usize)> {
    let sample = String::from_utf8_lossy(field(line, 1)?).into_owned();
    let hap = parse_u64(field(line, 2)?)? as usize;
    let seq_id = String::from_utf8_lossy(field(line, 3)?).into_owned();
    let start = parse_u64(field(line, 4)?)? as usize;
    let end = parse_u64(field(line, 5)?)? as usize;
    Some((sample, hap, seq_id, start, end))
}

/// The raw walk field (`>1<2>3`) of a `W` line.
pub fn walk_field(line: &[u8]) -> &[u8] {
    field(line, 6).unwrap_or_default()
}

/// Iterates a walk field's oriented steps without allocating.
pub struct StepIter<'a> {
    b: &'a [u8],
    i: usize,
}

impl<'a> StepIter<'a> {
    pub fn new(b: &'a [u8]) -> Self {
        StepIter { b, i: 0 }
    }
}

impl Iterator for StepIter<'_> {
    type Item = Step;
    fn next(&mut self) -> Option<Step> {
        while self.i < self.b.len() {
            let rev = match self.b[self.i] {
                b'>' => false,
                b'<' => true,
                _ => {
                    self.i += 1;
                    continue;
                }
            };
            let start = self.i + 1;
            let mut j = start;
            while j < self.b.len() && self.b[j] != b'>' && self.b[j] != b'<' {
                j += 1;
            }
            self.i = j;
            if let Some(id) = parse_u64(&self.b[start..j]) {
                return Some(Step { id, rev });
            }
        }
        None
    }
}

//-----------------------------------------------------------------------------
// Output.

/// Locus-level counts carried on the reduced GFA's `X` line, so the viewer can
/// report walk/collapse totals without ever seeing the dropped walks.
#[derive(Default)]
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

/// A segment in the reduced output. `members > 1` means it is an unchopped
/// chain, which prints as `u<first member>`.
pub struct OutSegment {
    pub first_member: NodeId,
    pub members: usize,
    pub seq: Vec<u8>,
    pub length: usize,
}

impl OutSegment {
    pub fn write_id<W: Write>(&self, out: &mut W) -> io::Result<()> {
        if self.members > 1 {
            write!(out, "u{}", self.first_member)
        } else {
            write!(out, "{}", self.first_member)
        }
    }
}

/// Writes the reduced GFA: header, `X` stats, segments and links with their
/// `WC` walk-coverage tags, and only the reference `W` line.
#[allow(clippy::too_many_arguments)]
pub fn write_reduced<W: Write>(
    reference_samples: &[String],
    stats: &ReduceStats,
    segments: &[OutSegment],
    links: &[(u32, bool, u32, bool)],
    node_cov: &[u32],
    node_starts: &[u32],
    node_ends: &[u32],
    edge_cov: &HashMap<(u32, u32), u32>,
    ref_walk: Option<&RefWalk>,
    ref_steps_out: &[(u32, bool)],
    out: &mut W,
) -> io::Result<()> {
    if reference_samples.is_empty() {
        out.write_all(b"H\tVN:Z:1.1\n")?;
    } else {
        writeln!(out, "H\tVN:Z:1.1\tRS:Z:{}", reference_samples.join(" "))?;
    }

    writeln!(
        out,
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

    for (i, seg) in segments.iter().enumerate() {
        out.write_all(b"S\t")?;
        seg.write_id(out)?;
        out.write_all(b"\t")?;
        out.write_all(&seg.seq)?;
        write!(out, "\tWC:i:{}", node_cov.get(i).copied().unwrap_or(0))?;
        // Only emit the endpoint tags where there is something to report, so a
        // typical interior node stays a short line.
        let (s, e) =
            (node_starts.get(i).copied().unwrap_or(0), node_ends.get(i).copied().unwrap_or(0));
        if s > 0 {
            write!(out, "\tWS:i:{}", s)?;
        }
        if e > 0 {
            write!(out, "\tWE:i:{}", e)?;
        }
        out.write_all(b"\n")?;
    }

    for &(from, from_rev, to, to_rev) in links {
        let wc = edge_cov.get(&edge_key(from, to)).copied().unwrap_or(0);
        out.write_all(b"L\t")?;
        segments[from as usize].write_id(out)?;
        out.write_all(if from_rev { b"\t-\t" } else { b"\t+\t" })?;
        segments[to as usize].write_id(out)?;
        out.write_all(if to_rev { b"\t-\t0M\t" } else { b"\t+\t0M\t" })?;
        writeln!(out, "WC:i:{}", wc)?;
    }

    if let Some(w) = ref_walk {
        out.write_all(b"W\t")?;
        out.write_all(w.sample.as_bytes())?;
        write!(out, "\t{}\t", w.hap)?;
        out.write_all(w.seq_id.as_bytes())?;
        write!(out, "\t{}\t{}\t", w.start, w.end)?;
        for &(idx, rev) in ref_steps_out {
            out.write_all(if rev { b"<" } else { b">" })?;
            segments[idx as usize].write_id(out)?;
        }
        out.write_all(b"\n")?;
    }

    Ok(())
}

/// Canonical (order-independent) key for an undirected edge between output segments.
pub fn edge_key(a: u32, b: u32) -> (u32, u32) {
    if a <= b {
        (a, b)
    } else {
        (b, a)
    }
}
