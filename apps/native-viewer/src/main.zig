//! Windowed plugin viewer. Loads a native plugin into maplibre-native-c, shows
//! a style with one layer from a JSON file, and re-applies the file whenever
//! it changes, so paint properties can be tuned live from any editor. It can
//! also register an app catalog, add GeoJSON sources, restart hovered features
//! through feature state (play-once), and replay scripted input.
//!
//! Adapted from maplibre-native-ffi's examples/zig-map (native-surface path).

const std = @import("std");
const builtin = @import("builtin");
const build_options = @import("build_options");
const objc = if (build_options.supports_metal) @import("objc") else struct {};

const c = @import("c.zig").c;
const channel = @import("channel.zig");
const diagnostics = @import("diagnostics.zig");
const maplibre = @import("maplibre_native_ffi");
const input = @import("input.zig");
const layer_file = @import("layer_file.zig");
const map_state = @import("map_state.zig");
const play_once = @import("play_once.zig");
const plugin_loader = @import("plugin_loader.zig");
const render = @import("render/mod.zig");
const scripted = @import("scripted.zig");
const types = @import("types.zig");
const viewport = @import("viewport.zig");

const RenderTarget = render.RenderTarget;

/// Backstop for a parked pump that nothing signals; the wake source is what
/// normally releases it.
const park_timeout_milliseconds = 100;
const uses_egl = build_options.supports_opengl and (builtin.os.tag == .linux or builtin.os.tag == .macos);
/// The largest app catalog file: a full 2048 x 2048 RGBA32F texel section
/// (64 MiB, the plugin texture's maximum) plus 1 MiB for the header, up to 510
/// records and the names.
const max_catalog_bytes = (64 << 20) + (1 << 20);
const max_geojson_bytes = 16 << 20;

fn usage() void {
    std.debug.print(
        \\Usage: native-viewer --plugin <library> --entry <symbol> --layer <layer.json> [options]
        \\
        \\Options:
        \\  --style <url>           Style URL (default OpenFreeMap bright)
        \\  --before <layer-id>     Insert the layer before this style layer
        \\  --center <lat,lon>      Camera center (default 37.7749,-122.4194)
        \\  --zoom <z> --bearing <deg> --pitch <deg>
        \\  --catalog <file>        Register this app catalog (<= 65 MiB) through --catalog-entry
        \\  --catalog-entry <symbol>
        \\                          The plugin's catalog entry point
        \\  --geojson <id>=<file>   Add a GeoJSON source (<= 16 MiB) with the file inlined; repeatable
        \\  --clock-symbol <symbol> The plugin's exported clock, double(void)
        \\  --play-once <source-id> Hover a feature of the source to set its feature state
        \\                          {{"start": <clock>}}; click to set it again (needs --clock-symbol)
        \\  --hover-at <x>,<y>@<s>  Scripted hover at logical px, <s> seconds after the first frame
        \\  --click-at <x>,<y>@<s>  Scripted click, likewise; both are repeatable
        \\  --exit-after <s>        Quit <s> seconds after the first frame
        \\
    , .{});
}

