#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace rofl::core {

inline constexpr std::string_view kDecoderProfileRegistrySchema =
    "rofl-replay-decoder-profiles/v1";

enum class ObjectiveMonsterClass {
    dragon,
    atakhan,
    baron,
    herald,
    horde,
};

enum class PayloadOffsetOrigin { start, end };

struct ContentLengthConstraint {
    std::vector<std::size_t> exact_values;
    std::optional<std::size_t> minimum;
    std::optional<std::size_t> maximum;
};

struct KillDecoderProfile {
    std::uint8_t channel = 0;
    std::uint16_t owner_sequence_packet_type = 0;
    std::uint16_t death_marker_packet_type = 0;
    std::size_t death_marker_content_length = 0;
    std::uint32_t champion_network_id_base = 0;
    std::size_t timestamp_tolerance_millis = 0;
    std::string owner_order;
};

struct ObjectiveDiscriminatorRule {
    std::uint8_t value = 0;
    ObjectiveMonsterClass monster_class = ObjectiveMonsterClass::dragon;
};

struct ObjectiveContentLengthRule {
    std::size_t content_length = 0;
    ObjectiveMonsterClass monster_class = ObjectiveMonsterClass::dragon;
};

struct ObjectiveDecoderProfile {
    std::uint8_t channel = 0;
    std::uint16_t packet_type = 0;
    std::size_t minimum_content_length = 0;
    std::size_t maximum_content_length = 0;
    PayloadOffsetOrigin discriminator_origin = PayloadOffsetOrigin::start;
    std::size_t discriminator_offset = 0;
    std::vector<ObjectiveDiscriminatorRule> discriminators;
    std::vector<ObjectiveContentLengthRule> content_length_classes;
};

struct WardResearchSpawnProfile {
    std::uint16_t primary_spawn_packet_type = 0;
    std::uint16_t companion_spawn_packet_type = 0;
    std::size_t primary_minimum_content_length = 0;
    std::size_t primary_maximum_content_length = 0;
    std::size_t companion_content_length = 0;
};

struct WardDecoderProfile {
    std::uint8_t channel = 0;
    std::uint16_t placement_marker_packet_type = 0;
    std::size_t placement_content_length = 0;
    std::size_t placement_discriminator_offset = 0;
    std::vector<std::uint8_t> placement_discriminator_values;
    std::uint16_t placement_owner_packet_type = 0;
    ContentLengthConstraint placement_owner_content_lengths;
    std::uint16_t removal_packet_type = 0;
    ContentLengthConstraint removal_content_lengths;
    std::uint16_t killer_owner_packet_type = 0;
    ContentLengthConstraint killer_owner_content_lengths;
    std::uint32_t champion_network_id_base = 0;
    std::optional<WardResearchSpawnProfile> research_spawn;
};

struct DecoderVersionProfile {
    std::string version_group;
    std::vector<std::string> accepted_game_versions;
    std::optional<bool> final_stats_validated;
    std::optional<KillDecoderProfile> kill;
    std::optional<ObjectiveDecoderProfile> objective;
    std::optional<WardDecoderProfile> ward;
};

struct DecoderProfileProvenance {
    std::string schema;
    std::string registry_id;
    std::string revision;
    std::string fingerprint;
};

class DecoderProfileRegistry {
public:
    DecoderProfileRegistry() = default;
    DecoderProfileRegistry(
        DecoderProfileProvenance provenance,
        std::vector<DecoderVersionProfile> profiles
    );

    [[nodiscard]] const DecoderProfileProvenance& provenance() const noexcept;
    [[nodiscard]] const std::vector<DecoderVersionProfile>& profiles() const noexcept;

private:
    DecoderProfileProvenance provenance_;
    std::vector<DecoderVersionProfile> profiles_;

};

struct DecoderProfileLoadResult {
    std::optional<DecoderProfileRegistry> registry;
    std::vector<std::string> errors;

    [[nodiscard]] bool ok() const noexcept { return registry.has_value() && errors.empty(); }
};

[[nodiscard]] DecoderProfileLoadResult parse_decoder_profile_registry_json(
    std::string_view json
);
[[nodiscard]] DecoderProfileLoadResult load_decoder_profile_registry_file(
    const std::string& path
);
[[nodiscard]] const DecoderVersionProfile* find_decoder_profile(
    const DecoderProfileRegistry& registry,
    std::string_view game_version_or_group
);
[[nodiscard]] const DecoderProfileProvenance& decoder_profile_provenance(
    const DecoderProfileRegistry& registry
) noexcept;
[[nodiscard]] std::string decoder_profile_fingerprint(
    const DecoderProfileRegistry& registry
);
[[nodiscard]] std::string_view objective_monster_class_name(
    ObjectiveMonsterClass value
) noexcept;

}  // namespace rofl::core
