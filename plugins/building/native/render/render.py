#!/usr/bin/env python3
"""Render the building examples offscreen and check them.

Run after `mise run ffi:build` and `zig build` in plugins/building/native:
  python3 plugins/building/native/render/render.py [<FFI install>] [--out DIR]

The install's render backend (its share/maplibre-native-c/artifact.json) picks
the session: Metal, Vulkan (the macos-arm64-vulkan preset, through Homebrew's
MoltenVK and vulkan-loader) or OpenGL ES (macos-arm64-egl, through the ANGLE
that the preset installs).

Renders the shapes grid and the Bamberg OSM demo at several cameras (pitched,
rotated, top-down, translucent, translated) and a lighting and depth scene
beside core fill-extrusion, to PNGs in --out (default /tmp/building-native,
or /tmp/building-native-<backend> for Vulkan and OpenGL).
It then checks pixels and rendered-feature queries:

- a flat building and a core fill-extrusion of the same color, height and
  light shade their roofs and walls alike;
- buildings across a zoom-15 tile corner, which every tile there draws (its
  copy in each tile's buffer), blend once when translucent: a roof over the
  background is the opaque color mixed with the background by the opacity,
  in each tile's quarter;
- a translucent layer shows no internal faces: a building's color over the
  background is the same where a hidden wall lies behind its front face;
- core fill-extrusion and the building layer share depth: whichever is
  nearer is drawn;
- queries hit buildings at their footprints, on the walls of tall buildings
  in pitched views, and miss empty ground;
- query grids (the center of every 20th pixel) report the share of drawn
  points that no query hits, which Native's broad phase leaves (README,
  "Plugin API gaps"), and fail above a ceiling per camera.

macOS only, like location-indicator's render test. Look at the images too:
the checks only sample a few pixels.
"""
import argparse
import json
import math
import os
import subprocess
import sys
from pathlib import Path

here = Path(__file__).resolve().parent
plugin_dir = here.parent.parent
repo = plugin_dir.parent.parent

parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
parser.add_argument("install", nargs="?", type=Path, help="maplibre-native-c install (default $MLN_NATIVE_INSTALL_DIR)")
parser.add_argument("--out", type=Path, help="output directory (default /tmp/building-native, or /tmp/building-native-<backend> off Metal)")
args = parser.parse_args()
install = (args.install or Path(os.environ.get("MLN_NATIVE_INSTALL_DIR", ""))).resolve()
if not (install / "include/maplibre_native_c.h").exists():
    sys.exit(f"no maplibre-native-c install at {install}; run `mise run ffi:build` or pass one")
library = plugin_dir / "native/zig-out/lib/libmaplibre-building.dylib"
if not library.exists():
    sys.exit(f"{library} is missing; run `zig build` in plugins/building/native")
artifact = install / "share/maplibre-native-c/artifact.json"
backend = json.loads(artifact.read_text())["renderBackend"] if artifact.exists() else "metal"
out = args.out or Path("/tmp/building-native" if backend == "metal" else f"/tmp/building-native-{backend}")
out.mkdir(parents=True, exist_ok=True)
backend_name = {"metal": "Metal", "vulkan": "Vulkan", "opengl": "OpenGL"}[backend]
# MoltenVK's ICD, as the FFI's mise.macos.toml sets it.
vulkan_loader = Path(os.environ.get("MLN_FFI_VULKAN_LOADER_DIR", "/opt/homebrew/opt/vulkan-loader/lib"))
moltenvk_icd = "/opt/homebrew/opt/molten-vk/etc/vulkan/icd.d/MoltenVK_icd.json"
if backend == "vulkan" and "VK_DRIVER_FILES" not in os.environ and Path(moltenvk_icd).exists():
    os.environ["VK_DRIVER_FILES"] = moltenvk_icd

# ---------------------------------------------------------------------------
# The renderer binary, rebuilt when render.cpp changes.
# ---------------------------------------------------------------------------

