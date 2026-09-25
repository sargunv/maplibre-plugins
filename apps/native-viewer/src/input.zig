const std = @import("std");
const maplibre = @import("maplibre_native_ffi");

const c = @import("c.zig").c;
const channel = @import("channel.zig");
const types = @import("types.zig");

const DragMode = enum { none, pan, rotate };

const keyboard_animation_ms = 160.0;
const reset_animation_ms = 220.0;
const click_slop = 4.0;

pub const Result = struct {
    handled: bool = false,
    camera_changed: bool = false,
    /// A left click that did not turn into a drag; the render loop queries
    /// rendered features there.
    click: ?maplibre.ScreenPoint = null,
    /// The pointer moved with no drag in progress; the render loop picks the
    /// feature under the latest point for hover play-once.
    hover: ?maplibre.ScreenPoint = null,
    reload_layer: bool = false,
};

/// Decodes host input into commands. Runs on the render loop, which does not
/// own the map, so it only queues commands for the runtime loop to apply.
pub const Controller = struct {
    drag_mode: DragMode = .none,
    drag_button: u8 = 0,
    last_x: f64 = 0,
    last_y: f64 = 0,
    press_x: f64 = 0,
    press_y: f64 = 0,
    moved: bool = false,

    pub fn handleEvent(self: *Controller, event: *const c.SDL_Event, commands: *channel.CommandQueue, viewport: types.Viewport) Result {
        return switch (event.type) {
            c.SDL_EVENT_MOUSE_BUTTON_DOWN => self.handleMouseButtonDown(event.button, commands, viewport),
            c.SDL_EVENT_MOUSE_BUTTON_UP => self.handleMouseButtonUp(event.button, commands, viewport),
            c.SDL_EVENT_MOUSE_MOTION => self.handleMouseMotion(event.motion, commands, viewport),
            c.SDL_EVENT_MOUSE_WHEEL => handleMouseWheel(event.wheel, commands, viewport),
            c.SDL_EVENT_KEY_DOWN => handleKeyDown(event.key, commands, viewport),
            else => .{},
        };
    }

    fn handleMouseButtonDown(self: *Controller, button: c.SDL_MouseButtonEvent, commands: *channel.CommandQueue, viewport: types.Viewport) Result {
        if (self.drag_mode != .none) return .{ .handled = true };
        const mode = dragModeForButton(button.button);
        if (mode == .none) return .{};
        const cursor = logicalPoint(button.x, button.y, viewport);
        self.last_x = cursor.x;
        self.last_y = cursor.y;
        self.press_x = cursor.x;
        self.press_y = cursor.y;
        self.moved = false;
        commands.push(.cancel_transitions);
        commands.push(.{ .set_gesture_in_progress = .{ .in_progress = true } });
        self.drag_mode = mode;
        self.drag_button = button.button;
        return .{ .handled = true };
    }

    fn handleMouseButtonUp(self: *Controller, button: c.SDL_MouseButtonEvent, commands: *channel.CommandQueue, viewport: types.Viewport) Result {
        if (button.button != c.SDL_BUTTON_LEFT and button.button != c.SDL_BUTTON_RIGHT) return .{};
        if (button.button != self.drag_button) return .{ .handled = true };
        const was_pan = self.drag_mode == .pan;
        self.endDrag(commands);
        const cursor = logicalPoint(button.x, button.y, viewport);
        self.last_x = cursor.x;
        self.last_y = cursor.y;
        const click = was_pan and !self.moved and @abs(cursor.x - self.press_x) < click_slop and @abs(cursor.y - self.press_y) < click_slop;
        return .{ .handled = true, .click = if (click) cursor else null };
    }

    fn endDrag(self: *Controller, commands: *channel.CommandQueue) void {
        if (self.drag_mode == .none) return;
        self.drag_mode = .none;
        self.drag_button = 0;
        commands.push(.{ .set_gesture_in_progress = .{ .in_progress = false } });
    }

    fn handleMouseMotion(self: *Controller, motion: c.SDL_MouseMotionEvent, commands: *channel.CommandQueue, viewport: types.Viewport) Result {
        const cursor = logicalPoint(motion.x, motion.y, viewport);
        const x = cursor.x;
        const y = cursor.y;
        defer {
            self.last_x = x;
            self.last_y = y;
        }
        const dx = x - self.last_x;
        const dy = y - self.last_y;
        switch (self.drag_mode) {
            .none => return .{ .hover = cursor },
            .pan => {
                if (dx == 0 and dy == 0) return .{ .handled = true };
                if (@abs(x - self.press_x) >= click_slop or @abs(y - self.press_y) >= click_slop) self.moved = true;
                commands.push(.{ .move_by = .{ .dx = dx, .dy = dy } });
            },
            .rotate => {
                if (dx == 0 and dy == 0) return .{ .handled = true };
                self.moved = true;
                commands.push(.{ .adjust_bearing = .{ .delta = dx * 0.5 } });
                commands.push(.{ .pitch_by = .{ .delta = dy / 2.0 } });
            },
        }
        return .{ .handled = true, .camera_changed = true };
    }
};