fn parseArgs(allocator: std.mem.Allocator, init_args: std.process.Init) !?types.Options {
    var args = try std.process.Args.Iterator.initAllocator(init_args.minimal.args, allocator);
    defer args.deinit();
    _ = args.skip();
    var plugin_path: ?[]const u8 = null;
    var entry_point: ?[]const u8 = null;
    var layer_path: ?[]const u8 = null;
    var options = types.Options{ .plugin_path = "", .entry_point = "", .layer_path = "" };
    var geojson_sources: std.ArrayList(types.GeoJsonSource) = .empty;
    var scripted_inputs: std.ArrayList(types.ScriptedInput) = .empty;
    while (args.next()) |arg| {
        if (std.mem.eql(u8, arg, "--help") or std.mem.eql(u8, arg, "-h")) {
            usage();
            return null;
        }
        const value = args.next() orelse {
            std.debug.print("missing value for {s}\n", .{arg});
            usage();
            return types.AppError.InvalidArguments;
        };
        if (std.mem.eql(u8, arg, "--plugin")) {
            plugin_path = try allocator.dupe(u8, value);
        } else if (std.mem.eql(u8, arg, "--entry")) {
            entry_point = try allocator.dupe(u8, value);
        } else if (std.mem.eql(u8, arg, "--layer")) {
            layer_path = try allocator.dupe(u8, value);
        } else if (std.mem.eql(u8, arg, "--style")) {
            options.style_url = try allocator.dupe(u8, value);
        } else if (std.mem.eql(u8, arg, "--before")) {
            options.before_layer = try allocator.dupe(u8, value);
        } else if (std.mem.eql(u8, arg, "--center")) {
            const comma = std.mem.indexOfScalar(u8, value, ',') orelse return types.AppError.InvalidArguments;
            options.latitude = try std.fmt.parseFloat(f64, value[0..comma]);
            options.longitude = try std.fmt.parseFloat(f64, value[comma + 1 ..]);
        } else if (std.mem.eql(u8, arg, "--zoom")) {
            options.zoom = try std.fmt.parseFloat(f64, value);
        } else if (std.mem.eql(u8, arg, "--bearing")) {
            options.bearing = try std.fmt.parseFloat(f64, value);
        } else if (std.mem.eql(u8, arg, "--pitch")) {
            options.pitch = try std.fmt.parseFloat(f64, value);
        } else if (std.mem.eql(u8, arg, "--catalog")) {
            options.catalog_path = try allocator.dupe(u8, value);
        } else if (std.mem.eql(u8, arg, "--catalog-entry")) {
            options.catalog_entry_point = try allocator.dupe(u8, value);
        } else if (std.mem.eql(u8, arg, "--geojson")) {
            const equals = std.mem.indexOfScalar(u8, value, '=') orelse 0;
            if (equals == 0 or equals + 1 == value.len) {
                std.debug.print("--geojson takes <source-id>=<file>, got {s}\n", .{value});
                return types.AppError.InvalidArguments;
            }
            const source = types.GeoJsonSource{ .id = try allocator.dupe(u8, value[0..equals]), .path = try allocator.dupe(u8, value[equals + 1 ..]) };
            // A later flag for the same id replaces the earlier one.
            for (geojson_sources.items) |*existing| {
                if (std.mem.eql(u8, existing.id, source.id)) {
                    existing.* = source;
                    break;
                }
            } else try geojson_sources.append(allocator, source);
        } else if (std.mem.eql(u8, arg, "--clock-symbol")) {
            options.clock_symbol = try allocator.dupe(u8, value);
        } else if (std.mem.eql(u8, arg, "--play-once")) {
            options.play_once_source = try allocator.dupe(u8, value);
        } else if (std.mem.eql(u8, arg, "--hover-at") or std.mem.eql(u8, arg, "--click-at")) {
            const kind: @FieldType(types.ScriptedInput, "kind") = if (std.mem.eql(u8, arg, "--hover-at")) .hover else .click;
            try scripted_inputs.append(allocator, scripted.parseInput(kind, value) catch {
                std.debug.print("{s} takes <x>,<y>@<seconds>, got {s}\n", .{ arg, value });
                return types.AppError.InvalidArguments;
            });
        } else if (std.mem.eql(u8, arg, "--exit-after")) {
            const seconds = scripted.parseFinite(value) catch -1;
            if (seconds < 0) {
                std.debug.print("--exit-after takes seconds, got {s}\n", .{value});
                return types.AppError.InvalidArguments;
            }
            options.exit_after_seconds = seconds;
        } else {
            std.debug.print("unknown option {s}\n", .{arg});
            usage();
            return types.AppError.InvalidArguments;
        }
    }
    options.plugin_path = plugin_path orelse {
        usage();
        return types.AppError.InvalidArguments;
    };
    options.entry_point = entry_point orelse {
        usage();
        return types.AppError.InvalidArguments;
    };
    options.layer_path = layer_path orelse {
        usage();
        return types.AppError.InvalidArguments;
    };
    if (options.catalog_path != null and options.catalog_entry_point == null) {
        std.debug.print("--catalog needs --catalog-entry, the plugin's catalog entry point\n", .{});
        return types.AppError.InvalidArguments;
    }
    if (options.play_once_source != null and options.clock_symbol == null) {
        std.debug.print("--play-once needs --clock-symbol, the plugin's exported clock\n", .{});
        return types.AppError.InvalidArguments;
    }
    options.geojson_sources = try geojson_sources.toOwnedSlice(allocator);
    scripted.sort(scripted_inputs.items);
    options.scripted_inputs = try scripted_inputs.toOwnedSlice(allocator);
    return options;
}

