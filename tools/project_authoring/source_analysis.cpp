#include "source_analysis.hpp"

#include "source_authority.hpp"

#include <algorithm>
#include <cctype>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <utility>

namespace noveltea::authoring {
namespace {
struct Token {
    enum class Kind {
        Identifier,
        String,
        Punctuation
    } kind;
    std::string text;
    std::size_t begin;
    std::size_t end;
};

std::pair<std::size_t, std::size_t> location(std::string_view source, std::size_t offset)
{
    std::size_t line = 1, column = 1;
    for (std::size_t i = 0; i < offset && i < source.size(); ++i) {
        if (source[i] == '\r') {
            if (i + 1 < offset && source[i + 1] == '\n')
                ++i;
            ++line;
            column = 1;
        } else if (source[i] == '\n') {
            ++line;
            column = 1;
        } else {
            const auto byte = static_cast<unsigned char>(source[i]);
            // TypeScript source coordinates are UTF-16 code units, not UTF-8
            // bytes: a supplementary-plane scalar occupies two columns.
            if (byte < 0x80 || byte >= 0xc0)
                column += byte >= 0xf0 && byte < 0xf8 ? 2 : 1;
        }
    }
    return {line, column};
}

bool identifier_start(char value)
{
    return std::isalpha(static_cast<unsigned char>(value)) || value == '_';
}

bool identifier_part(char value)
{
    return std::isalnum(static_cast<unsigned char>(value)) || value == '_';
}

void diagnostic(SourceAnalysis& output, std::string code, std::string message, std::string severity,
                std::size_t line, std::size_t column)
{
    Diagnostic entry{"", std::move(code), std::move(message), std::move(severity)};
    entry.source_path = output.source_path;
    entry.line = line;
    entry.column = column;
    output.diagnostics.push_back(std::move(entry));
}

std::optional<std::pair<std::size_t, std::size_t>> long_bracket(std::string_view text,
                                                                std::size_t at)
{
    if (at >= text.size() || text[at] != '[')
        return std::nullopt;
    auto cursor = at + 1;
    while (cursor < text.size() && text[cursor] == '=')
        ++cursor;
    if (cursor >= text.size() || text[cursor] != '[')
        return std::nullopt;
    return {{cursor + 1, cursor - at - 1}};
}

std::string decode_quote(std::string_view source)
{
    std::string decoded;
    if (source.size() < 2)
        return decoded;
    for (std::size_t i = 1; i + 1 < source.size(); ++i) {
        if (source[i] != '\\') {
            decoded += source[i];
            continue;
        }
        if (++i + 1 >= source.size())
            break;
        switch (source[i]) {
        case 'n':
            decoded += '\n';
            break;
        case 'r':
            decoded += '\r';
            break;
        case 't':
            decoded += '\t';
            break;
        case 'z':
            while (i + 2 < source.size() && std::isspace(static_cast<unsigned char>(source[i + 1])))
                ++i;
            break;
        default:
            decoded += source[i];
            break;
        }
    }
    return decoded;
}

std::vector<Token> lua_tokens(std::string_view source, SourceAnalysis& output,
                              std::size_t base_line, std::size_t base_column)
{
    std::vector<Token> tokens;
    bool complete = true;
    for (std::size_t i = 0; i < source.size();) {
        if (source.substr(i, 2) == "--") {
            auto start = i + 2;
            if (const auto bracket = long_bracket(source, start)) {
                const auto marker = "]" + std::string(bracket->second, '=') + "]";
                const auto end = source.find(marker, bracket->first);
                if (end == std::string_view::npos) {
                    complete = false;
                    break;
                }
                i = end + marker.size();
            } else {
                i = source.find_first_of("\r\n", start);
                if (i == std::string_view::npos)
                    break;
            }
            continue;
        }
        const auto start = i;
        if (source[i] == '\'' || source[i] == '"') {
            const auto quote = source[i++];
            bool closed = false;
            while (i < source.size()) {
                if (source[i] == '\\') {
                    i += std::min<std::size_t>(2, source.size() - i);
                    continue;
                }
                if (source[i] == quote) {
                    ++i;
                    closed = true;
                    break;
                }
                if (source[i] == '\n' || source[i] == '\r')
                    break;
                ++i;
            }
            complete &= closed;
            tokens.push_back({Token::Kind::String,
                              closed ? decode_quote(source.substr(start, i - start)) : "", start,
                              i});
            continue;
        }
        if (const auto bracket = long_bracket(source, i)) {
            const auto marker = "]" + std::string(bracket->second, '=') + "]";
            const auto end = source.find(marker, bracket->first);
            if (end == std::string_view::npos) {
                complete = false;
                break;
            }
            auto decoded = std::string(source.substr(bracket->first, end - bracket->first));
            if (decoded.starts_with("\r\n"))
                decoded.erase(0, 2);
            else if (decoded.starts_with('\n') || decoded.starts_with('\r'))
                decoded.erase(0, 1);
            i = end + marker.size();
            tokens.push_back({Token::Kind::String, std::move(decoded), start, i});
            continue;
        }
        if (identifier_start(source[i])) {
            while (++i < source.size() && identifier_part(source[i])) {}
            tokens.push_back(
                {Token::Kind::Identifier, std::string(source.substr(start, i - start)), start, i});
            continue;
        }
        if (!std::isspace(static_cast<unsigned char>(source[i])))
            tokens.push_back({Token::Kind::Punctuation, std::string(1, source[i]), i, i + 1});
        ++i;
    }
    if (!complete) {
        output.complete = false;
        diagnostic(output, "authoring.lua.lexical_incomplete",
                   "Lua source contains an unterminated or unsupported lexical construct.",
                   "warning", base_line, base_column);
    }
    return tokens;
}

struct Argument {
    std::size_t first = 0;
    std::size_t last = 0; // exclusive
};

std::optional<std::pair<std::vector<Argument>, std::size_t>>
call_arguments(const std::vector<Token>& tokens, std::size_t opening)
{
    std::vector<Argument> args;
    std::vector<std::string> closers;
    auto start = opening + 1;
    for (auto i = start; i < tokens.size(); ++i) {
        const auto& value = tokens[i].text;
        if (tokens[i].kind != Token::Kind::Punctuation)
            continue;
        if (value == "(" || value == "{" || value == "[") {
            closers.push_back(value == "(" ? ")" : value == "{" ? "}" : "]");
            continue;
        }
        if (value == ")" && closers.empty()) {
            if (start != i || !args.empty())
                args.push_back({start, i});
            return {{std::move(args), i}};
        }
        if (!closers.empty() && value == closers.back()) {
            closers.pop_back();
            continue;
        }
        if (value == "," && closers.empty()) {
            args.push_back({start, i});
            start = i + 1;
        }
    }
    return std::nullopt;
}

std::optional<std::map<std::string, std::string>>
static_message_cases(const std::vector<Token>& tokens, Argument arg)
{
    if (arg.first == arg.last || tokens[arg.first].text != "{" || tokens[arg.last - 1].text != "}")
        return std::nullopt;
    std::map<std::string, std::string> cases;
    auto cursor = arg.first + 1;
    while (cursor < arg.last - 1) {
        if (tokens[cursor].text == "," || tokens[cursor].text == ";") {
            ++cursor;
            continue;
        }
        std::string key;
        if (tokens[cursor].kind == Token::Kind::Identifier)
            key = tokens[cursor++].text;
        else if (tokens[cursor].text == "[" && cursor + 2 < arg.last &&
                 tokens[cursor + 1].kind == Token::Kind::String && tokens[cursor + 2].text == "]") {
            key = tokens[cursor + 1].text;
            cursor += 3;
        } else
            return std::nullopt;
        if (key.empty() || cursor + 1 >= arg.last || tokens[cursor++].text != "=" ||
            tokens[cursor].kind != Token::Kind::String || cases.contains(key))
            return std::nullopt;
        cases.emplace(std::move(key), tokens[cursor++].text);
        if (cursor < arg.last - 1 && tokens[cursor].text != "," && tokens[cursor].text != ";")
            return std::nullopt;
    }
    return cases;
}

bool static_metadata(const std::vector<Token>& tokens, Argument arg)
{
    if (arg.first == arg.last || (arg.first + 1 == arg.last && tokens[arg.first].text == "nil"))
        return true;
    if (tokens[arg.first].text != "{" || tokens[arg.last - 1].text != "}")
        return false;
    std::set<std::string> keys;
    auto cursor = arg.first + 1;
    while (cursor < arg.last - 1) {
        if (tokens[cursor].text == "," || tokens[cursor].text == ";") {
            ++cursor;
            continue;
        }
        if (cursor + 2 >= arg.last || tokens[cursor].kind != Token::Kind::Identifier ||
            (tokens[cursor].text != "context" && tokens[cursor].text != "note") ||
            tokens[cursor + 1].text != "=" || tokens[cursor + 2].kind != Token::Kind::String ||
            !keys.insert(tokens[cursor].text).second)
            return false;
        cursor += 3;
        if (cursor < arg.last - 1 && tokens[cursor].text != "," && tokens[cursor].text != ";")
            return false;
    }
    return true;
}

std::pair<std::size_t, std::size_t> region_location(std::string_view text, std::size_t offset,
                                                    std::size_t base_line, std::size_t base_column)
{
    auto [line, column] = location(text, offset);
    return {base_line + line - 1, line == 1 ? base_column + column - 1 : column};
}

void analyze_lua(SourceAnalysis& output, std::string_view source, std::size_t base_line,
                 std::size_t base_column)
{
    if (source.size() > 4 * 1024 * 1024) {
        output.complete = false;
        diagnostic(output, "authoring.lua.source_limit",
                   "Source exceeds the fixed analysis byte limit.", "warning", base_line,
                   base_column);
        return;
    }
    const auto tokens = lua_tokens(source, output, base_line, base_column);
    for (std::size_t i = 0; i + 3 < tokens.size(); ++i) {
        if (tokens[i].kind != Token::Kind::Identifier || tokens[i].text != "Text" ||
            tokens[i + 1].text != "." || tokens[i + 2].kind != Token::Kind::Identifier ||
            tokens[i + 3].text != "(" ||
            (i && (tokens[i - 1].text == "." || tokens[i - 1].text == ":")))
            continue;
        const auto member = tokens[i + 2].text;
        if (member != "tr" && member != "msg" && member != "plural" && member != "select")
            continue;
        const auto parsed = call_arguments(tokens, i + 3);
        if (!parsed)
            continue;
        const auto& args = parsed->first;
        const auto [line, column] =
            region_location(source, tokens[i].begin, base_line, base_column);
        const auto fail = [&](std::string code, std::string message) {
            diagnostic(output, "authoring.localization.lua_" + code, std::move(message), "error",
                       line, column);
        };
        const bool selector = member == "plural" || member == "select";
        if (args.size() < (selector ? 2U : 1U) || args.size() > (member == "msg" ? 2U : 3U)) {
            fail("arity", "Text." + member + " has an unsupported argument count.");
            continue;
        }
        if (selector) {
            if (args[0].first == args[0].last) {
                fail("selector_missing", "Text." + member + " requires a selector value.");
                continue;
            }
            const auto cases = static_message_cases(tokens, args[1]);
            if (!cases) {
                fail("cases_static",
                     "Text." + member +
                         " cases must be a literal table with literal string branches.");
                continue;
            }
            if (!cases->contains("other")) {
                fail("cases_other_required", "Text." + member + " requires an 'other' case.");
                continue;
            }
            if (member == "plural" &&
                std::any_of(cases->begin(), cases->end(), [](const auto& case_entry) {
                    const auto& name = case_entry.first;
                    return name != "zero" && name != "one" && name != "two" && name != "few" &&
                           name != "many" && name != "other";
                })) {
                fail("plural_case_invalid",
                     "Text.plural cases may only use CLDR zero/one/two/few/many/other categories.");
                continue;
            }
            if (args.size() >= 3 && !static_metadata(tokens, args[2])) {
                fail("metadata_static", "Text." + member +
                                            " translator metadata must be a literal table "
                                            "containing only literal context/note values.");
                continue;
            }
            output.messages.push_back({member, cases->at("other"), output.source_path,
                                       output.source_revision, line, column});
            continue;
        }
        const auto& first = args[0];
        if (first.last != first.first + 1 || tokens[first.first].kind != Token::Kind::String) {
            fail(member == "tr" ? "source_literal" : "named_key_literal",
                 member == "tr" ? "Text.tr requires a direct string literal as its source argument."
                                : "Text.msg requires a direct string literal named Message key.");
            continue;
        }
        if (member == "tr" && args.size() >= 3 && !static_metadata(tokens, args[2])) {
            fail("metadata_static", "Text.tr translator metadata must be a literal table "
                                    "containing only literal context/note values.");
            continue;
        }
        output.messages.push_back({member == "tr" ? "local" : "named", tokens[first.first].text,
                                   output.source_path, output.source_revision, line, column});
    }
}

bool name_char(char value)
{
    return identifier_part(value) || value == '-' || value == ':' || value == '.';
}

std::string lower(std::string_view value)
{
    std::string copy(value);
    std::transform(copy.begin(), copy.end(), copy.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return copy;
}

void analyze_cursor_css(SourceAnalysis& output, std::string_view source, std::size_t base_line,
                        std::size_t base_column)
{
    std::string masked(source);
    for (std::size_t pos = 0; pos < masked.size();) {
        const auto open = masked.find("/*", pos);
        if (open == std::string::npos)
            break;
        const auto close = masked.find("*/", open + 2);
        const auto end = close == std::string::npos ? masked.size() : close + 2;
        for (auto i = open; i < end; ++i)
            if (masked[i] != '\r' && masked[i] != '\n')
                masked[i] = ' ';
        pos = end;
    }
    const auto css = lower(masked);
    for (std::size_t i = 0; i + 6 <= css.size(); ++i) {
        if (css.substr(i, 6) != "cursor")
            continue;
        auto j = i;
        while (j && std::isspace(static_cast<unsigned char>(css[j - 1])))
            --j;
        if (j && css[j - 1] != ';' && css[j - 1] != '{')
            continue;
        j = i + 6;
        while (j < css.size() && std::isspace(static_cast<unsigned char>(css[j])))
            ++j;
        if (j >= css.size() || css[j++] != ':')
            continue;
        while (j < css.size() && std::isspace(static_cast<unsigned char>(css[j])))
            ++j;
        const auto begin = j;
        if (j >= css.size() || css[j] < 'a' || css[j] > 'z')
            continue;
        while (j < css.size() && ((css[j] >= 'a' && css[j] <= 'z') ||
                                  (css[j] >= '0' && css[j] <= '9') || css[j] == '-'))
            ++j;
        const auto name = css.substr(begin, j - begin);
        while (j < css.size() && std::isspace(static_cast<unsigned char>(css[j])))
            ++j;
        if (css.substr(j, 10) == "!important") {
            j += 10;
            while (j < css.size() && std::isspace(static_cast<unsigned char>(css[j])))
                ++j;
        }
        if (j < css.size() && css[j] != ';' && css[j] != '}')
            continue;
        const auto [line, column] = region_location(source, begin, base_line, base_column);
        output.cursors.push_back({name, line, column});
        i = j;
    }
}

void analyze_rml(SourceAnalysis& output, std::string_view source)
{
    struct TranslatedNode {
        std::size_t start;
        std::size_t content_start;
        std::string key;
    };
    std::vector<TranslatedNode> translated;
    std::size_t pos = 0;
    while (pos < source.size()) {
        const auto start = source.find('<', pos);
        if (start == std::string_view::npos)
            break;
        if (source.substr(start, 4) == "<!--") {
            const auto end = source.find("-->", start + 4);
            if (end == std::string_view::npos) {
                output.complete = false;
                const auto [line, col] = location(source, start);
                diagnostic(output, "authoring.lua.rml_parse", "Unterminated RML comment.",
                           "warning", line, col);
                return;
            }
            pos = end + 3;
            continue;
        }
        if (source.substr(start, 2) == "<!" || source.substr(start, 2) == "<?") {
            const auto end = source.find('>', start + 2);
            pos = end == std::string_view::npos ? source.size() : end + 1;
            continue;
        }
        auto cursor = start + 1;
        const bool closing = cursor < source.size() && source[cursor] == '/';
        if (closing)
            ++cursor;
        const auto name_start = cursor;
        while (cursor < source.size() && name_char(source[cursor]))
            ++cursor;
        if (cursor == name_start) {
            pos = start + 1;
            continue;
        }
        const auto tag = lower(source.substr(name_start, cursor - name_start));
        std::map<std::string, std::string> attributes;
        bool terminated = false;
        while (cursor < source.size()) {
            while (cursor < source.size() &&
                   std::isspace(static_cast<unsigned char>(source[cursor])))
                ++cursor;
            if (cursor < source.size() && source[cursor] == '>') {
                ++cursor;
                terminated = true;
                break;
            }
            if (source.substr(cursor, 2) == "/>") {
                cursor += 2;
                terminated = true;
                break;
            }
            if (cursor >= source.size())
                break;
            const auto key_start = cursor;
            while (cursor < source.size() && name_char(source[cursor]))
                ++cursor;
            if (key_start == cursor) {
                ++cursor;
                continue;
            }
            const auto key = lower(source.substr(key_start, cursor - key_start));
            while (cursor < source.size() &&
                   std::isspace(static_cast<unsigned char>(source[cursor])))
                ++cursor;
            if (cursor >= source.size() || source[cursor] != '=')
                continue;
            ++cursor;
            while (cursor < source.size() &&
                   std::isspace(static_cast<unsigned char>(source[cursor])))
                ++cursor;
            if (cursor >= source.size() || (source[cursor] != '"' && source[cursor] != '\'')) {
                const auto [line, col] = location(source, cursor);
                diagnostic(output, "authoring.lua.rml_parse", "Expected a quoted RML attribute.",
                           "warning", line, col);
                output.complete = false;
                return;
            }
            const auto quote = source[cursor++];
            const auto value_start = cursor;
            const auto end = source.find(quote, cursor);
            if (end == std::string_view::npos) {
                output.complete = false;
                const auto [line, col] = location(source, cursor);
                diagnostic(output, "authoring.lua.rml_parse", "Unterminated RML attribute.",
                           "warning", line, col);
                return;
            }
            attributes[key] = std::string(source.substr(cursor, end - cursor));
            if (!closing && key == "style") {
                const auto [line, col] = location(source, value_start);
                analyze_cursor_css(output, source.substr(value_start, end - value_start), line,
                                   col);
            }
            if (!closing && key.size() > 2 && key.starts_with("on")) {
                const auto [line, col] = location(source, value_start);
                analyze_lua(output, source.substr(value_start, end - value_start), line, col);
            }
            cursor = end + 1;
        }
        if (!terminated) {
            output.complete = false;
            const auto [line, col] = location(source, start);
            diagnostic(output, "authoring.lua.rml_parse", "Unterminated RML tag.", "warning", line,
                       col);
            break;
        }
        const auto [line, col] = location(source, start);
        const bool self_closing = cursor >= 2 && source.substr(cursor - 2, 2) == "/>";
        if (tag == "nt-tr") {
            if (closing) {
                if (translated.empty()) {
                    output.complete = false;
                    diagnostic(output, "authoring.localization.rml_malformed",
                               "Unmatched closing nt-tr element.", "warning", line, col);
                } else {
                    auto node = std::move(translated.back());
                    translated.pop_back();
                    const auto [node_line, node_column] = location(source, node.start);
                    output.messages.push_back(
                        {node.key.empty() ? "local" : "named",
                         node.key.empty() ? std::string(source.substr(node.content_start,
                                                                      start - node.content_start))
                                          : std::move(node.key),
                         output.source_path, output.source_revision, node_line, node_column});
                }
            } else if (self_closing) {
                output.messages.push_back({attributes["key"].empty() ? "local" : "named",
                                           attributes["key"], output.source_path,
                                           output.source_revision, line, col});
            } else
                translated.push_back({start, cursor, attributes["key"]});
        }
        if (!closing) {
            const auto reference = [&](std::string kind, std::string_view attribute) {
                if (const auto found = attributes.find(std::string(attribute));
                    found != attributes.end())
                    output.references.push_back({std::move(kind), found->second, line, col});
            };
            if (tag == "script")
                reference("script", "src");
            if (tag == "link" && lower(attributes["type"]) == "text/template")
                reference("template-link", "href");
            if (tag == "template")
                reference("template-use", "src");
            if (tag == "body")
                reference("template-use", "template");
        }
        pos = cursor;
        if (!closing && tag == "script" && !attributes.contains("src") &&
            source.substr(cursor - 2, 2) != "/>") {
            const auto folded = lower(source.substr(cursor));
            const auto closing_tag = folded.find("</script");
            if (closing_tag == std::string::npos) {
                output.complete = false;
                diagnostic(output, "authoring.lua.rml_raw_text",
                           "Malformed or unterminated RML raw-text element.", "warning", line, col);
                break;
            }
            const auto body = source.substr(cursor, closing_tag);
            const auto [body_line, body_col] = location(source, cursor);
            analyze_lua(output, body, body_line, body_col);
            pos = cursor + closing_tag;
        }
        if (!closing && tag == "style" && !self_closing) {
            const auto closing_tag = lower(source.substr(cursor)).find("</style");
            if (closing_tag != std::string::npos) {
                const auto [body_line, body_column] = location(source, cursor);
                analyze_cursor_css(output, source.substr(cursor, closing_tag), body_line,
                                   body_column);
                pos = cursor + closing_tag;
            }
        }
    }
    if (!translated.empty()) {
        output.complete = false;
        const auto [line, column] = location(source, translated.back().start);
        diagnostic(output, "authoring.localization.rml_malformed", "Unterminated nt-tr element.",
                   "warning", line, column);
    }
}
} // namespace

SourceAnalysis analyze_project_text(std::string_view relative_path, std::string_view text)
{
    SourceAnalysis result;
    result.source_path = std::string(relative_path);
    result.source_revision = exact_source_revision(text);
    if (relative_path.ends_with(".lua"))
        analyze_lua(result, text, 1, 1);
    else if (relative_path.ends_with(".rml"))
        analyze_rml(result, text);
    else if (relative_path.ends_with(".rcss"))
        analyze_cursor_css(result, text, 1, 1);
    return result;
}
} // namespace noveltea::authoring
