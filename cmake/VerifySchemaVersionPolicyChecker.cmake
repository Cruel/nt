cmake_minimum_required(VERSION 3.24)
if(NOT DEFINED SOURCE_ROOT)
    message(FATAL_ERROR "SOURCE_ROOT is required")
endif()

set(root "${SOURCE_ROOT}/build/schema-version-policy-fixtures")
file(REMOVE_RECURSE "${root}")
file(MAKE_DIRECTORY "${root}/src")
file(WRITE "${root}/contract.ts" "export const version = 2;\n")
file(WRITE "${root}/contracts.tsv" "contract_id\tcurrent_marker\tcurrent_version\towner\tproducer_paths\tconsumer_paths\tunsupported_input_action\tpositive_fixture_paths\tnegative_fixture_paths\nfixture\tfixture\t2\ttest\tcontract.ts\tcontract.ts\treject\tcontract.ts\tcontract.ts\n")
file(WRITE "${root}/rules.tsv" "rule_id\tpath_prefixes\tregular_expression\texplanation\nno-migrate\tsrc\tmigrate[A-Za-z0-9_]*\\(\tNo migration helpers.\nno-default\tsrc\tvalue === undefined\\) return 1\tNo missing-version defaults.\nno-union\tsrc\ttypeof value === 'string' \\|\\| typeof value === 'object'\tNo alternate decoders.\n")

function(run_fixture name fixture_file expect_success exceptions debt)
    file(READ "${SOURCE_ROOT}/cmake/schema_version_policy/fixtures/${fixture_file}" content)
    file(WRITE "${root}/src/input.ts" "${content}")
    file(WRITE "${root}/exceptions.tsv" "rule_id\tpath\texpected_count\trationale\n${exceptions}")
    file(WRITE "${root}/debt.tsv" "rule_id\tpath\texpected_count\tremoval_phase\trationale\n${debt}")
    execute_process(COMMAND "${CMAKE_COMMAND}" -DSOURCE_ROOT=${root}
        -DCONTRACTS=${root}/contracts.tsv -DRULES=${root}/rules.tsv
        -DEXCEPTIONS=${root}/exceptions.tsv -DTEMPORARY_DEBT=${root}/debt.tsv
        -P ${SOURCE_ROOT}/cmake/CheckSchemaVersionPolicy.cmake RESULT_VARIABLE result
        OUTPUT_QUIET ERROR_QUIET)
    if(expect_success AND NOT result EQUAL 0)
        message(FATAL_ERROR "Checker rejected positive fixture ${name}")
    elseif(NOT expect_success AND result EQUAL 0)
        message(FATAL_ERROR "Checker accepted negative fixture ${name}")
    endif()
endfunction()

run_fixture(clean clean.ts TRUE "" "")
run_fixture(migration undocumented-migration.ts FALSE "" "")
run_fixture(default missing-version-default.ts FALSE "" "")
run_fixture(union alternate-decoder.ts FALSE "" "")
run_fixture(stale-debt stale-debt.ts FALSE "" "no-migrate\tsrc/input.ts\t1\t2\tstale\n")
run_fixture(wrong-count wrong-count-exception.ts FALSE "no-migrate\tsrc/input.ts\t2\twrong count\n" "")
run_fixture(exact-exception wrong-count-exception.ts TRUE "no-migrate\tsrc/input.ts\t1\tfixture exemption\n" "")

file(REMOVE_RECURSE "${root}")
message(STATUS "Schema version policy checker self-tests passed")
