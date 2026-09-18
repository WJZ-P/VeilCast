//! ffmpeg as a sidecar process: probing, snapshots, and the scramble/restore
//! pipeline (decode → veilcast_core → encode) with the frames pumped through
//! pipes. Nothing here touches Tauri; `lib.rs` wraps it in commands.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, Command, Stdio};
use std::thread;

use serde::{Deserialize, Serialize};
use veilcast_core::{Yuv420Layout, Yuv420Plan, seed_from_text, seeded_permutation};

/// Tag written into scrambled files so restore can prefill the geometry.
/// The seed is deliberately not included.
const METADATA_PREFIX: &str = "veilcast/1";

pub struct Tools {
    ffmpeg: PathBuf,
    ffprobe: PathBuf,
}

impl Tools {
    /// Finds ffmpeg/ffprobe: `VEILCAST_FFMPEG_DIR`, next to the executable,
    /// the development checkout's `tools/ffmpeg`, then `PATH`.
    pub fn locate() -> Result<Self, String> {
        let mut candidates = Vec::new();
        if let Ok(dir) = std::env::var("VEILCAST_FFMPEG_DIR") {
            candidates.push(PathBuf::from(dir));
        }
        if let Some(dir) = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(Path::to_path_buf))
        {
            candidates.push(dir);
        }
        candidates.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tools/ffmpeg"));
        for dir in candidates {
            let tools = Self {
                ffmpeg: dir.join(exe_name("ffmpeg")),
                ffprobe: dir.join(exe_name("ffprobe")),
            };
            if tools.ffmpeg.is_file() && tools.ffprobe.is_file() {
                return Ok(tools);
            }
        }
        let tools = Self {
            ffmpeg: PathBuf::from(exe_name("ffmpeg")),
            ffprobe: PathBuf::from(exe_name("ffprobe")),
        };
        match command(&tools.ffprobe).arg("-version").output() {
            Ok(output) if output.status.success() => Ok(tools),
            _ => Err(
                "找不到 ffmpeg：请运行 scripts/fetch-ffmpeg.ps1，或设置 VEILCAST_FFMPEG_DIR".into(),
            ),
        }
    }
}

fn exe_name(base: &str) -> String {
    if cfg!(windows) {
        format!("{base}.exe")
    } else {
        base.to_string()
    }
}

fn command(program: &Path) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Keep child consoles from flashing up in front of the window.
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    command
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct ColorTags {
    range: Option<String>,
    space: Option<String>,
    primaries: Option<String>,
    transfer: Option<String>,
}

impl ColorTags {
    /// Encoder flags that re-tag raw frames with the source's colour metadata.
    fn encoder_args(&self) -> Vec<String> {
        let mut args = Vec::new();
        for (flag, value) in [
            ("-color_range", &self.range),
            ("-colorspace", &self.space),
            ("-color_primaries", &self.primaries),
            ("-color_trc", &self.transfer),
        ] {
            if let Some(value) = value.as_deref().filter(|v| *v != "unknown") {
                args.push(flag.to_string());
                args.push(value.to_string());
            }
        }
        args
    }
}

/// Geometry recovered from a scrambled file's metadata tag; `width`/`height`
/// are the source size before padding.
#[derive(Debug, Clone, Serialize)]
pub struct PlanHint {
    pub width: usize,
    pub height: usize,
    pub tile: usize,
    pub margin: usize,
}

/// The frame size the plan runs on: the source padded up to a multiple of the
/// tile on the right and bottom edges (replicated edge pixels), and cropped
/// back after restore. This is how any source size fits a strict tile grid.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct WorkSize {
    pub width: usize,
    pub height: usize,
    pub pad_right: usize,
    pub pad_bottom: usize,
}

