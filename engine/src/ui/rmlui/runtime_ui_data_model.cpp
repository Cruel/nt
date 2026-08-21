#include "ui/rmlui/runtime_ui_data_model.hpp"

#include "ui/rmlui/runtime_ui_action_gateway.hpp"
#include "ui/rmlui/rmlui_custom_components.hpp"

#include <noveltea/active_text.hpp>

#include <RmlUi/Core.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <iomanip>
#include <limits>
#include <sstream>
#include <string_view>
#include <type_traits>
#include <utility>
#include <variant>

namespace noveltea::ui::rmlui {
namespace {

std::string actor_instance_text(const core::ActorPresentationKey& key)
{
    return std::visit(
        [](const auto& value) -> std::string {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, core::CharacterActorKey>)
                return value.character.text();
            else if constexpr (std::is_same_v<T, core::RoomCastActorKey>)
                return value.entry.text();
            else if constexpr (std::is_same_v<T, core::SceneActorKey>)
                return value.slot.text();
            else
                return value.instance.text();
        },
        key);
}

std::pair<std::string_view, std::string_view>
direction_presentation(core::compiled::RoomExitDirection direction)
{
    using Direction = core::compiled::RoomExitDirection;
    switch (direction) {
    case Direction::Northwest:
        return {"northwest", "NW"};
    case Direction::North:
        return {"north", "N"};
    case Direction::Northeast:
        return {"northeast", "NE"};
    case Direction::West:
        return {"west", "W"};
    case Direction::Custom:
        return {"custom", "GO"};
    case Direction::East:
        return {"east", "E"};
    case Direction::Southwest:
        return {"southwest", "SW"};
    case Direction::South:
        return {"south", "S"};
    case Direction::Southeast:
        return {"southeast", "SE"};
    }
    return {"custom", "GO"};
}

std::string shell_screen_name(core::RuntimeShellScreen screen)
{
    using Screen = core::RuntimeShellScreen;
    switch (screen) {
    case Screen::None:
        return "none";
    case Screen::Title:
        return "title";
    case Screen::Pause:
        return "pause";
    case Screen::Settings:
        return "settings";
    case Screen::Save:
        return "save";
    case Screen::Load:
        return "load";
    case Screen::TextLog:
        return "text-log";
    case Screen::Confirmation:
        return "confirmation";
    case Screen::Debug:
        return "debug";
    }
    return "none";
}

std::string text_log_kind(core::TextLogEntryKind kind)
{
    using Kind = core::TextLogEntryKind;
    switch (kind) {
    case Kind::Line:
        return "line";
    case Kind::Choice:
        return "choice";
    case Kind::Notification:
        return "notification";
    }
    return "notification";
}

std::string paragraph_rml(std::string_view text)
{
    if (text.empty())
        return {};

    std::ostringstream out;
    std::size_t start = 0;
    while (start <= text.size()) {
        const std::size_t end = text.find('\n', start);
        const auto line = text.substr(start, end == std::string_view::npos ? std::string_view::npos
                                                                           : end - start);
        if (!line.empty())
            out << "<p>" << escape_rml(line) << "</p>";
        if (end == std::string_view::npos)
            break;
        start = end + 1;
    }
    return out.str();
}

std::string color_attr(const core::RichTextColor& color)
{
    std::ostringstream out;
    out << '#' << std::hex << std::setfill('0') << std::setw(2) << static_cast<int>(color.r)
        << std::setw(2) << static_cast<int>(color.g) << std::setw(2) << static_cast<int>(color.b)
        << std::setw(2) << static_cast<int>(color.a);
    return out.str();
}

std::string effect_name(core::TextEffect effect)
{
    switch (effect) {
    case core::TextEffect::Fade:
        return "fade";
    case core::TextEffect::FadeAcross:
        return "fade-across";
    case core::TextEffect::Glow:
        return "glow";
    case core::TextEffect::Nod:
        return "nod";
    case core::TextEffect::Shake:
        return "shake";
    case core::TextEffect::Test:
        return "test";
    case core::TextEffect::Tremble:
        return "tremble";
    case core::TextEffect::Pop:
        return "pop";
    case core::TextEffect::None:
        break;
    }
    return "none";
}

std::string run_class(const core::RichTextRun& run)
{
    std::string classes = "nt-active-text__run";
    if ((run.style.font_style & core::FontBold) != 0)
        classes += " nt-active-text__run--bold";
    if ((run.style.font_style & core::FontItalic) != 0)
        classes += " nt-active-text__run--italic";
    if ((run.style.font_style & core::FontUnderlined) != 0)
        classes += " nt-active-text__run--underlined";
    if ((run.style.font_style & core::FontStrikeThrough) != 0)
        classes += " nt-active-text__run--strike";
    if (run.style.diff)
        classes += " nt-active-text__run--diff";
    if (!run.style.object_id.empty())
        classes += " nt-active-text__run--object";
    if (run.animation.type != core::TextEffect::None)
        classes += " nt-active-text__run--effect nt-active-text__run--effect-" +
                   effect_name(run.animation.type);
    return classes;
}

std::string glyph_text_rml(std::string_view text)
{
    return text == " " ? "&#160;" : escape_rml(text);
}

std::string glyph_style_rml(const ActiveTextGlyph& glyph)
{
    std::ostringstream style;
    style << "color: #" << std::hex << std::setw(2) << std::setfill('0')
          << static_cast<int>(glyph.style.color.r) << std::setw(2)
          << static_cast<int>(glyph.style.color.g) << std::setw(2)
          << static_cast<int>(glyph.style.color.b) << std::dec << ";";
    if (glyph.style.font_size != 12)
        style << "font-size: " << glyph.style.font_size << "px;";
    if ((glyph.style.font_style & core::FontBold) != 0)
        style << "font-weight: bold;";
    if ((glyph.style.font_style & core::FontItalic) != 0)
        style << "color: #bfe3ff;";
    if ((glyph.style.font_style & core::FontUnderlined) != 0)
        style << "text-decoration: underline;";
    return style.str();
}

std::string glyph_rml(const ActiveTextGlyph& glyph)
{
    core::RichTextRun class_source;
    class_source.style = glyph.style;
    class_source.animation = glyph.animation;

    std::ostringstream out;
    out << "<span class=\"nt-active-text__glyph " << run_class(class_source) << "\"";
    out << " style=\"" << glyph_style_rml(glyph) << "\"";
    out << " data-run-index=\"" << glyph.run_index << "\"";
    out << " data-glyph-index=\"" << glyph.glyph_index << "\"";
    if (!glyph.style.object_id.empty())
        out << " data-object-id=\"" << escape_rml(glyph.style.object_id) << "\"";
    if (!glyph.style.material_id.empty())
        out << " data-material=\"" << escape_rml(glyph.style.material_id) << "\"";
    if (!glyph.style.font_alias.empty())
        out << " data-font=\"" << escape_rml(glyph.style.font_alias) << "\"";
    if (!glyph.style.vertex_shader_id.empty())
        out << " data-vertex-shader=\"" << escape_rml(glyph.style.vertex_shader_id) << "\"";
    if (!glyph.style.fragment_shader_id.empty())
        out << " data-fragment-shader=\"" << escape_rml(glyph.style.fragment_shader_id) << "\"";
    if (glyph.style.font_size != 12)
        out << " data-font-size=\"" << glyph.style.font_size << "\"";
    if (glyph.offset.x != 0.0f)
        out << " data-x-offset=\"" << std::fixed << std::setprecision(3) << glyph.offset.x << "\"";
    if (glyph.offset.y != 0.0f)
        out << " data-y-offset=\"" << std::fixed << std::setprecision(3) << glyph.offset.y << "\"";
    if (glyph.scale != 1.0f)
        out << " data-scale=\"" << std::fixed << std::setprecision(3) << glyph.scale << "\"";
    if (glyph.alpha != 1.0f)
        out << " data-alpha=\"" << std::fixed << std::setprecision(3) << glyph.alpha << "\"";
    if (glyph.glow != 0.0f)
        out << " data-glow=\"" << std::fixed << std::setprecision(3) << glyph.glow << "\"";
    if (glyph.style.diff)
        out << " data-diff=\"true\"";
    if (glyph.animation.type != core::TextEffect::None) {
        out << " data-effect=\"" << effect_name(glyph.animation.type) << "\"";
        out << " data-effect-fallback=\"semantic\"";
        if (glyph.animation.duration_ms > 0)
            out << " data-effect-duration-ms=\"" << glyph.animation.duration_ms << "\"";
        if (glyph.animation.delay_ms > 0)
            out << " data-effect-delay-ms=\"" << glyph.animation.delay_ms << "\"";
    }
    out << " data-color=\"" << color_attr(glyph.style.color) << "\">" << glyph_text_rml(glyph.text)
        << "</span>";
    return out.str();
}

std::string text_log_body_rml(const core::TextLogEntry& entry)
{
    const auto document = core::parse_rich_text(entry.text);
    if (document.runs.empty())
        return paragraph_rml(entry.text);

    const auto frame =
        build_active_text_frame(document, ActiveTextOptions{.reveal_progress = 1.0f});
    std::ostringstream out;
    bool paragraph_open = false;
    const auto open_paragraph = [&]() {
        if (!paragraph_open) {
            out << "<p>";
            paragraph_open = true;
        }
    };
    const auto close_paragraph = [&]() {
        if (paragraph_open) {
            out << "</p>";
            paragraph_open = false;
        }
    };
    for (const auto& run_frame : frame.runs) {
        const auto& run = document.runs[run_frame.run_index];
        if (run.start_on_new_line)
            close_paragraph();
        for (const auto& glyph : run_frame.glyphs) {
            if (glyph.text == "\n")
                close_paragraph();
            else {
                open_paragraph();
                out << glyph_rml(glyph);
            }
        }
    }
    close_paragraph();
    const auto rich = out.str();
    return rich.empty() ? paragraph_rml(entry.text) : rich;
}

template<class Id>
bool id_matches_selected(const std::vector<core::compiled::InteractionSubject>& selected,
                         const Id& id)
{
    const core::compiled::InteractionSubject subject = [&]() -> core::compiled::InteractionSubject {
        if constexpr (std::is_same_v<Id, core::CharacterId>)
            return core::compiled::CharacterInteractionSubject{id};
        else
            return core::compiled::InteractableInteractionSubject{id};
    }();
    return std::find(selected.begin(), selected.end(), subject) != selected.end();
}

template<class T> T event_arg(const Rml::VariantList& arguments, std::size_t index, T fallback = {})
{
    return index < arguments.size() ? arguments[index].Get<T>() : std::move(fallback);
}

std::uint64_t event_slot_number_arg(const Rml::VariantList& arguments, std::size_t index)
{
    constexpr auto invalid = std::numeric_limits<std::uint64_t>::max();
    if (index >= arguments.size())
        return invalid;

    const auto type = arguments[index].GetType();
    switch (type) {
    case Rml::Variant::BYTE:
    case Rml::Variant::CHAR:
    case Rml::Variant::FLOAT:
    case Rml::Variant::DOUBLE:
    case Rml::Variant::INT:
    case Rml::Variant::INT64:
    case Rml::Variant::UINT:
    case Rml::Variant::UINT64:
        break;
    default:
        return invalid;
    }

    double value = 0.0;
    if (!arguments[index].GetInto(value) || !std::isfinite(value) || value < 0.0 ||
        std::trunc(value) != value ||
        value > static_cast<double>(std::numeric_limits<std::uint32_t>::max()))
        return invalid;
    return static_cast<std::uint64_t>(value);
}

struct ChoiceProjection {
    std::string kind;
    std::string id;
    std::string label;
    bool enabled = false;
    std::string get_kind() { return kind; }
    std::string get_id() { return id; }
    std::string get_label() { return label; }
    bool get_enabled() { return enabled; }
};

struct ActorProjection {
    std::string character_id;
    std::string instance_id;
    std::string pose_id;
    std::string expression_id;
    bool presentation_complete = false;
    std::string get_character_id() { return character_id; }
    std::string get_instance_id() { return instance_id; }
    std::string get_pose_id() { return pose_id; }
    std::string get_expression_id() { return expression_id; }
    bool get_presentation_complete() { return presentation_complete; }
};

struct ExitProjection {
    std::string id;
    std::string target_id;
    std::string direction;
    std::string label;
    bool enabled = false;
    std::string glyph;
    std::string get_id() { return id; }
    std::string get_target_id() { return target_id; }
    std::string get_direction() { return direction; }
    std::string get_label() { return label; }
    bool get_enabled() { return enabled; }
    std::string get_glyph() { return glyph; }
};

struct ObjectProjection {
    std::string subject_kind;
    std::string subject_id;
    std::string label;
    bool enabled = false;
    bool selected = false;
    std::string get_subject_kind() { return subject_kind; }
    std::string get_subject_id() { return subject_id; }
    std::string get_label() { return label; }
    bool get_enabled() { return enabled; }
    bool get_selected() { return selected; }
};

struct InventoryItemProjection {
    std::string id;
    std::string display_name;
    bool enabled = false;
    bool selected = false;
    std::string get_id() { return id; }
    std::string get_display_name() { return display_name; }
    bool get_enabled() { return enabled; }
    bool get_selected() { return selected; }
};

struct ActionProjection {
    std::string verb_id;
    std::string label;
    int arity = 0;
    bool quick_action = false;
    bool enabled = false;
    std::string get_verb_id() { return verb_id; }
    std::string get_label() { return label; }
    int get_arity() { return arity; }
    bool get_quick_action() { return quick_action; }
    bool get_enabled() { return enabled; }
};

struct TextLogEntryProjection {
    std::uint64_t sequence = 0;
    std::string kind;
    bool has_speaker = false;
    std::string speaker_id;
    std::string text;
    std::string body_rml;
    std::uint64_t get_sequence() { return sequence; }
    std::string get_kind() { return kind; }
    bool get_has_speaker() { return has_speaker; }
    std::string get_speaker_id() { return speaker_id; }
    std::string get_text() { return text; }
    std::string get_body_rml() { return body_rml; }
};

struct RoomProjection {
    bool available = false;
    bool has_enabled_exits = false;
    std::vector<ExitProjection> exits;
    std::vector<ObjectProjection> objects;
    bool get_available() { return available; }
    bool get_has_enabled_exits() { return has_enabled_exits; }
    std::vector<ExitProjection>& get_exits() { return exits; }
    std::vector<ObjectProjection>& get_objects() { return objects; }
};

struct InventoryProjection {
    std::vector<InventoryItemProjection> items;
    std::vector<InventoryItemProjection>& get_items() { return items; }
};

struct InteractionProjection {
    bool has_selection = false;
    std::vector<ActionProjection> actions;
    bool get_has_selection() { return has_selection; }
    std::vector<ActionProjection>& get_actions() { return actions; }
};

struct TextLogProjection {
    std::vector<TextLogEntryProjection> entries;
    std::vector<TextLogEntryProjection>& get_entries() { return entries; }
};

struct GameplayProjection {
    bool available = false;
    std::string mode;
    std::string title;
    std::string notification;
    bool can_continue = false;
    bool active_text_available = false;
    std::vector<ChoiceProjection> choices;
    std::vector<ActorProjection> actors;
    RoomProjection room;
    InventoryProjection inventory;
    InteractionProjection interaction;
    TextLogProjection text_log;
    bool get_available() { return available; }
    std::string get_mode() { return mode; }
    std::string get_title() { return title; }
    std::string get_notification() { return notification; }
    bool get_can_continue() { return can_continue; }
    bool get_active_text_available() { return active_text_available; }
    std::vector<ChoiceProjection>& get_choices() { return choices; }
    std::vector<ActorProjection>& get_actors() { return actors; }
    RoomProjection& get_room() { return room; }
    InventoryProjection& get_inventory() { return inventory; }
    InteractionProjection& get_interaction() { return interaction; }
    TextLogProjection& get_text_log() { return text_log; }
};

struct ProjectProjection {
    std::string title = "NovelTea";
    std::string subtitle;
    std::string start_label = "Start";
    std::string get_title() { return title; }
    std::string get_subtitle() { return subtitle; }
    std::string get_start_label() { return start_label; }
};

struct ScaleProjection {
    bool enabled = false;
    double value = 1.0;
    double minimum = 1.0;
    double default_value = 1.0;
    double maximum = 1.0;
    bool get_enabled() { return enabled; }
    double get_value() { return value; }
    double get_minimum() { return minimum; }
    double get_default_value() { return default_value; }
    double get_maximum() { return maximum; }
};

struct SettingsProjection {
    ScaleProjection ui_scale;
    ScaleProjection text_scale;
    ScaleProjection& get_ui_scale() { return ui_scale; }
    ScaleProjection& get_text_scale() { return text_scale; }
};

struct CheckpointProjection {
    bool available = false;
    bool ready = false;
    bool retained = false;
    std::string retained_revision;
    std::uint64_t replay_structural_generations = 0;
    std::uint64_t replay_time_generations = 0;
    std::uint64_t replay_play_time_ms = 0;
    bool thumbnail_available = false;
    bool thumbnail_capture_pending = false;
    std::string summary = "Checkpoint status unavailable.";
    bool get_available() { return available; }
    bool get_ready() { return ready; }
    bool get_retained() { return retained; }
    std::string get_retained_revision() { return retained_revision; }
    std::uint64_t get_replay_structural_generations() { return replay_structural_generations; }
    std::uint64_t get_replay_time_generations() { return replay_time_generations; }
    std::uint64_t get_replay_play_time_ms() { return replay_play_time_ms; }
    bool get_thumbnail_available() { return thumbnail_available; }
    bool get_thumbnail_capture_pending() { return thumbnail_capture_pending; }
    std::string get_summary() { return summary; }
};

struct SaveSlotProjection {
    std::string kind;
    std::uint64_t number = 0;
    std::string label;
    bool occupied = false;
    bool has_metadata = false;
    std::uint64_t play_time_ms = 0;
    std::string project_version;
    std::string detail;
    bool thumbnail_available = false;
    std::string thumbnail_url;
    std::string get_kind() { return kind; }
    std::uint64_t get_number() { return number; }
    std::string get_label() { return label; }
    bool get_occupied() { return occupied; }
    bool get_has_metadata() { return has_metadata; }
    std::uint64_t get_play_time_ms() { return play_time_ms; }
    std::string get_project_version() { return project_version; }
    std::string get_detail() { return detail; }
    bool get_thumbnail_available() { return thumbnail_available; }
    std::string get_thumbnail_url() { return thumbnail_url; }
};

struct ConfirmationProjection {
    bool active = false;
    std::string prompt;
    bool get_active() { return active; }
    std::string get_prompt() { return prompt; }
};

struct ShellProjection {
    bool available = false;
    std::string screen = "none";
    bool game_active = false;
    std::string status;
    SettingsProjection settings;
    CheckpointProjection checkpoint;
    std::vector<SaveSlotProjection> save_slots;
    ConfirmationProjection confirmation;
    bool get_available() { return available; }
    std::string get_screen() { return screen; }
    bool get_game_active() { return game_active; }
    std::string get_status() { return status; }
    SettingsProjection& get_settings() { return settings; }
    CheckpointProjection& get_checkpoint() { return checkpoint; }
    std::vector<SaveSlotProjection>& get_save_slots() { return save_slots; }
    ConfirmationProjection& get_confirmation() { return confirmation; }
};

struct Projection {
    ProjectProjection project;
    GameplayProjection gameplay;
    ShellProjection shell;
};

template<class Struct, class Member>
bool register_member(Rml::StructHandle<Struct>& handle, const char* name, Member member)
{
    return handle.RegisterMember(name, member);
}

template<class Struct, class... MemberPairs>
bool register_struct(Rml::DataModelConstructor& constructor, MemberPairs&&... members)
{
    auto handle = constructor.RegisterStruct<Struct>();
    if (!handle)
        return false;
    return (register_member(handle, members.first, members.second) && ...);
}

} // namespace

