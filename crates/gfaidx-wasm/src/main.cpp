// gfaidx-query: Graphoscope's entry point into the gfaidx library, built for
// WebAssembly (WASI) by scripts/build-gfaidx-wasm.sh.
//
// It opens a gfaidx index (the block-compressed GFA plus its sidecars, all in
// one directory) and writes a query's result to stdout. In the browser each
// file is backed by HTTP range requests (src/lib/sparseVfs.ts), so only the
// bytes a query touches are fetched.
//
//   gfaidx-query tracks   <graph>
//       TSV of the paths and walks a region can be asked on:
//       type (P, W or S for rGFA), sample, haplotype, sequence, begin, end, steps
//   gfaidx-query region   <graph> --reference R --sequence S --begin B --end E
//                         [--mode all|bfs|reference] [--context BP]
//                         [--max-nodes N] [--haplotype-gap BP]
//       GFA of the region, every walk named and carrying its coordinates.
//   gfaidx-query subgraph <graph> --node NAME [--max-nodes N]
//       GFA of the neighbourhood of one node.

#include <gfaidx/gfaidx.hpp>

#include <cstdint>
#include <cstdio>
#include <exception>
#include <map>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace {

using Flags = std::map<std::string, std::string>;

Flags parse_flags(int argc, char** argv, int first) {
    Flags flags;
    for (int i = first; i < argc; ++i) {
        const std::string name = argv[i];
        if (name.rfind("--", 0) != 0 || i + 1 >= argc) {
            throw std::runtime_error("expected --flag value, got: " + name);
        }
        flags[name.substr(2)] = argv[++i];
    }
    return flags;
}

std::string require(const Flags& flags, const std::string& name) {
    const auto found = flags.find(name);
    if (found == flags.end()) throw std::runtime_error("missing --" + name);
    return found->second;
}

std::uint64_t number(const std::string& text, const std::string& name) {
    std::size_t used = 0;
    const unsigned long long value = std::stoull(text, &used);
    if (used != text.size()) throw std::runtime_error("--" + name + " is not a number: " + text);
    return value;
}

// One buffered writer for stdout: a line per fwrite would be a WASI call each.
struct Output {
    std::string buffer;
    bool line(std::string_view text) {
        buffer.append(text);
        if (buffer.empty() || buffer.back() != '\n') buffer.push_back('\n');
        if (buffer.size() >= (1u << 20)) flush();
        return true;
    }
    void flush() {
        std::fwrite(buffer.data(), 1, buffer.size(), stdout);
        buffer.clear();
    }
};

gfaidx::QueryCallbacks progress_to_stderr() {
    gfaidx::QueryCallbacks callbacks;
    callbacks.warning = [](std::string_view text) {
        std::fprintf(stderr, "warning: %.*s\n", static_cast<int>(text.size()), text.data());
    };
    callbacks.progress = [](std::string_view text) {
        std::fprintf(stderr, "%.*s\n", static_cast<int>(text.size()), text.data());
    };
    return callbacks;
}

int tracks(const std::string& graph_path) {
    const gfaidx::IndexedGraph index(graph_path);
    Output out;
    // Every indexed P path and W walk can anchor a region query; rGFA tracks
    // (a .cdx sidecar) come after them.
    for (const auto& path : index.paths()) {
        out.line(std::string(1, path.record_type) + '\t' +
                 (path.sample.empty() ? path.name : path.sample) + '\t' +
                 std::to_string(path.haplotype) + '\t' +
                 (path.sequence_name.empty() ? path.name : path.sequence_name) + '\t' +
                 std::to_string(path.sequence_start) + '\t' + std::to_string(path.sequence_end) + '\t' +
                 std::to_string(path.step_count));
    }
    for (const auto& track : index.coordinate_tracks()) {
        out.line(std::string(1, track.source_type) + '\t' + track.reference + '\t' +
                 std::to_string(track.haplotype) + '\t' + track.sequence + '\t' +
                 std::to_string(track.begin) + '\t' + std::to_string(track.end) + '\t' +
                 std::to_string(track.entry_count));
    }
    out.flush();
    return 0;
}

int region(const std::string& graph_path, const Flags& flags) {
    const gfaidx::IndexedGraph index(graph_path);
    gfaidx::RegionOptions options;
    options.include_paths = true;
    options.include_coordinates = true;
    options.threads = 1;

    const std::string mode = flags.count("mode") ? flags.at("mode") : "all";
    if (mode == "all") options.mode = gfaidx::RegionMode::all_haplotypes;
    else if (mode == "bfs") options.mode = gfaidx::RegionMode::bfs;
    else if (mode == "reference") options.mode = gfaidx::RegionMode::reference;
    else throw std::runtime_error("unknown --mode: " + mode);

    if (flags.count("context")) options.context = number(flags.at("context"), "context");
    if (flags.count("max-nodes")) {
        options.max_nodes = static_cast<std::uint32_t>(number(flags.at("max-nodes"), "max-nodes"));
    }
    if (flags.count("haplotype-gap")) {
        options.haplotype_gap = number(flags.at("haplotype-gap"), "haplotype-gap");
    }

    Output out;
    index.stream_region(require(flags, "reference"),
                        require(flags, "sequence"),
                        number(require(flags, "begin"), "begin"),
                        number(require(flags, "end"), "end"),
                        [&out](std::string_view text) { return out.line(text); },
                        options,
                        progress_to_stderr());
    out.flush();
    return 0;
}

int subgraph(const std::string& graph_path, const Flags& flags) {
    const gfaidx::IndexedGraph index(graph_path);
    gfaidx::ExtractionOptions options;
    const auto capabilities = index.capabilities();
    options.include_paths = capabilities.paths;
    options.include_coordinates = capabilities.paths && capabilities.node_lengths;
    options.threads = 1;
    options.max_nodes = flags.count("max-nodes")
        ? static_cast<std::uint32_t>(number(flags.at("max-nodes"), "max-nodes"))
        : 500;

    Output out;
    index.stream_subgraph({require(flags, "node")},
                          [&out](std::string_view text) { return out.line(text); },
                          options,
                          progress_to_stderr());
    out.flush();
    return 0;
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 3) {
        std::fprintf(stderr, "usage: gfaidx-query tracks|region|subgraph <graph> [--flag value ...]\n");
        return 2;
    }
    try {
        const std::string command = argv[1];
        const std::string graph_path = argv[2];
        if (command == "tracks") return tracks(graph_path);
        const Flags flags = parse_flags(argc, argv, 3);
        if (command == "region") return region(graph_path, flags);
        if (command == "subgraph") return subgraph(graph_path, flags);
        std::fprintf(stderr, "unknown command: %s\n", command.c_str());
        return 2;
    } catch (const std::exception& error) {
        std::fprintf(stderr, "gfaidx error: %s\n", error.what());
        return 1;
    }
}
