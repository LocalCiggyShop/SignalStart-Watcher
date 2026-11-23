SignalStart Watcher automatic updates for Windows Chrome

Publisher setup

1. Store one RSA signing key securely and use it for later releases. The
   setup ZIP contains its public key. Keep the private key out of Git.

   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out signalstart-release.pem

2. From the Signalstart folder, build the release with Python and OpenSSL:

   python3 updater/build-release.py --github-repo LocalCiggyShop/SignalStart-Watcher --signing-key "/path/to/signalstart-release.pem" --output release-1.4.0

3. Attach signalstart-update.json, signalstart-extension.zip and the
   versioned Windows Setup ZIP to the same GitHub release. Keep the first
   two asset names for future releases. Share the Windows Setup ZIP with
   first-time users who have access to the repository.

4. For future releases, increase the version in manifest.json, build into
   a new folder with the same repository and signing key, and publish.
   Users receive the update the next time Chrome or the extension opens.

For a public HTTPS file host, you can use --feed with the full URL ending
in /signalstart-update.json instead of --github-repo. Host both update
files in the same directory.

To rebuild SignalStartUpdater.exe after editing the C# source, run from
the Signalstart folder in Windows PowerShell:

   & "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:exe /out:updater\SignalStartUpdater.exe /reference:System.IO.Compression.dll /reference:System.Web.Extensions.dll /reference:System.Security.dll updater\SignalStartUpdater.cs

See INSTALL.txt for the one-time user setup. GitHub access is stored for
the current Windows user using Windows Data Protection. GitHub users
who can create a fine-grained token for this repository can select
Contents read-only access. On GitHub, see Settings, Developer settings,
Personal access tokens.
