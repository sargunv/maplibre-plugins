const std = @import("std");

/// Reads a repo file at configure time so the plugin can embed the shared
/// spec, shaders and catalog, which live outside this module's root.
fn readRepoFile(b: *std.Build, relative_path: []const u8) []const u8 {
    const path = b.pathFromRoot(relative_path);
    return std.Io.Dir.cwd().readFileAlloc(b.graph.io, path, b.allocator, .limited(1 << 24)) catch
        std.debug.panic("failed to read {s}", .{path});
}

/// Every file of a repo directory, sorted by name, as build options holding
/// parallel `names` and `files` lists.
fn repoDirOptions(b: *std.Build, relative_path: []const u8) *std.Build.Step.Options {
    const io = b.graph.io;
    const path = b.pathFromRoot(relative_path);
    var dir = std.Io.Dir.cwd().openDir(io, path, .{ .iterate = true }) catch
        std.debug.panic("failed to open {s}", .{path});
    defer dir.close(io);
    var names: std.ArrayList([]const u8) = .empty;
    var it = dir.iterate();
    while (it.next(io) catch std.debug.panic("failed to list {s}", .{path})) |entry| {
        if (entry.kind == .file) names.append(b.allocator, b.dupe(entry.name)) catch @panic("OOM");
    }
    std.mem.sort([]const u8, names.items, {}, struct {
        fn lessThan(_: void, lhs: []const u8, rhs: []const u8) bool {
            return std.mem.order(u8, lhs, rhs) == .lt;
        }
    }.lessThan);
    const files = b.allocator.alloc([]const u8, names.items.len) catch @panic("OOM");
    for (names.items, files) |name, *file| file.* = readRepoFile(b, b.fmt("{s}/{s}", .{ relative_path, name }));
    const options = b.addOptions();
    options.addOption([]const []const u8, "names", names.items);
    options.addOption([]const []const u8, "files", files);
    return options;
}

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    // The plugin ABI header. Defaults to the vendored copy so the plugin builds
    // with no native library present; apps may point it at a real install.
    const plugin_api_dir = b.option(
        std.Build.LazyPath,
        "plugin-api-include-dir",
        "Directory containing mln/plugin/plugin_api.h",
    ) orelse b.path("../../../third_party/mln-plugin-api");

    const translate_c = b.addTranslateC(.{
        .root_source_file = b.addWriteFiles().add("plugin_api_import.h", "#include <mln/plugin/plugin_api.h>\n"),
        .target = target,
        .optimize = optimize,
    });
    translate_c.addIncludePath(plugin_api_dir);

    const options = b.addOptions();
    options.addOption([]const u8, "spec_json", readRepoFile(b, "../spec.json"));
    // The shared shaders: property resolution and vertex placement, then the
    // fragment's coverage and paint.
    options.addOption([]const u8, "properties_glsl", readRepoFile(b, "../shaders/properties.glsl"));
    options.addOption([]const u8, "place_glsl", readRepoFile(b, "../shaders/place.glsl"));
    options.addOption([]const u8, "icon_glsl", readRepoFile(b, "../shaders/icon.glsl"));
    // The baked demo catalog (../baker), parsed when the plugin registers it.
    options.addOption([]const u8, "catalog_mlvc", readRepoFile(b, "../catalog/demo.mlvc"));
    // The shader sections the WebGL2 twin shares verbatim, for the tests.
    options.addOption([]const u8, "shader_sections", readRepoFile(b, "../fixtures/shaders/sections.glsl"));

    // The shared fixtures (../fixtures), for the tests of catalog.zig,
    // layout.zig and place.zig; the library never references them.
    // One module, since the catalog module and the plugin's tests share it.
    const catalog_fixtures = repoDirOptions(b, "../fixtures/catalog").createModule();
    const layout_fixtures = repoDirOptions(b, "../fixtures/layout");
    const place_fixtures = repoDirOptions(b, "../fixtures/place");

    // The catalog reader alone, so its tests run without the plugin: it
    // imports std only. The plugin imports it as a module, so its tests run
    // once, here.
    const catalog_module = b.createModule(.{
        .root_source_file = b.path("src/catalog.zig"),
        .target = target,
        .optimize = optimize,
    });
    catalog_module.addImport("catalog_fixtures", catalog_fixtures);
    const catalog_tests = b.addTest(.{ .root_module = catalog_module });
    const test_catalog = b.step("test-catalog", "Run the catalog reader's fixture tests");
    test_catalog.dependOn(&b.addRunArtifact(catalog_tests).step);

    // The plugin's module gets only the translated header and libc: the
    // register function arrives as a runtime argument, so the library carries
    // no undefined maplibre-native-c symbols and links against nothing.
    const root_module = b.createModule(.{
        .root_source_file = b.path("src/plugin.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    root_module.addImport("maplibre_native_c", translate_c.createModule());
    root_module.addImport("catalog", catalog_module);
    root_module.addOptions("build_options", options);
    root_module.addImport("catalog_fixtures", catalog_fixtures);
    root_module.addOptions("layout_fixtures", layout_fixtures);
    root_module.addOptions("place_fixtures", place_fixtures);

    const library = b.addLibrary(.{
        .name = "maplibre-animated-icon",
        .root_module = root_module,
        .linkage = .dynamic,
    });
    b.installArtifact(library);

    const tests = b.addTest(.{ .root_module = root_module });
    const test_step = b.step("test", "Run the catalog, layout, placement, shader and spec parity tests");
    test_step.dependOn(test_catalog);
    test_step.dependOn(&b.addRunArtifact(tests).step);
}
