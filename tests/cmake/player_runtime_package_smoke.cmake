if(NOT DEFINED PLAYER OR NOT EXISTS "${PLAYER}")
    message(FATAL_ERROR "PLAYER must name the built NovelTea player executable")
endif()
if(NOT DEFINED PACKAGE OR NOT EXISTS "${PACKAGE}")
    message(FATAL_ERROR "PACKAGE must name a generated NovelTea runtime package")
endif()
if(NOT DEFINED WORK_DIR OR WORK_DIR STREQUAL "")
    message(FATAL_ERROR "WORK_DIR must name the isolated player smoke directory")
endif()

file(REMOVE_RECURSE "${WORK_DIR}")
file(MAKE_DIRECTORY "${WORK_DIR}" "${WORK_DIR}/data")
file(COPY_FILE "${PACKAGE}" "${WORK_DIR}/game.ntpkg" ONLY_IF_DIFFERENT)
file(SHA256 "${WORK_DIR}/game.ntpkg" package_sha256)
file(WRITE "${WORK_DIR}/player.json"
    "{\"format\":\"noveltea.player-config\",\"formatVersion\":1,"
    "\"displayName\":\"NovelTea Player Smoke\","
    "\"applicationId\":\"org.noveltea.player-smoke\","
    "\"saveNamespace\":\"org.noveltea.player-smoke\","
    "\"versionName\":\"1.0.0\","
    "\"package\":{\"path\":\"game.ntpkg\",\"sha256\":\"${package_sha256}\","
    "\"runtimePackageApi\":1},\"capabilities\":[],"
    "\"display\":{\"aspectRatio\":{\"width\":16,\"height\":9},"
    "\"orientation\":\"landscape\",\"barColor\":\"#000000\"}}\n")

set(player_command "${PLAYER}" --player-config "${WORK_DIR}/player.json")
if(DEFINED XVFB_RUN AND NOT XVFB_RUN STREQUAL "" AND EXISTS "${XVFB_RUN}")
    list(PREPEND player_command "${XVFB_RUN}" -a)
endif()

execute_process(
    COMMAND "${CMAKE_COMMAND}" -E env
        "XDG_DATA_HOME=${WORK_DIR}/data"
        "NOVELTEA_PLAYER_SMOKE_FRAMES=5"
        ${player_command}
    RESULT_VARIABLE player_result
    OUTPUT_VARIABLE player_stdout
    ERROR_VARIABLE player_stderr
    TIMEOUT 30
)
message("${player_stdout}${player_stderr}")
if(NOT player_result STREQUAL "0")
    message(FATAL_ERROR "NovelTea player runtime package smoke failed: ${player_result}")
endif()