/// Reads an input file named on the command line, up to `limit` bytes.
fn readInputFile(allocator: std.mem.Allocator, io: std.Io, path: []const u8, limit: usize) ![]u8 {
    return std.Io.Dir.cwd().readFileAlloc(io, path, allocator, .limited(limit + 1)) catch |err| {
        switch (err) {
            error.StreamTooLong => std.debug.print("{s} is larger than {d} bytes\n", .{ path, limit }),
            else => std.debug.print("cannot read {s}: {s}\n", .{ path, @errorName(err) }),
        }
        return types.AppError.InputReadFailed;
    };
}

/// Inlines each `--geojson` file as its source's data.
fn loadGeoJsonSources(allocator: std.mem.Allocator, io: std.Io, sources: []const types.GeoJsonSource) ![]const types.GeoJsonSource {
    const loaded = try allocator.dupe(types.GeoJsonSource, sources);
    for (loaded) |*source| {
        const data = try readInputFile(allocator, io, source.path, max_geojson_bytes);
        defer allocator.free(data);
        source.json = try std.mem.concat(allocator, u8, &.{ "{\"type\":\"geojson\",\"data\":", data, "}" });
    }
    return loaded;
}

/// Registers the plugin, with the `--catalog` bytes when given, and returns
/// its clock when `--clock-symbol` names one.
fn loadPlugin(allocator: std.mem.Allocator, io: std.Io, options: *const types.Options) !?plugin_loader.Clock {
    const catalog_path = options.catalog_path orelse
        return plugin_loader.load(options.plugin_path, options.entry_point, null, options.clock_symbol);
    // The plugin copies the catalog, so the bytes are only borrowed for the call.
    const bytes = try readInputFile(allocator, io, catalog_path, max_catalog_bytes);
    defer allocator.free(bytes);
    return plugin_loader.load(options.plugin_path, options.entry_point, .{
        .path = catalog_path,
        .bytes = bytes,
        .entry_point = options.catalog_entry_point.?,
    }, options.clock_symbol);
}

const RuntimeLoopArgs = struct {
    allocator: std.mem.Allocator,
    io: std.Io,
    options: *const types.Options,
    initial_viewport: types.Viewport,
    commands: *channel.CommandQueue,
    render_request: *channel.RenderRequest,
    map_channel: *channel.MapChannel,
};

/// Owns the runtime and the map for their whole lifetime, on a thread that is
/// not the one presenting.
fn runtimeLoop(args: RuntimeLoopArgs) void {
    var state = map_state.MapState.init(args.allocator, args.options, args.initial_viewport) catch |err| {
        args.map_channel.fail(err);
        return;
    };
    // A map with an attached session cannot be destroyed, so wait for the render
    // loop to close its session first; defers run in reverse.
    defer state.deinit();
    defer args.map_channel.awaitShutdown(args.io);
    runtimeLoopBody(args, &state) catch |err| args.map_channel.fail(err);
}

fn runtimeLoopBody(args: RuntimeLoopArgs, state: *map_state.MapState) !void {
    const wake = try state.runtime.wakeSource();
    defer wake.release();
    var batch: std.ArrayList(channel.Command) = .empty;
    defer batch.deinit(args.allocator);
    args.map_channel.publish(state.map, wake);
    while (!args.map_channel.shutdownRequested() and args.map_channel.failureValue() == null) {
        try state.applyCommands(args.commands, &batch);
        try state.runtime.pump(park_timeout_milliseconds, null);
        if (try state.drainEvents()) args.render_request.set();
    }
}

