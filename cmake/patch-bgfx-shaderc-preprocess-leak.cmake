# Patch bgfx shaderc's preprocess-only early returns.
#
# bgfx::compileShader replaces the caller-owned source buffer with a padded
# preprocessed allocation when raw mode is disabled. The preprocess-only paths
# return before the function's common delete[] cleanup, leaking that replacement
# buffer under NovelTea's embedded shader reflection probes.

set(shaderc_file "bgfx/tools/shaderc/shaderc.cpp")
if(NOT EXISTS "${shaderc_file}")
  message(FATAL_ERROR "bgfx shaderc source not found: ${shaderc_file}")
endif()

file(READ "${shaderc_file}" shaderc_content)
set(preprocess_marker "if (_options.preprocessOnly)")
set(cleanup_marker "delete [] data;")
set(return_marker "return true;")

function(find_next_marker content marker start out_index)
  string(LENGTH "${content}" content_length)
  if(start GREATER_EQUAL content_length)
    set(${out_index} -1 PARENT_SCOPE)
    return()
  endif()
  string(SUBSTRING "${content}" ${start} -1 tail)
  string(FIND "${tail}" "${marker}" relative_index)
  if(relative_index EQUAL -1)
    set(${out_index} -1 PARENT_SCOPE)
  else()
    math(EXPR absolute_index "${start} + ${relative_index}")
    set(${out_index} ${absolute_index} PARENT_SCOPE)
  endif()
endfunction()

set(search_start 0)
set(preprocess_blocks 0)
while(1)
  find_next_marker("${shaderc_content}" "${preprocess_marker}" ${search_start} block_index)
  if(block_index EQUAL -1)
    break()
  endif()

  math(EXPR block_search_start "${block_index} + 1")
  find_next_marker("${shaderc_content}" "${return_marker}" ${block_search_start} return_index)
  if(return_index EQUAL -1)
    message(FATAL_ERROR "bgfx preprocess-only block no longer contains an early return")
  endif()

  math(EXPR block_length "${return_index} - ${block_index}")
  string(SUBSTRING "${shaderc_content}" ${block_index} ${block_length} block_prefix)
  string(FIND "${block_prefix}" "${cleanup_marker}" cleanup_index)
  if(cleanup_index EQUAL -1)
    string(SUBSTRING "${shaderc_content}" 0 ${return_index} content_before_return)
    string(SUBSTRING "${shaderc_content}" ${return_index} -1 content_from_return)
    set(shaderc_content
        "${content_before_return}${cleanup_marker}\n\t\t\t\t\t\t\t${content_from_return}")
    string(LENGTH "${cleanup_marker}\n\t\t\t\t\t\t\t" inserted_length)
    math(EXPR return_index "${return_index} + ${inserted_length}")
  endif()

  math(EXPR preprocess_blocks "${preprocess_blocks} + 1")
  math(EXPR search_start "${return_index} + 1")
endwhile()

if(NOT preprocess_blocks EQUAL 2)
  message(FATAL_ERROR
    "bgfx shaderc preprocess-only structure changed; expected 2 blocks, found ${preprocess_blocks}")
endif()

file(WRITE "${shaderc_file}" "${shaderc_content}")
