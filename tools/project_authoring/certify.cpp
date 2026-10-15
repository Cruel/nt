#include "contracts.hpp"

#include <iostream>
#include <iterator>
#include <string>

int main(int argc, char** argv)
{
    if (argc != 2)
        return 2;
    if (std::string(argv[1]) == "--self-test") {
        const auto valid = noveltea::authoring::validate_record(
            "Condition",
            R"({"kind":"all","conditions":[{"kind":"lua-predicate","source":"return true"}]})");
        const auto invalid = noveltea::authoring::validate_record(
            "Condition", R"({"kind":"not","condition":{"kind":"lua-predicate","source":5}})");
        const auto malformed = noveltea::authoring::validate_record("Condition", "{");
        const auto unsupported = noveltea::authoring::validate_record("Project", "{}");
        if (!valid.accepted || invalid.accepted || malformed.accepted || unsupported.accepted ||
            invalid.diagnostics.empty() || invalid.diagnostics[0].path != "/condition/source") {
            std::cerr << noveltea::authoring::validation_result_json(valid) << '\n'
                      << noveltea::authoring::validation_result_json(invalid) << '\n';
            return 1;
        }
        return 0;
    }
    const std::string source{std::istreambuf_iterator<char>(std::cin),
                             std::istreambuf_iterator<char>()};
    std::cout << noveltea::authoring::validation_result_json(
                     noveltea::authoring::validate_record(argv[1], source))
              << '\n';
}
