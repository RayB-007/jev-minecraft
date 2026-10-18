"""Install and launch an isolated vanilla client for this loopback development server."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import uuid

import minecraft_launcher_lib.command
import minecraft_launcher_lib.install
import minecraft_launcher_lib.fabric

ROOT = Path(__file__).resolve().parent.parent
CLIENT = ROOT / "data" / "viewer"
PID_FILE = ROOT / "data" / "viewer-process.json"
VERSION = "1.21.1"
LOADER = "0.16.14"
VIEWER_VERSION = f"fabric-loader-{LOADER}-{VERSION}"
USERNAME = "JevViewer"
JAVA = Path.home() / "Library/Application Support/minecraft/runtime/java-runtime-delta/mac-os-arm64/java-runtime-delta/jre.bundle/Contents/Home/bin/java"


def configure_spectator_controls():
    """This isolated client is a camera, with no movement or gameplay input bindings."""
    path = CLIENT / "options.txt"
    lines = path.read_text().splitlines() if path.exists() else []
    disabled = ("forward", "back", "left", "right", "jump", "sneak", "sprint",
                "attack", "use", "pickItem", "drop", "inventory", "swapOffhand", "togglePerspective",
                "chat", "command", "advancements", "socialInteractions", "spectatorOutlines",
                *(f"hotbar.{i}" for i in range(1, 10)))
    settings = {f"key_key.{name}": "key.keyboard.unknown" for name in disabled}
    settings.update({"pauseOnLostFocus": "false"})
    for i, line in enumerate(lines):
        key = line.split(":", 1)[0]
        if key in settings:
            lines[i] = f"{key}:{settings.pop(key)}"
    lines.extend(f"{key}:{value}" for key, value in settings.items())
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n")


def offline_uuid(name):
    raw = hashlib.md5(f"OfflinePlayer:{name}".encode()).digest()
    return str(uuid.UUID(bytes=raw, version=3))


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except (ProcessLookupError, PermissionError):
        return False


def install():
    CLIENT.mkdir(parents=True, exist_ok=True)
    # Hard-link versioned/content-addressed assets and libraries, but privately copy
    # the runtime because its named component can be updated in place by installers.
    # No launcher accounts, game profiles, mods or credentials are read.
    shared = Path.home() / "Library/Application Support/minecraft"
    for name in ("assets", "libraries", "runtime"):
        source, target = shared / name, CLIENT / name
        if source.exists() and not target.exists():
            print(f"Reusing cached Minecraft {name}...", flush=True)
            shutil.copytree(source, target, copy_function=shutil.copy2 if name == 'runtime' else os.link, symlinks=True)
    last_status = None

    def status(message):
        nonlocal last_status
        # Individual asset names can number in thousands. Print phase changes only.
        phase = 'download' if message.startswith('Download ') else message
        if phase != last_status:
            print(message, flush=True)
            last_status = phase

    minecraft_launcher_lib.install.install_minecraft_version(VERSION, CLIENT, {"setStatus": status})
    options_file = CLIENT / "options.txt"
    if not options_file.exists():
        options_file.write_text("\n".join([
            "version:3955", "renderDistance:6", "simulationDistance:4", "maxFps:60",
            "guiScale:2", "fullscreen:false", "pauseOnLostFocus:false", "skipMultiplayerWarning:true",
            "onboardAccessibility:false", "tutorialStep:none", "soundCategory_master:0.2",
        ]) + "\n")


def launch():
    if PID_FILE.exists():
        try:
            old = json.loads(PID_FILE.read_text())
            if alive(int(old["pid"])):
                print(json.dumps({"viewer": "already-running", "pid": old["pid"]}), flush=True)
                return
        except (ValueError, KeyError, OSError):
            pass
    configure_spectator_controls()
    java = os.environ.get("JEV_VIEWER_JAVA", str(JAVA if JAVA.exists() else "/usr/bin/java"))
    mod = ROOT / "viewer-hud/build/libs/jev-viewer-hud-0.2.0.jar"
    if not mod.exists():
        raise RuntimeError("Build viewer-hud first; see README.md for the pinned Gradle command.")
    if not (CLIENT / "versions" / VIEWER_VERSION / f"{VIEWER_VERSION}.json").exists():
        minecraft_launcher_lib.fabric.install_fabric(VERSION, CLIENT, loader_version=LOADER, java=java)
    (CLIENT / "mods").mkdir(exist_ok=True)
    shutil.copy2(mod, CLIENT / "mods/jev-viewer-hud.jar")
    command = minecraft_launcher_lib.command.get_minecraft_command(VIEWER_VERSION, CLIENT, {
        "username": USERNAME, "uuid": offline_uuid(USERNAME), "token": "0",
        "executablePath": java, "launcherName": "Jev Local Viewer", "launcherVersion": "0.1.0",
        "jvmArguments": ["-Xms256M", "-Xmx2G", "-Djava.awt.application.name=Jev Minecraft Viewer",
                         f"-Djev.hud.path={ROOT / 'data/hud.json'}"],
        "quickPlayMultiplayer": "127.0.0.1:25565", "quickPlayPath": "quickPlay/viewer.json",
        "customResolution": True, "resolutionWidth": "1100", "resolutionHeight": "720",
    })
    if sys.platform == "darwin" and "-XstartOnFirstThread" not in command:
        command.insert(1, "-XstartOnFirstThread")
    log_path = ROOT / "data" / "viewer-console.log"
    with log_path.open("ab", buffering=0) as log:
        process = subprocess.Popen(command, cwd=CLIENT, stdin=subprocess.DEVNULL,
                                   stdout=log, stderr=log, start_new_session=True)
    PID_FILE.write_text(json.dumps({"pid": process.pid, "username": USERNAME, "version": VIEWER_VERSION}) + "\n")
    print(json.dumps({"viewer": "opening", "pid": process.pid, "address": "127.0.0.1:25565"}), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["install", "launch"], nargs="?", default="launch")
    args = parser.parse_args()
    if args.command == "install":
        install()
    else:
        if not (CLIENT / "versions" / VERSION / f"{VERSION}.jar").exists():
            install()
        launch()


if __name__ == "__main__":
    main()