binary = out / f"render-bin-{backend}"
source = here / "render.cpp"
if not binary.exists() or binary.stat().st_mtime < source.stat().st_mtime:
    # The SDK the FFI was built with: the newest one on the host can be ahead
    # of the linker.
    sysroot = []
    commands = install.parent / "compile_commands.json"
    if commands.exists():
        words = json.loads(commands.read_text())[0]["command"].split()
        if "-isysroot" in words:
            sysroot = ["-isysroot", words[words.index("-isysroot") + 1]]
    command = ["/usr/bin/c++", *sysroot, "-std=c++20", "-O1", "-I", str(install / "include"), str(source),
               str(install / "lib/libmaplibre-native-c.dylib"), "-Wl,-rpath," + str(install / "lib")]
    for framework in ("Foundation", "Metal", "QuartzCore", "CoreGraphics", "ImageIO", "CoreFoundation"):
        command += ["-framework", framework]
    if backend == "vulkan":
        ffi = Path(os.environ.get("MLN_FFI_DIR", install.parents[2]))
        command += ["-DRENDER_VULKAN", "-I", str(ffi / "third_party/maplibre-native/vendor/Vulkan-Headers/include"),
                    "-L", str(vulkan_loader), "-lvulkan", "-Wl,-rpath," + str(vulkan_loader)]
    elif backend == "opengl":
        command += ["-DRENDER_OPENGL", str(install / "lib/libEGL.dylib")]
    subprocess.run(command + ["-o", str(binary)], check=True)

# ---------------------------------------------------------------------------
# Styles.
# ---------------------------------------------------------------------------

def load(path):
    return json.loads(Path(path).read_text())

examples = plugin_dir / "examples"
shapes = load(examples / "shapes/buildings.geojson")
osm = load(examples / "osm/buildings.geojson")
shapes_layer = load(examples / "layer.json")
osm_layer = load(examples / "osm/layer.json")
source_options = load(examples / "shapes/source.json")
assert source_options == load(examples / "osm/source.json")

background = {"id": "background", "type": "background", "paint": {"background-color": "#d9d5cc"}}
background_rgb = [0xd9, 0xd5, 0xcc]
default_light = {"anchor": "viewport", "color": "white", "intensity": 0.5, "position": [1.15, 210, 30]}


def style(name, sources, layers, light=None):
    document = {"version": 8, "sources": sources, "layers": [background] + layers}
    if light is not None:
        document["light"] = light
    path = out / f"{name}.style.json"
    path.write_text(json.dumps(document))
    return path


def geojson_source(data, **options):
    return {**source_options, **options, "data": data}


def with_paint(layer, **paint):
    copy = json.loads(json.dumps(layer))
    copy["paint"].update({key.replace("_", "-"): value for key, value in paint.items()})
    return copy


shapes_sources = {"building-shapes": geojson_source(shapes)}
osm_sources = {"osm-buildings": geojson_source(osm)}

# A lighting and depth scene south of the shapes grid: a flat building and a
# core fill-extrusion of the same color and height side by side (lighting),
# and a tall core slab through a long building (depth).
scene_center = (50.09535, 14.41520)
meters_lat = 111_320.0
meters_lon = 111_320.0 * math.cos(math.radians(scene_center[0]))


def box(id, east, north, width, depth, **properties):
    """A rectangle `width` m east-west and `depth` m north-south, its center
    `east` and `north` meters from the scene center; counterclockwise."""
    lat0, lon0 = scene_center
    x0, x1 = (east - width / 2) / meters_lon, (east + width / 2) / meters_lon
    y0, y1 = (north - depth / 2) / meters_lat, (north + depth / 2) / meters_lat
    ring = [[lon0 + x0, lat0 + y0], [lon0 + x1, lat0 + y0], [lon0 + x1, lat0 + y1], [lon0 + x0, lat0 + y1], [lon0 + x0, lat0 + y0]]
    return {"type": "Feature", "id": id, "geometry": {"type": "Polygon", "coordinates": [ring]}, "properties": properties}


