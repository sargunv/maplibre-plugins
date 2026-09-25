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
    InputReadFailed,
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

/// A GeoJSON source from `--geojson <id>=<file>`. main fills `json`, the
/// source JSON with the file inlined as its data, before the map starts.
pub const GeoJsonSource = struct {
    id: []const u8,
    path: []const u8,
    json: []const u8 = "",
};

/// Scripted input from `--hover-at` or `--click-at`, fired `seconds` after the
/// first rendered frame at a logical-pixel point.
pub const ScriptedInput = struct {
    kind: enum { hover, click },
    x: f64,
    y: f64,
    seconds: f64,
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
    /// An app catalog registered through `catalog_entry_point` instead of
    /// `entry_point`.
    catalog_path: ?[]const u8 = null,
    catalog_entry_point: ?[]const u8 = null,
    /// Added on every style load, before the layer.
    geojson_sources: []const GeoJsonSource = &.{},
    /// The plugin's exported clock, `double(void)`.
    clock_symbol: ?[]const u8 = null,
    /// Hovering or clicking one of this source's features plays it once.
    play_once_source: ?[]const u8 = null,
    scripted_inputs: []const ScriptedInput = &.{},
    exit_after_seconds: ?f64 = null,
};
