const std = @import("std");

/// Reads a repo file at configure time so the plugin can embed the shared
/// shader and spec, which live outside this module's root.
fn readRepoFile(b: *std.Build, relative_path: []const u8) []const u8 {
    const path = b.pathFromRoot(relative_path);
    return std.Io.Dir.cwd().readFileAlloc(b.graph.io, path, b.allocator, .limited(1 << 20)) catch
        std.debug.panic("failed to read {s}", .{path});
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
    options.addOption([]const u8, "shade_glsl", readRepoFile(b, "../shaders/puck.glsl"));
    options.addOption([]const u8, "spec_json", readRepoFile(b, "../spec.json"));

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
    root_module.addOptions("build_options", options);

    const library = b.addLibrary(.{
        .name = "maplibre-location-puck",
        .root_module = root_module,
        .linkage = .dynamic,
    });
    b.installArtifact(library);

    const tests = b.addTest(.{ .root_module = root_module });
    b.step("test", "Run the frame geometry and spec parity tests").dependOn(&b.addRunArtifact(tests).step);
}
