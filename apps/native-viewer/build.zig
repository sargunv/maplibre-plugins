const std = @import("std");
const maplibre_build = @import("maplibre_native_ffi");

/// A native plugin the viewer can load, with the symbols of its spec.json
/// `native` section.
const Plugin = struct {
    name: []const u8,
    dependency: []const u8,
    artifact: []const u8,
    entry_point: []const u8,
    /// Registers an app catalog (`--catalog`) instead of the embedded one.
    catalog_entry_point: ?[]const u8 = null,
    /// The exported animation clock, for `--play-once`.
    clock_symbol: ?[]const u8 = null,
};

/// Every native plugin the viewer can load. Each entry becomes a
/// `zig build run-<name>` step that builds the plugin and passes its library
/// and symbols to the viewer.
const plugins = [_]Plugin{
    .{ .name = "location-indicator", .dependency = "location_indicator", .artifact = "maplibre-location-puck", .entry_point = "mln_location_puck_register" },
    .{ .name = "water", .dependency = "water", .artifact = "maplibre-water", .entry_point = "mln_water_register" },
    .{
        .name = "animated-icon",
        .dependency = "animated_icon",
        .artifact = "maplibre-animated-icon",
        .entry_point = "mln_animated_icon_register",
        .catalog_entry_point = "mln_animated_icon_register_catalog",
        .clock_symbol = "mln_animated_icon_clock_seconds",
    },
    .{ .name = "particles", .dependency = "particles", .artifact = "maplibre-particles", .entry_point = "mln_particles_register" },
};

const BuildOptions = struct {
    target: std.Build.ResolvedTarget,
    optimize: std.builtin.OptimizeMode,
    native_install_dir: std.Build.LazyPath,
    include_dirs: []const std.Build.LazyPath,
    dependency_include_dirs: []const std.Build.LazyPath,
    dependency_library_dirs: []const std.Build.LazyPath,
    render_backend: maplibre_build.RenderBackend,
    system_root: ?std.Build.LazyPath,
};

fn appendIncludeDir(b: *std.Build, include_dirs: []const std.Build.LazyPath, include_dir: std.Build.LazyPath) []const std.Build.LazyPath {
    const result = b.allocator.alloc(std.Build.LazyPath, include_dirs.len + 1) catch @panic("out of memory");
    @memcpy(result[0..include_dirs.len], include_dirs);
    result[include_dirs.len] = include_dir;
    return result;
}

fn cBindingsHeader(b: *std.Build, backend: maplibre_build.RenderBackend) std.Build.LazyPath {
    return switch (backend) {
        .metal => b.path("c_metal.h"),
        .opengl => b.path("c_opengl.h"),
        .vulkan => b.path("c_vulkan.h"),
    };
}

