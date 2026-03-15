#include "rofl/core/replay_analyzer.hpp"

#include <algorithm>
#include <cctype>
#include <fstream>
#include <sstream>
#include <stdexcept>

namespace rofl::core {
namespace {

constexpr std::string_view kMetadataMarker = "{\"gameLength\":";
constexpr std::string_view kStatsJsonKey = "\"statsJson\"";

[[nodiscard]] bool is_digit(char value) {
    return value >= '0' && value <= '9';
}

[[nodiscard]] std::string json_escape(std::string_view input) {
    std::string escaped;
    escaped.reserve(input.size() + 16);

    for (const char ch : input) {
        switch (ch) {
            case '\\':
                escaped += "\\\\";
                break;
            case '"':
                escaped += "\\\"";
                break;
            case '\n':
                escaped += "\\n";
                break;
            case '\r':
                escaped += "\\r";
                break;
            case '\t':
                escaped += "\\t";
                break;
            default:
                escaped += ch;
                break;
        }
    }

    return escaped;
}

[[nodiscard]] std::size_t find_subsequence(const std::vector<std::uint8_t>& bytes, std::string_view needle) {
    if (needle.empty() || bytes.size() < needle.size()) {
        return std::string::npos;
    }

    for (std::size_t offset = 0; offset + needle.size() <= bytes.size(); ++offset) {
        bool match = true;
        for (std::size_t index = 0; index < needle.size(); ++index) {
            if (bytes[offset + index] != static_cast<std::uint8_t>(needle[index])) {
                match = false;
                break;
            }
        }

        if (match) {
            return offset;
        }
    }

    return std::string::npos;
}

[[nodiscard]] std::string scan_game_version(const std::vector<std::uint8_t>& bytes) {
    const std::size_t limit = std::min<std::size_t>(bytes.size(), 256);
    for (std::size_t offset = 0; offset < limit; ++offset) {
        if (!is_digit(static_cast<char>(bytes[offset]))) {
            continue;
        }

        std::size_t cursor = offset;
        int dot_count = 0;
        while (cursor < limit) {
            const char ch = static_cast<char>(bytes[cursor]);
            if (is_digit(ch)) {
                ++cursor;
                continue;
            }
            if (ch == '.') {
                ++dot_count;
                ++cursor;
                continue;
            }
            break;
        }

        if (dot_count == 3 && cursor > offset) {
            return std::string(reinterpret_cast<const char*>(bytes.data() + offset), cursor - offset);
        }
    }

    return "unknown";
}

[[nodiscard]] std::string extract_balanced_json(const std::vector<std::uint8_t>& bytes, std::size_t start_offset) {
    bool in_string = false;
    bool escape = false;
    int depth = 0;

    for (std::size_t offset = start_offset; offset < bytes.size(); ++offset) {
        const char ch = static_cast<char>(bytes[offset]);

        if (in_string) {
            if (escape) {
                escape = false;
            } else if (ch == '\\') {
                escape = true;
            } else if (ch == '"') {
                in_string = false;
            }
            continue;
        }

        if (ch == '"') {
            in_string = true;
            continue;
        }
        if (ch == '{') {
            ++depth;
            continue;
        }
        if (ch == '}') {
            --depth;
            if (depth == 0) {
                return std::string(reinterpret_cast<const char*>(bytes.data() + start_offset), offset - start_offset + 1);
            }
        }
    }

    throw std::runtime_error("Could not extract balanced metadata JSON from replay bytes.");
}

[[nodiscard]] std::size_t find_key(std::string_view json, std::string_view key) {
    return json.find(std::string("\"") + std::string(key) + "\"");
}

[[nodiscard]] std::size_t find_value_start(std::string_view json, std::string_view key) {
    const std::size_t key_offset = find_key(json, key);
    if (key_offset == std::string::npos) {
        return std::string::npos;
    }

    const std::size_t colon_offset = json.find(':', key_offset + key.size() + 2);
    if (colon_offset == std::string::npos) {
        return std::string::npos;
    }

    std::size_t value_offset = colon_offset + 1;
    while (value_offset < json.size() && std::isspace(static_cast<unsigned char>(json[value_offset])) != 0) {
        ++value_offset;
    }

    return value_offset;
}

[[nodiscard]] int parse_int_field(std::string_view json, std::string_view key) {
    const std::size_t value_offset = find_value_start(json, key);
    if (value_offset == std::string::npos) {
        return 0;
    }

    std::size_t cursor = value_offset;
    if (cursor < json.size() && json[cursor] == '"') {
        ++cursor;
    }

    bool negative = false;
    if (cursor < json.size() && json[cursor] == '-') {
        negative = true;
        ++cursor;
    }

    int value = 0;
    bool found_digit = false;
    while (cursor < json.size() && is_digit(json[cursor])) {
        found_digit = true;
        value = (value * 10) + static_cast<int>(json[cursor] - '0');
        ++cursor;
    }

    if (!found_digit) {
        return 0;
    }

    return negative ? -value : value;
}

[[nodiscard]] std::string parse_string_field(std::string_view json, std::string_view key) {
    const std::size_t value_offset = find_value_start(json, key);
    if (value_offset == std::string::npos || value_offset >= json.size() || json[value_offset] != '"') {
        return {};
    }

    std::string result;
    bool escape = false;
    for (std::size_t cursor = value_offset + 1; cursor < json.size(); ++cursor) {
        const char ch = json[cursor];
        if (escape) {
            switch (ch) {
                case '"':
                case '\\':
                case '/':
                    result += ch;
                    break;
                case 'n':
                    result += '\n';
                    break;
                case 'r':
                    result += '\r';
                    break;
                case 't':
                    result += '\t';
                    break;
                default:
                    result += ch;
                    break;
            }
            escape = false;
            continue;
        }

        if (ch == '\\') {
            escape = true;
            continue;
        }
        if (ch == '"') {
            return result;
        }

        result += ch;
    }

    return result;
}

[[nodiscard]] std::vector<std::string> split_top_level_objects(std::string_view json_array) {
    std::vector<std::string> objects;
    bool in_string = false;
    bool escape = false;
    int depth = 0;
    std::size_t object_start = std::string::npos;

    for (std::size_t offset = 0; offset < json_array.size(); ++offset) {
        const char ch = json_array[offset];

        if (in_string) {
            if (escape) {
                escape = false;
            } else if (ch == '\\') {
                escape = true;
            } else if (ch == '"') {
                in_string = false;
            }
            continue;
        }

        if (ch == '"') {
            in_string = true;
            continue;
        }

        if (ch == '{') {
            if (depth == 0) {
                object_start = offset;
            }
            ++depth;
            continue;
        }

        if (ch == '}') {
            --depth;
            if (depth == 0 && object_start != std::string::npos) {
                objects.emplace_back(json_array.substr(object_start, offset - object_start + 1));
                object_start = std::string::npos;
            }
        }
    }

    return objects;
}

[[nodiscard]] std::vector<PlayerSummary> parse_players_from_stats_json(const std::string& stats_json) {
    std::vector<PlayerSummary> players;
    for (const std::string& object_json : split_top_level_objects(stats_json)) {
        PlayerSummary player;
        player.champion = parse_string_field(object_json, "SKIN");
        player.riot_id_game_name = parse_string_field(object_json, "RIOT_ID_GAME_NAME");
        player.riot_id_tag_line = parse_string_field(object_json, "RIOT_ID_TAG_LINE");
        player.team_position = parse_string_field(object_json, "TEAM_POSITION");
        player.win = parse_string_field(object_json, "WIN");
        player.team = parse_int_field(object_json, "TEAM");
        player.kills = parse_int_field(object_json, "CHAMPIONS_KILLED");
        player.deaths = parse_int_field(object_json, "NUM_DEATHS");
        player.assists = parse_int_field(object_json, "ASSISTS");
        player.gold_earned = parse_int_field(object_json, "GOLD_EARNED");
        player.total_damage_to_champions = parse_int_field(object_json, "TOTAL_DAMAGE_DEALT_TO_CHAMPIONS");
        player.vision_score = parse_int_field(object_json, "VISION_SCORE");
        players.push_back(std::move(player));
    }

    return players;
}

[[nodiscard]] std::vector<std::uint8_t> read_file_bytes(const std::string& path) {
    std::ifstream input(path, std::ios::binary);
    if (!input) {
        throw std::runtime_error("Could not open replay file: " + path);
    }

    input.seekg(0, std::ios::end);
    const std::streamoff size = input.tellg();
    input.seekg(0, std::ios::beg);

    if (size < 0) {
        throw std::runtime_error("Could not determine replay file size: " + path);
    }

    std::vector<std::uint8_t> bytes(static_cast<std::size_t>(size));
    if (!bytes.empty()) {
        input.read(reinterpret_cast<char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
    }

    return bytes;
}

}  // namespace

BuildInfo get_build_info() {
    return {
        .version = "0.2.0-metadata-mvp",
        .parser_state = "extracts-embedded-match-metadata",
        .wasm_state = "scaffolded-not-built"
    };
}

std::string describe_scaffold() {
    const BuildInfo info = get_build_info();
    return "league-replay-analyzer " + info.version +
           " | parser=" + info.parser_state +
           " | wasm=" + info.wasm_state;
}

std::string normalize_version_label(std::string_view version) {
    return version.empty() ? "unknown" : std::string(version);
}

ReplaySummary parse_replay_bytes(const std::vector<std::uint8_t>& bytes) {
    ReplaySummary summary;
    summary.file_size = bytes.size();
    summary.game_version = scan_game_version(bytes);

    const std::size_t metadata_offset = find_subsequence(bytes, kMetadataMarker);
    if (metadata_offset == std::string::npos) {
        throw std::runtime_error("Could not locate embedded metadata JSON in replay.");
    }

    try {
        summary.metadata_json = extract_balanced_json(bytes, metadata_offset);
        summary.game_length_millis = parse_int_field(summary.metadata_json, "gameLength");
        summary.last_game_chunk_id = parse_int_field(summary.metadata_json, "lastGameChunkId");
        summary.last_keyframe_id = parse_int_field(summary.metadata_json, "lastKeyFrameId");
    } catch (const std::exception& exception) {
        throw std::runtime_error("Failed while extracting embedded metadata JSON: " + std::string(exception.what()));
    }

    try {
        const std::string stats_json = parse_string_field(summary.metadata_json, "statsJson");
        if (!stats_json.empty()) {
            summary.players = parse_players_from_stats_json(stats_json);
        }
    } catch (const std::exception& exception) {
        throw std::runtime_error("Failed while parsing statsJson from embedded metadata: " + std::string(exception.what()));
    }

    return summary;
}

ReplaySummary parse_replay_file(const std::string& path) {
    return parse_replay_bytes(read_file_bytes(path));
}

std::string replay_summary_to_json(const ReplaySummary& summary) {
    std::ostringstream output;
    output << "{";
    output << "\"gameVersion\":\"" << json_escape(summary.game_version) << "\",";
    output << "\"fileSize\":" << summary.file_size << ",";
    output << "\"gameLengthMillis\":" << summary.game_length_millis << ",";
    output << "\"lastGameChunkId\":" << summary.last_game_chunk_id << ",";
    output << "\"lastKeyFrameId\":" << summary.last_keyframe_id << ",";
    output << "\"playerCount\":" << summary.players.size() << ",";
    output << "\"players\":[";

    for (std::size_t index = 0; index < summary.players.size(); ++index) {
        const PlayerSummary& player = summary.players[index];
        if (index > 0) {
            output << ',';
        }

        output << '{'
               << "\"champion\":\"" << json_escape(player.champion) << "\","
               << "\"riotIdGameName\":\"" << json_escape(player.riot_id_game_name) << "\","
               << "\"riotIdTagLine\":\"" << json_escape(player.riot_id_tag_line) << "\","
               << "\"teamPosition\":\"" << json_escape(player.team_position) << "\","
               << "\"win\":\"" << json_escape(player.win) << "\","
               << "\"team\":" << player.team << ','
               << "\"kills\":" << player.kills << ','
               << "\"deaths\":" << player.deaths << ','
               << "\"assists\":" << player.assists << ','
               << "\"goldEarned\":" << player.gold_earned << ','
               << "\"totalDamageToChampions\":" << player.total_damage_to_champions << ','
               << "\"visionScore\":" << player.vision_score
               << '}';
    }

    output << "],";
    output << "\"metadataJson\":\"" << json_escape(summary.metadata_json) << "\"";
    output << '}';
    return output.str();
}

}  // namespace rofl::core
