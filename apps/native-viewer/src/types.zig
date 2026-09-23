pub const AppError = error{
    InvalidArguments,
    SdlInitFailed,
    WindowCreateFailed,
    RuntimeCreateFailed,
    MapCreateFailed,
    EventMaskFailed,
    StyleLoadFailed,
    LayerApplyFailed,
    CameraJumpFailed,
    CameraCommandFailed,
    SurfaceAttachFailed,
    SurfaceResizeFailed,
    SurfaceRenderFailed,
    BackendSetupFailed,
    BackendDrawFailed,
    PluginLoadFailed,
};

pub const Viewport = struct {
    logical_width: u32,
    logical_height: u32,
    window_width: u32,
    window_height: u32,
    physical_width: u32,
    physical_height: u32,
    scale_factor: f64,
};

/// Command-line options; strings are owned by the arena in main.
pub const Options = struct {
    plugin_path: []const u8,
    entry_point: []const u8,
    layer_path: []const u8,
    style_url: []const u8 = "https://tiles.openfreemap.org/styles/bright",
    before_layer: []const u8 = "",
    latitude: f64 = 37.7749,
    longitude: f64 = -122.4194,
    zoom: f64 = 13.0,
    bearing: f64 = 12.0,
    pitch: f64 = 30.0,
};
