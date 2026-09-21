//! Tauri shell around `veilcast_core`. Commands are the only surface the
//! frontend sees; keep them thin and let `ffmpeg.rs` and the core crate do
//! the work.

pub mod ffmpeg;
pub mod intro;

use serde::Serialize;
use tauri::ipc::{Channel, Response};
use veilcast_core::{Yuv420Layout, Yuv420Plan, seeded_permutation};

use ffmpeg::{JobParams, JobResult, Progress, Tools, VideoInfo, WorkSize};

/// The hardware encoder jobs use with "GPU" on, so the UI can name it up front.
#[derive(Debug, Serialize)]
struct EncoderInfo {
    codec: &'static str,
    label: &'static str,
}

#[tauri::command]
async fn hardware_encoder() -> Result<Option<EncoderInfo>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let tools = Tools::locate()?;
        Ok(ffmpeg::hardware_encoder(&tools).map(|encoder| EncoderInfo {
            codec: encoder.codec(),
            label: encoder.label(),
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Geometry the UI shows before scrambling: padding, grid and upload size.
#[derive(Debug, Serialize)]
struct PlanPreview {
    work: WorkSize,
    columns: usize,
    rows: usize,
    tile_count: usize,
    upload_width: usize,
    upload_height: usize,
}

/// Validates a tile/margin choice against a source size the same way the
/// scrambler will, so the UI can reject bad settings before touching ffmpeg.
#[tauri::command]
fn plan_preview(
    width: usize,
    height: usize,
    tile: usize,
    margin: usize,
) -> Result<PlanPreview, String> {
    let work = ffmpeg::fit(width, height, tile);
    let layout = Yuv420Layout::packed(work.width, work.height).map_err(|e| e.to_string())?;
    let columns = work.width / tile.max(1);
    let rows = work.height / tile.max(1);
    let permutation = seeded_permutation(columns * rows, 0);
    let plan =
        Yuv420Plan::new(layout, tile, tile, margin, &permutation).map_err(|e| e.to_string())?;
    let scrambled = plan.scrambled_layout();
    Ok(PlanPreview {
        work,
        columns,
        rows,
        tile_count: columns * rows,
        upload_width: scrambled.width(),
        upload_height: scrambled.height(),
    })
}

#[tauri::command]
async fn probe_video(path: String) -> Result<VideoInfo, String> {
    tauri::async_runtime::spawn_blocking(move || ffmpeg::probe(&Tools::locate()?, &path))
        .await
        .map_err(|e| e.to_string())?
}

/// One frame as PNG bytes; the frontend turns it into a blob URL.
#[tauri::command]
async fn snapshot(path: String, seconds: f64) -> Result<Response, String> {
    let png = tauri::async_runtime::spawn_blocking(move || {
        ffmpeg::snapshot(&Tools::locate()?, &path, seconds)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(Response::new(png))
}

/// A video handed to the app at launch: the first CLI argument (so "open
/// with" and dropping a file onto the executable work) or `VEILCAST_OPEN`.
#[tauri::command]
fn initial_file() -> Option<String> {
    std::env::args()
        .nth(1)
        .filter(|arg| !arg.starts_with('-'))
        .or_else(|| std::env::var("VEILCAST_OPEN").ok())
        .filter(|path| std::path::Path::new(path).is_file())
}

/// Scrambles or restores one file. Progress arrives on `on_progress` while
/// the job runs on a blocking thread; the result is the output path.
#[tauri::command]
async fn run_job(params: JobParams, on_progress: Channel<Progress>) -> Result<JobResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        ffmpeg::run_job(&Tools::locate()?, &params, |progress| {
            let _ = on_progress.send(progress);
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            plan_preview,
            initial_file,
            probe_video,
            snapshot,
            run_job,
            hardware_encoder
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