pub fn fit(source_width: usize, source_height: usize, tile: usize) -> WorkSize {
    let tile = tile.max(1);
    let width = source_width.div_ceil(tile) * tile;
    let height = source_height.div_ceil(tile) * tile;
    WorkSize {
        width,
        height,
        pad_right: width - source_width,
        pad_bottom: height - source_height,
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct VideoInfo {
    pub path: String,
    pub width: usize,
    pub height: usize,
    pub fps: f64,
    fps_rational: String,
    pub duration: f64,
    pub frames: u64,
    pub codec: String,
    pub has_audio: bool,
    color: ColorTags,
    pub hint: Option<PlanHint>,
}

pub fn probe(tools: &Tools, path: &str) -> Result<VideoInfo, String> {
    let output = command(&tools.ffprobe)
        .args([
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
        ])
        .arg(path)
        .output()
        .map_err(|e| format!("无法启动 ffprobe: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "ffprobe 失败: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let json: serde_json::Value =
        serde_json::from_slice(&output.stdout).map_err(|e| format!("ffprobe 输出无法解析: {e}"))?;
    let streams = json["streams"].as_array().cloned().unwrap_or_default();
    let video = streams
        .iter()
        .find(|s| s["codec_type"] == "video")
        .ok_or("文件里没有视频流")?;
    let has_audio = streams.iter().any(|s| s["codec_type"] == "audio");

    let text = |v: &serde_json::Value| v.as_str().map(str::to_string);
    let fps_rational = text(&video["r_frame_rate"]).unwrap_or_else(|| "30/1".into());
    let fps = parse_rational(&fps_rational).unwrap_or(30.0);
    let duration = text(&json["format"]["duration"])
        .and_then(|d| d.parse::<f64>().ok())
        .unwrap_or(0.0);
    let frames = text(&video["nb_frames"])
        .and_then(|n| n.parse::<u64>().ok())
        .unwrap_or_else(|| (duration * fps).round() as u64);
    let hint = text(&json["format"]["tags"]["comment"]).and_then(|c| parse_hint(&c));

    Ok(VideoInfo {
        path: path.to_string(),
        width: video["width"].as_u64().ok_or("缺少宽度")? as usize,
        height: video["height"].as_u64().ok_or("缺少高度")? as usize,
        fps,
        fps_rational,
        duration,
        frames,
        codec: text(&video["codec_name"]).unwrap_or_default(),
        has_audio,
        color: ColorTags {
            range: text(&video["color_range"]),
            space: text(&video["color_space"]),
            primaries: text(&video["color_primaries"]),
            transfer: text(&video["color_transfer"]),
        },
        hint,
    })
}

fn parse_rational(text: &str) -> Option<f64> {
    let (num, den) = text.split_once('/')?;
    let num: f64 = num.parse().ok()?;
    let den: f64 = den.parse().ok()?;
    (den != 0.0).then(|| num / den)
}

fn parse_hint(comment: &str) -> Option<PlanHint> {
    let rest = comment.strip_prefix(METADATA_PREFIX)?;
    let mut hint = PlanHint {
        width: 0,
        height: 0,
        tile: 0,
        margin: 0,
    };
    let mut source = None;
    for pair in rest.split_whitespace() {
        let (key, value) = pair.split_once('=')?;
        if key == "source" {
            let (w, h) = value.split_once('x')?;
            source = Some((w.parse().ok()?, h.parse().ok()?));
            continue;
        }
        let value = value.parse().ok()?;
        match key {
            "width" => hint.width = value,
            "height" => hint.height = value,
            "tile" => hint.tile = value,
            "margin" => hint.margin = value,
            _ => {}
        }
    }
    // `width`/`height` in the tag are the padded work size; prefer the source size.
    if let Some((width, height)) = source {
        hint.width = width;
        hint.height = height;
    }
    (hint.width > 0 && hint.height > 0 && hint.tile > 0).then_some(hint)
}

/// One frame of `path` at `seconds`, as PNG bytes scaled to at most 480px tall.
pub fn snapshot(tools: &Tools, path: &str, seconds: f64) -> Result<Vec<u8>, String> {
    let output = command(&tools.ffmpeg)
        .args(["-v", "error", "-ss", &format!("{seconds:.3}"), "-i", path])
        .args([
            "-frames:v",
            "1",
            "-vf",
            "scale=-2:min(ih\\,480)",
            "-f",
            "image2pipe",
            "-c:v",
            "png",
            "-",
        ])
        .output()
        .map_err(|e| format!("无法启动 ffmpeg: {e}"))?;
    if !output.status.success() || output.stdout.is_empty() {
        return Err(format!(
            "截图失败: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(output.stdout)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Scramble,
    Restore,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobParams {
    pub input: String,
    pub output_dir: String,
    pub mode: Mode,
    /// Original (unscrambled) frame size; for restore this is the size to recover.
    pub width: usize,
    pub height: usize,
    pub tile: usize,
    pub margin: usize,
    /// Text seed, see `veilcast_core::seed_from_text`.
    pub seed: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Progress {
    pub done: u64,
    pub total: u64,
}

#[derive(Debug, Serialize)]
pub struct JobResult {
    pub output: String,
    pub frames: u64,
    pub work: WorkSize,
    pub upload_width: usize,
    pub upload_height: usize,
}

/// Runs one scramble or restore job to completion, reporting progress as frames go through.
pub fn run_job(
    tools: &Tools,
    params: &JobParams,
    mut on_progress: impl FnMut(Progress),
) -> Result<JobResult, String> {
    let info = probe(tools, &params.input)?;
    // The plan runs on the padded work size; `params.width/height` is the source size.
    let work = fit(params.width, params.height, params.tile);
    let layout = Yuv420Layout::packed(work.width, work.height).map_err(|e| e.to_string())?;
    let tile_count = (work.width / params.tile.max(1)) * (work.height / params.tile.max(1));
    let permutation = seeded_permutation(tile_count, seed_from_text(&params.seed));
    let plan = Yuv420Plan::new(
        layout,
        params.tile,
        params.tile,
        params.margin,
        &permutation,
    )
    .map_err(|e| e.to_string())?;
    let original = plan.original_layout();
    let scrambled = plan.scrambled_layout();

    let stem = Path::new(&params.input)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("video");
    // Decoder filter brings the input to the plan's input size: scramble pads
    // the source with replicated edge pixels, restore scales a possibly
    // platform-rescaled upload back to its exact size. The encoder filter
    // crops restored frames back to the source size.
    let (in_layout, out_layout, output_name, decode_filter, encode_filter) = match params.mode {
        Mode::Scramble => {
            if (info.width, info.height) != (params.width, params.height) {
                return Err(format!(
                    "视频是 {}×{}，参数里的原始尺寸是 {}×{}",
                    info.width, info.height, params.width, params.height
                ));
            }
            let name = format!("{stem}.veilcast-t{}m{}.mp4", params.tile, params.margin);
            let pad = if work.pad_right == 0 && work.pad_bottom == 0 {
                "null".to_string()
            } else {
                format!(
                    "pad={}:{}:0:0,fillborders=right={}:bottom={}:mode=smear",
                    work.width, work.height, work.pad_right, work.pad_bottom
                )
            };
            (original, scrambled, name, pad, "null".to_string())
        }
        Mode::Restore => {
            let stem = stem.split(".veilcast-").next().unwrap_or(stem);
            let scale = format!(
                "scale={}:{}:flags=bicubic",
                scrambled.width(),
                scrambled.height()
            );
            let crop = format!("crop={}:{}:0:0", params.width, params.height);
            (
                scrambled,
                original,
                format!("{stem}.restored.mp4"),
                scale,
                crop,
            )
        }
    };
    // An empty output directory means "next to the input".
    let output_dir = if params.output_dir.trim().is_empty() {
        Path::new(&params.input)
            .parent()
            .map(Path::to_path_buf)
            .ok_or("无法确定输入文件所在目录")?
    } else {
        PathBuf::from(&params.output_dir)
    };
    if !output_dir.is_dir() {
        return Err(format!("输出目录不存在: {}", output_dir.display()));
    }
    let output_path = output_dir.join(output_name);

    // Decoder: raw yuv420p frames at the plan's input size. Restore inputs may
    // have been rescaled by a platform, so they are scaled back to the upload size.
    let mut decoder = command(&tools.ffmpeg);
    decoder
        .args(["-v", "error", "-nostats", "-i", &params.input])
        .args(["-vf", &decode_filter])
        .args(["-f", "rawvideo", "-pix_fmt", "yuv420p", "-"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut encoder = command(&tools.ffmpeg);
    encoder
        .args(["-v", "error", "-nostats"])
        .args(["-f", "rawvideo", "-pix_fmt", "yuv420p"])
        .args([
            "-s",
            &format!("{}x{}", out_layout.width(), out_layout.height()),
        ])
        .args(["-framerate", &info.fps_rational, "-i", "-"])
        .args([
            "-i",
            &params.input,
            "-map",
            "0:v",
            "-map",
            "1:a?",
            "-c:a",
            "copy",
        ])
        .args(["-vf", &encode_filter])
        .args([
            "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p",
        ])
        .args(info.color.encoder_args())
        .args(["-movflags", "+faststart"]);
    if params.mode == Mode::Scramble {
        encoder.args([
            "-metadata",
            &format!(
                "comment={METADATA_PREFIX} width={} height={} tile={} margin={} source={}x{}",
                work.width, work.height, params.tile, params.margin, params.width, params.height
            ),
        ]);
    }
    encoder
        .arg("-y")
        .arg(&output_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    let mut decoder = decoder
        .spawn()
        .map_err(|e| format!("无法启动解码 ffmpeg: {e}"))?;
    let mut encoder = encoder
        .spawn()
        .map_err(|e| format!("无法启动编码 ffmpeg: {e}"))?;
    let decoder_errors = drain_stderr(decoder.stderr.take());
    let encoder_errors = drain_stderr(encoder.stderr.take());
    let mut frames_in = decoder.stdout.take().ok_or("解码器没有输出管道")?;
    let mut frames_out = encoder.stdin.take().ok_or("编码器没有输入管道")?;

    let mut input = vec![0u8; in_layout.buffer_len()];
    let mut output = vec![0u8; out_layout.buffer_len()];
    let total = info.frames.max(1);
    let mut done = 0u64;
    let pump = (|| -> Result<(), String> {
        while read_frame(&mut frames_in, &mut input).map_err(|e| format!("读取帧失败: {e}"))? {
            let result = match params.mode {
                Mode::Scramble => plan.scramble(
                    original.split(&input).map_err(|e| e.to_string())?,
                    scrambled
                        .split_mut(&mut output)
                        .map_err(|e| e.to_string())?,
                ),
                Mode::Restore => plan.restore(
                    scrambled.split(&input).map_err(|e| e.to_string())?,
                    original.split_mut(&mut output).map_err(|e| e.to_string())?,
                ),
            };
            result.map_err(|e| e.to_string())?;
            frames_out
                .write_all(&output)
                .map_err(|e| format!("写入编码器失败: {e}"))?;
            done += 1;
            if done.is_multiple_of(10) || done == total {
                on_progress(Progress {
                    done,
                    total: total.max(done),
                });
            }
        }
        Ok(())
    })();
    // Close both pipes before waiting: the encoder finishes its file on EOF, and
    // a decoder still running after an error exits once its reader is gone.
    drop(frames_out);
    drop(frames_in);
    let decoder_status = wait(&mut decoder);
    let encoder_status = wait(&mut encoder);
    let decoder_errors = decoder_errors.join().unwrap_or_default();
    let encoder_errors = encoder_errors.join().unwrap_or_default();

    pump?;
    if !decoder_status {
        return Err(format!("解码失败: {}", decoder_errors.trim()));
    }
    if !encoder_status {
        return Err(format!("编码失败: {}", encoder_errors.trim()));
    }
    on_progress(Progress { done, total: done });
    Ok(JobResult {
        output: output_path.to_string_lossy().into_owned(),
        frames: done,
        work,
        upload_width: scrambled.width(),
        upload_height: scrambled.height(),
    })
}

fn drain_stderr(stderr: Option<ChildStderr>) -> thread::JoinHandle<String> {
    thread::spawn(move || {
        let mut text = String::new();
        if let Some(mut stderr) = stderr {
            let _ = stderr.read_to_string(&mut text);
        }
        text
    })
}

fn wait(child: &mut Child) -> bool {
    child.wait().map(|status| status.success()).unwrap_or(false)
}

/// Fills `frame` completely, or returns `Ok(false)` on a clean end of stream.
fn read_frame(reader: &mut impl Read, frame: &mut [u8]) -> std::io::Result<bool> {
    let mut filled = 0;
    while filled < frame.len() {
        let n = reader.read(&mut frame[filled..])?;
        if n == 0 {
            if filled == 0 {
                return Ok(false);
            }
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                format!("truncated frame: {filled} of {} bytes", frame.len()),
            ));
        }
        filled += n;
    }
    Ok(true)
}