struct RuntimeUiDataModel::Impl {
    struct HandleRecord {
        Rml::Context* context = nullptr;
        Rml::DataModelHandle handle;
    };

    RuntimeUiActionGateway& gateway;
    Projection projection;
    std::vector<HandleRecord> handles;

    explicit Impl(RuntimeUiActionGateway& action_gateway) : gateway(action_gateway) {}

    void dirty_all()
    {
        for (auto& record : handles)
            record.handle.DirtyAllVariables();
    }

    bool register_types(Rml::DataModelConstructor& c)
    {
        bool ok = true;
#define NT_MEMBER(TYPE, NAME)                                                                      \
    std::pair { #NAME, &TYPE::get_##NAME }
        ok &= register_struct<ChoiceProjection>(
            c, NT_MEMBER(ChoiceProjection, kind), NT_MEMBER(ChoiceProjection, id),
            NT_MEMBER(ChoiceProjection, label), NT_MEMBER(ChoiceProjection, enabled));
        ok &= register_struct<ActorProjection>(
            c, NT_MEMBER(ActorProjection, character_id), NT_MEMBER(ActorProjection, instance_id),
            NT_MEMBER(ActorProjection, pose_id), NT_MEMBER(ActorProjection, expression_id),
            NT_MEMBER(ActorProjection, presentation_complete));
        ok &= register_struct<ExitProjection>(
            c, NT_MEMBER(ExitProjection, id), NT_MEMBER(ExitProjection, target_id),
            NT_MEMBER(ExitProjection, direction), NT_MEMBER(ExitProjection, label),
            NT_MEMBER(ExitProjection, enabled), NT_MEMBER(ExitProjection, glyph));
        ok &= register_struct<ObjectProjection>(
            c, NT_MEMBER(ObjectProjection, subject_kind), NT_MEMBER(ObjectProjection, subject_id),
            NT_MEMBER(ObjectProjection, label), NT_MEMBER(ObjectProjection, enabled),
            NT_MEMBER(ObjectProjection, selected));
        ok &= register_struct<InventoryItemProjection>(
            c, NT_MEMBER(InventoryItemProjection, id),
            NT_MEMBER(InventoryItemProjection, display_name),
            NT_MEMBER(InventoryItemProjection, enabled),
            NT_MEMBER(InventoryItemProjection, selected));
        ok &= register_struct<ActionProjection>(
            c, NT_MEMBER(ActionProjection, verb_id), NT_MEMBER(ActionProjection, label),
            NT_MEMBER(ActionProjection, arity), NT_MEMBER(ActionProjection, quick_action),
            NT_MEMBER(ActionProjection, enabled));
        ok &= register_struct<TextLogEntryProjection>(
            c, NT_MEMBER(TextLogEntryProjection, sequence), NT_MEMBER(TextLogEntryProjection, kind),
            NT_MEMBER(TextLogEntryProjection, has_speaker),
            NT_MEMBER(TextLogEntryProjection, speaker_id), NT_MEMBER(TextLogEntryProjection, text),
            NT_MEMBER(TextLogEntryProjection, body_rml));
        ok &= c.RegisterArray<std::vector<ChoiceProjection>>();
        ok &= c.RegisterArray<std::vector<ActorProjection>>();
        ok &= c.RegisterArray<std::vector<ExitProjection>>();
        ok &= c.RegisterArray<std::vector<ObjectProjection>>();
        ok &= c.RegisterArray<std::vector<InventoryItemProjection>>();
        ok &= c.RegisterArray<std::vector<ActionProjection>>();
        ok &= c.RegisterArray<std::vector<TextLogEntryProjection>>();
        ok &= register_struct<RoomProjection>(
            c, NT_MEMBER(RoomProjection, available), NT_MEMBER(RoomProjection, has_enabled_exits),
            NT_MEMBER(RoomProjection, exits), NT_MEMBER(RoomProjection, objects));
        ok &= register_struct<InventoryProjection>(c, NT_MEMBER(InventoryProjection, items));
        ok &= register_struct<InteractionProjection>(
            c, NT_MEMBER(InteractionProjection, has_selection),
            NT_MEMBER(InteractionProjection, actions));
        ok &= register_struct<TextLogProjection>(c, NT_MEMBER(TextLogProjection, entries));
        ok &= register_struct<GameplayProjection>(
            c, NT_MEMBER(GameplayProjection, available), NT_MEMBER(GameplayProjection, mode),
            NT_MEMBER(GameplayProjection, title), NT_MEMBER(GameplayProjection, notification),
            NT_MEMBER(GameplayProjection, can_continue),
            NT_MEMBER(GameplayProjection, active_text_available),
            NT_MEMBER(GameplayProjection, choices), NT_MEMBER(GameplayProjection, actors),
            NT_MEMBER(GameplayProjection, room), NT_MEMBER(GameplayProjection, inventory),
            NT_MEMBER(GameplayProjection, interaction), NT_MEMBER(GameplayProjection, text_log));
        ok &= register_struct<ProjectProjection>(c, NT_MEMBER(ProjectProjection, title),
                                                 NT_MEMBER(ProjectProjection, subtitle),
                                                 NT_MEMBER(ProjectProjection, start_label));
        ok &= register_struct<ScaleProjection>(
            c, NT_MEMBER(ScaleProjection, enabled), NT_MEMBER(ScaleProjection, value),
            NT_MEMBER(ScaleProjection, minimum), NT_MEMBER(ScaleProjection, default_value),
            NT_MEMBER(ScaleProjection, maximum));
        ok &= register_struct<SettingsProjection>(c, NT_MEMBER(SettingsProjection, ui_scale),
                                                  NT_MEMBER(SettingsProjection, text_scale));
        ok &= register_struct<CheckpointProjection>(
            c, NT_MEMBER(CheckpointProjection, available), NT_MEMBER(CheckpointProjection, ready),
            NT_MEMBER(CheckpointProjection, retained),
            NT_MEMBER(CheckpointProjection, retained_revision),
            NT_MEMBER(CheckpointProjection, replay_structural_generations),
            NT_MEMBER(CheckpointProjection, replay_time_generations),
            NT_MEMBER(CheckpointProjection, replay_play_time_ms),
            NT_MEMBER(CheckpointProjection, thumbnail_available),
            NT_MEMBER(CheckpointProjection, thumbnail_capture_pending),
            NT_MEMBER(CheckpointProjection, summary));
        ok &= register_struct<SaveSlotProjection>(
            c, NT_MEMBER(SaveSlotProjection, kind), NT_MEMBER(SaveSlotProjection, number),
            NT_MEMBER(SaveSlotProjection, label), NT_MEMBER(SaveSlotProjection, occupied),
            NT_MEMBER(SaveSlotProjection, has_metadata),
            NT_MEMBER(SaveSlotProjection, play_time_ms),
            NT_MEMBER(SaveSlotProjection, project_version), NT_MEMBER(SaveSlotProjection, detail),
            NT_MEMBER(SaveSlotProjection, thumbnail_available),
            NT_MEMBER(SaveSlotProjection, thumbnail_url));
        ok &= c.RegisterArray<std::vector<SaveSlotProjection>>();
        ok &= register_struct<ConfirmationProjection>(c, NT_MEMBER(ConfirmationProjection, active),
                                                      NT_MEMBER(ConfirmationProjection, prompt));
        ok &= register_struct<ShellProjection>(
            c, NT_MEMBER(ShellProjection, available), NT_MEMBER(ShellProjection, screen),
            NT_MEMBER(ShellProjection, game_active), NT_MEMBER(ShellProjection, status),
            NT_MEMBER(ShellProjection, settings), NT_MEMBER(ShellProjection, checkpoint),
            NT_MEMBER(ShellProjection, save_slots), NT_MEMBER(ShellProjection, confirmation));
#undef NT_MEMBER
        return ok;
    }

    bool register_callbacks(Rml::DataModelConstructor& c)
    {
        const auto callback = [](auto function) {
            return [function](Rml::DataModelHandle, Rml::Event&, const Rml::VariantList& args) {
                (void)function(args);
            };
        };
        bool ok = true;
        ok &= c.BindEventCallback(
            "ui_continue", callback([this](const auto&) { return gateway.action_continue(); }));
        ok &= c.BindEventCallback("ui_choose", callback([this](const auto& args) {
                                      return gateway.action_choose(event_arg<std::string>(args, 0),
                                                                   event_arg<std::string>(args, 1));
                                  }));
        ok &= c.BindEventCallback("ui_navigate_room", callback([this](const auto& args) {
                                      return gateway.action_navigate_room(
                                          event_arg<std::string>(args, 0));
                                  }));
        ok &= c.BindEventCallback("ui_toggle_subject", callback([this](const auto& args) {
                                      return gateway.action_toggle_subject(
                                          event_arg<std::string>(args, 0),
                                          event_arg<std::string>(args, 1));
                                  }));
        ok &= c.BindEventCallback("ui_clear_selection", callback([this](const auto&) {
                                      return gateway.action_clear_selection();
                                  }));
        ok &= c.BindEventCallback("ui_invoke_interaction", callback([this](const auto& args) {
                                      return gateway.action_invoke_interaction(
                                          event_arg<std::string>(args, 0));
                                  }));
        ok &= c.BindEventCallback("shell_start", callback([this](const auto&) {
                                      return gateway.dispatch_shell_command(
                                          core::RuntimeShellCommand{core::StartGameShellCommand{}});
                                  }));
        ok &= c.BindEventCallback("shell_pause", callback([this](const auto&) {
                                      return gateway.dispatch_shell_command(
                                          core::RuntimeShellCommand{core::OpenPauseShellCommand{}});
                                  }));
        ok &=
            c.BindEventCallback("shell_resume", callback([this](const auto&) {
                                    return gateway.dispatch_shell_command(
                                        core::RuntimeShellCommand{core::ResumeGameShellCommand{}});
                                }));
        ok &=
            c.BindEventCallback("shell_open_settings", callback([this](const auto&) {
                                    return gateway.dispatch_shell_command(core::RuntimeShellCommand{
                                        core::OpenSettingsShellCommand{}});
                                }));
        ok &= c.BindEventCallback("shell_open_save", callback([this](const auto&) {
                                      return gateway.dispatch_shell_command(
                                          core::RuntimeShellCommand{core::OpenSaveShellCommand{}});
                                  }));
        ok &= c.BindEventCallback("shell_open_load", callback([this](const auto&) {
                                      return gateway.dispatch_shell_command(
                                          core::RuntimeShellCommand{core::OpenLoadShellCommand{}});
                                  }));
        ok &=
            c.BindEventCallback("shell_open_text_log", callback([this](const auto&) {
                                    return gateway.dispatch_shell_command(
                                        core::RuntimeShellCommand{core::OpenTextLogShellCommand{}});
                                }));
        ok &= c.BindEventCallback("shell_open_debug", callback([this](const auto&) {
                                      return gateway.dispatch_shell_command(
                                          core::RuntimeShellCommand{core::OpenDebugShellCommand{}});
                                  }));
        ok &=
            c.BindEventCallback("shell_close", callback([this](const auto&) {
                                    return gateway.dispatch_shell_command(
                                        core::RuntimeShellCommand{core::CloseShellScreenCommand{}});
                                }));
        ok &=
            c.BindEventCallback("shell_return_to_title", callback([this](const auto&) {
                                    return gateway.dispatch_shell_command(core::RuntimeShellCommand{
                                        core::RequestReturnToTitleShellCommand{}});
                                }));
        ok &=
            c.BindEventCallback("shell_quit", callback([this](const auto&) {
                                    return gateway.dispatch_shell_command(
                                        core::RuntimeShellCommand{core::RequestQuitShellCommand{}});
                                }));
        ok &=
            c.BindEventCallback("shell_save_slot", callback([this](const auto& args) {
                                    return gateway.action_save_slot(event_slot_number_arg(args, 0));
                                }));
        ok &=
            c.BindEventCallback("shell_load_slot", callback([this](const auto& args) {
                                    return gateway.action_load_slot(event_arg<std::string>(args, 0),
                                                                    event_slot_number_arg(args, 1));
                                }));
        ok &= c.BindEventCallback(
            "shell_set_ui_scale", callback([this](const auto& args) {
                return gateway.dispatch_shell_command(core::RuntimeShellCommand{
                    core::SetRuntimeUiScaleShellCommand{event_arg<double>(args, 0)}});
            }));
        ok &= c.BindEventCallback(
            "shell_set_text_scale", callback([this](const auto& args) {
                return gateway.dispatch_shell_command(core::RuntimeShellCommand{
                    core::SetRuntimeTextScaleShellCommand{event_arg<double>(args, 0)}});
            }));
        ok &= c.BindEventCallback("shell_confirm", callback([this](const auto&) {
                                      return gateway.dispatch_shell_command(
                                          core::RuntimeShellCommand{core::ConfirmShellCommand{}});
                                  }));
        ok &= c.BindEventCallback("shell_cancel", callback([this](const auto&) {
                                      return gateway.dispatch_shell_command(
                                          core::RuntimeShellCommand{core::CancelShellCommand{}});
                                  }));
        return ok;
    }
};

RuntimeUiDataModel::RuntimeUiDataModel(RuntimeUiActionGateway& action_gateway)
    : m_impl(std::make_unique<Impl>(action_gateway))
{
}

RuntimeUiDataModel::~RuntimeUiDataModel() { detach_all(); }

bool RuntimeUiDataModel::attach_context(Rml::Context& context)
{
    if (std::any_of(m_impl->handles.begin(), m_impl->handles.end(),
                    [&](const auto& value) { return value.context == &context; }))
        return true;
    auto constructor = context.CreateDataModel("noveltea");
    if (!constructor)
        return false;
    if (!m_impl->register_types(constructor) ||
        !constructor.Bind("project", &m_impl->projection.project) ||
        !constructor.Bind("gameplay", &m_impl->projection.gameplay) ||
        !constructor.Bind("shell", &m_impl->projection.shell) ||
        !m_impl->register_callbacks(constructor)) {
        context.RemoveDataModel("noveltea");
        return false;
    }
    m_impl->handles.push_back({&context, constructor.GetModelHandle()});
    return true;
}

void RuntimeUiDataModel::detach_context(Rml::Context& context)
{
    context.RemoveDataModel("noveltea");
    std::erase_if(m_impl->handles, [&](const auto& value) { return value.context == &context; });
}

void RuntimeUiDataModel::detach_all()
{
    for (auto& record : m_impl->handles)
        if (record.context)
            record.context->RemoveDataModel("noveltea");
    m_impl->handles.clear();
}

void RuntimeUiDataModel::set_project(std::string title, std::string subtitle,
                                     std::string start_label)
{
    m_impl->projection.project.title = title.empty() ? "NovelTea" : std::move(title);
    m_impl->projection.project.subtitle = std::move(subtitle);
    m_impl->projection.project.start_label = start_label.empty() ? "Start" : std::move(start_label);
    m_impl->dirty_all();
}

void RuntimeUiDataModel::set_gameplay(const RuntimeUiGameplayValues& values,
                                      const std::string& typed_notification)
{
    auto& out = m_impl->projection.gameplay;
    const auto& view = values.view;
    out = {};
    out.available = values.revision != 0;
    if (!out.available) {
        m_impl->dirty_all();
        return;
    }
    out.mode = view.mode;
    out.title = view.map && view.map->title ? *view.map->title : std::string{};
    out.notification =
        typed_notification.empty() && view.interaction && view.interaction->notification
            ? *view.interaction->notification
            : typed_notification;
    out.can_continue = view.can_continue;
    out.active_text_available =
        (view.scene && view.scene->text && !view.scene->text->text.empty()) ||
        (view.dialogue && view.dialogue->line && !view.dialogue->line->text.empty()) ||
        (view.room && !view.room->description.empty());

    if (view.scene && view.scene->choice) {
        for (const auto& option : view.scene->choice->options)
            out.choices.push_back({"scene", option.option.text(), option.label, option.enabled});
    } else if (view.dialogue && view.dialogue->choice) {
        for (const auto& option : view.dialogue->choice->options)
            out.choices.push_back({"dialogue", option.edge.text(), option.label, option.enabled});
    }
    if (view.scene) {
        for (const auto& actor : view.scene->actors) {
            if (!actor.visible)
                continue;
            out.actors.push_back({actor.character.text(), actor_instance_text(actor.key),
                                  actor.pose.text(), actor.expression.text(),
                                  actor.presentation_complete});
        }
    }
    out.room.available = view.room.has_value();
    if (view.room) {
        for (const auto& exit : view.room->exits) {
            const auto [direction, glyph] = direction_presentation(exit.direction);
            out.room.exits.push_back({exit.exit.text(), exit.target.text(), std::string(direction),
                                      exit.label, exit.enabled, std::string(glyph)});
            out.room.has_enabled_exits |= exit.enabled;
        }
        for (const auto& placement : view.room->placements) {
            for (const auto& occupant : placement.occupants) {
                if (!occupant.visible)
                    continue;
                std::visit(
                    [&](const auto& subject) {
                        using Subject = std::decay_t<decltype(subject)>;
                        if constexpr (std::is_same_v<Subject,
                                                     core::compiled::CharacterInteractionSubject>) {
                            const auto id = subject.character.text();
                            out.room.objects.push_back(
                                {"character", id, placement.label.value_or(id), occupant.enabled,
                                 id_matches_selected(view.selected_subjects, subject.character)});
                        } else if constexpr (std::is_same_v<
                                                 Subject,
                                                 core::compiled::InteractableInteractionSubject>) {
                            const auto id = subject.interactable.text();
                            out.room.objects.push_back(
                                {"interactable", id, placement.label.value_or(id), occupant.enabled,
                                 id_matches_selected(view.selected_subjects,
                                                     subject.interactable)});
                        }
                    },
                    occupant.subject);
            }
        }
    }
    for (const auto& item : view.inventory.items) {
        if (!item.visible)
            continue;
        out.inventory.items.push_back(
            {item.interactable.text(), item.display_name, item.enabled,
             id_matches_selected(view.selected_subjects, item.interactable)});
    }
    out.interaction.has_selection = !view.selected_subjects.empty();
    const auto& controls = view.room ? view.room->controls : view.inventory.controls;
    for (const auto& control : controls)
        out.interaction.actions.push_back({control.verb.text(), control.label, control.arity,
                                           control.quick_action, control.enabled});
    for (std::size_t i = 0; i < view.text_log.entries.size(); ++i) {
        const auto& entry = view.text_log.entries[i];
        out.text_log.entries.push_back({static_cast<std::uint64_t>(i), text_log_kind(entry.kind),
                                        entry.speaker.has_value(),
                                        entry.speaker ? entry.speaker->text() : std::string{},
                                        entry.text, text_log_body_rml(entry)});
    }
    m_impl->dirty_all();
}

void RuntimeUiDataModel::clear_gameplay()
{
    m_impl->projection.gameplay = {};
    m_impl->dirty_all();
}

void RuntimeUiDataModel::set_gameplay_notification(const std::string& typed_notification,
                                                   const core::TypedRuntimeUIViewState* view)
{
    auto& value = m_impl->projection.gameplay.notification;
    value.clear();
    if (m_impl->projection.gameplay.available && view) {
        value = typed_notification.empty() && view->interaction && view->interaction->notification
                    ? *view->interaction->notification
                    : typed_notification;
    }
    m_impl->dirty_all();
}

void RuntimeUiDataModel::set_shell(const core::RuntimeShellViewState& view,
                                   const std::vector<std::string>& thumbnail_urls)
{
    auto& out = m_impl->projection.shell;
    out = {};
    out.available = true;
    out.screen = shell_screen_name(view.screen);
    out.game_active = view.game_active;
    out.status = view.status;
    out.settings.ui_scale = {view.accessibility.ui_scale.enabled, view.settings.ui_scale(),
                             view.accessibility.ui_scale.minimum,
                             core::RuntimeUserSettings::default_ui_scale,
                             view.accessibility.ui_scale.maximum};
    out.settings.text_scale = {view.accessibility.text_scale.enabled, view.settings.text_scale(),
                               view.accessibility.text_scale.minimum,
                               core::RuntimeUserSettings::default_text_scale,
                               view.accessibility.text_scale.maximum};
    if (view.checkpoint) {
        const auto& checkpoint = *view.checkpoint;
        auto& target = out.checkpoint;
        target.available = true;
        target.ready = checkpoint.readiness.can_capture();
        target.retained = checkpoint.retained_revision.has_value();
        target.retained_revision = checkpoint.retained_revision
                                       ? std::to_string(checkpoint.retained_revision->number())
                                       : std::string{};
        target.replay_structural_generations = checkpoint.replay_distance.structural_generations;
        target.replay_time_generations = checkpoint.replay_distance.time_generations;
        target.replay_play_time_ms =
            static_cast<std::uint64_t>(checkpoint.replay_distance.play_time.count());
        target.thumbnail_available = checkpoint.thumbnail_available;
        target.thumbnail_capture_pending = checkpoint.thumbnail_capture_pending;
        std::ostringstream summary;
        summary << (target.ready ? "Ready to capture" : "Capture blocked") << " · retained "
                << (target.retained ? target.retained_revision : "none") << " · replay distance "
                << target.replay_structural_generations << " structural / "
                << target.replay_time_generations << " time / " << target.replay_play_time_ms
                << " ms · thumbnail "
                << (target.thumbnail_capture_pending
                        ? "pending"
                        : (target.thumbnail_available ? "available" : "unavailable"));
        target.summary = summary.str();
    }
    for (std::size_t i = 0; i < view.slots.size(); ++i) {
        const auto& slot = view.slots[i];
        SaveSlotProjection target;
        target.kind = slot.slot.is_autosave() ? "autosave" : "manual";
        target.number = slot.slot.number();
        target.label =
            slot.slot.is_autosave() ? "Autosave" : "Slot " + std::to_string(slot.slot.number());
        target.occupied = slot.occupied;
        target.has_metadata = slot.metadata.has_value();
        target.detail = slot.occupied ? "Occupied" : "Empty";
        if (slot.metadata) {
            target.play_time_ms = static_cast<std::uint64_t>(slot.metadata->play_time.count());
            target.project_version = slot.metadata->project_version;
            target.detail = "Play time " + std::to_string(target.play_time_ms) + " ms · version " +
                            target.project_version;
        }
        target.thumbnail_available = slot.thumbnail.has_value();
        if (i < thumbnail_urls.size())
            target.thumbnail_url = thumbnail_urls[i];
        out.save_slots.push_back(std::move(target));
    }
    out.confirmation.active = view.confirmation.has_value();
    out.confirmation.prompt = view.confirmation ? view.confirmation->prompt : std::string{};
    m_impl->dirty_all();
}

void RuntimeUiDataModel::clear_shell()
{
    m_impl->projection.shell = {};
    m_impl->projection.shell.settings.ui_scale.value = core::RuntimeUserSettings::default_ui_scale;
    m_impl->projection.shell.settings.ui_scale.default_value =
        core::RuntimeUserSettings::default_ui_scale;
    m_impl->projection.shell.settings.text_scale.value =
        core::RuntimeUserSettings::default_text_scale;
    m_impl->projection.shell.settings.text_scale.default_value =
        core::RuntimeUserSettings::default_text_scale;
    m_impl->dirty_all();
}

} // namespace noveltea::ui::rmlui
