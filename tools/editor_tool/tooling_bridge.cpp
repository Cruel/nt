#include "tooling_native_c.h"

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

int main(int argc, char** argv)
{
    if (argc != 4) {
        std::fprintf(stderr,
                     "usage: noveltea-tooling-bridge <operation> <request.json> <response.json>\n");
        return 64;
    }

    std::ifstream input(argv[2], std::ios::binary);
    if (!input) {
        std::fprintf(stderr, "failed to open native-tool request: %s\n", argv[2]);
        return 66;
    }
    const std::vector<std::uint8_t> request(std::istreambuf_iterator<char>(input), {});
    if (!input.eof() && input.fail()) {
        std::fprintf(stderr, "failed to read native-tool request: %s\n", argv[2]);
        return 74;
    }

    const auto* operation = reinterpret_cast<const std::uint8_t*>(argv[1]);
    const auto* response_path = reinterpret_cast<const std::uint8_t*>(argv[3]);
    noveltea_tooling_scriptc_invoke_to_file(operation, std::strlen(argv[1]), request.data(),
                                            request.size(), response_path, std::strlen(argv[3]));
    return 0;
}
