import argparse
import base64
import json
import subprocess
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


UPDATER = Path(__file__).resolve().parent
RUNTIME_FILES = (
    "manifest.json",
    "background.js", "shared.js", "trade-reader.js",
    "browser-updater.js", "update-config.js", "updates.html", "updates.js",
    "content.js", "content.css",
    "popup.html", "popup.js", "popup.css",
    "offscreen.html", "offscreen.js",
)


def encode(data):
    return base64.b64encode(data).decode("ascii")


def openssl(*arguments, payload=None):
    return subprocess.check_output(["openssl", *map(str, arguments)], input=payload)


def build(args):
    manifest = json.loads((args.source / "manifest.json").read_bytes())
    version = manifest["version"]
    paths = (*RUNTIME_FILES, *manifest["icons"].values())
    files = {name: (args.source / name).read_bytes() for name in paths}

    public_key = encode(openssl("pkey", "-in", args.signing_key, "-pubout", "-outform", "DER"))
    expected_key = f'export const RELEASE_PUBLIC_KEY = "{public_key}";'
    if expected_key not in files["update-config.js"].decode().splitlines():
        raise ValueError("The signing key does not match the extension's public key.")

    payload = json.dumps({
        "manifest": manifest,
        "files": {name: encode(data) for name, data in files.items() if name != "manifest.json"},
    }, separators=(",", ":")).encode()
    envelope = {
        "payload": encode(payload),
        "signature": encode(openssl("dgst", "-sha256", "-sign", args.signing_key, payload=payload)),
    }

    args.output.mkdir(parents=True, exist_ok=False)
    (args.output / "signalstart-browser-update.json").write_text(
        json.dumps(envelope, separators=(",", ":")) + "\n", encoding="utf-8"
    )
    folder = f"Signalstart_v{version}"
    package = args.output / "Signalstart.zip"
    with ZipFile(package, "x", ZIP_DEFLATED) as archive:
        archive.write(UPDATER / "INSTALL.txt", "INSTALL.txt")
        for name, data in files.items():
            archive.writestr(f"{folder}/{name}", data)
    return package


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Build the unpacked Chrome ZIP and its signed browser update.")
    parser.add_argument("--signing-key", required=True, type=Path, help="Publisher's private RSA PEM file")
    parser.add_argument("--output", required=True, type=Path, help="A new output directory")
    parser.add_argument("--source", type=Path, default=UPDATER.parent, help="Extension source directory")
    print(build(parser.parse_args()))