pub fn main(init_args: std.process.Init) !void {
    var arena = std.heap.ArenaAllocator.init(init_args.gpa);
    defer arena.deinit();
    var options = (try parseArgs(arena.allocator(), init_args)) orelse return;
    options.geojson_sources = try loadGeoJsonSources(arena.allocator(), init_args.io, options.geojson_sources);

    try validateNativeRenderBackend();
    const clock = try loadPlugin(init_args.gpa, init_args.io, &options);

    try maplibre.setLogCallback(.{ .handler = diagnostics.logRecord }, null);
    defer maplibre.clearLogCallback(null) catch {};

    if (uses_egl) _ = c.SDL_SetHint(c.SDL_HINT_VIDEO_FORCE_EGL, "1");
    if (!c.SDL_Init(c.SDL_INIT_VIDEO)) {
        std.debug.print("SDL_Init failed: {s}\n", .{std.mem.span(c.SDL_GetError())});
        return types.AppError.SdlInitFailed;
    }
    defer c.SDL_Quit();
    if (uses_egl) {
        if (!c.SDL_GL_SetAttribute(c.SDL_GL_CONTEXT_PROFILE_MASK, c.SDL_GL_CONTEXT_PROFILE_ES) or
            !c.SDL_GL_SetAttribute(c.SDL_GL_CONTEXT_MAJOR_VERSION, 3) or
            !c.SDL_GL_SetAttribute(c.SDL_GL_CONTEXT_MINOR_VERSION, 0))
        {
            std.debug.print("SDL_GL_SetAttribute failed: {s}\n", .{std.mem.span(c.SDL_GetError())});
            return types.AppError.BackendSetupFailed;
        }
    }

    const window = c.SDL_CreateWindow(
        "maplibre-plugins viewer",
        viewport.window_width,
        viewport.window_height,
        RenderTarget.window_flags | c.SDL_WINDOW_RESIZABLE | c.SDL_WINDOW_HIGH_PIXEL_DENSITY,
    ) orelse {
        std.debug.print("SDL_CreateWindow failed: {s}\n", .{std.mem.span(c.SDL_GetError())});
        return types.AppError.WindowCreateFailed;
    };
    defer c.SDL_DestroyWindow(window);
    _ = c.SDL_RaiseWindow(window);
    var current_viewport = viewport.get(window);
    viewport.log("initial viewport", current_viewport);

    var gpa = std.heap.DebugAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    // The graphics context, the render session, and every presentation resource
    // belong to this thread, which owns the window.
    var target = try RenderTarget.init(allocator, window, current_viewport);

    var commands = channel.CommandQueue.init(allocator);
    defer commands.deinit();
    var render_request = channel.RenderRequest{};
    var map_channel = channel.MapChannel{};

    var watcher = layer_file.Watcher.init(allocator, init_args.io, options.layer_path);
    defer watcher.deinit();
    // The first read queues the layer before the style even loads; the runtime
    // loop adds it once the style is live.
    _ = try watcher.poll(&commands, true);

    const runtime_thread = try std.Thread.spawn(.{}, runtimeLoop, .{RuntimeLoopArgs{
        .allocator = allocator,
        .io = init_args.io,
        .options = &options,
        .initial_viewport = current_viewport,
        .commands = &commands,
        .render_request = &render_request,
        .map_channel = &map_channel,
    }});

    var script = scripted.Script{ .inputs = options.scripted_inputs, .exit_after_seconds = options.exit_after_seconds };
    var play: ?PlayOnce = if (options.play_once_source) |source_id| .{
        .source_id = source_id,
        .clock = clock.?,
        .hover = .{ .allocator = allocator },
    } else null;
    defer if (play) |*p| p.hover.deinit();

    const result = renderLoop(init_args.io, allocator, window, &target, &current_viewport, &commands, &render_request, &map_channel, &watcher, &script, if (play) |*p| p else null);

    // Destroy the session before the runtime loop destroys the map.
    target.deinit();
    map_channel.requestShutdown();
    runtime_thread.join();

    try result;
    if (map_channel.failureValue()) |err| return err;
}