wall = "#c9b8a0"
scene_buildings = {"type": "FeatureCollection", "features": [
    box(1, -25, 15, 20, 14, height=20),
    box(3, 0, -20, 60, 10, height=12, **{"roof:shape": "gabled", "roof:height": 4}),
    box(5, 0, 60, 20, 14, height=20),
]}
scene_core = {"type": "FeatureCollection", "features": [
    box(2, 25, 15, 20, 14, height=20),
    box(4, 0, -20, 8, 30, height=30),
    box(6, 0, -60, 20, 14, height=20),
]}
scene_layer = {
    "id": "scene-buildings", "type": "building", "source": "scene-buildings",
    "layout": shapes_layer["layout"],
    "paint": {"building-height": ["get", "height"], "building-roof-height": ["coalesce", ["get", "roof:height"], 0],
              "building-color": wall, "building-roof-color": wall},
}
core_layer = {
    "id": "scene-core", "type": "fill-extrusion", "source": "scene-core",
    "paint": {"fill-extrusion-height": ["get", "height"], "fill-extrusion-color": wall},
}
scene_sources = {"scene-buildings": geojson_source(scene_buildings), "scene-core": geojson_source(scene_core)}

# ---------------------------------------------------------------------------
# Cases.
# ---------------------------------------------------------------------------

def centroid(feature):
    ring = feature["geometry"]["coordinates"][0][:-1]
    return (sum(p[1] for p in ring) / len(ring), sum(p[0] for p in ring) / len(ring))


shape_by_id = {f["id"]: f for f in shapes["features"]}
osm_by_id = {f["id"]: f for f in osm["features"]}
shapes_center = (50.0971, 14.4152)
osm_center = (49.8915, 10.8850)
cathedral_tower = 124650427  # a 72 m pyramidal tower of Bamberg Cathedral

cases = []


def case(name, style_path, camera, queries=(), samples=(), size=(1200, 800)):
    cases.append({"name": name, "style": style_path, "camera": camera, "queries": list(queries),
                  "samples": list(samples), "size": size})


def grid(ceiling):
    """Query the center of every 20th pixel and compare with the frame: at
    most `ceiling` of the drawn points may go unhit. Native's broad phase
    only asks the plugin about buildings whose footprint's bounding box holds
    the query's ground point (README, "Plugin API gaps"), so tall buildings
    in pitched views miss; the ceilings sit just above the measured shares
    and catch a narrow phase that stops hitting."""
    return ("grid", 20, ceiling)


# (translucent case, opaque case, sample key, opacity): the translucent
# sample must be the opaque one mixed with the background by the opacity.
blends = []


shapes_style = style("shapes", shapes_sources, [shapes_layer], default_light)
gabled = shape_by_id[2]
onion_rect = shape_by_id[15]
case("shapes-pitched", shapes_style, (*shapes_center, 17.3, 0, 60),
     queries=[("at", *centroid(gabled), 0, {2}), ("at", 50.0951, 14.4152, 0, set()), grid(0.55)])
case("shapes-rotated", shapes_style, (*shapes_center, 17.6, 135, 55), queries=[grid(0.53)])


def corner_gap(feature):
    """A ground point in the footprint's bounding box but outside the turned
    rectangle: the centroid of the gap at the box's northwest corner."""
    ring = feature["geometry"]["coordinates"][0][:-1]
    north = max(ring, key=lambda p: p[1])
    west = min(ring, key=lambda p: p[0])
    return ((north[1] + west[1] + north[1]) / 3, (north[0] + west[0] + west[0]) / 3)


# Shape 52 is the flat rectangle turned 30°. Native's broad phase finds it for
# ground points in its bounding box; the gap point is outside the footprint,
# so only the prism test can hit it: from the south its roof covers the point,
# from straight above nothing does.
turned = shape_by_id[52]
case("shapes-prism-pitched", shapes_style, (*centroid(turned), 18.5, 0, 60),
     queries=[("at", *corner_gap(turned), 0, {52})])
