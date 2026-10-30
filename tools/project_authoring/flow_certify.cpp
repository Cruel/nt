#include "contracts.hpp"

#include <jsoncons/json.hpp>

#include <algorithm>
#include <iostream>
#include <string>
#include <string_view>

// Streaming Zod differential seam. Inputs are one JSON object per line; the
// output includes normalized JSON and full diagnostic paths/codes. It does not
// execute a Gameplay Command or require a runtime or editor dependency.
int main(int argc, char** argv)
{
    using Json = jsoncons::ojson;
    if (argc == 2 && std::string_view(argv[1]) == "--self-test") {
        // validate_record checks every generated operation in the reachable
        // schema graph before parsing, not just those on the supplied branch.
        const auto condition =
            noveltea::authoring::validate_record("Condition", R"({"kind":"always"})");
        const auto command = noveltea::authoring::validate_record(
            "GameplayCommand", R"({"id":"check-flow","kind":"run-lua","source":"return true"})");
        const auto unsupported = noveltea::authoring::validate_record("Project", "{}");
        const auto condition_again =
            noveltea::authoring::validate_record("Condition", R"({"kind":"always"})");
        const auto unsupported_again = noveltea::authoring::validate_record("Project", "{}");
        const auto has_unsupported = [](const auto& result) {
            return std::any_of(
                result.diagnostics.begin(), result.diagnostics.end(), [](const auto& issue) {
                    return issue.code == "contract.unsupported_operation" &&
                           issue.message.find("editor.recovery-pointer") != std::string::npos;
                });
        };
        if (!condition.accepted || !condition_again.accepted || !command.accepted ||
            unsupported.accepted || !has_unsupported(unsupported) ||
            !has_unsupported(unsupported_again) ||
            unsupported.diagnostics.size() != unsupported_again.diagnostics.size()) {
            std::cerr << "Native Flow operation registration is incomplete.\n";
            return 1;
        }
        return 0;
    }
    if (argc != 1)
        return 2;
    std::string input;
    while (std::getline(std::cin, input)) {
        try {
            const auto request = Json::parse(input);
            const auto contract = request.at("contract").as<std::string>();
            if (contract != "Condition" && contract != "GameplayCommand")
                return 2;
            const auto result =
                noveltea::authoring::validate_record(contract, request.at("value").to_string());
            Json response = Json::object();
            response["accepted"] = result.accepted;
            if (result.accepted)
                response["normalized"] = Json::parse(result.effective_json);
            Json diagnostics = Json::array();
            for (const auto& diagnostic : result.diagnostics) {
                Json item = Json::object();
                item["path"] = diagnostic.path;
                item["code"] = diagnostic.code;
                item["severity"] = diagnostic.severity;
                diagnostics.push_back(std::move(item));
            }
            response["diagnostics"] = std::move(diagnostics);
            std::cout << response.to_string() << '\n';
        } catch (const std::exception& exception) {
            std::cerr << "Native Flow certification input rejected: " << exception.what() << '\n';
            return 1;
        }
    }
}