pub fn logControls(play_once_source: ?[]const u8) void {
    std.debug.print(
        \\Controls:
        \\  left drag: pan          right drag or Ctrl+left drag: rotate / pitch
        \\  click: query rendered features under the cursor
        \\  scroll: zoom at cursor  + / -: zoom at center
        \\  arrows or WASD: pan     Q / E: rotate   ] / [: pitch   0: reset orientation
        \\  R: reload the layer JSON now (it also reloads whenever the file changes)
        \\
    , .{});
    if (play_once_source) |source| std.debug.print(
        \\  hover: set {{"start": clock}} on the {s} feature under the cursor   click: set it again
        \\  (the icon plays once only if the layer reads ["feature-state", "start"], e.g. play-once.layer.json)
        \\
    , .{source});
}

fn handleMouseWheel(wheel: c.SDL_MouseWheelEvent, commands: *channel.CommandQueue, viewport: types.Viewport) Result {
    const delta: f64 = wheel.y;
    if (delta == 0) return .{ .handled = true };
    const anchor = logicalPoint(wheel.mouse_x, wheel.mouse_y, viewport);
    commands.push(.{ .scale_by = .{ .scale = std.math.pow(f64, 2.0, delta * 0.25), .anchor = anchor } });
    return .{ .handled = true, .camera_changed = true };
}

fn handleKeyDown(key: c.SDL_KeyboardEvent, commands: *channel.CommandQueue, viewport: types.Viewport) Result {
    const pan_step = 120.0;
    const zoom_step = 1.25;
    const bearing_step = 10.0;
    const pitch_step = 5.0;
    const center = maplibre.ScreenPoint{
        .x = @as(f64, @floatFromInt(viewport.logical_width)) / 2.0,
        .y = @as(f64, @floatFromInt(viewport.logical_height)) / 2.0,
    };
    switch (key.scancode) {
        scancode(c.SDL_SCANCODE_LEFT), scancode(c.SDL_SCANCODE_A) => commands.push(.{ .move_by_animated = .{ .dx = pan_step, .dy = 0, .duration_ms = keyboard_animation_ms } }),
        scancode(c.SDL_SCANCODE_RIGHT), scancode(c.SDL_SCANCODE_D) => commands.push(.{ .move_by_animated = .{ .dx = -pan_step, .dy = 0, .duration_ms = keyboard_animation_ms } }),
        scancode(c.SDL_SCANCODE_UP), scancode(c.SDL_SCANCODE_W) => commands.push(.{ .move_by_animated = .{ .dx = 0, .dy = pan_step, .duration_ms = keyboard_animation_ms } }),
        scancode(c.SDL_SCANCODE_DOWN), scancode(c.SDL_SCANCODE_S) => commands.push(.{ .move_by_animated = .{ .dx = 0, .dy = -pan_step, .duration_ms = keyboard_animation_ms } }),
        scancode(c.SDL_SCANCODE_EQUALS), scancode(c.SDL_SCANCODE_KP_PLUS) => commands.push(.{ .scale_by_animated = .{ .scale = zoom_step, .anchor = center, .duration_ms = keyboard_animation_ms } }),
        scancode(c.SDL_SCANCODE_MINUS), scancode(c.SDL_SCANCODE_KP_MINUS) => commands.push(.{ .scale_by_animated = .{ .scale = 1.0 / zoom_step, .anchor = center, .duration_ms = keyboard_animation_ms } }),
        scancode(c.SDL_SCANCODE_Q) => commands.push(.{ .adjust_bearing_animated = .{ .delta = -bearing_step, .duration_ms = keyboard_animation_ms } }),
        scancode(c.SDL_SCANCODE_E) => commands.push(.{ .adjust_bearing_animated = .{ .delta = bearing_step, .duration_ms = keyboard_animation_ms } }),
        scancode(c.SDL_SCANCODE_RIGHTBRACKET) => commands.push(.{ .adjust_pitch_animated = .{ .delta = pitch_step, .duration_ms = keyboard_animation_ms } }),
        scancode(c.SDL_SCANCODE_LEFTBRACKET) => commands.push(.{ .adjust_pitch_animated = .{ .delta = -pitch_step, .duration_ms = keyboard_animation_ms } }),
        scancode(c.SDL_SCANCODE_0) => commands.push(.{ .reset_orientation = .{ .duration_ms = reset_animation_ms } }),
        scancode(c.SDL_SCANCODE_R) => return .{ .handled = true, .reload_layer = true },
        else => return .{},
    }
    return .{ .handled = true, .camera_changed = true };
}

fn dragModeForButton(button: u8) DragMode {
    if (button == c.SDL_BUTTON_RIGHT) return .rotate;
    if (button != c.SDL_BUTTON_LEFT) return .none;
    if ((@as(c_uint, c.SDL_GetModState()) & c.SDL_KMOD_CTRL) != 0) return .rotate;
    return .pan;
}

fn logicalPoint(x: f64, y: f64, viewport: types.Viewport) maplibre.ScreenPoint {
    return .{
        .x = logicalCoordinate(x, viewport.window_width, viewport.logical_width),
        .y = logicalCoordinate(y, viewport.window_height, viewport.logical_height),
    };
}

fn logicalCoordinate(value: f64, window_size: u32, logical_size: u32) f64 {
    if (window_size == 0) return value;
    return value * @as(f64, @floatFromInt(logical_size)) / @as(f64, @floatFromInt(window_size));
}

fn scancode(value: c_int) c.SDL_Scancode {
    return @intCast(value);
}
