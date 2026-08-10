#include "tooling_native.hpp"

#include <iostream>
#include <sstream>
#include <string>

namespace {

std::string read_stdin()
{
    std::ostringstream buffer;
    buffer << std::cin.rdbuf();
    return buffer.str();
}

} // namespace

int main(int argc, char** argv)
{
    if (argc < 2) {
        std::cerr << "Usage: noveltea-editor-tool <command>\n";
        return 2;
    }

    const auto result = noveltea::tooling::invoke_legacy_command(argv[1], read_stdin());
    std::cout << result.response_json << '\n';
    return result.exit_code;
}
