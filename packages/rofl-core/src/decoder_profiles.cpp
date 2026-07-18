#include "rofl/core/decoder_profiles.hpp"

#include <algorithm>
#include <cctype>
#include <charconv>
#include <filesystem>
#include <fstream>
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
[[nodiscard]] std::vector<std::uint8_t> byte_array(const JsonValue& value, std::string_view name) {
    if (value.kind != JsonValue::Kind::array || value.array.empty() || value.array.size() > 16) throw std::runtime_error("profile schema: '" + std::string(name) + "' must be a non-empty bounded array");
    std::set<std::uint8_t> seen; std::vector<std::uint8_t> result;
    for (const JsonValue& element : value.array) { const auto item = static_cast<std::uint8_t>(integer_value(element, name, 255)); if (!seen.insert(item).second) throw std::runtime_error("profile schema: duplicate value in '" + std::string(name) + "'"); result.push_back(item); }
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

[[nodiscard]] std::string version_group(std::string_view version) {
    const std::size_t first = version.find('.');
    if (first == std::string_view::npos) return std::string(version);
    const std::size_t second = version.find('.', first + 1);
    return std::string(version.substr(0, second == std::string_view::npos ? version.size() : second));
}
[[nodiscard]] std::string fnv1a64(std::string_view source) {
    std::uint64_t value = 14695981039346656037ULL;
    for (const unsigned char byte : source) { value ^= byte; value *= 1099511628211ULL; }
    std::ostringstream output; output << "fnv1a64:" << std::hex << value; return output.str();
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
            allow_only(item, {"versionGroup", "acceptedGameVersions", "finalStatsValidated", "kill", "objective", "ward"});
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
            if (!profile.final_stats_validated && !profile.kill && !profile.objective && !profile.ward) throw std::runtime_error("profile schema: patch profile must declare at least one decoder capability");
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
