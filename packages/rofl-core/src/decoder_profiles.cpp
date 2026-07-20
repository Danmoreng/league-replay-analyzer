#include "rofl/core/decoder_profiles.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <charconv>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <limits>
#include <set>
#include <sstream>
#include <stdexcept>
#include <utility>

namespace rofl::core {
namespace {

constexpr std::size_t kMaximumProfileBytes = 256 * 1024;
constexpr std::size_t kMaximumJsonDepth = 32;
constexpr std::size_t kMaximumProfiles = 128;
constexpr std::size_t kMaximumRuleCount = 64;
constexpr std::size_t kMaximumContentLength = 1024 * 1024;

struct JsonValue {
    enum class Kind { null_value, boolean, number, string, array, object };
    Kind kind = Kind::null_value;
    bool boolean = false;
    std::uint64_t number = 0;
    std::string string;
    std::vector<JsonValue> array;
    std::vector<std::pair<std::string, JsonValue>> object;
};

class JsonParser {
public:
    explicit JsonParser(std::string_view input) : input_(input) {}

    [[nodiscard]] JsonValue parse() {
        skip_whitespace();
        JsonValue value = parse_value(0);
        skip_whitespace();
        if (position_ != input_.size()) fail("trailing data after root value");
        return value;
    }

private:
    std::string_view input_;
    std::size_t position_ = 0;