/// The display-paced render loop. Owns the window, input, the layer watcher,
/// and the render session once it adopts it.
fn renderLoop(
    io: std.Io,
    allocator: std.mem.Allocator,
    window: *c.SDL_Window,
    target: *RenderTarget,
    current_viewport: *types.Viewport,
    commands: *channel.CommandQueue,
    render_request: *channel.RenderRequest,
    map_channel: *channel.MapChannel,
    watcher: *layer_file.Watcher,
    script: *scripted.Script,
    play: ?*PlayOnce,
) !void {
    var map = while (true) {
        if (map_channel.failureValue()) |err| return err;
        if (map_channel.mapHandle()) |handle| break handle;
        try io.sleep(.fromMilliseconds(1), .awake);
    };
    try target.attach(&map, current_viewport.*);
    input.logControls(if (play) |p| p.source_id else null);
    std.debug.print("watching {s}\n", .{watcher.path});

    var running = true;
    var controller = input.Controller{};
    // Only the latest pointer position is picked, once per iteration.
    var pending_hover: ?maplibre.ScreenPoint = null;
    while (running) {
        const pool = if (build_options.supports_metal) objc.AutoreleasePool.init() else {};
        defer if (build_options.supports_metal) pool.deinit();

        if (map_channel.failureValue()) |err| return err;
        // Scripted input queues SDL events, handled below like real ones.
        if (!script.fire(io, window, current_viewport.*)) running = false;

        var event: c.SDL_Event = undefined;
        while (c.SDL_PollEvent(&event)) {
            switch (event.type) {
                c.SDL_EVENT_QUIT, c.SDL_EVENT_WINDOW_CLOSE_REQUESTED => running = false,
                c.SDL_EVENT_WINDOW_RESIZED, c.SDL_EVENT_WINDOW_PIXEL_SIZE_CHANGED, c.SDL_EVENT_WINDOW_DISPLAY_SCALE_CHANGED => {
                    current_viewport.* = viewport.get(window);
                    try target.resize(current_viewport.*);
                    map_channel.wakeRuntimeLoop();
                    render_request.set();
                },
                else => {
                    const result = controller.handleEvent(&event, commands, current_viewport.*);
                    if (result.handled) map_channel.wakeRuntimeLoop();
                    if (result.camera_changed) render_request.set();
                    if (result.reload_layer) {
                        if (try watcher.poll(commands, true)) map_channel.wakeRuntimeLoop();
                    }
                    if (result.click) |point| {
                        if (clickAt(allocator, target, point, commands, play)) map_channel.wakeRuntimeLoop();
                    }
                    if (result.hover) |point| {
                        if (play != null) pending_hover = point;
                    }
                },
            }
        }

        if (pending_hover) |point| {
            pending_hover = null;
            if (hoverAt(allocator, target, point, commands, play.?)) map_channel.wakeRuntimeLoop();
        }

        if (try watcher.poll(commands, false)) {
            std.debug.print("layer file changed\n", .{});
            map_channel.wakeRuntimeLoop();
            render_request.set();
        }

        try target.finishFrame();
        // Consume before rendering, so a request published during the render
        // call is not discarded.
        if (render_request.consume()) {
            if (try target.renderUpdate()) script.frameRendered(io) else render_request.set();
        }
        // Stand-in for a display-refresh subscription.
        try io.sleep(.fromMilliseconds(8), .awake);
    }
}

/// Hover and click play-once (`--play-once`): the source whose features
/// restart, the plugin clock that stamps each start, and the hovered feature.
const PlayOnce = struct {
    source_id: []const u8,
    clock: plugin_loader.Clock,
    hover: play_once.Hover,
};

