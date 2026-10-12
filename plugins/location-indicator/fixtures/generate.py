#!/usr/bin/env python3
"""Generate native references, or check their Metal pixels and rendered queries.

Run after ffi:build and location-puck build:
  python3 plugins/location-indicator/fixtures/generate.py <FFI build directory>
  python3 plugins/location-indicator/fixtures/generate.py <FFI build directory> --render

The references use actual TransformState matrices and native CheapRuler helpers.
Generation/rendering targets macOS Metal; consuming the JSON in JS/Zig tests
needs neither a native build nor a graphics device.
"""
import argparse
import json
import shlex
import subprocess
import tempfile
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("build", type=Path, help="Configured macOS Metal FFI build")
parser.add_argument("--render", action="store_true", help="Check real pixels and rendered queries")
args = parser.parse_args()
here = Path(__file__).resolve().parent
build = args.build.resolve()
compile_unit = next(
    entry
    for entry in json.loads((build / "compile_commands.json").read_text())
    if entry["file"].endswith("transform_state.cpp")
)
flags = shlex.split(compile_unit["command"])
flags = flags[:flags.index("-o")]
library = here.parent / "native/zig-out/lib/libmaplibre-location-puck.dylib"
with tempfile.TemporaryDirectory() as temp:
    executable = Path(temp) / "generate"
    source = here / ("render.cpp" if args.render else "generate.cpp")
    command = flags + [str(source)]
    if args.render:
        command += [
            "-I" + str(build / "install/include"),
            str(build / "install/lib/libmaplibre-native-c.dylib"),
            "-Wl,-rpath," + str(build / "install/lib"),
        ]
    else:
        command += [
            str(build / "libmaplibre-native-c.a"),
            str(build / "maplibre-native/libmbgl-core.a"),
        ]
    for framework in (
        "Foundation", "Metal", "QuartzCore", "CoreGraphics", "CoreText",
        "SystemConfiguration", "Security",
    ):
        command += ["-framework", framework]
    command += ["-lcurl", "-lz", "-o", str(executable)]
    subprocess.run(command, check=True)
    if args.render:
        subprocess.run(
            [str(executable), str(library), str(here / "geographic.json")], check=True,
        )
    else:
        result = subprocess.check_output([str(executable), str(library)])
        (here / "geographic.json").write_bytes(result)
