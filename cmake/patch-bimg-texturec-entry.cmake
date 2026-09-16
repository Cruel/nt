# Give bimg texturec a stable embeddable entry point while preserving its standalone main.
#
# NovelTea links texturec into the editor tooling bridge. Renaming main through a compile definition
# is not reliable across all supported host compilers, so patch the fetched source explicitly and
# suppress the standalone wrapper only for the embedded target.

set(texturec_file "bimg/tools/texturec/texturec.cpp")
if(NOT EXISTS "${texturec_file}")
  message(FATAL_ERROR "bimg texturec source not found: ${texturec_file}")
endif()

file(READ "${texturec_file}" texturec_content)
set(upstream_signature "int main(int _argc, const char* _argv[])")
set(embedded_signature "int noveltea_bimg_texturec_main(int _argc, const char** _argv)")
string(FIND "${texturec_content}" "${upstream_signature}" upstream_signature_index)
string(FIND "${texturec_content}" "${embedded_signature}" embedded_signature_index)

if(NOT upstream_signature_index EQUAL -1)
  string(REPLACE
    "${upstream_signature}"
    "${embedded_signature}"
    texturec_content "${texturec_content}")
elseif(embedded_signature_index EQUAL -1)
  message(FATAL_ERROR
    "bimg texturec entry point changed; refusing to continue without embedded-entry review")
endif()

set(wrapper_marker "#if !defined(NOVELTEA_BIMG_TEXTUREC_EMBEDDED)")
string(FIND "${texturec_content}" "${wrapper_marker}" wrapper_marker_index)
if(wrapper_marker_index EQUAL -1)
  string(APPEND texturec_content
    "\n#if !defined(NOVELTEA_BIMG_TEXTUREC_EMBEDDED)\n"
    "int main(int _argc, const char* _argv[])\n"
    "{\n"
    "\treturn noveltea_bimg_texturec_main(_argc, _argv);\n"
    "}\n"
    "#endif\n")
endif()

file(WRITE "${texturec_file}" "${texturec_content}")