pub fn build(b: *std.Build) void {
    const native_install_dir = maplibre_build.nativeInstallDirPath(b);
    const target = maplibre_build.nativeTarget(b, native_install_dir);
    const render_backend = maplibre_build.renderBackend(b, native_install_dir);
    const system_root = maplibre_build.maybeSystemRootPath(b);
    const dependency_include_dirs = maplibre_build.dependencyIncludeDirs(b);
    const options = BuildOptions{
        .target = target,
        .optimize = b.standardOptimizeOption(.{}),
        .native_install_dir = native_install_dir,
        .include_dirs = maplibre_build.installedIncludeDirs(b, native_install_dir, dependency_include_dirs),
        .dependency_include_dirs = dependency_include_dirs,
        .dependency_library_dirs = maplibre_build.dependencyLibraryDirs(b),
        .render_backend = render_backend,
        .system_root = system_root,
    };

    const root_module = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = options.target,
        .optimize = options.optimize,
    });
    const exe = b.addExecutable(.{ .name = "native-viewer", .root_module = root_module });

    const sdl = b.dependency("sdl", .{ .target = options.target, .optimize = options.optimize }).artifact("SDL3");
    if (options.target.result.os.tag == .macos) {
        if (options.system_root) |sdk_root| {
            const root = sdk_root.getPath(b);
            sdl.root_module.addSystemIncludePath(.{ .cwd_relative = b.pathJoin(&.{ root, "usr", "include" }) });
            sdl.root_module.addLibraryPath(.{ .cwd_relative = b.pathJoin(&.{ root, "usr", "lib" }) });
            sdl.root_module.addSystemFrameworkPath(.{ .cwd_relative = b.pathJoin(&.{ root, "System", "Library", "Frameworks" }) });
        }
    }

    maplibre_build.addRenderBackendOptions(b, root_module, options.render_backend);
    maplibre_build.addIncludePaths(root_module, options.include_dirs);
    root_module.addImport("c", maplibre_build.translateCModule(b, .{
        .root_source_file = cBindingsHeader(b, options.render_backend),
        .target = options.target,
        .optimize = options.optimize,
        .include_dirs = appendIncludeDir(b, options.include_dirs, sdl.getEmittedIncludeTree()),
        .c_macros = maplibre_build.sdlTranslateCMacros(options.target),
        .system_root = options.system_root,
    }));
    root_module.addImport("maplibre_native_ffi", maplibre_build.maplibreNativeModule(b, .{
        .target = options.target,
        .optimize = options.optimize,
        .native_install_dir = options.native_install_dir,
        .render_backend = options.render_backend,
        .dependency_include_dirs = options.dependency_include_dirs,
        .dependency_library_dirs = options.dependency_library_dirs,
        .system_root = options.system_root,
    }));
    for (options.dependency_library_dirs) |dir| {
        root_module.addLibraryPath(dir);
        root_module.addRPath(dir);
    }
    root_module.linkLibrary(sdl);
    maplibre_build.linkRenderBackend(b, root_module, .{
        .target = options.target,
        .render_backend = options.render_backend,
        .dependency_library_dirs = options.dependency_library_dirs,
        .system_root = options.system_root,
    });
    if (options.render_backend == .metal) {
        if (b.lazyDependency("zig_objc", .{ .target = options.target, .optimize = options.optimize })) |zig_objc| {
            root_module.addImport("objc", zig_objc.module("objc"));
        }
        root_module.linkFramework("Foundation", .{});
    }
    b.installArtifact(exe);

    // The viewer's logic that needs no window or map: the play-once pick.
    const tests = b.addTest(.{ .root_module = b.createModule(.{
        .root_source_file = b.path("src/play_once.zig"),
        .target = options.target,
        .optimize = options.optimize,
    }) });
    b.step("test", "Run the viewer's unit tests").dependOn(&b.addRunArtifact(tests).step);

    // Plugins build against the headers of the install the viewer loads them
    // into, rather than the vendored copy.
    const install_include_dir = std.Build.LazyPath{ .cwd_relative = b.pathJoin(&.{ native_install_dir.getPath(b), "include" }) };
    inline for (plugins) |plugin| {
        const dependency = b.dependency(plugin.dependency, .{
            .target = options.target,
            .optimize = options.optimize,
            .@"plugin-api-include-dir" = install_include_dir,
        });
        const library = dependency.artifact(plugin.artifact);
        b.installArtifact(library);

        const run = b.addRunArtifact(exe);
        run.addArg("--plugin");
        run.addArtifactArg(library);
        run.addArgs(&.{ "--entry", plugin.entry_point });
        if (plugin.catalog_entry_point) |symbol| run.addArgs(&.{ "--catalog-entry", symbol });
        if (plugin.clock_symbol) |symbol| run.addArgs(&.{ "--clock-symbol", symbol });
        if (b.args) |args| run.addArgs(args);
        b.step("run-" ++ plugin.name, "Open the viewer with the " ++ plugin.name ++ " plugin").dependOn(&run.step);
    }
}