/// The rendered features under a point; plugin layers with hit envelopes show
/// up here like built-in layers do.
fn queryAt(allocator: std.mem.Allocator, target: *RenderTarget, point: maplibre.ScreenPoint) ?maplibre.QueriedFeatureList {
    const handle = target.sessionHandle() catch return null;
    return handle.queryRenderedFeatures(allocator, .{ .point = point }, null) catch |err| {
        diagnostics.logError("query rendered features failed", err, null);
        return null;
    };
}

/// Prints the features under a click and, with play-once, restarts the one
/// picked there even if it is already playing. Returns whether it queued a
/// command.
fn clickAt(allocator: std.mem.Allocator, target: *RenderTarget, point: maplibre.ScreenPoint, commands: *channel.CommandQueue, play: ?*PlayOnce) bool {
    var features = queryAt(allocator, target, point) orelse return false;
    defer features.deinit();
    std.debug.print("click at ({d:.0}, {d:.0}): {d} feature(s)\n", .{ point.x, point.y, features.items.len });
    for (features.items[0..@min(features.items.len, 5)]) |feature| {
        std.debug.print("  {s}{s}{s}\n", .{
            feature.feature[0..@min(feature.feature.len, 200)],
            if (feature.feature.len > 200) "…" else "",
            if (feature.source_id) |_| "" else "  (source-free)",
        });
    }
    const p = play orelse return false;
    const picked = play_once.pick(allocator, features.items, p.source_id) catch |err| {
        diagnostics.logError("play-once pick failed", err, null);
        return false;
    } orelse return false;
    defer picked.deinit(allocator);
    startPlayOnce(commands, p, picked.text);
    return true;
}

/// Restarts the feature under the pointer when it is not the one hovered last.
/// Returns whether it queued a command.
fn hoverAt(allocator: std.mem.Allocator, target: *RenderTarget, point: maplibre.ScreenPoint, commands: *channel.CommandQueue, play: *PlayOnce) bool {
    var features = queryAt(allocator, target, point) orelse return false;
    defer features.deinit();
    const picked = play_once.pick(allocator, features.items, play.source_id) catch |err| {
        diagnostics.logError("play-once pick failed", err, null);
        return false;
    };
    defer if (picked) |id| id.deinit(allocator);
    const change = play.hover.update(if (picked) |id| id.text else null) catch |err| {
        diagnostics.logError("play-once hover failed", err, null);
        return false;
    };
    switch (change) {
        .unchanged => return false,
        .left => {
            std.debug.print("hover at ({d:.0}, {d:.0}): no {s} feature\n", .{ point.x, point.y, play.source_id });
            return false;
        },
        .entered => {
            const id = picked.?.text;
            std.debug.print("hover at ({d:.0}, {d:.0}): {d} feature(s), picked {s}/{s}\n", .{ point.x, point.y, features.items.len, play.source_id, id });
            startPlayOnce(commands, play, id);
            return true;
        },
    }
}

/// Queues `{"start": <plugin clock>}` for the feature; the runtime loop sets it.
fn startPlayOnce(commands: *channel.CommandQueue, play: *const PlayOnce, feature_id: []const u8) void {
    const start = play.clock();
    const queue = commands.allocator;
    commands.push(.{ .set_feature_state = .{
        .source_id = queue.dupe(u8, play.source_id) catch @panic("command queue out of memory"),
        .feature_id = queue.dupe(u8, feature_id) catch @panic("command queue out of memory"),
        .state_json = std.fmt.allocPrint(queue, "{{\"start\":{d}}}", .{start}) catch @panic("command queue out of memory"),
        .start = start,
    } });
}

fn validateNativeRenderBackend() !void {
    const support = maplibre.supportedRenderBackends();
    std.debug.print("native render backends: metal={} opengl={} vulkan={}\n", .{ support.metal, support.opengl, support.vulkan });
    if (build_options.supports_metal and !support.metal) return error.NativeRenderBackendMismatch;
    if (build_options.supports_opengl and !support.opengl) return error.NativeRenderBackendMismatch;
    if (build_options.supports_vulkan and !support.vulkan) return error.NativeRenderBackendMismatch;
}
