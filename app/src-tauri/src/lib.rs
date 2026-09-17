//! Tauri shell around `veilcast_core`. Commands are the only surface the
//! frontend sees; keep them thin and let the core crate do the work.

use serde::Serialize;
use veilcast_core::{Yuv420Layout, Yuv420Plan, seeded_permutation};

/// Geometry the UI shows before scrambling: how large the upload will be.
#[derive(Debug, Serialize)]
struct PlanPreview {
    columns: usize,
    rows: usize,
    tile_count: usize,
    upload_width: usize,
    upload_height: usize,
}

/// Validates a tile/margin choice against a frame size the same way the
/// scrambler will, so the UI can reject bad settings before touching ffmpeg.
#[tauri::command]
fn plan_preview(
    width: usize,
    height: usize,
    tile: usize,
    margin: usize,
) -> Result<PlanPreview, String> {
    let layout = Yuv420Layout::packed(width, height).map_err(|e| e.to_string())?;
    let columns = width / tile.max(1);
    let rows = height / tile.max(1);
    let permutation = seeded_permutation(columns * rows, 0);
    let plan =
        Yuv420Plan::new(layout, tile, tile, margin, &permutation).map_err(|e| e.to_string())?;
    let scrambled = plan.scrambled_layout();
    Ok(PlanPreview {
        columns,
        rows,
        tile_count: columns * rows,
        upload_width: scrambled.width(),
        upload_height: scrambled.height(),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![plan_preview])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
