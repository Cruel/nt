#include "noveltea/core/data_asset_codec.hpp"

#include <nlohmann/json.hpp>

#include <cmath>
#include <limits>
#include <optional>
#include <unordered_set>

namespace noveltea::core {
namespace {

class DataDecoder final : public nlohmann::json_sax<nlohmann::json> {
public:
    bool null() override { return append(PersistableValue{std::monostate{}}); }
    bool boolean(bool value) override { return append(PersistableValue{value}); }
    bool number_integer(number_integer_t value) override { return append(PersistableValue{value}); }
    bool number_unsigned(number_unsigned_t value) override
    {
        if (value > static_cast<number_unsigned_t>(std::numeric_limits<std::int64_t>::max()))
            return fail("JSON integer is outside the signed 64-bit range");
        return append(PersistableValue{static_cast<std::int64_t>(value)});
    }
    bool number_float(number_float_t value, const string_t& token) override
    {
        if (!std::isfinite(value) || token.find_first_of(".eE") == std::string::npos)
            return fail("JSON number is non-finite or outside the signed 64-bit integer range");
        return append(PersistableValue{value});
    }
    bool string(string_t& value) override { return append(PersistableValue{std::move(value)}); }
    bool binary(binary_t&) override { return fail("Binary JSON is not supported"); }
    bool start_object(std::size_t) override { return start(PersistableValue::Object{}); }
    bool start_array(std::size_t) override { return start(PersistableValue::Array{}); }
    bool key(string_t& value) override
    {
        auto& frame = frames.back();
        if (!frame.keys.insert(value).second)
            return fail("JSON object contains a duplicate key");
        frame.key = std::move(value);
        return true;
    }
    bool end_object() override { return finish(); }
    bool end_array() override { return finish(); }
    bool parse_error(std::size_t, const std::string&, const nlohmann::detail::exception&) override
    {
        return fail("Malformed JSON data Asset");
    }

    std::optional<PersistableValue> result;
    std::string error;

private:
    struct Frame {
        PersistableValue value;
        std::string key;
        std::unordered_set<std::string> keys;
    };
    std::vector<Frame> frames;
    std::size_t nodes = 0;

    bool fail(std::string message)
    {
        error = std::move(message);
        return false;
    }
    bool start(PersistableValue::Value value)
    {
        if (frames.size() >= 64)
            return fail("JSON data Asset exceeds 64 container levels");
        frames.push_back({PersistableValue{std::move(value)}, {}, {}});
        return true;
    }
    bool finish()
    {
        auto value = std::move(frames.back().value);
        frames.pop_back();
        return append(std::move(value));
    }
    bool append(PersistableValue value)
    {
        if (++nodes > 100000)
            return fail("JSON data Asset exceeds 100000 values");
        if (frames.empty())
            result = std::move(value);
        else if (auto* array = std::get_if<PersistableValue::Array>(&frames.back().value.value))
            array->push_back(std::move(value));
        else
            std::get<PersistableValue::Object>(frames.back().value.value)
                .emplace_back(std::move(frames.back().key), std::move(value));
        return true;
    }
};

} // namespace

Result<PersistableValue, std::string> decode_data_asset(std::string_view source)
{
    using Result = core::Result<PersistableValue, std::string>;
    if (source.size() > 4 * 1024 * 1024)
        return Result::failure("JSON data Asset exceeds 4 MiB");
    DataDecoder decoder;
    if (!nlohmann::json::sax_parse(source.begin(), source.end(), &decoder))
        return Result::failure(std::move(decoder.error));
    return Result::success(std::move(*decoder.result));
}

} // namespace noveltea::core
