const std = @import("std");

/// Reads a repo file at configure time so the plugin can embed the shared
/// shaders, spec and test fixtures, which live outside this module's root.
fn readRepoFile(b: *std.Build, relative_path: []const u8) []const u8 {
    const path = b.pathFromRoot(relative_path);
    return std.Io.Dir.cwd().readFileAlloc(b.graph.io, path, b.allocator, .limited(1 << 24)) catch
        std.debug.panic("failed to read {s}", .{path});
}

/// The plugin ABI header translated for one target.
fn pluginApiModule(
    b: *std.Build,
    target: std.Build.ResolvedTarget,
    optimize: std.builtin.OptimizeMode,
    include_dir: std.Build.LazyPath,
) *std.Build.Module {
    const translate_c = b.addTranslateC(.{
        .root_source_file = b.addWriteFiles().add("plugin_api_import.h", "#include <mln/plugin/plugin_api.h>\n"),
        .target = target,
        .optimize = optimize,
    });
    translate_c.addIncludePath(include_dir);
    return translate_c.createModule();
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

    const options = b.addOptions();
    options.addOption([]const u8, "particle_glsl", readRepoFile(b, "../shaders/particle.glsl"));
    options.addOption([]const u8, "shape_glsl", readRepoFile(b, "../shaders/shape.glsl"));
    options.addOption([]const u8, "emitter_glsl", readRepoFile(b, "../shaders/emitter.glsl"));
    options.addOption([]const u8, "spec_json", readRepoFile(b, "../spec.json"));
    // Fixtures shared with the JS twins (see ../fixtures).
    options.addOption([]const u8, "fixture_hash", readRepoFile(b, "../fixtures/hash.json"));
    options.addOption([]const u8, "fixture_record", readRepoFile(b, "../fixtures/record.json"));
    options.addOption([]const u8, "fixture_layout_points", readRepoFile(b, "../fixtures/layout-points.json"));
    options.addOption([]const u8, "fixture_layout_lines", readRepoFile(b, "../fixtures/layout-lines.json"));
    options.addOption([]const u8, "fixture_layout_polygons", readRepoFile(b, "../fixtures/layout-polygons.json"));

    // The plugin's module gets only the translated header and libc: the
    // register function arrives as a runtime argument, so the library carries
    // no undefined maplibre-native-c symbols and links against nothing.
    const root_module = b.createModule(.{
        .root_source_file = b.path("src/plugin.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    root_module.addImport("maplibre_native_c", pluginApiModule(b, target, optimize, plugin_api_dir));
    root_module.addOptions("build_options", options);

    const library = b.addLibrary(.{
        .name = "maplibre-particles",
        .root_module = root_module,
        .linkage = .dynamic,
    });
    b.installArtifact(library);

    const test_step = b.step("test", "Run the spec parity, shader, layout and twin fixture tests");
    test_step.dependOn(&b.addRunArtifact(b.addTest(.{ .root_module = root_module })).step);

    // `zig build dump-shaders -- <dir>` writes every shader source behind a
    // replica of the host prelude, for the offline compilers in the
    // shader-check task. It runs on the build host whatever the target.
    const dump_module = b.createModule(.{
        .root_source_file = b.path("src/dump_shaders.zig"),
        .target = b.graph.host,
        .optimize = optimize,
        .link_libc = true,
    });
    dump_module.addImport("maplibre_native_c", pluginApiModule(b, b.graph.host, optimize, plugin_api_dir));
    dump_module.addOptions("build_options", options);
    const dump = b.addRunArtifact(b.addExecutable(.{ .name = "dump-shaders", .root_module = dump_module }));
    if (b.args) |args| dump.addArgs(args);
    b.step("dump-shaders", "Write every shader source to the directory given after --").dependOn(&dump.step);
    // Testing the dump module also keeps it compiling between shader checks.
    test_step.dependOn(&b.addRunArtifact(b.addTest(.{ .root_module = dump_module })).step);
}