    [[noreturn]] void fail(std::string_view message) const {
        throw std::runtime_error("profile JSON at byte " + std::to_string(position_) + ": " + std::string(message));
    }
    void skip_whitespace() {
        while (position_ < input_.size() && (input_[position_] == ' ' || input_[position_] == '\n' || input_[position_] == '\r' || input_[position_] == '\t')) ++position_;
    }
    [[nodiscard]] char take() {
        if (position_ == input_.size()) fail("unexpected end of input");
        return input_[position_++];
    }
    void require(char expected) {
        if (take() != expected) fail(std::string("expected '") + expected + "'");
    }
    [[nodiscard]] JsonValue parse_value(std::size_t depth) {
        if (depth > kMaximumJsonDepth) fail("maximum nesting depth exceeded");
        if (position_ == input_.size()) fail("expected a value");
        switch (input_[position_]) {
            case '{': return parse_object(depth + 1);
            case '[': return parse_array(depth + 1);
            case '"': { JsonValue v; v.kind = JsonValue::Kind::string; v.string = parse_string(); return v; }
            case 't': consume_literal("true"); { JsonValue v; v.kind = JsonValue::Kind::boolean; v.boolean = true; return v; }
            case 'f': consume_literal("false"); { JsonValue v; v.kind = JsonValue::Kind::boolean; return v; }
            case 'n': consume_literal("null"); return {};
            default:
                if (input_[position_] >= '0' && input_[position_] <= '9') return parse_number();
                fail("expected object, array, string, integer, boolean, or null");
        }
    }
    void consume_literal(std::string_view literal) {
        if (input_.substr(position_, literal.size()) != literal) fail("invalid literal");
        position_ += literal.size();
    }
    [[nodiscard]] JsonValue parse_object(std::size_t depth) {
        JsonValue result; result.kind = JsonValue::Kind::object; require('{'); skip_whitespace();
        std::set<std::string> keys;
        if (position_ < input_.size() && input_[position_] == '}') { ++position_; return result; }
        while (true) {
            skip_whitespace();
            if (position_ == input_.size() || input_[position_] != '"') fail("object key must be a string");
            std::string key = parse_string();
            if (!keys.insert(key).second) fail("duplicate object key '" + key + "'");
            skip_whitespace(); require(':'); skip_whitespace();
            result.object.emplace_back(std::move(key), parse_value(depth));
            skip_whitespace();
            const char delimiter = take();
            if (delimiter == '}') break;
            if (delimiter != ',') fail("expected ',' or '}' in object");
            skip_whitespace();
        }
        return result;
    }
    [[nodiscard]] JsonValue parse_array(std::size_t depth) {
        JsonValue result; result.kind = JsonValue::Kind::array; require('['); skip_whitespace();
        if (position_ < input_.size() && input_[position_] == ']') { ++position_; return result; }
        while (true) {
            result.array.push_back(parse_value(depth)); skip_whitespace();
            const char delimiter = take();
            if (delimiter == ']') break;
            if (delimiter != ',') fail("expected ',' or ']' in array");
            skip_whitespace();
        }
        return result;
    }
    [[nodiscard]] JsonValue parse_number() {
        const std::size_t start = position_;
        if (input_[position_] == '0') ++position_;
        else while (position_ < input_.size() && std::isdigit(static_cast<unsigned char>(input_[position_]))) ++position_;
        if (position_ < input_.size() && (input_[position_] == '.' || input_[position_] == 'e' || input_[position_] == 'E' || input_[position_] == '-')) fail("only non-negative integer numbers are allowed");
        std::uint64_t value = 0;
        const auto parsed = std::from_chars(input_.data() + start, input_.data() + position_, value);
        if (parsed.ec != std::errc{} || parsed.ptr != input_.data() + position_) fail("invalid integer");
        JsonValue result; result.kind = JsonValue::Kind::number; result.number = value; return result;
    }
    [[nodiscard]] std::string parse_string() {
        require('"'); std::string value;
        while (true) {
            if (position_ == input_.size()) fail("unterminated string");
            const unsigned char c = static_cast<unsigned char>(take());
            if (c == '"') break;
            if (c < 0x20) fail("control character in string");
            if (c != '\\') { value.push_back(static_cast<char>(c)); continue; }
            const char escape = take();
            switch (escape) {
                case '"': value.push_back('"'); break; case '\\': value.push_back('\\'); break;
                case '/': value.push_back('/'); break; case 'b': value.push_back('\b'); break;
                case 'f': value.push_back('\f'); break; case 'n': value.push_back('\n'); break;
                case 'r': value.push_back('\r'); break; case 't': value.push_back('\t'); break;
                default: fail("unsupported string escape; profile schema requires ASCII literals");
            }
        }
        return value;
    }
};

[[nodiscard]] const JsonValue& field(const JsonValue& object, std::string_view name, bool required = true) {
    if (object.kind != JsonValue::Kind::object) throw std::runtime_error("profile schema: expected object");
    for (const auto& [key, value] : object.object) if (key == name) return value;
    if (required) throw std::runtime_error("profile schema: missing required field '" + std::string(name) + "'");
    static const JsonValue null_value{}; return null_value;
}
void allow_only(const JsonValue& object, std::initializer_list<std::string_view> allowed) {
    for (const auto& [key, _] : object.object) {
        if (std::find(allowed.begin(), allowed.end(), key) == allowed.end()) throw std::runtime_error("profile schema: unknown field '" + key + "'");
    }
}
[[nodiscard]] std::string string_value(const JsonValue& value, std::string_view name, std::size_t maximum = 256) {
    if (value.kind != JsonValue::Kind::string || value.string.empty() || value.string.size() > maximum) throw std::runtime_error("profile schema: '" + std::string(name) + "' must be a non-empty string");
    return value.string;
}
[[nodiscard]] std::uint64_t integer_value(const JsonValue& value, std::string_view name, std::uint64_t maximum) {
    if (value.kind != JsonValue::Kind::number || value.number > maximum) throw std::runtime_error("profile schema: '" + std::string(name) + "' is outside its allowed unsigned range");
    return value.number;
}
[[nodiscard]] bool bool_value(const JsonValue& value, std::string_view name) {
    if (value.kind != JsonValue::Kind::boolean) throw std::runtime_error("profile schema: '" + std::string(name) + "' must be boolean");
    return value.boolean;
}
[[nodiscard]] bool version_group_is_valid(std::string_view value) {
    const std::size_t dot = value.find('.');
    return dot != std::string_view::npos && dot > 0 && dot + 1 < value.size() && value.find('.', dot + 1) == std::string_view::npos &&
        std::all_of(value.begin(), value.end(), [](char c) { return std::isdigit(static_cast<unsigned char>(c)) || c == '.'; });
}
[[nodiscard]] ObjectiveMonsterClass monster_class(const JsonValue& value) {
    const std::string text = string_value(value, "class", 24);
    if (text == "DRAGON") return ObjectiveMonsterClass::dragon;
    if (text == "ATAKHAN") return ObjectiveMonsterClass::atakhan;
    if (text == "BARON_NASHOR") return ObjectiveMonsterClass::baron;
    if (text == "RIFTHERALD") return ObjectiveMonsterClass::herald;
    if (text == "HORDE") return ObjectiveMonsterClass::horde;
    throw std::runtime_error("profile schema: unknown objective class '" + text + "'");
}
[[nodiscard]] std::vector<std::size_t> length_array(const JsonValue& value, std::string_view name, std::size_t maximum_count = 8) {
    if (value.kind != JsonValue::Kind::array || value.array.empty() || value.array.size() > maximum_count) throw std::runtime_error("profile schema: '" + std::string(name) + "' must be a non-empty bounded array");
    std::set<std::size_t> seen; std::vector<std::size_t> result;
    for (const JsonValue& element : value.array) { const auto item = static_cast<std::size_t>(integer_value(element, name, kMaximumContentLength)); if (!seen.insert(item).second) throw std::runtime_error("profile schema: duplicate value in '" + std::string(name) + "'"); result.push_back(item); }
    return result;
}
[[nodiscard]] ContentLengthConstraint length_constraint(const JsonValue& value, std::string_view name) {
    if (value.kind != JsonValue::Kind::object) throw std::runtime_error("profile schema: '" + std::string(name) + "' must be an object");
    allow_only(value, {"exact", "minimum", "maximum"});
    ContentLengthConstraint result;
    const JsonValue& exact = field(value, "exact", false);
    if (exact.kind != JsonValue::Kind::null_value) result.exact_values = length_array(exact, name);
    const JsonValue& minimum = field(value, "minimum", false);
    const JsonValue& maximum = field(value, "maximum", false);
    if (minimum.kind != JsonValue::Kind::null_value) result.minimum = static_cast<std::size_t>(integer_value(minimum, name, kMaximumContentLength));
    if (maximum.kind != JsonValue::Kind::null_value) result.maximum = static_cast<std::size_t>(integer_value(maximum, name, kMaximumContentLength));
    if (result.exact_values.empty() && !result.minimum && !result.maximum) throw std::runtime_error("profile schema: '" + std::string(name) + "' requires exact and/or min/max");
    if (result.minimum.has_value() != result.maximum.has_value()) throw std::runtime_error("profile schema: '" + std::string(name) + "' min/max must occur together");
    if (result.minimum && *result.minimum > *result.maximum) throw std::runtime_error("profile schema: '" + std::string(name) + "' minimum exceeds maximum");
    if ((result.minimum && *result.minimum == 0) || std::find(result.exact_values.begin(), result.exact_values.end(), 0) != result.exact_values.end()) throw std::runtime_error("profile schema: '" + std::string(name) + "' cannot contain zero length");
    return result;
}
[[nodiscard]] std::vector<std::uint8_t> byte_array(
    const JsonValue& value,
    std::string_view name,
    std::size_t maximum_count = 16
) {
    if (value.kind != JsonValue::Kind::array || value.array.empty() || value.array.size() > maximum_count) throw std::runtime_error("profile schema: '" + std::string(name) + "' must be a non-empty bounded array");
    std::set<std::uint8_t> seen; std::vector<std::uint8_t> result;
    for (const JsonValue& element : value.array) { const auto item = static_cast<std::uint8_t>(integer_value(element, name, 255)); if (!seen.insert(item).second) throw std::runtime_error("profile schema: duplicate value in '" + std::string(name) + "'"); result.push_back(item); }
    return result;
}

template <std::size_t Count>
[[nodiscard]] std::array<std::optional<std::uint8_t>, Count> fixed_partial_byte_permutation(
    const JsonValue& value,
    std::string_view name
) {
    if (value.kind != JsonValue::Kind::array || value.array.size() != Count) {
        throw std::runtime_error("profile schema: '" + std::string(name) +
            "' must contain exactly " + std::to_string(Count) + " byte values or nulls");
    }
    std::array<std::optional<std::uint8_t>, Count> result{};
    std::array<bool, Count> seen{};
    for (std::size_t index = 0; index < Count; ++index) {
        if (value.array[index].kind == JsonValue::Kind::null_value) continue;
        const std::uint8_t item = static_cast<std::uint8_t>(
            integer_value(value.array[index], name, 255));
        if (seen[item]) {
            throw std::runtime_error("profile schema: '" + std::string(name) +
                "' known values must be injective");
        }
        seen[item] = true;
        result[index] = item;
    }
    return result;
}

template <std::size_t Count>
[[nodiscard]] std::array<std::size_t, Count> fixed_offsets(
    const JsonValue& value,
    std::string_view name,
    std::size_t content_length
) {
    if (value.kind != JsonValue::Kind::array || value.array.size() != Count) {
        throw std::runtime_error("profile schema: '" + std::string(name) +
            "' must contain exactly " + std::to_string(Count) + " offsets");
    }
    std::array<std::size_t, Count> result{};
    std::set<std::size_t> seen;
    for (std::size_t index = 0; index < Count; ++index) {
        result[index] = static_cast<std::size_t>(
            integer_value(value.array[index], name, kMaximumContentLength));
        if (result[index] >= content_length || !seen.insert(result[index]).second) {
            throw std::runtime_error("profile schema: '" + std::string(name) +
                "' offsets must be distinct and in bounds");
        }
    }
    return result;
}

[[nodiscard]] std::vector<std::uint16_t> sorted_uint16_array(
    const JsonValue& value,
    std::string_view name,
    std::size_t maximum_count
) {
    if (value.kind != JsonValue::Kind::array || value.array.empty() ||
        value.array.size() > maximum_count) {
        throw std::runtime_error(
            "profile schema: '" + std::string(name) +
            "' must be a non-empty bounded array");
    }
    std::vector<std::uint16_t> result;
    result.reserve(value.array.size());
    for (const JsonValue& element : value.array) {
        const auto item = static_cast<std::uint16_t>(
            integer_value(element, name, 0xffff));
        if (item == 0 || (!result.empty() && result.back() >= item)) {
            throw std::runtime_error(
                "profile schema: '" + std::string(name) +
                "' must be strictly sorted and unique");
        }
        result.push_back(item);
    }
    return result;
}

[[nodiscard]] KillDecoderProfile parse_kill(const JsonValue& value) {
    allow_only(value, {"channel", "ownerSequencePacketType", "deathMarkerPacketType", "deathMarkerContentLength", "championNetworkIdBase", "timestampToleranceMillis", "ownerOrder"});
    KillDecoderProfile profile;
    profile.channel = static_cast<std::uint8_t>(integer_value(field(value, "channel"), "channel", 15));
    profile.owner_sequence_packet_type = static_cast<std::uint16_t>(integer_value(field(value, "ownerSequencePacketType"), "ownerSequencePacketType", 0xffff));
    profile.death_marker_packet_type = static_cast<std::uint16_t>(integer_value(field(value, "deathMarkerPacketType"), "deathMarkerPacketType", 0xffff));
    profile.death_marker_content_length = static_cast<std::size_t>(integer_value(field(value, "deathMarkerContentLength"), "deathMarkerContentLength", kMaximumContentLength));
    profile.champion_network_id_base = static_cast<std::uint32_t>(integer_value(field(value, "championNetworkIdBase"), "championNetworkIdBase", 0xffffffffULL));
    profile.timestamp_tolerance_millis = static_cast<std::size_t>(integer_value(field(value, "timestampToleranceMillis"), "timestampToleranceMillis", 1000));
    const JsonValue& order = field(value, "ownerOrder", false);
    profile.owner_order = order.kind == JsonValue::Kind::null_value ? "victim-assists-killer" : string_value(order, "ownerOrder", 64);
    if (profile.channel == 0 || profile.death_marker_content_length == 0 || profile.champion_network_id_base == 0 || profile.owner_order != "victim-assists-killer") throw std::runtime_error("profile schema: invalid kill profile invariants");
    return profile;
}

[[nodiscard]] ObjectiveDecoderProfile parse_objective(const JsonValue& value) {
    allow_only(value, {"channel", "packetType", "minimumContentLength", "maximumContentLength", "discriminator", "contentLengthClasses"});
    ObjectiveDecoderProfile profile;
    profile.channel = static_cast<std::uint8_t>(integer_value(field(value, "channel"), "channel", 15));
    profile.packet_type = static_cast<std::uint16_t>(integer_value(field(value, "packetType"), "packetType", 0xffff));
    profile.minimum_content_length = static_cast<std::size_t>(integer_value(field(value, "minimumContentLength"), "minimumContentLength", kMaximumContentLength));
    profile.maximum_content_length = static_cast<std::size_t>(integer_value(field(value, "maximumContentLength"), "maximumContentLength", kMaximumContentLength));
    const JsonValue& discriminator = field(value, "discriminator");
    allow_only(discriminator, {"origin", "offset", "values"});
    const std::string origin = string_value(field(discriminator, "origin"), "origin", 8);
    if (origin == "start") profile.discriminator_origin = PayloadOffsetOrigin::start;
    else if (origin == "end") profile.discriminator_origin = PayloadOffsetOrigin::end;
    else throw std::runtime_error("profile schema: discriminator origin must be start or end");
    profile.discriminator_offset = static_cast<std::size_t>(integer_value(field(discriminator, "offset"), "offset", kMaximumContentLength));
    const JsonValue& rules = field(discriminator, "values");
    if (rules.kind != JsonValue::Kind::array || rules.array.empty() || rules.array.size() > kMaximumRuleCount) throw std::runtime_error("profile schema: discriminators must be a non-empty bounded array");
    std::set<std::uint8_t> discriminator_values;
    for (const JsonValue& rule : rules.array) { allow_only(rule, {"value", "class"}); ObjectiveDiscriminatorRule parsed{static_cast<std::uint8_t>(integer_value(field(rule, "value"), "value", 255)), monster_class(field(rule, "class"))}; if (!discriminator_values.insert(parsed.value).second) throw std::runtime_error("profile schema: duplicate objective discriminator"); profile.discriminators.push_back(parsed); }
    const JsonValue& length_rules = field(value, "contentLengthClasses", false);
    if (length_rules.kind != JsonValue::Kind::null_value) {
        if (length_rules.kind != JsonValue::Kind::array || length_rules.array.size() > kMaximumRuleCount) throw std::runtime_error("profile schema: contentLengthClasses must be a bounded array");
        std::set<std::size_t> lengths;
        for (const JsonValue& rule : length_rules.array) { allow_only(rule, {"contentLength", "class"}); ObjectiveContentLengthRule parsed{static_cast<std::size_t>(integer_value(field(rule, "contentLength"), "contentLength", kMaximumContentLength)), monster_class(field(rule, "class"))}; if (!lengths.insert(parsed.content_length).second) throw std::runtime_error("profile schema: duplicate objective content length class"); profile.content_length_classes.push_back(parsed); }
    }
    if (profile.channel == 0 || profile.minimum_content_length == 0 || profile.minimum_content_length > profile.maximum_content_length || profile.discriminator_offset >= profile.minimum_content_length || (profile.discriminator_origin == PayloadOffsetOrigin::end && profile.discriminator_offset == 0)) throw std::runtime_error("profile schema: invalid objective profile invariants");
    for (const auto& rule : profile.content_length_classes) if (rule.content_length < profile.minimum_content_length || rule.content_length > profile.maximum_content_length) throw std::runtime_error("profile schema: objective content-length class is outside min/max bounds");
    return profile;
}

[[nodiscard]] WardResearchSpawnProfile parse_research_spawn(const JsonValue& value) {
    allow_only(value, {"primarySpawnPacketType", "companionSpawnPacketType", "primaryMinimumContentLength", "primaryMaximumContentLength", "companionContentLength"});
    WardResearchSpawnProfile profile;
    profile.primary_spawn_packet_type = static_cast<std::uint16_t>(integer_value(field(value, "primarySpawnPacketType"), "primarySpawnPacketType", 0xffff));
    profile.companion_spawn_packet_type = static_cast<std::uint16_t>(integer_value(field(value, "companionSpawnPacketType"), "companionSpawnPacketType", 0xffff));
    profile.primary_minimum_content_length = static_cast<std::size_t>(integer_value(field(value, "primaryMinimumContentLength"), "primaryMinimumContentLength", kMaximumContentLength));
    profile.primary_maximum_content_length = static_cast<std::size_t>(integer_value(field(value, "primaryMaximumContentLength"), "primaryMaximumContentLength", kMaximumContentLength));
    profile.companion_content_length = static_cast<std::size_t>(integer_value(field(value, "companionContentLength"), "companionContentLength", kMaximumContentLength));
    if (profile.primary_minimum_content_length == 0 || profile.primary_minimum_content_length > profile.primary_maximum_content_length || profile.companion_content_length == 0) throw std::runtime_error("profile schema: invalid ward research spawn invariants");
    return profile;
}

[[nodiscard]] WardDecoderProfile parse_ward(const JsonValue& value) {
    allow_only(value, {"channel", "placementMarkerPacketType", "placementContentLength", "placementDiscriminatorOffset", "placementDiscriminatorValues", "placementOwnerPacketType", "placementOwnerContentLengths", "removalPacketType", "removalContentLengths", "killerOwnerPacketType", "killerOwnerContentLengths", "championNetworkIdBase", "researchSpawn"});
    WardDecoderProfile profile;
    profile.channel = static_cast<std::uint8_t>(integer_value(field(value, "channel"), "channel", 15));
    profile.placement_marker_packet_type = static_cast<std::uint16_t>(integer_value(field(value, "placementMarkerPacketType"), "placementMarkerPacketType", 0xffff));
    profile.placement_content_length = static_cast<std::size_t>(integer_value(field(value, "placementContentLength"), "placementContentLength", kMaximumContentLength));
    profile.placement_discriminator_offset = static_cast<std::size_t>(integer_value(field(value, "placementDiscriminatorOffset"), "placementDiscriminatorOffset", kMaximumContentLength));
    profile.placement_discriminator_values = byte_array(field(value, "placementDiscriminatorValues"), "placementDiscriminatorValues");
    profile.placement_owner_packet_type = static_cast<std::uint16_t>(integer_value(field(value, "placementOwnerPacketType"), "placementOwnerPacketType", 0xffff));
    profile.placement_owner_content_lengths = length_constraint(field(value, "placementOwnerContentLengths"), "placementOwnerContentLengths");
    profile.removal_packet_type = static_cast<std::uint16_t>(integer_value(field(value, "removalPacketType"), "removalPacketType", 0xffff));
    profile.removal_content_lengths = length_constraint(field(value, "removalContentLengths"), "removalContentLengths");
    profile.killer_owner_packet_type = static_cast<std::uint16_t>(integer_value(field(value, "killerOwnerPacketType"), "killerOwnerPacketType", 0xffff));
    profile.killer_owner_content_lengths = length_constraint(field(value, "killerOwnerContentLengths"), "killerOwnerContentLengths");
    profile.champion_network_id_base = static_cast<std::uint32_t>(integer_value(field(value, "championNetworkIdBase"), "championNetworkIdBase", 0xffffffffULL));
    const JsonValue& research = field(value, "researchSpawn", false);
    if (research.kind != JsonValue::Kind::null_value) profile.research_spawn = parse_research_spawn(research);
    if (profile.channel == 0 || profile.placement_content_length == 0 || profile.placement_discriminator_offset >= profile.placement_content_length || profile.champion_network_id_base == 0) throw std::runtime_error("profile schema: invalid ward profile invariants");
    return profile;
}

[[nodiscard]] InventoryPurchasePacketFamilyProfile parse_inventory_purchase_family(
    const JsonValue& value,
    std::string_view name
) {
    if (value.kind != JsonValue::Kind::object) {
        throw std::runtime_error("profile schema: '" + std::string(name) + "' must be an object");
    }
    allow_only(value, {"packetType", "contentLengths"});
    InventoryPurchasePacketFamilyProfile family;
    family.packet_type = static_cast<std::uint16_t>(integer_value(
        field(value, "packetType"), "packetType", 0xffff));
    family.content_lengths = length_constraint(
        field(value, "contentLengths"), "contentLengths");
    if (family.packet_type == 0 || family.content_lengths.exact_values.empty() ||
        family.content_lengths.minimum.has_value() || family.content_lengths.maximum.has_value()) {
        throw std::runtime_error("profile schema: inventory purchase family requires a packet type and exact content lengths");
    }
    return family;
}

[[nodiscard]] InventoryPurchaseBundleFamily inventory_purchase_family_name(
    const JsonValue& value
) {
    const std::string name = string_value(value, "family", 32);
    if (name == "add") return InventoryPurchaseBundleFamily::add;
    if (name == "removal") return InventoryPurchaseBundleFamily::removal;
    if (name == "removalContext") return InventoryPurchaseBundleFamily::removal_context;
    if (name == "undoComponent") return InventoryPurchaseBundleFamily::undo_component;
    throw std::runtime_error("profile schema: unknown inventory purchase template family '" + name + "'");
}

[[nodiscard]] bool inventory_purchase_length_is_profiled(
    std::size_t length,
    const InventoryPurchasePacketFamilyProfile& family
) {
    return std::find(
        family.content_lengths.exact_values.begin(),
        family.content_lengths.exact_values.end(), length
    ) != family.content_lengths.exact_values.end();
}

[[nodiscard]] const InventoryPurchasePacketFamilyProfile*
inventory_purchase_family_profile(
    InventoryPurchaseBundleFamily family,
    const InventoryPurchaseSubsetDecoderProfile& profile
) {
    switch (family) {
        case InventoryPurchaseBundleFamily::add: return &profile.add;
        case InventoryPurchaseBundleFamily::removal: return &profile.removal;
        case InventoryPurchaseBundleFamily::removal_context: return &profile.removal_context;
        case InventoryPurchaseBundleFamily::undo_component: return nullptr;
    }
    return nullptr;
}

[[nodiscard]] std::string inventory_purchase_template_key(
    const InventoryPurchaseTemplate& template_value
) {
    std::ostringstream key;
    for (const InventoryPurchaseTemplateToken& token : template_value.tokens) {
        key << static_cast<unsigned int>(token.family) << ':' << token.content_length << ';';
    }
    return key.str();
}

[[nodiscard]] InventoryPurchaseSubsetDecoderProfile parse_inventory_purchase_subset(
    const JsonValue& value
) {
    if (value.kind != JsonValue::Kind::object) {
        throw std::runtime_error("profile schema: 'inventoryPurchaseSubset' must be an object");
    }
    allow_only(value, {"segmentType", "channel", "championNetworkIdBase", "add", "removal", "removalContext", "undoComponent", "templates"});
    InventoryPurchaseSubsetDecoderProfile profile;
    profile.segment_type = string_value(field(value, "segmentType"), "segmentType", 16);
    profile.channel = static_cast<std::uint8_t>(integer_value(field(value, "channel"), "channel", 15));
    profile.champion_network_id_base = static_cast<std::uint32_t>(integer_value(
        field(value, "championNetworkIdBase"), "championNetworkIdBase", 0xffffffffULL));
    profile.add = parse_inventory_purchase_family(field(value, "add"), "add");
    profile.removal = parse_inventory_purchase_family(field(value, "removal"), "removal");
    profile.removal_context = parse_inventory_purchase_family(field(value, "removalContext"), "removalContext");
    const JsonValue& undo = field(value, "undoComponent");
    if (undo.kind != JsonValue::Kind::object) {
        throw std::runtime_error("profile schema: 'undoComponent' must be an object");
    }
    allow_only(undo, {"packetType"});
    profile.undo_component_packet_type = static_cast<std::uint16_t>(integer_value(
        field(undo, "packetType"), "packetType", 0xffff));
    const JsonValue& templates = field(value, "templates");
    if (templates.kind != JsonValue::Kind::array || templates.array.size() != 10) {
        throw std::runtime_error("profile schema: inventory purchase subset requires exactly ten frozen templates");
    }
    if (profile.segment_type != "chunk" || profile.channel == 0 ||
        profile.champion_network_id_base == 0 || profile.add.packet_type == 0 ||
        profile.removal.packet_type == 0 || profile.removal_context.packet_type == 0 ||
        profile.undo_component_packet_type == 0 ||
        profile.add.packet_type == profile.removal.packet_type ||
        profile.add.packet_type == profile.removal_context.packet_type ||
        profile.add.packet_type == profile.undo_component_packet_type ||
        profile.removal.packet_type == profile.removal_context.packet_type ||
        profile.removal.packet_type == profile.undo_component_packet_type ||
        profile.removal_context.packet_type == profile.undo_component_packet_type ||
        !inventory_purchase_length_is_profiled(14, profile.add) ||
        !inventory_purchase_length_is_profiled(15, profile.add) ||
        !inventory_purchase_length_is_profiled(6, profile.removal) ||
        !inventory_purchase_length_is_profiled(7, profile.removal) ||
        !inventory_purchase_length_is_profiled(2, profile.removal_context) ||
        !inventory_purchase_length_is_profiled(3, profile.removal_context) ||
        !inventory_purchase_length_is_profiled(4, profile.removal_context) ||
        profile.add.content_lengths.exact_values.size() != 2 ||
        profile.removal.content_lengths.exact_values.size() != 2 ||
        profile.removal_context.content_lengths.exact_values.size() != 3) {
        throw std::runtime_error("profile schema: invalid inventory purchase subset invariants");
    }

    std::set<std::string> template_keys;
    std::size_t total_tokens = 0;
    for (const JsonValue& template_json : templates.array) {
        if (template_json.kind != JsonValue::Kind::array || template_json.array.size() < 2 || template_json.array.size() > 8) {
            throw std::runtime_error("profile schema: inventory purchase template must contain two to eight tokens");
        }
        InventoryPurchaseTemplate parsed;
        std::size_t add_count = 0;
        for (const JsonValue& token_json : template_json.array) {
            if (token_json.kind != JsonValue::Kind::object) {
                throw std::runtime_error("profile schema: inventory purchase template token must be an object");
            }
            allow_only(token_json, {"family", "contentLength"});
            const InventoryPurchaseBundleFamily family = inventory_purchase_family_name(field(token_json, "family"));
            const std::size_t content_length = static_cast<std::size_t>(integer_value(
                field(token_json, "contentLength"), "contentLength", kMaximumContentLength));
            const InventoryPurchasePacketFamilyProfile* family_profile =
                inventory_purchase_family_profile(family, profile);
            if (content_length == 0 ||
                (family_profile != nullptr && !inventory_purchase_length_is_profiled(content_length, *family_profile))) {
                throw std::runtime_error("profile schema: inventory purchase template token content length is not profiled");
            }
            if (family == InventoryPurchaseBundleFamily::add) ++add_count;
            parsed.tokens.push_back({family, content_length});
        }
        if (add_count != 1 || parsed.tokens.back().family != InventoryPurchaseBundleFamily::add ||
            parsed.tokens.back().content_length != 14) {
            throw std::runtime_error("profile schema: inventory purchase template must end with exactly one 14-byte add token");
        }
        total_tokens += parsed.tokens.size();
        if (total_tokens > 128 || !template_keys.insert(inventory_purchase_template_key(parsed)).second) {
            throw std::runtime_error("profile schema: duplicate or excessive inventory purchase templates");
        }
        profile.templates.push_back(std::move(parsed));
    }
    static constexpr std::array<std::string_view, 10> kFrozenTemplateKeys{{
        "1:6;1:6;0:14;", "1:7;1:6;0:14;", "1:7;0:14;",
        "1:6;1:7;1:7;0:14;", "1:6;1:6;1:7;0:14;",
        "1:7;1:6;1:7;0:14;", "1:7;1:7;0:14;",
        "1:7;1:7;1:6;0:14;", "1:7;1:7;1:7;0:14;",
        "1:6;1:6;1:7;1:7;0:14;",
    }};
    for (std::size_t index = 0; index < profile.templates.size(); ++index) {
        if (inventory_purchase_template_key(profile.templates[index]) != kFrozenTemplateKeys[index]) {
            throw std::runtime_error("profile schema: inventory purchase templates do not match the frozen 16.14 subset");
        }
    }
    return profile;
}

static constexpr std::array<std::uint16_t, 212> kInventoryRealItemIds16_14{{
    1001, 1004, 1006, 1011, 1018, 1026, 1027, 1028, 1029, 1031, 1033, 1036,
    1037, 1038, 1042, 1043, 1052, 1053, 1054, 1055, 1056, 1057, 1058, 1082,
    1083, 1086, 1101, 1102, 1103, 1105, 1106, 1107, 1120, 2003, 2019, 2020,
    2021, 2022, 2031, 2051, 2055, 2065, 2138, 2139, 2140, 2141, 2420, 2421,
    2501, 2502, 2503, 2504, 2508, 2510, 2512, 2517, 2520, 2522, 2523, 2524,
    2525, 2526, 3003, 3004, 3006, 3008, 3009, 3020, 3024, 3026, 3031, 3032,
    3033, 3035, 3036, 3041, 3044, 3046, 3047, 3050, 3051, 3053, 3057, 3065,
    3066, 3067, 3068, 3070, 3071, 3072, 3073, 3074, 3075, 3076, 3077, 3078,
    3082, 3083, 3084, 3085, 3086, 3087, 3089, 3091, 3094, 3097, 3100, 3102,
    3107, 3108, 3109, 3110, 3111, 3112, 3113, 3114, 3115, 3116, 3118, 3119,
    3123, 3124, 3133, 3134, 3135, 3137, 3139, 3140, 3142, 3143, 3144, 3145,
    3146, 3147, 3152, 3153, 3155, 3156, 3157, 3158, 3161, 3165, 3168, 3170,
    3171, 3172, 3173, 3174, 3175, 3177, 3179, 3181, 3184, 3190, 3211, 3222,
    3302, 3504, 3508, 3742, 3748, 3801, 3802, 3803, 3814, 3865, 3869, 3870,
    3871, 3876, 3877, 3916, 4005, 4401, 4628, 4629, 4630, 4632, 4633, 4642,
    4645, 4646, 6333, 6609, 6610, 6616, 6617, 6620, 6621, 6631, 6653, 6655,
    6657, 6660, 6662, 6664, 6665, 6670, 6672, 6673, 6675, 6676, 6690, 6692,
    6694, 6695, 6696, 6697, 6698, 6699, 8010, 8020,
}};

static constexpr std::array<std::uint16_t, 71> kInventoryComponentItemIds16_14{{
    1001, 1004, 1006, 1011, 1018, 1026, 1027, 1028, 1029, 1031, 1033, 1036,
    1037, 1038, 1042, 1043, 1052, 1053, 1057, 1058, 1082, 2019, 2020, 2021,
    2022, 2031, 2420, 2421, 2508, 2526, 3006, 3008, 3009, 3020, 3024, 3035,
    3044, 3047, 3051, 3057, 3066, 3067, 3070, 3076, 3077, 3082, 3086, 3108,
    3111, 3113, 3114, 3123, 3133, 3134, 3140, 3144, 3145, 3147, 3155, 3158,
    3211, 3801, 3802, 3803, 3916, 4630, 4632, 4642, 6660, 6670, 6690,
}};

[[nodiscard]] InventoryStaticItemCatalogProfile parse_inventory_static_item_catalog(
    const JsonValue& value
) {
    if (value.kind != JsonValue::Kind::object) {
        throw std::runtime_error("profile schema: 'staticItemCatalog' must be an object");
    }
    allow_only(value, {"provider", "version", "locale", "sourceUrl", "sourceByteLength", "sourceSha256", "entryCount", "realItemIds", "componentItemIds"});

    InventoryStaticItemCatalogProfile catalog;
    catalog.provider = string_value(field(value, "provider"), "provider", 64);
    catalog.version = string_value(field(value, "version"), "version", 32);
    catalog.locale = string_value(field(value, "locale"), "locale", 16);
    catalog.source_url = string_value(field(value, "sourceUrl"), "sourceUrl", 256);
    catalog.source_byte_length = static_cast<std::size_t>(integer_value(
        field(value, "sourceByteLength"), "sourceByteLength", kMaximumProfileBytes * 8ULL));
    catalog.source_sha256 = string_value(field(value, "sourceSha256"), "sourceSha256", 64);
    catalog.entry_count = static_cast<std::size_t>(integer_value(
        field(value, "entryCount"), "entryCount", 4096));
    catalog.real_item_ids = sorted_uint16_array(
        field(value, "realItemIds"), "realItemIds", 1024);
    catalog.component_item_ids = sorted_uint16_array(
        field(value, "componentItemIds"), "componentItemIds", 1024);

    static constexpr std::string_view kProvider = "Riot Data Dragon";
    static constexpr std::string_view kVersion = "16.14.1";
    static constexpr std::string_view kLocale = "en_US";
    static constexpr std::string_view kSourceUrl =
        "https://ddragon.leagueoflegends.com/cdn/16.14.1/data/en_US/item.json";
    static constexpr std::string_view kSourceSha256 =
        "0094f848489371da9e86b9f210f70b6ce0a3982c9063c7c734099cd5a88ddb75";
    if (catalog.provider != kProvider || catalog.version != kVersion ||
        catalog.locale != kLocale || catalog.source_url != kSourceUrl ||
        catalog.source_byte_length != 583139 || catalog.source_sha256 != kSourceSha256 ||
        catalog.entry_count != 706 ||
        catalog.real_item_ids.size() != kInventoryRealItemIds16_14.size() ||
        catalog.component_item_ids.size() != kInventoryComponentItemIds16_14.size() ||
        !std::equal(
            catalog.real_item_ids.begin(), catalog.real_item_ids.end(),
            kInventoryRealItemIds16_14.begin(), kInventoryRealItemIds16_14.end()) ||
        !std::equal(
            catalog.component_item_ids.begin(), catalog.component_item_ids.end(),
            kInventoryComponentItemIds16_14.begin(), kInventoryComponentItemIds16_14.end())) {
        throw std::runtime_error(
            "profile schema: static item catalog must match the pinned 16.14.1 Data Dragon catalog");
    }
    for (const std::uint16_t item_id : catalog.real_item_ids) {
        if (item_id > 8191) {
            throw std::runtime_error("profile schema: realItemIds must not exceed 8191");
        }
    }
    for (const std::uint16_t item_id : catalog.component_item_ids) {
        if (!std::binary_search(
                catalog.real_item_ids.begin(), catalog.real_item_ids.end(), item_id)) {
            throw std::runtime_error(
                "profile schema: componentItemIds must be a subset of realItemIds");
        }
    }
    return catalog;
}

[[nodiscard]] InventoryDirectPurchaseSubsetDecoderProfile
parse_inventory_direct_purchase_subset(const JsonValue& value) {
    if (value.kind != JsonValue::Kind::object) {
        throw std::runtime_error(
            "profile schema: 'inventoryDirectPurchaseSubset' must be an object");
    }
    allow_only(value, {"segmentType", "channel", "championNetworkIdBase", "add", "blockingPacketTypes", "isolationToleranceMillis", "staticItemCatalog"});

    InventoryDirectPurchaseSubsetDecoderProfile profile;
    profile.segment_type = string_value(field(value, "segmentType"), "segmentType", 16);
    profile.channel = static_cast<std::uint8_t>(integer_value(
        field(value, "channel"), "channel", 15));
    profile.champion_network_id_base = static_cast<std::uint32_t>(integer_value(
        field(value, "championNetworkIdBase"), "championNetworkIdBase", 0xffffffffULL));
    profile.add = parse_inventory_purchase_family(field(value, "add"), "add");
    const JsonValue& blocking = field(value, "blockingPacketTypes");
    if (blocking.kind != JsonValue::Kind::array || blocking.array.size() != 3) {
        throw std::runtime_error(
            "profile schema: blockingPacketTypes must contain exactly three frozen packet types");
    }
    for (const JsonValue& packet_type : blocking.array) {
        profile.blocking_packet_types.push_back(static_cast<std::uint16_t>(
            integer_value(packet_type, "blockingPacketTypes", 0xffff)));
    }
    static constexpr std::array<std::uint16_t, 3> kBlockingPacketTypes{{1017, 326, 129}};
    if (!std::equal(profile.blocking_packet_types.begin(), profile.blocking_packet_types.end(),
                    kBlockingPacketTypes.begin(), kBlockingPacketTypes.end())) {
        throw std::runtime_error(
            "profile schema: blockingPacketTypes must match the frozen 16.14 isolation blockers");
    }
    profile.isolation_tolerance_millis = static_cast<std::size_t>(integer_value(
        field(value, "isolationToleranceMillis"), "isolationToleranceMillis", 1000));
    profile.static_item_catalog = parse_inventory_static_item_catalog(
        field(value, "staticItemCatalog"));

    if (profile.segment_type != "chunk" || profile.channel != 1 ||
        profile.champion_network_id_base != 1073741997 ||
        profile.add.packet_type != 873 ||
        profile.add.content_lengths.exact_values != std::vector<std::size_t>{14, 15} ||
        profile.isolation_tolerance_millis != 1) {
        throw std::runtime_error(
            "profile schema: invalid inventory direct purchase subset invariants");
    }
    return profile;
}

[[nodiscard]] InventorySaleSubsetDecoderProfile parse_inventory_sale_subset(
    const JsonValue& value
) {
    if (value.kind != JsonValue::Kind::object) {
        throw std::runtime_error(
            "profile schema: 'inventorySaleSubset' must be an object");
    }
    allow_only(value, {"segmentType", "channel", "championNetworkIdBase", "add", "removal", "exactGroup", "removalPayload"});

    InventorySaleSubsetDecoderProfile profile;
    profile.segment_type = string_value(field(value, "segmentType"), "segmentType", 16);
    profile.channel = static_cast<std::uint8_t>(integer_value(
        field(value, "channel"), "channel", 15));
    profile.champion_network_id_base = static_cast<std::uint32_t>(integer_value(
        field(value, "championNetworkIdBase"), "championNetworkIdBase", 0xffffffffULL));
    profile.add = parse_inventory_purchase_family(field(value, "add"), "add");
    profile.removal = parse_inventory_purchase_family(field(value, "removal"), "removal");

    const JsonValue& group = field(value, "exactGroup");
    if (group.kind != JsonValue::Kind::object) {
        throw std::runtime_error("profile schema: 'exactGroup' must be an object");
    }
    allow_only(group, {"addCount", "removalCount", "timestampToleranceMillis"});
    profile.required_add_update_count = static_cast<std::size_t>(integer_value(
        field(group, "addCount"), "addCount", 8));
    profile.required_removal_count = static_cast<std::size_t>(integer_value(
        field(group, "removalCount"), "removalCount", 8));
    profile.group_timestamp_tolerance_millis = static_cast<std::size_t>(integer_value(
        field(group, "timestampToleranceMillis"), "timestampToleranceMillis", 1000));

    const JsonValue& payload = field(value, "removalPayload");
    if (payload.kind != JsonValue::Kind::object) {
        throw std::runtime_error("profile schema: 'removalPayload' must be an object");
    }
    allow_only(payload, {"payload0LowNibbleAllow", "payload2LowTwoBitReject", "payload2Allow"});
    profile.payload0_low_nibble_values = byte_array(
        field(payload, "payload0LowNibbleAllow"), "payload0LowNibbleAllow");
    profile.payload2_low_bits_mask = 0x03;
    profile.payload2_rejected_low_bits_value = static_cast<std::uint8_t>(
        integer_value(field(payload, "payload2LowTwoBitReject"), "payload2LowTwoBitReject", 3));
    profile.sale_payload_byte2_values = byte_array(
        field(payload, "payload2Allow"), "payload2Allow");

    static constexpr std::array<std::uint8_t, 2> kPayload0LowNibbleAllow{{2, 5}};
    static constexpr std::array<std::uint8_t, 6> kPayload2Allow{{
        0x30, 0x6E, 0x7A, 0xEA, 0xEE, 0xF9,
    }};
    if (profile.segment_type != "chunk" || profile.channel != 1 ||
        profile.champion_network_id_base != 1073741997 ||
        profile.add.packet_type != 873 || profile.removal.packet_type != 1017 ||
        profile.add.content_lengths.exact_values != std::vector<std::size_t>{14, 15} ||
        profile.removal.content_lengths.exact_values != std::vector<std::size_t>{6, 7} ||
        profile.required_add_update_count != 0 ||
        profile.required_removal_count != 1 ||
        profile.group_timestamp_tolerance_millis != 0 ||
        profile.payload0_low_nibble_values.size() !=
            kPayload0LowNibbleAllow.size() ||
        !std::equal(profile.payload0_low_nibble_values.begin(),
                    profile.payload0_low_nibble_values.end(),
                    kPayload0LowNibbleAllow.begin(), kPayload0LowNibbleAllow.end()) ||
        profile.payload2_low_bits_mask != 0x03 ||
        profile.payload2_rejected_low_bits_value != 3 ||
        profile.sale_payload_byte2_values.size() != kPayload2Allow.size() ||
        !std::equal(profile.sale_payload_byte2_values.begin(),
                    profile.sale_payload_byte2_values.end(),
                    kPayload2Allow.begin(), kPayload2Allow.end())) {
        throw std::runtime_error(
            "profile schema: invalid inventory sale subset invariants");
    }
    return profile;
}

[[nodiscard]] KeyframeParticipantStatsDecoderProfile
parse_keyframe_participant_stats(const JsonValue& value, std::string_view profile_version_group) {
    if (value.kind != JsonValue::Kind::object) {
        throw std::runtime_error(
            "profile schema: 'keyframeParticipantStats' must be an object");
    }
    allow_only(value, {"acceptedGameVersions", "segmentType", "channel", "packetType",
                       "contentLength", "championNetworkIdBase", "cipherToPlain",
                       "ambiguousCipherMappings", "experienceOffsets", "totalGoldOffsets",
                       "laneMinionsKilledOffsets", "neutralMinionsKilledOffsets",
                       "neutralMinionsKilledProjection"});
    KeyframeParticipantStatsDecoderProfile profile;
    const JsonValue& accepted = field(value, "acceptedGameVersions");
    if (accepted.kind != JsonValue::Kind::array || accepted.array.empty() ||
        accepted.array.size() > kMaximumRuleCount) {
        throw std::runtime_error(
            "profile schema: keyframe participant stats acceptedGameVersions must be a non-empty bounded array");
    }
    std::set<std::string> accepted_versions;
    for (const JsonValue& entry : accepted.array) {
        const std::string exact = string_value(entry, "acceptedGameVersions", 64);
        if (!exact.starts_with(std::string(profile_version_group) + ".") ||
            !accepted_versions.insert(exact).second) {
            throw std::runtime_error(
                "profile schema: keyframe participant stats exact versions must be unique and match versionGroup");
        }
        profile.accepted_game_versions.push_back(exact);
    }
    profile.segment_type = string_value(field(value, "segmentType"), "segmentType", 16);
    profile.channel = static_cast<std::uint8_t>(integer_value(
        field(value, "channel"), "channel", 15));
    profile.packet_type = static_cast<std::uint16_t>(integer_value(
        field(value, "packetType"), "packetType", 0xffff));
    profile.content_length = static_cast<std::size_t>(integer_value(
        field(value, "contentLength"), "contentLength", kMaximumContentLength));
    profile.champion_network_id_base = static_cast<std::uint32_t>(integer_value(
        field(value, "championNetworkIdBase"), "championNetworkIdBase", 0xffffffffULL));
    profile.cipher_to_plain = fixed_partial_byte_permutation<256>(
        field(value, "cipherToPlain"), "cipherToPlain");
    std::set<std::uint8_t> known_plain_values;
    for (const auto plain : profile.cipher_to_plain) {
        if (plain.has_value()) known_plain_values.insert(*plain);
    }
    const JsonValue& ambiguous = field(value, "ambiguousCipherMappings", false);
    if (ambiguous.kind != JsonValue::Kind::null_value) {
        if (ambiguous.kind != JsonValue::Kind::array ||
            ambiguous.array.size() > 256) {
            throw std::runtime_error(
                "profile schema: ambiguousCipherMappings must be a bounded array");
        }
        std::set<std::uint8_t> seen_cipher_values;
        for (const JsonValue& mapping : ambiguous.array) {
            if (mapping.kind != JsonValue::Kind::object) {
                throw std::runtime_error(
                    "profile schema: ambiguousCipherMappings entries must be objects");
            }
            allow_only(mapping, {"cipher", "plain"});
            const auto cipher = static_cast<std::uint8_t>(integer_value(
                field(mapping, "cipher"), "cipher", 255));
            if (!seen_cipher_values.insert(cipher).second ||
                profile.cipher_to_plain[cipher].has_value()) {
                throw std::runtime_error(
                    "profile schema: ambiguous cipher entry must be unique and unresolved");
            }
            auto domain = byte_array(field(mapping, "plain"), "plain", 256);
            if (std::any_of(domain.begin(), domain.end(), [&](std::uint8_t plain) {
                    return known_plain_values.contains(plain);
                })) {
                throw std::runtime_error(
                    "profile schema: ambiguous cipher domain overlaps a known plain value");
            }
            profile.ambiguous_cipher_plain_domains[cipher] = std::move(domain);
        }
    }
    const JsonValue& experience_offsets = field(value, "experienceOffsets", false);
    const JsonValue& total_gold_offsets = field(value, "totalGoldOffsets", false);
    if ((experience_offsets.kind == JsonValue::Kind::null_value) !=
        (total_gold_offsets.kind == JsonValue::Kind::null_value)) {
        throw std::runtime_error(
            "profile schema: experienceOffsets and totalGoldOffsets must occur together");
    }
    if (experience_offsets.kind != JsonValue::Kind::null_value) {
        profile.experience_offsets = fixed_offsets<4>(
            experience_offsets, "experienceOffsets", profile.content_length);
        profile.total_gold_offsets = fixed_offsets<4>(
            total_gold_offsets, "totalGoldOffsets", profile.content_length);
    }
    profile.lane_minions_killed_offsets = fixed_offsets<4>(
        field(value, "laneMinionsKilledOffsets"), "laneMinionsKilledOffsets",
        profile.content_length);
    profile.neutral_minions_killed_offsets = fixed_offsets<4>(
        field(value, "neutralMinionsKilledOffsets"), "neutralMinionsKilledOffsets",
        profile.content_length);
    profile.neutral_minions_killed_projection = string_value(
        field(value, "neutralMinionsKilledProjection"),
        "neutralMinionsKilledProjection", 32);
    const std::size_t known_cipher_count = static_cast<std::size_t>(std::count_if(
        profile.cipher_to_plain.begin(), profile.cipher_to_plain.end(),
        [](const auto& plain) { return plain.has_value(); }));
    if (profile.segment_type != "keyframe" || profile.channel != 1 ||
        profile.packet_type == 0 || profile.content_length < 1000 ||
        profile.content_length > 4096 || profile.champion_network_id_base == 0 ||
        known_cipher_count < 128 ||
        (profile.neutral_minions_killed_projection != "floor-plus-1e-5" &&
         profile.neutral_minions_killed_projection != "floor-plus-2e-5")) {
        throw std::runtime_error(
            "profile schema: invalid keyframe participant stats invariants");
    }
    return profile;
}

[[nodiscard]] std::string version_group(std::string_view version) {
    const std::size_t first = version.find('.');
    if (first == std::string_view::npos) return std::string(version);
    const std::size_t second = version.find('.', first + 1);
    return std::string(version.substr(0, second == std::string_view::npos ? version.size() : second));
}
[[nodiscard]] std::string fnv1a64(std::string_view source) {
    std::uint64_t value = 14695981039346656037ULL;
    for (const unsigned char byte : source) { value ^= byte; value *= 1099511628211ULL; }
    std::ostringstream output;
    output << "fnv1a64:" << std::hex << std::setfill('0') << std::setw(16) << value;
    return output.str();
}

}  // namespace

const DecoderProfileProvenance& DecoderProfileRegistry::provenance() const noexcept { return provenance_; }
const std::vector<DecoderVersionProfile>& DecoderProfileRegistry::profiles() const noexcept { return profiles_; }
DecoderProfileRegistry::DecoderProfileRegistry(DecoderProfileProvenance provenance, std::vector<DecoderVersionProfile> profiles)
    : provenance_(std::move(provenance)), profiles_(std::move(profiles)) {}

DecoderProfileLoadResult parse_decoder_profile_registry_json(std::string_view json) {
    DecoderProfileLoadResult result;
    try {
        if (json.empty() || json.size() > kMaximumProfileBytes) throw std::runtime_error("profile JSON must be between 1 and 262144 bytes");
        const JsonValue root = JsonParser(json).parse();
        allow_only(root, {"schema", "registryId", "revision", "profiles"});
        if (string_value(field(root, "schema"), "schema") != kDecoderProfileRegistrySchema) throw std::runtime_error("profile schema: unsupported schema identifier");
        DecoderProfileProvenance provenance;
        provenance.schema = std::string(kDecoderProfileRegistrySchema);
        provenance.registry_id = string_value(field(root, "registryId"), "registryId", 128);
        const JsonValue& revision = field(root, "revision", false);
        if (revision.kind == JsonValue::Kind::string) provenance.revision = string_value(revision, "revision", 128);
        else if (revision.kind == JsonValue::Kind::number) provenance.revision = std::to_string(revision.number);
        else if (revision.kind != JsonValue::Kind::null_value) throw std::runtime_error("profile schema: revision must be string or integer");
        const JsonValue& profiles = field(root, "profiles");
        if (profiles.kind != JsonValue::Kind::array || profiles.array.empty() || profiles.array.size() > kMaximumProfiles) throw std::runtime_error("profile schema: profiles must be a non-empty bounded array");
        std::set<std::string> groups;
        std::vector<DecoderVersionProfile> parsed_profiles;
        for (const JsonValue& item : profiles.array) {
            allow_only(item, {"versionGroup", "acceptedGameVersions", "finalStatsValidated", "kill", "objective", "ward", "inventoryPurchaseSubset", "inventoryDirectPurchaseSubset", "inventorySaleSubset", "keyframeParticipantStats"});
            DecoderVersionProfile profile;
            profile.version_group = string_value(field(item, "versionGroup"), "versionGroup", 24);
            if (!version_group_is_valid(profile.version_group) || !groups.insert(profile.version_group).second) throw std::runtime_error("profile schema: versionGroup must be unique major.minor digits");
            const JsonValue& accepted = field(item, "acceptedGameVersions", false);
            if (accepted.kind != JsonValue::Kind::null_value) {
                if (accepted.kind != JsonValue::Kind::array || accepted.array.empty() || accepted.array.size() > kMaximumRuleCount) throw std::runtime_error("profile schema: acceptedGameVersions must be a non-empty bounded array");
                std::set<std::string> versions;
                for (const JsonValue& entry : accepted.array) { const auto full = string_value(entry, "acceptedGameVersions", 64); if (version_group(full) != profile.version_group || !versions.insert(full).second) throw std::runtime_error("profile schema: accepted game version must be unique and match versionGroup"); profile.accepted_game_versions.push_back(full); }
            }
            const JsonValue& final_stats = field(item, "finalStatsValidated", false);
            if (final_stats.kind != JsonValue::Kind::null_value) profile.final_stats_validated = bool_value(final_stats, "finalStatsValidated");
            const JsonValue& kill = field(item, "kill", false); if (kill.kind != JsonValue::Kind::null_value) profile.kill = parse_kill(kill);
            const JsonValue& objective = field(item, "objective", false); if (objective.kind != JsonValue::Kind::null_value) profile.objective = parse_objective(objective);
            const JsonValue& ward = field(item, "ward", false); if (ward.kind != JsonValue::Kind::null_value) profile.ward = parse_ward(ward);
            const JsonValue& inventory_purchase = field(item, "inventoryPurchaseSubset", false);
            if (inventory_purchase.kind != JsonValue::Kind::null_value) profile.inventory_purchase_subset = parse_inventory_purchase_subset(inventory_purchase);
            const JsonValue& inventory_direct_purchase = field(item, "inventoryDirectPurchaseSubset", false);
            if (inventory_direct_purchase.kind != JsonValue::Kind::null_value) {
                profile.inventory_direct_purchase_subset = parse_inventory_direct_purchase_subset(inventory_direct_purchase);
            }
            const JsonValue& inventory_sale = field(item, "inventorySaleSubset", false);
            if (inventory_sale.kind != JsonValue::Kind::null_value) {
                profile.inventory_sale_subset = parse_inventory_sale_subset(inventory_sale);
            }
            const JsonValue& keyframe_participant_stats = field(item, "keyframeParticipantStats", false);
            if (keyframe_participant_stats.kind != JsonValue::Kind::null_value) {
                profile.keyframe_participant_stats = parse_keyframe_participant_stats(
                    keyframe_participant_stats, profile.version_group);
            }
            if ((profile.inventory_purchase_subset.has_value() ||
                 profile.inventory_direct_purchase_subset.has_value() ||
                 profile.inventory_sale_subset.has_value()) &&
                (profile.version_group != "16.14" || profile.accepted_game_versions.size() != 1 ||
                 profile.accepted_game_versions.front() != "16.14.794.5912")) {
                throw std::runtime_error("profile schema: exact-build decoder subsets are restricted to 16.14.794.5912");
            }
            if (!profile.final_stats_validated && !profile.kill && !profile.objective && !profile.ward && !profile.inventory_purchase_subset && !profile.inventory_direct_purchase_subset && !profile.inventory_sale_subset && !profile.keyframe_participant_stats) throw std::runtime_error("profile schema: patch profile must declare at least one decoder capability");
            parsed_profiles.push_back(std::move(profile));
        }
        provenance.fingerprint = fnv1a64(json);
        result.registry.emplace(std::move(provenance), std::move(parsed_profiles));
    } catch (const std::exception& error) {
        result.errors.push_back(error.what());
    }
    return result;
}

DecoderProfileLoadResult load_decoder_profile_registry_file(const std::string& path) {
    DecoderProfileLoadResult result;
    try {
        std::error_code error; const auto size = std::filesystem::file_size(path, error);
        if (error || size == 0 || size > kMaximumProfileBytes) throw std::runtime_error("profile file must be between 1 and 262144 bytes");
        std::ifstream input(path, std::ios::binary); if (!input) throw std::runtime_error("could not open profile file");
        std::string json(static_cast<std::size_t>(size), '\0'); input.read(json.data(), static_cast<std::streamsize>(json.size()));
        if (!input || input.gcount() != static_cast<std::streamsize>(json.size())) throw std::runtime_error("could not read complete profile file");
        result = parse_decoder_profile_registry_json(json);
    } catch (const std::exception& error) { result.errors.push_back(error.what()); }
    return result;
}

const DecoderVersionProfile* find_decoder_profile(const DecoderProfileRegistry& registry, std::string_view game_version_or_group) {
    const std::string group = version_group(game_version_or_group);
    const auto& profiles = registry.profiles();
    const auto found = std::find_if(profiles.begin(), profiles.end(), [&](const DecoderVersionProfile& profile) {
        if (profile.version_group != group) return false;
        return profile.accepted_game_versions.empty() || std::find(profile.accepted_game_versions.begin(), profile.accepted_game_versions.end(), game_version_or_group) != profile.accepted_game_versions.end();
    });
    return found == profiles.end() ? nullptr : &*found;
}

const DecoderProfileProvenance& decoder_profile_provenance(const DecoderProfileRegistry& registry) noexcept { return registry.provenance(); }
std::string decoder_profile_fingerprint(const DecoderProfileRegistry& registry) { return registry.provenance().fingerprint; }
std::string_view objective_monster_class_name(ObjectiveMonsterClass value) noexcept {
    switch (value) { case ObjectiveMonsterClass::dragon: return "DRAGON"; case ObjectiveMonsterClass::atakhan: return "ATAKHAN"; case ObjectiveMonsterClass::baron: return "BARON_NASHOR"; case ObjectiveMonsterClass::herald: return "RIFTHERALD"; case ObjectiveMonsterClass::horde: return "HORDE"; }
    return "UNKNOWN";
}

}  // namespace rofl::core
