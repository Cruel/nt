#include <noveltea/core/fingerprint.hpp>

#include <cstdlib>
#include <iostream>
#include <string>
#include <string_view>

using noveltea::core::xxh3_128_revision;
using noveltea::core::Xxh3Hasher;

namespace {

bool verify(std::string_view source, std::string_view expected)
{
    if (xxh3_128_revision(source) != expected)
        return false;
    for (auto chunk : {std::size_t(1), std::size_t(3), std::size_t(55), std::size_t(56),
                       std::size_t(63), std::size_t(64), std::size_t(65), std::size_t(127),
                       std::size_t(128), std::size_t(4096), source.size() + 1}) {
        Xxh3Hasher hasher;
        for (std::size_t pos = 0; pos < source.size(); pos += chunk)
            hasher.update(source.substr(pos, chunk));
        if (hasher.finish() != expected)
            return false;
    }
    return true;
}

} // namespace

int main()
{
    // XXH3-128 zero-seed reference results independently generated with libxxhash.
    constexpr std::string_view empty = "xxh3-128:99aa06d3014798d86001c324468d497f";
    constexpr std::string_view abc = "xxh3-128:06b05ab6733a618578af5f94892f3950";
    constexpr std::string_view million = "xxh3-128:a545df8e384a9579b1fd6fae5285c4eb";
    constexpr std::string_view binary_reference = "xxh3-128:cadc423d662477d4c5822592d3d90b3a";
    const std::string one_million_a(1'000'000, 'a');
    const std::string binary("\0\xff\x01\0\x80", 5);
    if (!verify("", empty) || !verify("abc", abc) || !verify(one_million_a, million) ||
        !verify(binary, binary_reference)) {
        std::cerr << "XXH3-128 reference or streaming mismatch\n";
        return EXIT_FAILURE;
    }
    for (auto n : {std::size_t(1), std::size_t(55), std::size_t(56), std::size_t(63),
                   std::size_t(64), std::size_t(65), std::size_t(127), std::size_t(128),
                   std::size_t(129), std::size_t(100'000), std::size_t(6'235'344)}) {
        std::string data(n, '\0');
        for (std::size_t i = 0; i < n; ++i)
            data[i] = static_cast<char>((i * 131 + i / 11) & 255);
        if (!verify(data, xxh3_128_revision(data))) {
            std::cerr << "XXH3-128 streaming mismatch at length " << n << "\n";
            return EXIT_FAILURE;
        }
    }
    std::cout << "XXH3-128 reference vectors, binary and chunked input passed\n";
}
