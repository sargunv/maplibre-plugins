const std = @import("std");

/// Reads a repo file at configure time so the plugin can embed the shared
/// shaders, spec and fixtures, which live outside this module's root.
fn readRepoFile(b: *std.Build, relative_path: []const u8) []const u8 {
    const path = b.pathFromRoot(relative_path);
    return std.Io.Dir.cwd().readFileAlloc(b.graph.io, path, b.allocator, .limited(1 << 22)) catch
        std.debug.panic("failed to read {s}", .{path});
}

fn lessThanName(_: void, a: []const u8, b: []const u8) bool {
    return std.mem.lessThan(u8, a, b);
}

/// Every `*.json` in a repo directory, sorted by name, as the TypeScript
/// twin's layout.test.ts finds them.
fn readFixtureDir(b: *std.Build, relative_path: []const u8) struct { names: []const []const u8, texts: []const []const u8 } {
    const io = b.graph.io;
    const path = b.pathFromRoot(relative_path);
    var dir = std.Io.Dir.cwd().openDir(io, path, .{ .iterate = true }) catch
        std.debug.panic("failed to open {s}", .{path});
    defer dir.close(io);
    var names: std.ArrayList([]const u8) = .empty;
    var it = dir.iterate();
    while (it.next(io) catch std.debug.panic("failed to list {s}", .{path})) |entry| {
        if (entry.kind != .file or !std.mem.endsWith(u8, entry.name, ".json")) continue;
        names.append(b.allocator, b.dupe(entry.name)) catch @panic("OOM");
    }
    std.mem.sort([]const u8, names.items, {}, lessThanName);
    const texts = b.allocator.alloc([]const u8, names.items.len) catch @panic("OOM");
    for (names.items, texts) |name, *text| text.* = readRepoFile(b, b.pathJoin(&.{ relative_path, name }));
    return .{ .names = names.items, .texts = texts };
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
    options.addOption([]const u8, "spec_json", readRepoFile(b, "../spec.json"));
    // The shared shader code (../shaders), wrapped per backend in shaders.zig.
    options.addOption([]const u8, "attributes_glsl", readRepoFile(b, "../shaders/attributes.glsl"));
    options.addOption([]const u8, "uniforms_glsl", readRepoFile(b, "../shaders/uniforms.glsl"));
    options.addOption([]const u8, "building_glsl", readRepoFile(b, "../shaders/building.glsl"));
    options.addOption([]const u8, "properties_glsl", readRepoFile(b, "../shaders/properties.glsl"));
    options.addOption([]const u8, "vertex_glsl", readRepoFile(b, "../shaders/vertex.glsl"));
    // The rendering contract both twins test their tables against.
    options.addOption([]const u8, "render_contract_json", readRepoFile(b, "../fixtures/render/contract.json"));
    // The hit-test cases shared with the TypeScript twin.
    options.addOption([]const u8, "query_fixture_json", readRepoFile(b, "../fixtures/query/prism.json"));
    // The layout fixtures shared with the TypeScript twin (../fixtures/layout).
    const fixtures = readFixtureDir(b, "../fixtures/layout");
    options.addOption([]const []const u8, "layout_fixture_names", fixtures.names);
    options.addOption([]const []const u8, "layout_fixtures", fixtures.texts);

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
        .name = "maplibre-building",
        .root_module = root_module,
        .linkage = .dynamic,
    });
    b.installArtifact(library);

    const test_step = b.step("test", "Run the spec parity, contract, shader, hit-test and layout fixture tests");
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
