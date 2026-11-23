using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using Microsoft.Win32;

static class SignalStartUpdater {
    const string HostName = "com.signalstart.watcher_updater";
    const string ExtensionName = "SignalStart Floating PL Watcher";
    const string SettingsFile = "signalstart-update-settings.json";
    const string ReleaseFile = "signalstart-update.json";
    const string PackageFile = "signalstart-extension.zip";
    const string TokenFile = "github-update-token.bin";
    const int MetadataLimit = 16 * 1024;
    const int PackageLimit = 16 * 1024 * 1024;
    static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 1024 * 1024 };
    static readonly Regex SafePart = new Regex(@"\A[A-Za-z0-9_][A-Za-z0-9_.-]*\z");
    static readonly Regex DeviceName = new Regex(@"^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)", RegexOptions.IgnoreCase);
    static readonly string[] BrowserFiles = {
        "background.js", "shared.js", "trade-reader.js", "content.js", "content.css",
        "popup.html", "popup.js", "popup.css", "offscreen.html", "offscreen.js",
        "icons/icon16.png", "icons/icon48.png", "icons/icon128.png"
    };

    static int Main(string[] args) {
        ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
        string executable = Assembly.GetExecutingAssembly().Location;
        string location = Path.GetDirectoryName(executable);
        if (args.Length > 0 && args[0].StartsWith("chrome-extension://", StringComparison.Ordinal)) {
            using (Stream input = Console.OpenStandardInput())
            using (Stream output = Console.OpenStandardOutput()) {
                try {
                    int size = BitConverter.ToInt32(ReadExact(input, 4), 0);
                    if (size <= 0 || size > MetadataLimit) throw new InvalidDataException("Invalid updater message.");
                    var request = Parse(Utf8.GetString(ReadExact(input, size)));
                    string extension = ExtensionFolder(location);
                    if (args[0].TrimEnd('/') != "chrome-extension://" + ExtensionId(extension)) {
                        throw new UnauthorizedAccessException("The updater is registered for a different extension folder.");
                    }
                    using (Lock(location)) {
                        Reply(output, CheckForUpdate(location, ParseVersion(Text(request, "version"))));
                    }
                } catch (Exception error) {
                    Reply(output, new { error = error.Message });
                }
            }
            return 0;
        }

        try {
            string destination = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SignalStartWatcher");
            Install(executable, location, destination, Array.IndexOf(args, "--replace-token") >= 0);
            Console.WriteLine("In Chrome, open chrome://extensions and turn on Developer mode.");
            Console.WriteLine("Click Load unpacked and select this folder:");
            Console.WriteLine(ExtensionFolder(destination));
            if (!Console.IsInputRedirected) {
                Console.WriteLine("Press Enter to close this window.");
                Console.ReadLine();
            }
            return 0;
        } catch (Exception error) {
            Console.Error.WriteLine("Setup could not finish. " + error.Message);
            if (!Console.IsInputRedirected) Console.ReadLine();
            return 1;
        }
    }

    static void Install(string executable, string source, string destination, bool replaceToken) {
        var settings = Parse(File.ReadAllText(Path.Combine(source, SettingsFile), Utf8));
        bool privateRelease = settings.ContainsKey("githubRepository");
        if (privateRelease) GitHubRepository(settings);
        else HttpsUrl(Text(settings, "feedUrl"));
        var release = Parse(File.ReadAllText(Path.Combine(source, ReleaseFile), Utf8));
        byte[] package = File.ReadAllBytes(Path.Combine(source, PackageFile));
        Version bundled = ParseVersion(Text(release, "version"));
        Verify(package, release, settings);
        Directory.CreateDirectory(destination);

        using (Lock(destination)) {
            string tokenPath = Path.Combine(destination, TokenFile);
            if (privateRelease && (replaceToken || !File.Exists(tokenPath))) {
                string repository = GitHubRepository(settings);
                Console.WriteLine("This setup uses the private GitHub repository " + repository + ".");
                Console.WriteLine("Paste your GitHub access token with read access to the repository.");
                string token = ReadToken();
                GitHubAssets(repository, token);
                File.WriteAllBytes(tokenPath, ProtectedData.Protect(Utf8.GetBytes(token), null, DataProtectionScope.CurrentUser));
            }
            Recover(destination);
            string extension = ExtensionFolder(destination);
            if (!Directory.Exists(extension) || bundled > ReadExtensionVersion(extension)) {
                ReplaceExtension(destination, package, bundled);
            }

            string installedExe = Path.Combine(destination, "SignalStartUpdater.exe");
            File.Copy(executable, installedExe, true);
            File.Copy(Path.Combine(source, SettingsFile), Path.Combine(destination, SettingsFile), true);
            string manifestPath = Path.Combine(destination, HostName + ".json");
            var manifest = new {
                name = HostName,
                description = "SignalStart Watcher Windows updater",
                path = installedExe,
                type = "stdio",
                allowed_origins = new[] { "chrome-extension://" + ExtensionId(extension) + "/" }
            };
            File.WriteAllText(manifestPath, Json.Serialize(manifest), Utf8);
            using (var key = Registry.CurrentUser.CreateSubKey(@"Software\Google\Chrome\NativeMessagingHosts\" + HostName)) {
                key.SetValue("", manifestPath);
            }
        }
    }

    static object CheckForUpdate(string root, Version loaded) {
        Recover(root);
        Version installed = ReadExtensionVersion(ExtensionFolder(root));
        if (installed > loaded) return new { reload = true };
        var settings = Parse(File.ReadAllText(Path.Combine(root, SettingsFile), Utf8));
        Uri feed;
        Uri packageUrl;
        string token = null;
        if (settings.ContainsKey("githubRepository")) {
            string repository = GitHubRepository(settings);
            string tokenPath = Path.Combine(root, TokenFile);
            if (!File.Exists(tokenPath)) throw new InvalidOperationException("Run setup to authorize GitHub updates.");
            token = Utf8.GetString(ProtectedData.Unprotect(File.ReadAllBytes(tokenPath), null, DataProtectionScope.CurrentUser));
            var assets = GitHubAssets(repository, token);
            feed = GitHubAsset(assets, repository, ReleaseFile);
            packageUrl = GitHubAsset(assets, repository, PackageFile);
        } else {
            feed = HttpsUrl(Text(settings, "feedUrl"));
            packageUrl = new Uri(feed, PackageFile);
        }
        var release = Parse(Utf8.GetString(Download(feed, MetadataLimit, token, "application/octet-stream")));
        Version available = ParseVersion(Text(release, "version"));
        if (available <= installed || available <= loaded) return new { reload = false };
        byte[] package = Download(packageUrl, PackageLimit, token, "application/octet-stream");
        Verify(package, release, settings);
        ReplaceExtension(root, package, available);
        return new { reload = true };
    }

    static void Verify(byte[] package, IDictionary<string, object> release, IDictionary<string, object> settings) {
        if (package.Length > PackageLimit) throw new InvalidDataException("The update package is too large.");
        using (var rsa = new RSACryptoServiceProvider(new CspParameters(24))) {
            rsa.PersistKeyInCsp = false;
            rsa.ImportParameters(new RSAParameters {
                Modulus = Convert.FromBase64String(Text(settings, "modulus")),
                Exponent = Convert.FromBase64String(Text(settings, "exponent"))
            });
            byte[] signature = Convert.FromBase64String(Text(release, "signature"));
            if (!rsa.VerifyData(package, "SHA256", signature)) {
                throw new InvalidDataException("The update signature is invalid. The current version was kept.");
            }
        }
    }

    static void ReplaceExtension(string root, byte[] package, Version expectedVersion) {
        string extension = ExtensionFolder(root);
        string backup = extension + ".backup";
        string staging = extension + ".incoming";
        if (Directory.Exists(staging)) Directory.Delete(staging, true);
        Directory.CreateDirectory(staging);
        try {
            using (var input = new MemoryStream(package, false))
            using (var zip = new ZipArchive(input, ZipArchiveMode.Read)) {
                if (zip.Entries.Count > 500) throw new InvalidDataException("The update archive has too many entries.");
                long expanded = 0;
                foreach (ZipArchiveEntry entry in zip.Entries) {
                    string relative = entry.FullName.TrimEnd('/');
                    string[] parts = relative.Split('/');
                    foreach (string part in parts) {
                        if (!SafePart.IsMatch(part) || DeviceName.IsMatch(part) || part.EndsWith(".")) {
                            throw new InvalidDataException("The update archive contains an invalid path.");
                        }
                    }
                    string destination = Path.Combine(staging, Path.Combine(parts));
                    if (entry.FullName.EndsWith("/")) {
                        Directory.CreateDirectory(destination);
                        continue;
                    }
                    expanded += entry.Length;
                    if (expanded > PackageLimit) throw new InvalidDataException("The extracted update is too large.");
                    Directory.CreateDirectory(Path.GetDirectoryName(destination));
                    using (Stream source = entry.Open())
                    using (FileStream target = File.Open(destination, FileMode.CreateNew)) {
                        CopyWithinLimit(source, target, entry.Length);
                    }
                }
            }
            if (ReadExtensionVersion(staging) != expectedVersion) throw new InvalidDataException("The signed package version did not match its release.");
            foreach (string file in BrowserFiles) {
                if (!File.Exists(Path.Combine(staging, file))) throw new InvalidDataException("Missing extension file " + file + ".");
            }
            if (Directory.Exists(backup)) Directory.Delete(backup, true);
            if (Directory.Exists(extension)) Directory.Move(extension, backup);
            try {
                Directory.Move(staging, extension);
            } catch {
                Recover(root);
                throw;
            }
        } finally {
            if (Directory.Exists(staging)) Directory.Delete(staging, true);
        }
    }

    static void Recover(string root) {
        string extension = ExtensionFolder(root);
        if (!Directory.Exists(extension) && Directory.Exists(extension + ".backup")) {
            Directory.Move(extension + ".backup", extension);
        }
    }

    static Version ReadExtensionVersion(string extension) {
        var manifest = Parse(File.ReadAllText(Path.Combine(extension, "manifest.json"), Utf8));
        if (Text(manifest, "name") != ExtensionName || manifest.ContainsKey("key") ||
            !manifest.ContainsKey("manifest_version") || !Object.Equals(manifest["manifest_version"], 3)) {
            throw new InvalidDataException("The archive is not a SignalStart Watcher extension.");
        }
        return ParseVersion(Text(manifest, "version"));
    }

    static Version ParseVersion(string value) {
        Version version;
        if (!Regex.IsMatch(value, @"\A(0|[1-9][0-9]{0,4})(\.(0|[1-9][0-9]{0,4})){1,3}\z") ||
            !Version.TryParse(value, out version) || version.Major > 65535 ||
            version.Minor > 65535 || version.Build > 65535 || version.Revision > 65535) {
            throw new InvalidDataException("Invalid release version.");
        }
        return new Version(version.Major, version.Minor, Math.Max(0, version.Build), Math.Max(0, version.Revision));
    }

    static Uri HttpsUrl(string value) {
        Uri url;
        if (!Uri.TryCreate(value, UriKind.Absolute, out url) || url.Scheme != "https" || url.UserInfo.Length != 0) {
            throw new InvalidDataException("The update URL must use HTTPS.");
        }
        return url;
    }

    static string GitHubRepository(IDictionary<string, object> settings) {
        string repository = Text(settings, "githubRepository");
        if (!Regex.IsMatch(repository, @"\A[A-Za-z0-9-]+/[A-Za-z0-9_.-]+\z")) {
            throw new InvalidDataException("Invalid GitHub repository name.");
        }
        return repository;
    }

    static IList GitHubAssets(string repository, string token) {
        var url = new Uri("https://api.github.com/repos/" + repository + "/releases/latest");
        var release = Parse(Utf8.GetString(Download(url, 1024 * 1024, token, "application/vnd.github+json")));
        object list;
        if (release.TryGetValue("assets", out list) && list is IList) return (IList)list;
        throw new InvalidDataException("The GitHub release has no update files.");
    }

    static Uri GitHubAsset(IList assets, string repository, string fileName) {
        foreach (object item in assets) {
            var asset = item as IDictionary<string, object>;
            object id;
            long number;
            if (asset != null && Text(asset, "name") == fileName && asset.TryGetValue("id", out id) &&
                Int64.TryParse(Convert.ToString(id, System.Globalization.CultureInfo.InvariantCulture), out number) && number > 0) {
                return new Uri("https://api.github.com/repos/" + repository + "/releases/assets/" + number);
            }
        }
        throw new InvalidDataException("The GitHub release is missing " + fileName + ".");
    }

    static string ReadToken() {
        if (Console.IsInputRedirected) throw new InvalidOperationException("Run setup in a Windows console to enter your GitHub token.");
        var value = new StringBuilder();
        for (;;) {
            ConsoleKeyInfo key = Console.ReadKey(true);
            if (key.Key == ConsoleKey.Enter) break;
            if (key.Key == ConsoleKey.Backspace && value.Length > 0) value.Length--;
            if (!Char.IsControl(key.KeyChar)) value.Append(key.KeyChar);
        }
        Console.WriteLine();
        string token = value.ToString().Trim();
        if (!Regex.IsMatch(token, @"\A[A-Za-z0-9_]{20,255}\z")) throw new InvalidDataException("Enter a valid GitHub access token.");
        return token;
    }

    static byte[] Download(Uri url, int limit, string token, string accept) {
        for (int redirects = 0; redirects <= 5; redirects++) {
            var request = (HttpWebRequest)WebRequest.Create(url);
            request.AllowAutoRedirect = false;
            request.Timeout = 10000;
            request.ReadWriteTimeout = 10000;
            request.UserAgent = "SignalStartWatcher-Updater";
            request.Accept = accept;
            if (token != null && redirects == 0 && url.Host == "api.github.com") {
                request.Headers[HttpRequestHeader.Authorization] = "Bearer " + token;
                request.Headers["X-GitHub-Api-Version"] = "2022-11-28";
            }
            using (var response = (HttpWebResponse)request.GetResponse()) {
                int code = (int)response.StatusCode;
                if (code >= 300 && code < 400 && response.Headers["Location"] != null) {
                    url = HttpsUrl(new Uri(url, response.Headers["Location"]).AbsoluteUri);
                    continue;
                }
                if (code != 200 || response.ContentLength > limit) throw new InvalidDataException("The update server returned an invalid response.");
                using (Stream stream = response.GetResponseStream())
                using (var buffer = new MemoryStream()) {
                    CopyWithinLimit(stream, buffer, limit);
                    return buffer.ToArray();
                }
            }
        }
        throw new InvalidDataException("The update server returned too many redirects.");
    }

    static void CopyWithinLimit(Stream input, Stream output, long limit) {
        byte[] chunk = new byte[8192];
        long total = 0;
        for (int length; (length = input.Read(chunk, 0, chunk.Length)) != 0;) {
            total += length;
            if (total > limit) throw new InvalidDataException("The update file exceeds its size limit.");
            output.Write(chunk, 0, length);
        }
    }

    static string ExtensionFolder(string root) {
        return Path.Combine(root, "extension");
    }

    static string ExtensionId(string extension) {
        string normalized = Char.ToUpperInvariant(extension[0]) + extension.Substring(1);
        using (var sha = SHA256.Create()) {
            byte[] hash = sha.ComputeHash(Encoding.Unicode.GetBytes(normalized));
            var id = new StringBuilder(32);
            for (int index = 0; index < 16; index++) {
                id.Append((char)('a' + (hash[index] >> 4)));
                id.Append((char)('a' + (hash[index] & 15)));
            }
            return id.ToString();
        }
    }

    static FileStream Lock(string root) {
        return new FileStream(Path.Combine(root, "updater.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
    }

    static IDictionary<string, object> Parse(string input) {
        var value = Json.DeserializeObject(input) as IDictionary<string, object>;
        if (value == null) throw new InvalidDataException("Invalid update metadata.");
        return value;
    }

    static string Text(IDictionary<string, object> fields, string key) {
        object field;
        if (fields.TryGetValue(key, out field) && field is string) return (string)field;
        throw new InvalidDataException("Missing update metadata field " + key + ".");
    }

    static byte[] ReadExact(Stream input, int length) {
        byte[] bytes = new byte[length];
        int offset = 0;
        while (offset < length) {
            int read = input.Read(bytes, offset, length - offset);
            if (read == 0) throw new EndOfStreamException("The updater message was incomplete.");
            offset += read;
        }
        return bytes;
    }

    static void Reply(Stream output, object result) {
        byte[] contents = Utf8.GetBytes(Json.Serialize(result));
        byte[] length = BitConverter.GetBytes(contents.Length);
        output.Write(length, 0, length.Length);
        output.Write(contents, 0, contents.Length);
        output.Flush();
    }
}