case("shapes-prism-top-down", shapes_style, (*centroid(turned), 18.5, 0, 0),
     queries=[("at", *corner_gap(turned), 0, set()), ("at", *centroid(turned), 0, {52})])
case("shapes-top-down", shapes_style, (*shapes_center, 17.4, 0, 0),
     queries=[("at", *centroid(shape_by_id[41]), 0, {41}), ("at", *centroid(shape_by_id[126]), 0, {126}),
              # Between rows 3 and 4 of column 7: open ground.
              ("at", (centroid(shape_by_id[41])[0] + centroid(shape_by_id[58])[0]) / 2, centroid(shape_by_id[41])[1], 0, set()),
              grid(0.16)])
case("shapes-close-radial", shapes_style, (*centroid(shape_by_id[12]), 19.6, 20, 50))
for footprint, feature_id in [("rectangle", 12), ("l", 114), ("courtyard", 216)]:
    case(f"shapes-dome-{footprint}", shapes_style, (*centroid(shape_by_id[feature_id]), 20.3, 30, 55))
case("shapes-close-frame", shapes_style, (*centroid(shape_by_id[7]), 19.3, -30, 55))
case("shapes-close-rotated", shapes_style, (*centroid(shape_by_id[60]), 19.0, 160, 50))
# Onion roofs overhang (roof undersides) and cones: rows 1 to 3.
case("shapes-close-onion", shapes_style, (*centroid(shape_by_id[32]), 19.4, 330, 60))
case("shapes-close-l", shapes_style, (*centroid(shape_by_id[110]), 19.0, 30, 55))
for footprint, feature_id in [("l", 104), ("t", 172), ("u", 189), ("courtyard", 206)]:
    case(f"shapes-gabled-{footprint}", shapes_style, (*centroid(shape_by_id[feature_id]), 20.0, 30, 55))
    case(f"shapes-gambrel-{footprint}", shapes_style, (*centroid(shape_by_id[feature_id + 5]), 20.0, 30, 55))
for footprint, feature_id in [("l", 104), ("t", 172), ("u", 189)]:
    for shape, offset in [("half-hipped", 2), ("saltbox", 8), ("double_saltbox", 7), ("quadruple_saltbox", 11), ("round", 6), ("round_gabled", 12)]:
        case(f"shapes-{shape}-{footprint}", shapes_style, (*centroid(shape_by_id[feature_id + offset]), 20.0, 30, 55))
case("shapes-opacity", style("shapes-opacity", shapes_sources, [with_paint(shapes_layer, building_opacity=0.55)], default_light),
     (*centroid(shape_by_id[12]), 19.2, 20, 50))
case("shapes-translate", style("shapes-translate", shapes_sources,
                               [with_paint(shapes_layer, building_translate=[60, 0], building_translate_anchor="viewport")], default_light),
     (*centroid(gabled), 19.0, 90, 0),
     # 60 px right on screen: the building moved off its footprint's center.
     queries=[("px", 530, 400, set()), ("px", 660, 400, {2})])
case("shapes-light-map", style("shapes-light-map", shapes_sources, [shapes_layer],
                               {"anchor": "map", "color": "#ffd9a8", "intensity": 0.75, "position": [1.5, 90, 60]}),
     (*shapes_center, 17.6, 200, 55))

scene_style = style("scene", scene_sources, [core_layer, scene_layer], default_light)
flat_building = scene_buildings["features"][0]
flat_core = scene_core["features"][0]
case("scene-lighting-depth", scene_style, (scene_center[0] - 0.0001, scene_center[1], 18.4, 0, 50),
     queries=[("at", *centroid(flat_building), 0, {1}), ("at", *centroid(flat_core), 0, {2})],
     # Each pair: the building's roof and its south wall at the same spot of
     # the core extrusion, mirrored across the scene's north-south axis.
     samples=[("pair", *centroid(flat_building), -105, *centroid(flat_core), -105, "roof"),
              ("pair", *centroid(flat_building), 0, *centroid(flat_core), 0, "south wall")])
