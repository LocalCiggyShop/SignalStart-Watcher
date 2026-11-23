using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace SignalStartBridge {
    public static class NativeHost {
        const int Limit = 1024 * 1024;
        static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = Limit };
        static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
        static readonly CultureInfo Inv = CultureInfo.InvariantCulture;
        static readonly List<Process> Terminals = new List<Process>();

        static byte[] ReadExact(Stream stream, int count, bool allowEof) {
            byte[] bytes = new byte[count];
            int offset = 0;
            while (offset < count) {
                int read = stream.Read(bytes, offset, count - offset);
                if (read == 0) {
                    if (offset == 0 && allowEof) return null;
                    throw new EndOfStreamException("Incomplete native message.");
                }
                offset += read;
            }
            return bytes;
        }
        static object Get(IDictionary<string, object> obj, string key) {
            object value;
            return obj.TryGetValue(key, out value) ? value : null;
        }
        static string Text(object value, int max) {
            string raw = Convert.ToString(value, Inv) ?? "";
            var result = new StringBuilder();
            foreach (char c in raw) {
                if (result.Length >= max) break;
                result.Append(char.IsControl(c) ? ' ' : c);
            }
            return result.ToString();
        }
        static double Number(object value) {
            if (value == null || value is bool || value is string) throw new ArgumentException("Expected a number.");
            double number = Convert.ToDouble(value, Inv);
            if (Double.IsNaN(number) || Double.IsInfinity(number)) throw new ArgumentException("Number must be finite.");
            return number;
        }
        static bool Flag(object value) { return value is bool && (bool)value; }
        static long Now() { return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds; }
        static string N(double value) { return value.ToString("R", Inv); }

        static bool TerminalRunning(int testPid) {
            if (testPid >= 0) {
                try { using (var process = Process.GetProcessById(testPid)) return !process.HasExited; }
                catch (ArgumentException) { return false; }
            }
            // Reuse process handles; never enumerate all terminal processes per price update.
            for (int index = Terminals.Count - 1; index >= 0; index--) {
                try { if (!Terminals[index].HasExited) return true; }
                catch (InvalidOperationException) {}
                Terminals[index].Dispose();
                Terminals.RemoveAt(index);
            }
            int session;
            using (var current = Process.GetCurrentProcess()) session = current.SessionId;
            foreach (string name in new [] { "terminal64", "terminal" }) {
                bool found = false;
                foreach (var process in Process.GetProcessesByName(name)) {
                    bool keep = false;
                    try { keep = !process.HasExited && process.SessionId == session; }
                    catch (InvalidOperationException) {}
                    if (keep) { Terminals.Add(process); found = true; }
                    else process.Dispose();
                }
                if (found) return true;
            }
            return false;
        }

        static void WriteSnapshot(IDictionary<string, object> message, string folder) {
            double schema = Number(Get(message, "schema"));
            if (schema != 1 && schema != 2) throw new ArgumentException("Unsupported bridge schema. Update the local helper.");
            string requestId = Text(Get(message, "requestId"), 80);
            if (requestId.Length == 0) throw new ArgumentException("Missing request ID.");
            bool enabled = Flag(Get(message, "enabled"));
            var signal = Get(message, "signal") as IDictionary<string, object>;
            var alerts = Get(message, "alerts") as IList;
            if (alerts == null || alerts.Count > 100) throw new ArgumentException("Invalid alert list.");
            var body = new StringBuilder();
            if (schema == 2) {
                double seconds = Number(Get(message, "checkSeconds"));
                if (seconds < 1 || seconds > 60 || seconds != Math.Floor(seconds)) throw new ArgumentException("Check interval must be 1 to 60 whole seconds.");
                body.AppendLine("C\t" + N(seconds));
            }
            string signalId = "";
            if (enabled) {
                if (signal == null) throw new ArgumentException("Missing signal data.");
                signalId = Text(Get(signal, "id"), 30);
                ulong parsedId;
                if (!UInt64.TryParse(signalId, out parsedId)) throw new ArgumentException("Invalid signal ID.");
                double trades = Number(Get(signal, "openTrades"));
                if (trades < -1 || trades != Math.Floor(trades)) throw new ArgumentException("Invalid trade count.");
                double sampleAt = Number(Get(signal, "sampleAt"));
                if (sampleAt <= 0 || sampleAt > Now() + 5000) throw new ArgumentException("Invalid sample timestamp.");
                string source = Text(Get(signal, "source"), 10);
                if (source != "live" && source != "poll") throw new ArgumentException("Invalid data source.");
                body.AppendLine(String.Join("\t", new [] { "S", signalId,
                    Text(Get(signal, "name"), 300), N(Number(Get(signal, "floatingValue"))),
                    Text(Get(signal, "floatingDisplay"), 300), N(trades), N(sampleAt), source,
                    Text(Get(signal, "error"), 300).Length == 0 ? "-" : Text(Get(signal, "error"), 300),
                    Flag(Get(signal, "cycleHadMultiple")) ? "1" : "0" }));
                if (schema == 2) {
                    var details = Get(signal, "tradeDetails") as IDictionary<string, object>;
                    string state = details == null ? "unavailable" : Text(Get(details, "status"), 20);
                    string symbol = details == null ? "" : Text(Get(details, "symbol"), 40);
                    double lots = 0, sl = 0, tp = 0, side = 0;
                    if (state == "ready") {
                        lots = Number(Get(details, "lots")); sl = Number(Get(details, "sl"));
                        tp = Number(Get(details, "tp")); side = Number(Get(details, "side"));
                        if (trades != 1 || symbol.Length == 0 || lots <= 0 || sl < 0 || tp < 0 || (side != -1 && side != 0 && side != 1))
                            throw new ArgumentException("Invalid automatic trade details.");
                    } else if (state != "flat" && state != "multiple") state = "unavailable";
                    string reason = details == null ? "Waiting for automatic trade details from the browser." : Text(Get(details, "reason"), 180);
                    string identity = details == null ? "" : Text(Get(details, "identity"), 120);
                    body.AppendLine(String.Join("\t", new [] { "T", state, symbol.Length == 0 ? "-" : symbol,
                        N(lots), N(sl), N(tp), N(side), identity.Length == 0 ? "-" : identity,
                        reason.Length == 0 ? "-" : reason }));
                }
            }
            foreach (object item in alerts) {
                var alert = item as IDictionary<string, object>;
                ulong alertSignalId;
                if (alert == null || !UInt64.TryParse(Text(Get(alert, "signalId"), 30), out alertSignalId))
                    throw new ArgumentException("Alert has an invalid signal ID.");
                body.AppendLine(String.Join("\t", new [] { "A", Text(Get(alert, "id"), 80),
                    N(Number(Get(alert, "at"))), Text(Get(alert, "signalId"), 30),
                    Text(Get(alert, "title"), 300), Text(Get(alert, "message"), 600) }));
            }
            string header = String.Join("\t", new [] { schema == 2 ? "SSB2" : "SSB1", N(schema), Now().ToString(Inv),
                enabled ? "1" : "0", Flag(Get(message, "notificationsEnabled")) ? "1" : "0",
                requestId, alerts.Count.ToString(Inv) });
            string contents = header + "\r\n" + body + "END\t" + requestId + "\r\n";
            Directory.CreateDirectory(folder);
            string target = Path.Combine(folder, "snapshot.tsv");
            string temp = Path.Combine(folder, Guid.NewGuid().ToString("N") + ".tmp");
            using (var mutex = new Mutex(false, "Local\\SignalStartMt5BridgeWriter")) {
                bool held = false;
                try {
                    try { held = mutex.WaitOne(3000); } catch (AbandonedMutexException) { held = true; }
                    if (!held) throw new IOException("Another bridge writer is busy.");
                    File.WriteAllText(temp, contents, Utf8);
                    for (int attempt = 0; ; attempt++) {
                        try {
                            if (File.Exists(target)) File.Replace(temp, target, null);
                            else File.Move(temp, target);
                            break;
                        } catch (IOException) {
                            if (attempt >= 19) throw;
                            Thread.Sleep(2);
                        }
                    }
                } finally {
                    if (File.Exists(temp)) File.Delete(temp);
                    if (held) mutex.ReleaseMutex();
                }
            }
        }
        static void Reply(Stream output, object response) {
            byte[] bytes = Utf8.GetBytes(Json.Serialize(response));
            byte[] header = BitConverter.GetBytes((UInt32)bytes.Length);
            output.Write(header, 0, header.Length);
            output.Write(bytes, 0, bytes.Length);
            output.Flush();
        }
        public static int Main(string[] args) {
            // Explorer/console launches have no native-messaging pipe to serve.
            if (!Console.IsInputRedirected) {
                Console.Error.WriteLine("This helper is started by the SignalStart browser extension. Use SetupBridge.exe for setup.");
                return 0;
            }
            bool isolated = false;
            int testPid = -1;
            string folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                "MetaQuotes", "Terminal", "Common", "Files", "SignalStartBridge");
            foreach (string arg in args) {
                // For isolated protocol tests; the extension cannot select a filesystem path.
                if (arg.StartsWith("--data-dir=", StringComparison.Ordinal)) {
                    folder = Path.GetFullPath(arg.Substring(11));
                    isolated = true;
                }
                if (arg.StartsWith("--terminal-process-id=", StringComparison.Ordinal)) testPid = Int32.Parse(arg.Substring(22), Inv);
            }
            using (Stream input = Console.OpenStandardInput())
            using (Stream output = Console.OpenStandardOutput()) {
                try {
                    while (true) {
                        byte[] header = ReadExact(input, 4, true);
                        if (header == null) return 0;
                        uint size = BitConverter.ToUInt32(header, 0);
                        if (size == 0 || size > Limit) throw new ArgumentException("Native message is too large or empty.");
                        string requestId = "";
                        try {
                            var message = Json.DeserializeObject(Utf8.GetString(ReadExact(input, (int)size, false))) as IDictionary<string, object>;
                            if (message == null) throw new ArgumentException("Expected a JSON object.");
                            requestId = Text(Get(message, "requestId"), 80);
                            if ((!isolated || testPid >= 0) && !TerminalRunning(testPid)) {
                                message["enabled"] = false;
                                message["signal"] = null;
                                message["alerts"] = new object[0];
                                WriteSnapshot(message, folder);
                                Reply(output, new { ok = true, mt5Running = false, requestId = requestId });
                                return 0;
                            }
                            WriteSnapshot(message, folder);
                            Reply(output, new { ok = true, requestId = requestId });
                        } catch (Exception error) {
                            Reply(output, new { error = error.Message, requestId = requestId });
                        }
                    }
                } catch (Exception error) {
                    Console.Error.WriteLine(error.Message);
                    return 1;
                }
            }
        }
    }
}
