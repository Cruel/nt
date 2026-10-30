// Host-only comparison of the selected XXH3 source fingerprint and BLAKE3.
#include <noveltea/core/fingerprint.hpp>

extern "C" {
#include <libfyaml/libfyaml-blake3.h>
}

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <dlfcn.h>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <new>
#include <string>
#include <vector>

#if defined(__x86_64__) || defined(__i386__)
#include <x86intrin.h>
#endif

static std::atomic<std::size_t> cpp_allocations{0};
static std::atomic<bool> count_allocations{false};

void* operator new(std::size_t n)
{
    if (count_allocations)
        ++cpp_allocations;
    if (void* p = std::malloc(n ? n : 1))
        return p;
    throw std::bad_alloc();
}
void operator delete(void* p) noexcept { std::free(p); }
void operator delete(void* p, std::size_t) noexcept { std::free(p); }

namespace {

volatile std::uint64_t sink = 0;
using Clock = std::chrono::steady_clock;
using XXH3Hash = struct {
    std::uint64_t low64;
    std::uint64_t high64;
};
using XXH3 = XXH3Hash (*)(const void*, std::size_t);

std::uint64_t cycles()
{
#if defined(__x86_64__) || defined(__i386__)
    unsigned int aux = 0;
    return __rdtscp(&aux);
#else
    return 0;
#endif
}

template<typename F>
void measure(const std::string& sample, const std::string& label, const std::string& bytes,
             std::size_t chunk, F&& hash)
{
    const auto repeats =
        std::clamp<std::size_t>(200'000'000 / std::max(bytes.size(), std::size_t(1)), 20, 2000);
    hash(bytes, chunk);
    cpp_allocations = 0;
    count_allocations = true;
    const auto c0 = cycles();
    const auto t0 = Clock::now();
    for (std::size_t i = 0; i < repeats; ++i)
        hash(bytes, chunk);
    const auto t1 = Clock::now();
    const auto c1 = cycles();
    count_allocations = false;
    const auto ns = std::chrono::duration<double, std::nano>(t1 - t0).count() / repeats;
    const auto mib_per_s = bytes.empty() ? 0 : bytes.size() * 1e9 / (ns * 1024 * 1024);
    const auto cycles_per_byte = bytes.empty() ? 0 : double(c1 - c0) / repeats / bytes.size();
    std::cout << sample << "," << bytes.size() << "," << label << "," << chunk << "," << ns << ","
              << mib_per_s << "," << cycles_per_byte << ","
              << double(cpp_allocations.load()) / repeats << "\n";
}

std::string file_bytes(const std::filesystem::path& path)
{
    std::ifstream input(path, std::ios::binary);
    return {std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
}

} // namespace

int main(int argc, char** argv)
{
    if (argc < 2) {
        std::cerr << "Usage: source_hash_benchmark FEATURE_LAB_ROOT\n";
        return 2;
    }
    // libfyaml's pinned BLAKE3 is a candidate only; it must not become a
    // transitive dependency of the source-authority API.
    fy_blake3_hasher_cfg cfg{};
    cfg.num_threads = -1;
    auto* blake = fy_blake3_hasher_create(&cfg);
    cfg.backend = "portable";
    auto* portable_blake = fy_blake3_hasher_create(&cfg);
    auto* lib = dlopen("libxxhash.so.0", RTLD_NOW | RTLD_LOCAL);
    const auto xxh3 = lib ? reinterpret_cast<XXH3>(dlsym(lib, "XXH3_128bits")) : nullptr;
    if (!blake || !portable_blake || !xxh3) {
        std::cerr << "Benchmark requires pinned fyaml BLAKE3 and isolated libxxhash.so.0\n";
        return 2;
    }
    auto fast = [](std::string_view bytes, std::size_t chunk) {
        noveltea::core::Xxh3Hasher hasher;
        for (std::size_t off = 0; off < bytes.size(); off += chunk)
            hasher.update(bytes.substr(off, chunk));
        const auto output = hasher.finish();
        sink = sink ^ std::uint64_t(output.back());
    };
    auto b3 = [](fy_blake3_hasher* hasher, std::string_view bytes, std::size_t chunk) {
        fy_blake3_hasher_reset(hasher);
        for (std::size_t off = 0; off < bytes.size(); off += chunk)
            fy_blake3_hasher_update(hasher, bytes.data() + off,
                                    std::min(chunk, bytes.size() - off));
        const auto output = fy_blake3_hasher_finalize(hasher);
        sink = sink ^ std::uint64_t(output[0]);
    };
    const auto lab = std::filesystem::path(argv[1]);
    std::vector<std::pair<std::string, std::string>> samples;
    samples.emplace_back("empty", "");
    samples.emplace_back("one-byte", "x");
    for (const auto size : {1024, 100'000, 700'000, 6'235'344}) {
        std::string random(size, '\0');
        std::uint32_t seed = 0x12345678;
        for (auto& c : random) {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            c = static_cast<char>(seed);
        }
        samples.emplace_back("random-" + std::to_string(size), std::move(random));
        samples.emplace_back("repeated-" + std::to_string(size), std::string(size, 'a'));
    }
    for (const auto& file : std::filesystem::recursive_directory_iterator(lab / "assets")) {
        if (file.is_regular_file() && file.path().extension() == ".ttf" &&
            file.file_size() >= 500'000)
            samples.emplace_back(file.path().filename().string(), file_bytes(file.path()));
    }
    std::cout
        << "sample,bytes,algorithm,chunk,ns_per_hash,MiB_per_s,cycles_per_byte,cpp_news_per_hash\n";
    for (const auto& [name, bytes] : samples) {
        for (const std::size_t chunk : {std::size_t(65'536), std::size_t(1024)}) {
            measure(name, "xxh3-128-stream", bytes, chunk,
                    [&](const auto& s, auto n) { fast(s, n); });
            measure(name, "blake3-dispatch", bytes, chunk,
                    [&](const auto& s, auto n) { b3(blake, s, n); });
            measure(name, "blake3-portable", bytes, chunk,
                    [&](const auto& s, auto n) { b3(portable_blake, s, n); });
            // Compare directly against the host library's same-algorithm reference.
            if (chunk == 65'536)
                measure(name, "xxh3-128-reference", bytes, bytes.size(), [&](const auto& s, auto) {
                    const auto output = xxh3(s.data(), s.size());
                    sink = sink ^ output.low64;
                });
        }
    }
    fy_blake3_hasher_destroy(blake);
    fy_blake3_hasher_destroy(portable_blake);
    dlclose(lib);
}