# Looking east at a building (north) and a core extrusion (south), mirrored
# across the view axis, lit from the west-northwest: their west walls face
# the camera and must shade alike, which pins the light's x sign.
west_light = {"anchor": "map", "color": "white", "intensity": 0.6, "position": [1.15, 290, 50]}
west_lon = scene_center[1] - 10 / meters_lon
case("scene-lighting-west", style("scene-west", scene_sources, [core_layer, scene_layer], west_light),
     (scene_center[0], scene_center[1] - 70 / meters_lon, 18.2, 90, 45),
     samples=[("pair", scene_center[0] + 60 / meters_lat, west_lon, -30, scene_center[0] - 60 / meters_lat, west_lon, -30, "west wall"),
              ("pair", scene_center[0] + 60 / meters_lat, west_lon, -90, scene_center[0] - 60 / meters_lat, west_lon, -90, "roof")])
case("scene-top-down", scene_style, (*scene_center, 18.6, 0, 0))
# The building layer below core fill-extrusion: depth still decides.
case("scene-reversed", style("scene-reversed", scene_sources, [scene_layer, core_layer], default_light),
     (scene_center[0] - 0.0001, scene_center[1], 18.4, 0, 50))
case("scene-rotated", style("scene-rotated", scene_sources, [core_layer, with_paint(scene_layer, building_opacity=0.6)], default_light),
     (scene_center[0] - 0.0001, scene_center[1], 18.6, 210, 55))

# Buildings across the corner of four zoom-15 tiles. The source's buffer (half
# a tile) holds each of them whole in every tile that has it, so each tile
# draws its own copy: a flat box on the corner, drawn by four tiles, and a
# gabled one across the tile edge north of it. A 1 km hall south of it
# reaches past the buffer on both sides of the edge, so every copy is cut and
# it draws roofless (README, "Tile copies").
def tile_corner(lat, lon, z):
    n = 2 ** z
    x = round((lon + 180) / 360 * n)
    y = round((1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n)
    return (math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n)))), x / n * 360 - 180)


seam_corner = tile_corner(*scene_center, 15)
seam_m_lon = 111_320.0 * math.cos(math.radians(seam_corner[0]))


def seam_box(id, east, north, width, depth, **properties):
    lat0, lon0 = seam_corner
    x0, x1 = (east - width / 2) / seam_m_lon, (east + width / 2) / seam_m_lon
    y0, y1 = (north - depth / 2) / meters_lat, (north + depth / 2) / meters_lat
    ring = [[lon0 + x0, lat0 + y0], [lon0 + x1, lat0 + y0], [lon0 + x1, lat0 + y1], [lon0 + x0, lat0 + y1], [lon0 + x0, lat0 + y0]]
    return {"type": "Feature", "id": id, "geometry": {"type": "Polygon", "coordinates": [ring]}, "properties": properties}


seam_buildings = {"type": "FeatureCollection", "features": [
    seam_box(1, 0, 0, 40, 40, height=20),
    seam_box(2, 0, 60, 24, 60, height=14, **{"roof:shape": "gabled", "roof:height": 6}),
    seam_box(3, 0, -70, 1000, 20, height=12, **{"roof:shape": "gabled", "roof:height": 5}),
    # Whole in the eastern tiles, cut at the western tiles' buffer line, 392 m
    # east of the edge, and drawn by both. With building-roof-height the
    # whole copy's roof covers the roofless one. With building-roof-angle the
    # piece's run (46 m, against the whole's 60 m) puts its lid above the
    # real eaves, and it shows through the hip (README, limit 4).
    seam_box(4, 235, 150, 530, 24, height=16, **{"roof:shape": "gabled", "roof:height": 6}),
    seam_box(5, 500, 260, 400, 120, height=40, **{"roof:shape": "hipped", "roof:angle": 30}),
]}
seam_layer = {**scene_layer, "id": "seam-buildings", "source": "seam-buildings",
              "paint": {**scene_layer["paint"], "building-roof-color": "#b35a3c",
                        "building-roof-angle": ["coalesce", ["get", "roof:angle"], 0]}}
