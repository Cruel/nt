#include <noveltea/core/typed_save_slot_store.hpp>

#include <catch2/catch_test_macros.hpp>

#include <chrono>
#include <filesystem>
#include <string>

using namespace noveltea::core;

namespace {

std::filesystem::path temporary_root(std::string_view name)
{
    return std::filesystem::temp_directory_path() /
           ("noveltea-" + std::string(name) + "-" +
            std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
}

} // namespace

TEST_CASE("typed memory save slots store only encoded bytes under reserved identities")
{
    TypedMemorySaveSlotStore store;
    const auto manual = TypedSaveSlotId::manual(0);
    const auto autosave = TypedSaveSlotId::autosave();
    REQUIRE(store.write_slot(manual, "manual-bytes"));
    REQUIRE(store.write_slot(autosave, "autosave-bytes"));
    CHECK(store.has_slot(manual).value());
    CHECK(store.has_slot(autosave).value());
    CHECK(store.read_slot(manual).value() == "manual-bytes");
    CHECK(store.read_slot(autosave).value() == "autosave-bytes");
    REQUIRE(store.delete_slot(manual));
    CHECK_FALSE(store.has_slot(manual).value());
    CHECK_FALSE(store.read_slot(manual));
}

TEST_CASE("typed save slots preserve checkpoint metadata and thumbnail with exact save bytes")
{
    const auto root = temporary_root("typed-checkpoint-bundle");
    const auto slot = TypedSaveSlotId::manual(3);
    const TypedSaveSlotCheckpoint checkpoint{
        .encoded_save = "{\"exact\":\"save\"}",
        .metadata =
            SaveCheckpointMetadata{.save_format_version = 6,
                                   .project = ProjectId::create("checkpoint-project").value(),
                                   .project_version = "9C",
                                   .play_time = std::chrono::milliseconds{3210},
                                   .generations = {7, 7, 5, 5}},
        .thumbnail = SaveCheckpointThumbnail{.encoding = SaveCheckpointThumbnailEncoding::Png,
                                             .width = 320,
                                             .height = 180,
                                             .bytes = "\x89PNG\r\n\x1a\nthumbnail"}};

    TypedMemorySaveSlotStore memory;
    REQUIRE(memory.write_checkpoint(slot, checkpoint));
    CHECK(memory.read_slot(slot).value() == checkpoint.encoded_save);
    CHECK(memory.read_checkpoint(slot).value() == checkpoint);

    TypedFilesystemSaveSlotStore filesystem(root);
    REQUIRE(filesystem.write_checkpoint(slot, checkpoint));
    CHECK(filesystem.read_slot(slot).value() == checkpoint.encoded_save);
    CHECK(filesystem.read_checkpoint(slot).value() == checkpoint);

    std::error_code error;
    std::filesystem::remove_all(root, error);
}

TEST_CASE("typed filesystem slots contain paths and replace files atomically")
{
    const auto root = temporary_root("typed-save-slots");
    TypedFilesystemSaveSlotStore store(root);
    const auto manual = TypedSaveSlotId::manual(42);
    const auto autosave = TypedSaveSlotId::autosave();

    REQUIRE(store.write_slot(manual, "first"));
    REQUIRE(store.write_slot(manual, "replacement"));
    REQUIRE(store.write_slot(autosave, "auto"));
    CHECK(store.read_slot(manual).value() == "replacement");
    CHECK(store.read_slot(autosave).value() == "auto");
    CHECK(std::filesystem::is_regular_file(root / "slot-42.ntsav"));
    CHECK(std::filesystem::is_regular_file(root / "autosave.ntsav"));

    std::error_code error;
    std::filesystem::remove_all(root, error);
}

TEST_CASE("typed filesystem slot failures do not replace the prior save")
{
    const auto root = temporary_root("typed-save-interruption");
    TypedFilesystemSaveSlotStore store(root);
    const auto slot = TypedSaveSlotId::manual(7);
    REQUIRE(store.write_slot(slot, "complete-save"));
    REQUIRE(std::filesystem::create_directory(root / "slot-7.ntsav.tmp"));

    auto interrupted = store.write_slot(slot, "partial-save");
    REQUIRE_FALSE(interrupted);
    CHECK(interrupted.error().front().code == "save_slot.short_write");
    CHECK(store.read_slot(slot).value() == "complete-save");

    std::error_code error;
    std::filesystem::remove_all(root, error);
}

TEST_CASE("typed filesystem store reports missing and unreadable slots")
{
    const auto root = temporary_root("typed-save-errors");
    TypedFilesystemSaveSlotStore store(root);
    CHECK_FALSE(store.read_slot(TypedSaveSlotId::manual(1)));

    std::error_code error;
    std::filesystem::create_directories(root / "slot-2.ntsav", error);
    auto unreadable = store.read_slot(TypedSaveSlotId::manual(2));
    REQUIRE_FALSE(unreadable);
    CHECK(unreadable.error().front().code == "save_slot.missing");
    std::filesystem::remove_all(root, error);
}
