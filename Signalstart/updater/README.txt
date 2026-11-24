SignalStart Watcher browser updates

SignalStart Watcher uses the Chrome File System Access API to update the
unpacked folder the user selects. The update code is in browser-updater.js.
The worker downloads a signed asset from the repository's public Releases.

To publish an update:

1. Increase the version in manifest.json and update INSTALL.txt as needed.
2. Use the existing private RSA signing key. Keep it outside the repository.
   Its matching public key is in update-config.js.
3. From the Signalstart folder, build with Python and OpenSSL:

   python3 updater/build-release.py --signing-key "/path/to/signalstart-release.pem" --output release-1.5.1

4. Create a published GitHub release in LocalCiggyShop/SignalStart-Watcher
   with the corresponding version tag, for example v1.5.1. Attach
   Signalstart.zip for the repository's download button and
   signalstart-browser-update.json for automatic updates. Keep these two
   asset filenames unchanged.

The required first-time browser permissions are described in INSTALL.txt.