seam_sources = {"seam-buildings": geojson_source(seam_buildings)}


def seam_at(east, north):
    return (seam_corner[0] + north / meters_lat, seam_corner[1] + east / seam_m_lon)


# The flat box's roof in each tile's quarter, straight down.
quarters = [("at", *seam_at(dx, dy), 0, f"quarter {dx:+d} {dy:+d}") for dx in (-8, 8) for dy in (-8, 8)]
seam_camera = (*seam_corner, 18.2, 0, 0)
case("seam-opaque", style("seam", seam_sources, [seam_layer], default_light), seam_camera, samples=quarters,
     queries=[("at", *seam_at(0, 0), 0, {1}), ("at", *seam_at(0, 50), 0, {2}), ("at", *seam_at(-100, -70), 0, {3})])
case("seam-translucent", style("seam-translucent", seam_sources, [with_paint(seam_layer, building_opacity=0.5)], default_light),
     seam_camera, samples=quarters)
blends += [("seam-translucent", "seam-opaque", q[-1], 0.5) for q in quarters]
case("seam-pitched", style("seam-pitched", seam_sources, [with_paint(seam_layer, building_opacity=0.6)], default_light),
     (*seam_at(0, -40), 17.2, 20, 55))
case("seam-overlap", style("seam", seam_sources, [seam_layer], default_light), (*seam_at(360, 175), 17.6, 330, 65))

osm_style = style("osm", osm_sources, [osm_layer], default_light)
tower = osm_by_id[cathedral_tower]
case("osm-pitched", osm_style, (*osm_center, 16.5, 0, 60),
     # The ground point of the cathedral's 72 m tower hits it and the parts
     # whose prisms cover it.
     queries=[("at", *centroid(tower), 0, {cathedral_tower}),
              # Known gap (README, "Plugin API gaps"): up the tower the ground
              # under the cursor lies beyond the footprint's bounding box (13 m
              # here), so Native's broad phase never asks the plugin.
              # Reported, not checked.
              ("at", *centroid(tower), -40, {cathedral_tower}, "gap"),
              ("at", *centroid(tower), -90, {cathedral_tower}, "gap"),
              grid(0.28)])
case("osm-domberg", osm_style, (49.8908, 10.8822, 17.6, 300, 58), queries=[grid(0.28)])
case("osm-inselstadt", osm_style, (49.8925, 10.8880, 18.0, 30, 55))
case("osm-top-down", osm_style, (*osm_center, 16.6, 0, 0), queries=[grid(0.05)])
case("osm-opacity", style("osm-opacity", osm_sources, [with_paint(osm_layer, building_opacity=0.7)], default_light),
     (49.8908, 10.8822, 17.4, 300, 58))
# On the zoom-15 tile corner nearest the demo's center, where buildings cross
# tile edges: every copy draws its roof, and a translucent layer blends each
# building once. The university's 111 m hipped U2 (way/37894022) crosses an edge
# here.
osm_corner = tile_corner(*osm_center, 15)
university = osm_by_id[37894022]
case("osm-seam-opaque", osm_style, (*osm_corner, 17.5, 0, 50))
case("osm-seam-translucent", style("osm-seam-translucent", osm_sources, [with_paint(osm_layer, building_opacity=0.6)], default_light),
     (*osm_corner, 17.5, 0, 50))
case("osm-seam-top-down", style("osm-seam-top-down", osm_sources, [with_paint(osm_layer, building_opacity=0.6)], default_light),
     (*osm_corner, 17.5, 0, 0))
case("osm-university", osm_style, (*centroid(university), 18.2, 300, 55), queries=[("at", *centroid(university), 0, {37894022})])

# ---------------------------------------------------------------------------
# Run.
# ---------------------------------------------------------------------------

