#include <windows.h>

#include <cstdlib>
#include <fstream>

int main(int argc, char** argv)
{
    if (argc != 3)
        return 2;
    {
        std::ofstream response(argv[2]);
        response << "{\"ok\":true}";
        if (!response)
            return 2;
    }
    if (std::getenv("NT_DIAGNOSTIC_PROBE_CRASH")) {
        // Full page heap must catch this write, even though a response already exists.
        auto* allocation = static_cast<volatile char*>(HeapAlloc(GetProcessHeap(), 0, 16));
        if (!allocation)
            return 3;
        allocation[16] = 42;
        HeapFree(GetProcessHeap(), 0, const_cast<char*>(allocation));
    }
    return 0;
}
