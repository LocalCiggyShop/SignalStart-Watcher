import argparse
import base64
import json
import re
import subprocess
from pathlib import Path
from urllib.parse import urlsplit
from zipfile import ZIP_DEFLATED, ZipFile


UPDATER = Path(__file__).resolve().parent
FEED_NAME = "signalstart-update.json"
PACKAGE_NAME = "signalstart-extension.zip"
SETTINGS_NAME = "signalstart-update-settings.json"
INSTALLER_NAME = "SignalStartUpdater.exe"
RUNTIME_FILES = (
    "manifest.json",
    "background.js", "shared.js", "trade-reader.js",
    "content.js", "content.css",
    "popup.html", "popup.js", "popup.css",
    "offscreen.html", "offscreen.js",
)


def openssl(*args):
    return subprocess.check_output(["openssl", *map(str, args)])


def encode(value):
    return base64.b64encode(value).decode("ascii")


def rsa_public_fields(key):
    details = openssl("pkey", "-in", key, "-text_pub", "-noout").decode()
    modulus = openssl("rsa", "-in", key, "-modulus", "-noout").decode().strip()
    exponent = int(re.search(r"Exponent:\s+(\d+)", details, re.IGNORECASE)[1])
    modulus_bytes = bytes.fromhex(modulus.split("=", 1)[1])
    return {
        "modulus": encode(modulus_bytes),
        "exponent": encode(exponent.to_bytes((exponent.bit_length() + 7) // 8, "big")),
    }


def build(args):
    if args.github_repo:
        if not re.fullmatch(r"[A-Za-z0-9-]+/[A-Za-z0-9_.-]+", args.github_repo):
            raise ValueError("Use OWNER/REPOSITORY for a GitHub release.")
        source_settings = {"githubRepository": args.github_repo}
    else:
        feed = urlsplit(args.feed)
        if feed.scheme != "https" or not feed.hostname or feed.username is not None:
            raise ValueError("The release feed needs an HTTPS URL.")
        if not feed.path.endswith("/" + FEED_NAME) or feed.query or feed.fragment:
            raise ValueError(f"The release feed URL must end in /{FEED_NAME}.")
        source_settings = {"feedUrl": args.feed}

    manifest = json.loads((args.source / "manifest.json").read_bytes())
    version = manifest["version"]
    files = (*RUNTIME_FILES, *manifest["icons"].values())
    settings = {**source_settings, **rsa_public_fields(args.signing_key)}
    args.output.mkdir(parents=True, exist_ok=False)
    package = args.output / PACKAGE_NAME
    with ZipFile(package, "x", ZIP_DEFLATED) as archive:
        for name in files:
            archive.write(args.source / name, name)

    metadata = {
        "version": version,
        "signature": encode(openssl("dgst", "-sha256", "-sign", args.signing_key, package)),
    }
    release_feed = args.output / FEED_NAME
    release_feed.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    setup = args.output / f"Signalstart_v{version}_Windows_Setup.zip"
    with ZipFile(setup, "x", ZIP_DEFLATED) as archive:
        archive.write(UPDATER / INSTALLER_NAME, INSTALLER_NAME)
        archive.write(package, PACKAGE_NAME)
        archive.write(release_feed, FEED_NAME)
        archive.writestr(SETTINGS_NAME, json.dumps(settings, indent=2) + "\n")
        archive.write(UPDATER / "INSTALL.txt", "INSTALL.txt")
    return setup


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Build signed release files and a one-time Windows setup ZIP.")
    release_source = parser.add_mutually_exclusive_group(required=True)
    release_source.add_argument("--feed", help="HTTPS URL of the latest release metadata")
    release_source.add_argument("--github-repo", help="Private GitHub release source as OWNER/REPOSITORY")
    parser.add_argument("--signing-key", required=True, type=Path, help="Publisher's private RSA PEM file")
    parser.add_argument("--output", required=True, type=Path, help="A new output directory")
    parser.add_argument("--source", type=Path, default=UPDATER.parent, help="Extension source directory")
    print(build(parser.parse_args()))