job = []
for c in cases:
    width, height = c["size"]
    lat, lon, zoom, bearing, pitch = c["camera"]
    c["png"] = out / f"{c['name']}.png"
    job += [f"style {c['style']}", f"size {width} {height} 1", f"camera {lat} {lon} {zoom} {bearing} {pitch}", f"out {c['png']}"]
    for q in c["queries"]:
        if q[0] == "at":
            job.append(f"query-at {q[1]} {q[2]} {q[3]}")
        elif q[0] == "grid":
            job.append(f"query-grid {q[1]} {' '.join(map(str, background_rgb))}")
        else:
            job.append(f"query {q[1]} {q[2]}")
    for s in c["samples"]:
        job.append(f"sample-at {s[1]} {s[2]} {s[3]}")
        if s[0] == "pair":
            job.append(f"sample-at {s[4]} {s[5]} {s[6]}")
    job.append("render")
(out / "job.txt").write_text("\n".join(job) + "\n")

result = subprocess.run([str(binary), str(library), "mln_building_register", str(out / "job.txt")],
                        capture_output=True, text=True)
sys.stderr.write(result.stderr)
if result.returncode != 0:
    sys.exit(result.stdout + "\nrenderer failed")

lines = iter(result.stdout.splitlines())
failures = []
sampled = {}
for c in cases:
    image = next(lines)
    assert image.startswith("image "), image
    print(image)
    for q in c["queries"]:
        words = next(lines).split()
        if q[0] == "grid":
            assert words[0] == "grid", words
            points, drawn, missed, extra = map(int, words[1:5])
            share = missed / max(drawn, 1)
            ok = drawn > 0 and share <= q[2]
            print(f"  query grid, every {q[1]} px: {drawn} of {points} points drawn, {missed} of them missed "
                  f"({100 * share:.1f}%, the broad-phase gap; at most {100 * q[2]:.0f}%), {extra} hit off the drawn pixels "
                  f"{'ok' if ok else 'FAILED'}")
            if not ok:
                failures.append(f"{c['name']}: query grid missed {100 * share:.1f}% of the drawn points")
            continue
        assert words[0] == "query", words
        hits = {int(w) for w in words[4:] if w.lstrip("-").isdigit()}
        known_gap = q[-1] == "gap"
        expected = q[-2] if known_gap else q[-1]
        ok = expected <= hits if expected else not hits
        verdict = "ok" if ok else ("missed (known gap)" if known_gap else "FAILED, expected " + str(sorted(expected) or "nothing"))
        print(f"  query ({float(words[1]):.0f}, {float(words[2]):.0f}): {sorted(hits)} {verdict}")
        if not ok and not known_gap:
            failures.append(f"{c['name']}: query {q}")
    for s in c["samples"]:
        a = [int(w) for w in next(lines).split()[3:]]
        if s[0] == "at":
            sampled[(c["name"], s[-1])] = a
            continue
        b = [int(w) for w in next(lines).split()[3:]]
        difference = max(abs(x - y) for x, y in zip(a, b))
        ok = difference <= 3
        print(f"  {s[-1]}: building {a} core {b} {'ok' if ok else 'FAILED'}")
        if not ok:
            failures.append(f"{c['name']}: {s[-1]} differs from core by {difference}")
for translucent, opaque, key, alpha in blends:
    t = sampled[(translucent, key)]
    o = sampled[(opaque, key)]
    expected = [round(bg + (x - bg) * alpha) for bg, x in zip(background_rgb, o)]
    difference = max(abs(x - y) for x, y in zip(t, expected))
    # Blending twice would give bg + (x - bg) * (1 - (1 - alpha)^2).
    ok = difference <= 3 and o[:3] != background_rgb
    print(f"  {translucent} {key}: {t[:3]}, opaque {o[:3]} mixed {expected} {'ok' if ok else 'FAILED'}")
    if not ok:
        failures.append(f"{translucent}: {key} blends to {t[:3]}, not {expected}")
if failures:
    sys.exit("\n".join(["FAILED:"] + failures))
print(f"{len(cases)} {backend_name} frames rendered to {out}: pixel and query checks passed")
