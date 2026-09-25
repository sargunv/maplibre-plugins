const std = @import("std");
const maplibre = @import("maplibre_native_ffi");

const channel = @import("channel.zig");
const diagnostics = @import("diagnostics.zig");
const types = @import("types.zig");

/// Runtime and map, owned for their whole lifetime by the runtime loop thread.
pub const MapState = struct {
    allocator: std.mem.Allocator,
    options: *const types.Options,
    diagnostic_store: *maplibre.DiagnosticStore,
    runtime: maplibre.RuntimeHandle,
    map: maplibre.MapHandle,
    /// The latest layer JSON, re-added whenever a style finishes loading.
    layer_json: ?[]const u8 = null,
    layer_id: ?[]const u8 = null,
    style_loaded: bool = false,

    pub fn init(allocator: std.mem.Allocator, options: *const types.Options, viewport: types.Viewport) !MapState {
        const diagnostic_store = try allocator.create(maplibre.DiagnosticStore);
        diagnostic_store.* = maplibre.DiagnosticStore.init(allocator);
        errdefer {
            diagnostic_store.deinit();
            allocator.destroy(diagnostic_store);
        }

        var runtime = maplibre.RuntimeHandle.create(allocator, .{ .cache_path = ":memory:" }, diagnostic_store) catch |err| {
            diagnostics.logError("runtime create failed", err, diagnostic_store);
            return types.AppError.RuntimeCreateFailed;
        };
        errdefer runtime.close() catch {};

        var map = maplibre.MapHandle.create(&runtime, .{
            .width = viewport.logical_width,
            .height = viewport.logical_height,
            .scale_factor = viewport.scale_factor,
            .mode = .continuous,
        }) catch |err| {
            diagnostics.logError("map create failed", err, diagnostic_store);
            return types.AppError.MapCreateFailed;
        };
        errdefer map.close() catch {};

        map.setEventMask(.{
            .map_render_update_available = true,
            .map_render_frame_finished = true,
            .map_style_loaded = true,
        }) catch |err| {
            diagnostics.logError("event mask select failed", err, diagnostic_store);
            return types.AppError.EventMaskFailed;
        };
        map.setStyleUrl(allocator, options.style_url) catch |err| {
            diagnostics.logError("style load failed", err, diagnostic_store);
            return types.AppError.StyleLoadFailed;
        };
        map.jumpTo(.{
            .center = .{ .latitude = options.latitude, .longitude = options.longitude },
            .zoom = options.zoom,
            .bearing = options.bearing,
            .pitch = options.pitch,
        }) catch |err| {
            diagnostics.logError("camera jump failed", err, diagnostic_store);
            return types.AppError.CameraJumpFailed;
        };

        return .{
            .allocator = allocator,
            .options = options,
            .diagnostic_store = diagnostic_store,
            .runtime = runtime,
            .map = map,
        };
    }

    pub fn deinit(self: *MapState) void {
        if (self.layer_json) |json| self.allocator.free(json);
        if (self.layer_id) |id| self.allocator.free(id);
        self.map.close() catch {};
        self.runtime.close() catch {};
        self.diagnostic_store.deinit();
        self.allocator.destroy(self.diagnostic_store);
    }

    /// Applies every queued command on the map's owner thread.
    pub fn applyCommands(self: *MapState, commands: *channel.CommandQueue, batch: *std.ArrayList(channel.Command)) !void {
        commands.drainInto(batch);
        for (batch.items) |command| {
            defer channel.freeCommand(commands.allocator, command);
            try self.applyCommand(command);
        }
    }

    fn applyCommand(self: *MapState, command: channel.Command) !void {
        const map = &self.map;
        const store = self.diagnostic_store;
        switch (command) {
            .cancel_transitions => try expect(map.cancelTransitions(), "cancel camera transitions failed", store),
            .set_gesture_in_progress => |g| try expect(map.setGestureInProgress(g.in_progress), "set gesture failed", store),
            .move_by => |m| try expect(map.moveBy(m.dx, m.dy), "camera pan failed", store),
            .move_by_animated => |m| try expect(map.moveByAnimated(m.dx, m.dy, .{ .duration_ms = m.duration_ms }), "keyboard pan failed", store),
            .scale_by => |z| try expect(map.scaleBy(z.scale, z.anchor), "camera zoom failed", store),
            .scale_by_animated => |z| try expect(map.scaleByAnimated(z.scale, z.anchor, .{ .duration_ms = z.duration_ms }), "keyboard zoom failed", store),
            .pitch_by => |p| try expect(map.pitchBy(p.delta), "camera pitch failed", store),
            .adjust_bearing => |b| {
                const camera = try self.currentCamera();
                try expect(map.jumpTo(.{ .bearing = (camera.bearing orelse 0) + b.delta }), "camera rotate failed", store);
            },
            .adjust_bearing_animated => |b| {
                const camera = try self.currentCamera();
                try expect(map.easeTo(.{ .bearing = (camera.bearing orelse 0) + b.delta }, .{ .duration_ms = b.duration_ms }), "keyboard rotate failed", store);
            },
            .adjust_pitch_animated => |p| {
                const camera = try self.currentCamera();
                const pitch = std.math.clamp((camera.pitch orelse 0) + p.delta, 0.0, 60.0);
                try expect(map.easeTo(.{ .pitch = pitch }, .{ .duration_ms = p.duration_ms }), "keyboard pitch failed", store);
            },
            .reset_orientation => |r| try expect(map.easeTo(.{ .bearing = 0, .pitch = 0 }, .{ .duration_ms = r.duration_ms }), "camera reset failed", store),
            .apply_layer_json => |layer| try self.applyLayerJson(layer.json),
            .set_feature_state => |state| self.setFeatureState(state.source_id, state.feature_id, state.state_json, state.start),
        }
    }

    fn setFeatureState(self: *MapState, source_id: []const u8, feature_id: []const u8, state_json: []const u8, start: f64) void {
        self.map.setFeatureState(self.allocator, .{ .source_id = source_id, .feature_id = feature_id }, state_json) catch |err| {
            diagnostics.logError("set feature state failed", err, self.diagnostic_store);
            return;
        };
        std.debug.print("play-once {s}/{s} start={d}\n", .{ source_id, feature_id, start });
    }

    /// Stores the layer JSON and, once a style is live, adds the layer or
    /// updates its paint and layout properties in place so transitions run.
    fn applyLayerJson(self: *MapState, json: []const u8) !void {
        var parsed = std.json.parseFromSlice(std.json.Value, self.allocator, json, .{}) catch |err| {
            std.debug.print("layer JSON parse failed: {s} (keeping the previous layer)\n", .{@errorName(err)});
            return;
        };
        defer parsed.deinit();
        const object = switch (parsed.value) {
            .object => |o| o,
            else => {
                std.debug.print("layer JSON must be an object\n", .{});
                return;
            },
        };
        const id = switch (object.get("id") orelse .null) {
            .string => |s| s,
            else => {
                std.debug.print("layer JSON needs a string \"id\"\n", .{});
                return;
            },
        };

        const copy = try self.allocator.dupe(u8, json);
        if (self.layer_json) |old| self.allocator.free(old);
        self.layer_json = copy;
        if (self.layer_id == null or !std.mem.eql(u8, self.layer_id.?, id)) {
            if (self.layer_id) |old_id| {
                _ = self.map.removeStyleLayer(old_id) catch {};
                self.allocator.free(old_id);
            }
            self.layer_id = try self.allocator.dupe(u8, id);
        }
        if (!self.style_loaded) return;

        const exists = self.map.styleLayerExists(id) catch false;
        if (!exists) {
            self.addLayer();
            return;
        }
        var updated: usize = 0;
        for ([_][]const u8{ "paint", "layout" }) |section| {
            const properties = switch (object.get(section) orelse .null) {
                .object => |o| o,
                else => continue,
            };
            var it = properties.iterator();
            while (it.next()) |entry| {
                const value = try std.json.Stringify.valueAlloc(self.allocator, entry.value_ptr.*, .{});
                defer self.allocator.free(value);
                self.map.setLayerProperty(self.allocator, id, entry.key_ptr.*, value) catch |err| {
                    diagnostics.logError(entry.key_ptr.*, err, self.diagnostic_store);
                    continue;
                };
                updated += 1;
            }
        }
        std.debug.print("layer \"{s}\": updated {d} properties\n", .{ id, updated });
    }

    /// A new style has none of the `--geojson` sources yet; they go in before
    /// the layer that reads them.
    fn addSources(self: *MapState) void {
        for (self.options.geojson_sources) |source| {
            self.map.addStyleSourceJson(self.allocator, source.id, source.json) catch |err| {
                diagnostics.logError("add source failed", err, self.diagnostic_store);
                continue;
            };
            std.debug.print("source \"{s}\": added from {s}\n", .{ source.id, source.path });
        }
    }

    fn addLayer(self: *MapState) void {
        const json = self.layer_json orelse return;
        self.map.addStyleLayerJson(self.allocator, json, self.options.before_layer) catch |err| {
            diagnostics.logError("add layer failed", err, self.diagnostic_store);
            return;
        };
        std.debug.print("layer \"{s}\": added\n", .{self.layer_id orelse "?"});
    }

    /// Drains one batch of runtime events, reporting whether the map wants
    /// another frame.
    pub fn drainEvents(self: *MapState) !bool {
        const map_id = try self.map.id();
        var render_update_available = false;
        var batch = try self.runtime.drainEvents(self.allocator, 0);
        defer batch.deinit();
        for (0..batch.len()) |index| {
            const event = try batch.at(index);
            if (event.source_type != .map or event.source_id == null or !std.meta.eql(event.source_id.?, map_id)) continue;
            switch (event.event_type) {
                .map_style_loaded => {
                    // A new style has no layer yet; the stored JSON goes back in.
                    self.style_loaded = true;
                    self.addSources();
                    self.addLayer();
                    render_update_available = true;
                },
                .map_render_update_available => render_update_available = true,
                .map_render_frame_finished => switch (event.payload) {
                    .render_frame => |frame| render_update_available = render_update_available or frame.needs_repaint,
                    else => {},
                },
                else => {},
            }
        }
        return render_update_available;
    }

    fn currentCamera(self: *MapState) !maplibre.CameraOptions {
        return self.map.getCamera() catch |err| {
            diagnostics.logError("camera snapshot failed", err, self.diagnostic_store);
            return types.AppError.CameraCommandFailed;
        };
    }
};

fn expect(result: maplibre.Error!void, message: []const u8, store: *const maplibre.DiagnosticStore) !void {
    result catch |err| {
        diagnostics.logError(message, err, store);
        return types.AppError.CameraCommandFailed;
    };
}
