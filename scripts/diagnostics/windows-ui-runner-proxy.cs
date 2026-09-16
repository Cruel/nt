using System;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;
using System.Text.RegularExpressions;
using System.Collections.Generic;
using System.Web.Script.Serialization;

// A diagnostic-only executable adapter for NOVELTEA_UI_TEST_RUNNER. Never packaged.
internal static class WindowsUiRunnerProxy
{
    private static string Required(string name)
    {
        string value = Environment.GetEnvironmentVariable(name);
        if (String.IsNullOrEmpty(value)) throw new InvalidOperationException(name + " is required.");
        return Path.GetFullPath(value);
    }

    private static string QuoteForCommandLine(string value)
    {
        // Quoting for CreateProcess argument parsing, which honors backslash
        // escapes. This must not be reused inside cdb -c strings.
        if (value.IndexOfAny(new char[] { '"', '\r', '\n' }) >= 0)
            throw new ArgumentException("Unsupported character in diagnostic path.");
        return "\"" + value + "\"";
    }

    private static void CopyProject(string source, string destination)
    {
        Directory.CreateDirectory(destination);
        foreach (string file in Directory.GetFiles(source))
            if ((File.GetAttributes(file) & FileAttributes.ReparsePoint) == 0)
                File.Copy(file, Path.Combine(destination, Path.GetFileName(file)));
        foreach (string directory in Directory.GetDirectories(source))
            if (Path.GetFileName(directory) != ".noveltea" &&
                (File.GetAttributes(directory) & FileAttributes.ReparsePoint) == 0)
                CopyProject(directory, Path.Combine(destination, Path.GetFileName(directory)));
    }

    private static int Main(string[] args)
    {
        string evidence = null;
        try
        {
            if (args.Length != 2) throw new ArgumentException("Expected request and response paths.");
            string root = Required("NT_DIAGNOSTIC_EVIDENCE");
            string runner = Required("NT_DIAGNOSTIC_REAL_RUNNER");
            string debugger = Required("NT_DIAGNOSTIC_CDB");
            // A cold-cache caller can retry after failure; do not generate another full dump.
            if (File.Exists(Path.Combine(root, "fault-detected.txt"))) return 1;
            evidence = Path.Combine(root, DateTime.UtcNow.ToString("yyyyMMddTHHmmssfffffff") + "-" + Process.GetCurrentProcess().Id);
            Directory.CreateDirectory(evidence);
            string request = Path.Combine(evidence, "request.json");
            string response = Path.Combine(evidence, "response.json");
            string dump = Path.Combine(evidence, "crash.dmp");
            string log = Path.Combine(evidence, "debugger.log");
            string commands = Path.Combine(evidence, "debugger.commands");
            File.Copy(args[0], request);
            File.WriteAllText(Path.Combine(evidence, "runner.txt"), runner);
            // Dump before symbol analysis, so even an analysis timeout leaves the essential evidence.
            // The dump path travels via an alias so the -c strings contain no nested
            // quotes; cdb does not process backslash escapes there and a garbled
            // registration silently skips the handler on second chance.
            // cdb's `as` does interpret backslash escapes in the value, so the
            // path is doubled; ${...} expansion at use yields the real path.
            if (dump.IndexOfAny(new char[] { '"', '\r', '\n' }) >= 0)
                throw new ArgumentException("Unsupported character in diagnostic path.");
            string aliasedDump = dump.Replace("\\", "\\\\");
            const string handlers =
                "sxe -c \".echo NT_DIAGNOSTIC_EXCEPTION; " +
                ".dump /ma ${NT_DIAGNOSTIC_DUMP}; .ecxr; !analyze -v; ~*kb; q\" ";
            File.WriteAllText(commands,
                "as NT_DIAGNOSTIC_DUMP " + aliasedDump + "\n" +
                handlers + "av\n" +
                handlers + "c0000374\n" +
                // Full page heap reports verifier corruption with an int3 after
                // the initial loader break, rather than as an AV/heap status.
                handlers + "80000003\n" +
                "g\n");
            // No -g: the command file must be processed at the initial break so
            // handlers are registered before the first exception. With -g, -cf
            // runs at the first-chance break instead, and plain -c handlers
            // (first-chance only) never fire; the run then drifts into second
            // chance with nothing to run and quits on stdin EOF. Keep -G so
            // clean target exits do not stop at the final process breakpoint.
            var start = new ProcessStartInfo(debugger,
                "-G -logo " + QuoteForCommandLine(log) + " -cf " +
                QuoteForCommandLine(commands) + " " + QuoteForCommandLine(runner) + " " +
                QuoteForCommandLine(request) + " " + QuoteForCommandLine(response));
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.RedirectStandardOutput = true;
            start.RedirectStandardError = true;
            int debuggerExit;
            using (var process = Process.Start(start))
            using (var stdout = new FileStream(Path.Combine(evidence, "stdout.log"), FileMode.Create))
            using (var stderr = new FileStream(Path.Combine(evidence, "stderr.log"), FileMode.Create))
            {
                Task output = process.StandardOutput.BaseStream.CopyToAsync(stdout);
                Task error = process.StandardError.BaseStream.CopyToAsync(stderr);
                if (!process.WaitForExit(180000))
                {
                    File.WriteAllText(Path.Combine(evidence, "timeout.txt"), "Debugger exceeded 180 seconds.");
                    var kill = new ProcessStartInfo("taskkill.exe", "/PID " + process.Id + " /T /F");
                    kill.UseShellExecute = false;
                    kill.CreateNoWindow = true;
                    using (var killer = Process.Start(kill)) killer.WaitForExit();
                    process.WaitForExit();
                }
                Task.WaitAll(output, error);
                debuggerExit = process.ExitCode;
                File.WriteAllText(Path.Combine(evidence, "debugger-exit.txt"), debuggerExit.ToString());
            }
            bool fault = File.Exists(dump) || File.Exists(Path.Combine(evidence, "timeout.txt")) ||
                (File.Exists(log) && Regex.IsMatch(File.ReadAllText(log), @"(?m)^NT_DIAGNOSTIC_EXCEPTION\r?$"));
            if (fault || debuggerExit != 0 || !File.Exists(response))
            {
                File.WriteAllText(Path.Combine(root, "fault-detected.txt"), evidence);
                // Certification deletes its temporary Project when the parent unwinds.
                try
                {
                    var json = new JavaScriptSerializer();
                    json.MaxJsonLength = Int32.MaxValue;
                    var payload = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(request));
                    object projectRoot;
                    if (payload.TryGetValue("projectRoot", out projectRoot) && projectRoot is string &&
                        Directory.Exists((string)projectRoot))
                        CopyProject((string)projectRoot, Path.Combine(evidence, "project"));
                }
                catch (Exception error)
                {
                    File.WriteAllText(Path.Combine(evidence, "project-copy-error.txt"), error.ToString());
                }
                // Never let a response written before a teardown crash turn the invocation green.
                return 1;
            }
            File.Copy(response, args[1], true);
            return 0;
        }
        catch (Exception error)
        {
            if (evidence != null) File.WriteAllText(Path.Combine(evidence, "proxy-error.txt"), error.ToString());
            Console.Error.WriteLine("Diagnostic runner proxy failed: " + error.Message);
            return 2;
        }
    }
}
