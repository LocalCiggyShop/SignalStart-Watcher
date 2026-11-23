using System;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

namespace SignalStartSetup {
    public static class Installer {
        static readonly UTF8Encoding Utf8 = new UTF8Encoding(false);
        public static bool ValidId(string id) { return Regex.IsMatch(id ?? "", "^[a-p]{32}$"); }
        static byte[] Resource(string name) {
            using (Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(name)) {
                if (stream == null) throw new InvalidOperationException("Missing installer component: " + name);
                using (var buffer = new MemoryStream()) { stream.CopyTo(buffer); return buffer.ToArray(); }
            }
        }
        public static string Install(string id, string root, Action<string, string> register) {
            if (!ValidId(id)) throw new ArgumentException("Paste the 32-letter Extension ID shown in the browser extension popup.");
            byte[] host = Resource("SignalStartNativeHost"), ea = Resource("SignalStartBridgeEA");
            string hash;
            using (var sha = SHA256.Create()) {
                byte[] both = new byte[host.Length + ea.Length];
                Buffer.BlockCopy(host, 0, both, 0, host.Length); Buffer.BlockCopy(ea, 0, both, host.Length, ea.Length);
                hash = BitConverter.ToString(sha.ComputeHash(both)).Replace("-", "").Substring(0, 16);
            }
            string version = Path.Combine(root, hash);
            Directory.CreateDirectory(version);
            string hostPath = Path.Combine(version, "SignalStartNativeHost.exe");
            string eaPath = Path.Combine(version, "SignalStartBridge.ex5");
            if (!File.Exists(hostPath)) File.WriteAllBytes(hostPath, host);
            if (!File.Exists(eaPath)) File.WriteAllBytes(eaPath, ea);
            string manifest = Path.Combine(root, "com.signalstart.mt5_bridge.json");
            var config = new { name = "com.signalstart.mt5_bridge", description = "SignalStart to MT5 local file bridge",
                path = hostPath, type = "stdio", allowed_origins = new [] { "chrome-extension://" + id + "/" } };
            File.WriteAllText(manifest, new JavaScriptSerializer().Serialize(config), Utf8);
            foreach (string browser in new [] { @"Software\Google\Chrome", @"Software\BraveSoftware\Brave-Browser", @"Software\Microsoft\Edge" })
                register(browser + @"\NativeMessagingHosts\com.signalstart.mt5_bridge", manifest);
            return version;
        }
        static int SelfTest(string report) {
            string root = Path.Combine(Path.GetTempPath(), "signalstart-setup-test-" + Guid.NewGuid().ToString("N"));
            try {
                int writes = 0;
                if (ValidId("bad-id")) throw new Exception("Invalid ID accepted.");
                string version = Install(new string('a', 32), root, (key, manifest) => {
                    if (!key.EndsWith(@"\com.signalstart.mt5_bridge") || !File.Exists(manifest)) throw new Exception("Invalid registration.");
                    writes++;
                });
                if (writes != 3 || !File.Exists(Path.Combine(version, "SignalStartBridge.ex5"))) throw new Exception("Incomplete installation.");
                string again = Install(new string('a', 32), root, (key, manifest) => {});
                if (again != version) throw new Exception("Reinstall should reuse identical components.");
                var manifestData = new JavaScriptSerializer().DeserializeObject(File.ReadAllText(Path.Combine(root, "com.signalstart.mt5_bridge.json"))) as System.Collections.Generic.Dictionary<string, object>;
                if (manifestData == null || !Convert.ToString(manifestData["path"]).StartsWith(root + Path.DirectorySeparatorChar)) throw new Exception("Incorrect host path.");
                File.WriteAllText(report, "Installer self-test passed: embedded components, ID validation, three simulated registrations, reinstall and manifest path. No real registry keys changed.", Utf8);
                return 0;
            } catch (Exception error) { File.WriteAllText(report, error.ToString(), Utf8); return 1; }
            finally {
                string full = Path.GetFullPath(root), expected = Path.GetFullPath(Path.GetTempPath()) + "signalstart-setup-test-";
                if (full.StartsWith(expected, StringComparison.OrdinalIgnoreCase) && Directory.Exists(full)) Directory.Delete(full, true);
            }
        }
        [STAThread]
        public static int Main(string[] args) {
            Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
            foreach (string arg in args) if (arg.StartsWith("--self-test=")) return SelfTest(Path.GetFullPath(arg.Substring(12)));
            using (var form = new SetupForm()) {
                foreach (string arg in args) if (arg.StartsWith("--preview=")) {
                    // Render the layout without displaying a window or registering anything.
                    using (var bitmap = new Bitmap(form.ClientSize.Width, form.ClientSize.Height))
                    using (Graphics graphics = Graphics.FromImage(bitmap)) {
                        graphics.Clear(form.BackColor);
                        foreach (Control control in form.Controls) {
                            Rectangle bounds = control.Bounds;
                            if (control is Button) {
                                ControlPaint.DrawButton(graphics, bounds, control.Enabled ? ButtonState.Normal : ButtonState.Inactive);
                                TextRenderer.DrawText(graphics, control.Text, control.Font, bounds, control.ForeColor, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
                            } else if (control is TextBox) { graphics.FillRectangle(Brushes.White, bounds); ControlPaint.DrawBorder(graphics, bounds, SystemColors.ControlDark, ButtonBorderStyle.Solid); }
                            else TextRenderer.DrawText(graphics, control.Text, control.Font, bounds, control.ForeColor, TextFormatFlags.WordBreak | TextFormatFlags.TextBoxControl);
                        }
                        bitmap.Save(Path.GetFullPath(arg.Substring(10)));
                    }
                    return 0;
                }
                Application.Run(form);
            }
            return 0;
        }
    }
    public sealed class SetupForm : Form {
        readonly TextBox extension = new TextBox();
        readonly Label status = new Label();
        readonly Button install = new Button(), open = new Button();
        string installed = "";
        public SetupForm() {
            Text = "SignalStart → MT5 setup"; ClientSize = new Size(570, 355);
            FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false; MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen; Font = new Font("Segoe UI", 10);
            var title = new Label { Text = "Connect your browser to MT5", Font = new Font("Segoe UI", 16, FontStyle.Bold), AutoSize = true, Location = new Point(20, 18) };
            var intro = new Label { Text = "One-time setup for this Windows user.\nNo PowerShell command, administrator account or open network port is needed.", Location = new Point(20, 63), Size = new Size(530, 50) };
            var label = new Label { Text = "Paste Extension ID from the browser extension's MT5 connection section:", Location = new Point(20, 121), Size = new Size(530, 25) };
            extension.Location = new Point(20, 150); extension.Size = new Size(530, 30); extension.MaxLength = 32;
            install.Text = "Install / update helper"; install.Location = new Point(20, 197); install.Size = new Size(210, 36);
            open.Text = "Open EA folder"; open.Location = new Point(245, 197); open.Size = new Size(165, 36); open.Enabled = false;
            status.Location = new Point(20, 250); status.Size = new Size(530, 86);
            status.Text = "After installation, copy the supplied EA into MT5's MQL5\\Experts folder.\nReload the browser extension and the SignalStart tab. Trading stays disabled until you enable it in MT5.";
            Controls.AddRange(new Control[] { title, intro, label, extension, install, open, status });
            install.Click += (sender, eventArgs) => {
                install.Enabled = false;
                try {
                    installed = Installer.Install(extension.Text.Trim(), Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SignalStartBridge"),
                        (key, manifest) => { using (RegistryKey value = Registry.CurrentUser.CreateSubKey(key)) { value.SetValue("", manifest, RegistryValueKind.String); } });
                    status.ForeColor = Color.DarkGreen;
                    status.Text = "Helper installed. Reload your browser extension and SignalStart tab.\nClick Open EA folder and copy SignalStartBridge.ex5 to MT5's MQL5\\Experts folder, replacing the old EA. Reattach the EA to your chart.";
                    open.Enabled = true;
                } catch (Exception error) { status.ForeColor = Color.Firebrick; status.Text = error.Message; }
                finally { install.Enabled = true; }
            };
            open.Click += (sender, eventArgs) => { if (Directory.Exists(installed)) System.Diagnostics.Process.Start("explorer.exe", "\"" + installed + "\""); };
        }
    }
}
