//! ffmpeg as a sidecar process: probing, snapshots, and the scramble/restore
//! pipeline (decode → veilcast_core → encode) with the frames pumped through
//! pipes. Nothing here touches Tauri; `lib.rs` wraps it in commands.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, Command, Stdio};
use std::sync::OnceLock;
use std::thread;

use serde::{Deserialize, Serialize};
use veilcast_core::{
    IntroHeader, MIRROR_SAMPLE_RATE, SYNC_CHIRP_LEAD, SpectrumMirror, Yuv420Layout, Yuv420Plan,
    block_frames, invert_yuv420_limited, reverse_blocks, seed_from_text, seeded_permutation,
    sync_chirp,
};

use crate::intro;

/// Tag written into scrambled files so restore can prefill the geometry.
/// The seed is deliberately not included.
const METADATA_PREFIX: &str = "veilcast/1";

/// Audio is pinned to 48 kHz so the block grid is the same number of samples
/// on both ends, whatever the source used; the spectrum mirror requires it too.
const AUDIO_RATE: u32 = MIRROR_SAMPLE_RATE;
/// One sample per channel, 16-bit: the transform only moves whole frames, so
/// the integer format costs nothing and halves the scratch file.
const AUDIO_SAMPLE_BYTES: usize = 2;

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

/// A hardware H.264 encoder ffmpeg can drive on this machine. The bundled
/// build lists all three whatever the hardware, so availability is settled by
/// test-encoding a frame, see [`hardware_encoder`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HwEncoder {
    Nvenc,
    Amf,
    Qsv,
}

impl HwEncoder {
    /// Detection order: with both present, a discrete NVIDIA card beats an AMD iGPU.
    const ALL: [Self; 3] = [Self::Nvenc, Self::Amf, Self::Qsv];

    pub fn codec(self) -> &'static str {
        match self {
            Self::Nvenc => "h264_nvenc",
            Self::Amf => "h264_amf",
            Self::Qsv => "h264_qsv",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Nvenc => "NVIDIA NVENC",
            Self::Amf => "AMD AMF",
            Self::Qsv => "Intel Quick Sync",
        }
    }

    /// Constant-quality settings matched to libx264 `medium` crf 16 on
    /// scrambled 2560×1376 content (10 s, VMAF against the source):
    /// x264 98.91 at 28.1 MB; NVENC p4 cq 19 98.81 at 25.2 MB and 3.5× the
    /// throughput; AMF cqp 17/19 on a Ryzen iGPU 98.10 at 27.7 MB. The QSV
    /// flags are ffmpeg's ICQ mode at a similar level and are unmeasured.
    fn args(self) -> &'static [&'static str] {
        match self {
            Self::Nvenc => &["-preset", "p4", "-rc", "vbr", "-cq", "19", "-b:v", "0"],
            Self::Amf => &[
                "-quality", "quality", "-rc", "cqp", "-qp_i", "17", "-qp_p", "19",
            ],
            Self::Qsv => &["-preset", "medium", "-global_quality", "19"],
        }
    }
}

/// The hardware encoder jobs use when asked to, or `None` for libx264.
/// Detected once per process: every candidate has to encode a frame with the
/// exact flags jobs use, because a listed encoder still fails without its
/// driver or GPU.
pub fn hardware_encoder(tools: &Tools) -> Option<HwEncoder> {
    static DETECTED: OnceLock<Option<HwEncoder>> = OnceLock::new();
    *DETECTED.get_or_init(|| {
        HwEncoder::ALL.into_iter().find(|encoder| {
            command(&tools.ffmpeg)
                .args([
                    "-v",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    "color=c=gray:s=256x256:r=30",
                ])
                .args([
                    "-frames:v",
                    "1",
                    "-pix_fmt",
                    "yuv420p",
                    "-c:v",
                    encoder.codec(),
                ])
                .args(encoder.args())
                .args(["-f", "null", "-"])
                .stdin(Stdio::null())
                .output()
                .is_ok_and(|output| output.status.success())
        })
    })
}

/// `-c:v` and its quality flags: the hardware encoder when one is given,
/// otherwise libx264.
fn video_codec_args(hw: Option<HwEncoder>) -> Vec<&'static str> {
    let mut args = vec!["-c:v"];
    match hw {
        Some(encoder) => {
            args.push(encoder.codec());
            args.extend(encoder.args());
        }
        None => args.extend(["libx264", "-preset", "medium", "-crf", "16"]),
    }
    args
}

/// Geometry recovered from a scrambled file's metadata tag; `width`/`height`
/// are the source size before padding.
#[derive(Debug, Clone, Serialize)]
pub struct PlanHint {
    pub width: usize,
    pub height: usize,
    pub tile: usize,
    pub margin: usize,
    pub invert: bool,
    /// Length of the QR intro at the start of the file, 0 when there is none.
    pub intro_ms: u32,
    /// Audio block length in milliseconds, 0 when the audio was left alone.
    /// Both the metadata tag and the intro QR code carry it.
    pub audio_ms: u32,
    /// The audio was spectrum-mirrored as well; absent from older files.
    pub audio_mirror: bool,
    /// Numeric seed carried by the intro QR code, as a decimal string.
    pub seed: Option<String>,
}

impl From<IntroHeader> for PlanHint {
    fn from(header: IntroHeader) -> Self {
        Self {
            width: header.width,
            height: header.height,
            tile: header.tile,
            margin: header.margin,
            invert: header.invert,
            intro_ms: (intro::INTRO_SECONDS * 1000.0) as u32,
            audio_ms: header.audio_ms,
            audio_mirror: header.audio_mirror,
            seed: header.seed.map(|seed| seed.to_string()),
        }
    }
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
    /// Channels in the first audio stream, 0 when the file has none.
    pub audio_channels: usize,
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
    let audio = streams.iter().find(|s| s["codec_type"] == "audio");
    let has_audio = audio.is_some();
    let audio_channels = audio.and_then(|s| s["channels"].as_u64()).unwrap_or(0) as usize;

    let text = |v: &serde_json::Value| v.as_str().map(str::to_string);
    let fps_rational = text(&video["r_frame_rate"]).unwrap_or_else(|| "30/1".into());
    let fps = parse_rational(&fps_rational).unwrap_or(30.0);
    let duration = text(&json["format"]["duration"])
        .and_then(|d| d.parse::<f64>().ok())
        .unwrap_or(0.0);
    let frames = text(&video["nb_frames"])
        .and_then(|n| n.parse::<u64>().ok())
        .unwrap_or_else(|| (duration * fps).round() as u64);
    let hint = text(&json["format"]["tags"]["comment"])
        .and_then(|c| parse_hint(&c))
        .or_else(|| read_intro(tools, path).map(PlanHint::from));

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
        audio_channels,
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
        invert: false,
        intro_ms: 0,
        audio_ms: 0,
        audio_mirror: false,
        seed: None,
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
            "intro" => hint.intro_ms = u32::try_from(value).ok()?,
            "audio" => hint.audio_ms = u32::try_from(value).ok()?,
            "invert" => hint.invert = flag(value)?,
            "mirror" => hint.audio_mirror = flag(value)?,
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

fn flag(value: usize) -> Option<bool> {
    match value {
        0 => Some(false),
        1 => Some(true),
        _ => None,
    }
}

/// Decodes one frame from the middle of the intro window as greyscale and
/// looks for the header QR code in it. `None` when there is no readable code.
pub fn read_intro(tools: &Tools, path: &str) -> Option<IntroHeader> {
    let seconds = intro::INTRO_SECONDS / 2.0;
    let output = command(&tools.ffmpeg)
        .args(["-v", "error", "-ss", &format!("{seconds:.3}"), "-i", path])
        .args([
            "-frames:v",
            "1",
            "-vf",
            r"scale=min(iw\,960):-2",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "gray",
            "-",
        ])
        .output()
        .ok()?;
    if !output.status.success() || output.stdout.is_empty() {
        return None;
    }
    // The scale filter keeps the aspect ratio, so recover the size from the byte count.
    let probe_dims = command(&tools.ffprobe)
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height",
            "-of",
            "csv=p=0",
        ])
        .arg(path)
        .output()
        .ok()?;
    let dims = String::from_utf8_lossy(&probe_dims.stdout);
    let (w, h) = dims.trim().split_once(',')?;
    let (src_w, src_h): (usize, usize) = (w.parse().ok()?, h.parse().ok()?);
    let width = src_w.min(960);
    let height = output.stdout.len() / width.max(1);
    if height == 0 || (src_h as f64 / src_w as f64 - height as f64 / width as f64).abs() > 0.05 {
        return None;
    }
    intro::read_frame(width, height, &output.stdout)
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
    /// Omitted by older clients: preserve the pre-inversion pipeline.
    #[serde(default)]
    pub invert: bool,
    /// Scramble: prepend the one-second QR intro. Restore: the input starts
    /// with such an intro, which is skipped.
    #[serde(default = "default_true")]
    pub intro: bool,
    /// Scramble only: write the numeric seed into the intro QR code, so
    /// anyone with the viewer can restore without being told the seed.
    #[serde(default)]
    pub seed_in_intro: bool,
    /// Audio block length in milliseconds; 0 leaves the audio untouched.
    /// The same value scrambles and restores, see [`scramble_audio`].
    #[serde(default)]
    pub audio_ms: u32,
    /// With `audio_ms`: also mirror the audio spectrum, see [`SpectrumMirror`].
    /// Omitted by older clients, and absent from older files: reversal only.
    #[serde(default)]
    pub audio_mirror: bool,
    /// Encode with the machine's hardware encoder (see [`hardware_encoder`]);
    /// falls back to libx264 when none initialises.
    #[serde(default)]
    pub gpu: bool,
}

fn default_true() -> bool {
    true
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
    pub intro_frames: u64,
    pub work: WorkSize,
    pub upload_width: usize,
    pub upload_height: usize,
    /// ffmpeg encoder name actually used, e.g. `libx264` or `h264_nvenc`.
    pub encoder: String,
    /// Audio block length applied, 0 when the audio was left alone (not
    /// requested, or the input has no audio track).
    pub audio_ms: u32,
    /// Whether the spectrum mirror ran as well.
    pub audio_mirror: bool,
}

/// A scratch file that is removed when the job holding it ends, either way.
pub struct TempFile(PathBuf);

impl TempFile {
    fn new(extension: &str) -> Result<Self, String> {
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let serial = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "veilcast-{}-{serial}.{extension}",
            std::process::id()
        ));
        Ok(Self(path))
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Reverses time inside fixed audio blocks and writes the result to a
/// temporary lossless file for the encoder to mux.
///
/// The transform is its own inverse, so scramble and restore differ only in
/// where the intro second goes: scrambling prepends it after the reversal,
/// restoring trims it before, which leaves the block grid anchored to the
/// content in both directions. Decoding to 16-bit PCM is lossless here
/// because only whole frames ever move.
///
/// With `mirror`, the [`SpectrumMirror`] runs after the reversal when
/// scrambling and before it when restoring, anchored at the content's first
/// sample like the block grid. In that order a viewer that has to find the
/// grid first can mirror back with a guessed anchor: a wrong guess only
/// rotates the phase of the whole track and the reversal's jumps stay put.
/// Loud, rhythmic content through a low-bitrate codec still defeats that
/// search, so a mirrored intro second carries [`sync_chirp`] instead of pure
/// silence. The mirror step is not lossless: it rounds back to 16 bits and
/// clips anything it pushes past full scale.
pub fn scramble_audio(
    tools: &Tools,
    input: &str,
    mode: Mode,
    block_ms: u32,
    mirror: bool,
    channels: usize,
    intro_seconds: Option<f64>,
) -> Result<TempFile, String> {
    let block = block_frames(block_ms, AUDIO_RATE);
    if block == 0 {
        return Err(format!("音频分块长度 {block_ms} ms 太短"));
    }
    if channels == 0 {
        return Err("音频流没有声道".into());
    }
    let frame_bytes = channels * AUDIO_SAMPLE_BYTES;
    let target = TempFile::new("flac")?;
    let rate = AUDIO_RATE.to_string();
    let channels_text = channels.to_string();

    let mut decoder = command(&tools.ffmpeg);
    decoder.args(["-v", "error", "-nostats", "-i", input, "-vn"]);
    if let (Some(seconds), Mode::Restore) = (intro_seconds, mode) {
        decoder.args([
            "-af",
            &format!("atrim=start={seconds},asetpts=PTS-STARTPTS"),
        ]);
    }
    decoder
        .args(["-f", "s16le", "-ar", &rate, "-ac", &channels_text, "-"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut encoder = command(&tools.ffmpeg);
    encoder.args([
        "-v",
        "error",
        "-nostats",
        "-f",
        "s16le",
        "-ar",
        &rate,
        "-ac",
        &channels_text,
        "-i",
        "-",
    ]);
    // A mirrored track writes its own intro second (silence and the sync chirp) below.
    if let (Some(seconds), Mode::Scramble, false) = (intro_seconds, mode, mirror) {
        encoder.args([
            "-af",
            &format!("adelay={}:all=1", (seconds * 1000.0) as u32),
        ]);
    }
    encoder
        .args(["-c:a", "flac", "-y"])
        .arg(target.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    let mut decoder = decoder
        .spawn()
        .map_err(|e| format!("无法启动音频解码 ffmpeg: {e}"))?;
    let mut encoder = encoder
        .spawn()
        .map_err(|e| format!("无法启动音频编码 ffmpeg: {e}"))?;
    let decoder_errors = drain_stderr(decoder.stderr.take());
    let encoder_errors = drain_stderr(encoder.stderr.take());
    let mut pcm_in = decoder.stdout.take().ok_or("音频解码器没有输出管道")?;
    let mut pcm_out = encoder.stdin.take().ok_or("音频编码器没有输入管道")?;

    // One block per read, so a whole block is always in hand; the short final
    // read is left unreversed by `reverse_blocks`.
    let block_bytes = block * frame_bytes;
    let mut buffer = vec![0u8; block_bytes];
    let mut mirror = if mirror {
        Some(SpectrumMirror::new(channels).map_err(|e| e.to_string())?)
    } else {
        None
    };
    let (mut samples, mut mirrored) = (Vec::new(), Vec::new());
    // Restoring with the mirror: its output lags, so it queues here until
    // whole blocks can be reversed.
    let mut queued = Vec::new();
    let pump = (|| -> Result<(), String> {
        if let (Some(seconds), Mode::Scramble, Some(_)) = (intro_seconds, mode, &mirror) {
            write_pcm(&mut pcm_out, &sync_intro(seconds, channels))?;
        }
        loop {
            let filled =
                fill(&mut pcm_in, &mut buffer).map_err(|e| format!("读取音频失败: {e}"))?;
            if filled == 0 {
                break;
            }
            let whole = filled - filled % frame_bytes;
            let chunk = &mut buffer[..whole];
            let Some(mirror) = mirror.as_mut() else {
                reverse_blocks(chunk, frame_bytes, block).map_err(|e| e.to_string())?;
                write_pcm(&mut pcm_out, chunk)?;
                continue;
            };
            if mode == Mode::Scramble {
                reverse_blocks(chunk, frame_bytes, block).map_err(|e| e.to_string())?;
            }
            pcm_to_f32(chunk, &mut samples);
            mirrored.clear();
            mirror
                .process(&samples, &mut mirrored)
                .map_err(|e| e.to_string())?;
            queued.extend(f32_to_pcm(&mirrored));
            if mode == Mode::Restore {
                let whole = queued.len() - queued.len() % block_bytes;
                reverse_blocks(&mut queued[..whole], frame_bytes, block)
                    .map_err(|e| e.to_string())?;
                write_pcm(&mut pcm_out, &queued[..whole])?;
                queued.drain(..whole);
            } else {
                write_pcm(&mut pcm_out, &queued)?;
                queued.clear();
            }
        }
        if let Some(mirror) = mirror.take() {
            mirrored.clear();
            mirror.finish(&mut mirrored);
            queued.extend(f32_to_pcm(&mirrored));
            if mode == Mode::Restore {
                // Whole blocks reversed, a trailing partial block as is.
                reverse_blocks(&mut queued, frame_bytes, block).map_err(|e| e.to_string())?;
            }
            write_pcm(&mut pcm_out, &queued)?;
        }
        Ok(())
    })();
    drop(pcm_out);
    let decoder_status = wait(&mut decoder);
    let encoder_status = wait(&mut encoder);
    let decoder_errors = decoder_errors.join().unwrap_or_default();
    let encoder_errors = encoder_errors.join().unwrap_or_default();
    if let Err(error) = pump {
        let details = [decoder_errors.trim(), encoder_errors.trim()]
            .into_iter()
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("; ");
        return Err(if details.is_empty() {
            error
        } else {
            format!("{error} ({details})")
        });
    }
    if !decoder_status {
        return Err(format!("音频解码失败: {}", decoder_errors.trim()));
    }
    if !encoder_status {
        return Err(format!("音频编码失败: {}", encoder_errors.trim()));
    }
    Ok(target)
}

/// The intro second of a mirrored track: silence with [`sync_chirp`] ending
/// [`SYNC_CHIRP_LEAD`] samples before the content, on every channel.
fn sync_intro(seconds: f64, channels: usize) -> Vec<u8> {
    let frames = (seconds * f64::from(AUDIO_RATE)).round() as usize;
    let mut intro = vec![0.0f32; frames * channels];
    let chirp = sync_chirp();
    let at = frames.saturating_sub(SYNC_CHIRP_LEAD);
    for (n, &value) in chirp.iter().enumerate().take(frames - at) {
        intro[(at + n) * channels..(at + n + 1) * channels].fill(value);
    }
    f32_to_pcm(&intro).collect()
}

fn write_pcm(out: &mut impl Write, bytes: &[u8]) -> Result<(), String> {
    out.write_all(bytes)
        .map_err(|e| format!("写入音频失败: {e}"))
}

fn pcm_to_f32(bytes: &[u8], samples: &mut Vec<f32>) {
    samples.clear();
    samples.extend(
        bytes
            .chunks_exact(AUDIO_SAMPLE_BYTES)
            .map(|b| f32::from(i16::from_le_bytes([b[0], b[1]])) / 32768.0),
    );
}

fn f32_to_pcm(samples: &[f32]) -> impl Iterator<Item = u8> + '_ {
    samples
        .iter()
        .flat_map(|&s| ((s * 32768.0).round().clamp(-32768.0, 32767.0) as i16).to_le_bytes())
}

/// Runs one scramble or restore job to completion, reporting progress as frames go through.
pub fn run_job(
    tools: &Tools,
    params: &JobParams,
    mut on_progress: impl FnMut(Progress),
) -> Result<JobResult, String> {
    let info = probe(tools, &params.input)?;
    if params.invert
        && matches!(
            info.color.transfer.as_deref(),
            Some("smpte2084" | "arib-std-b67")
        )
    {
        return Err("反色模式仅支持 SDR；请先将 HDR 视频转换为 SDR。".into());
    }
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
    let intro_frames = if params.intro {
        intro::frame_count(info.fps, intro::INTRO_SECONDS)
    } else {
        0
    };
    let audio_ms = if params.audio_ms > 0 && info.has_audio {
        params.audio_ms
    } else {
        0
    };
    let audio_mirror = audio_ms > 0 && params.audio_mirror;
    let intro_frame = if params.intro && params.mode == Mode::Scramble {
        let header = IntroHeader {
            width: params.width,
            height: params.height,
            tile: params.tile,
            margin: params.margin,
            invert: params.invert,
            audio_ms,
            audio_mirror,
            seed: params.seed_in_intro.then(|| seed_from_text(&params.seed)),
        };
        Some(intro::render_frame(&header, scrambled)?)
    } else {
        None
    };

    // Audio runs in its own pass and reaches the encoder as a temporary
    // lossless file, so the video pipe below stays exactly as it was.
    let audio_temp = if audio_ms > 0 {
        Some(scramble_audio(
            tools,
            &params.input,
            params.mode,
            audio_ms,
            audio_mirror,
            info.audio_channels,
            (intro_frames > 0).then_some(intro::INTRO_SECONDS),
        )?)
    } else {
        None
    };

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
            let name = format!(
                "{stem}.veilcast-t{}m{}{}.mp4",
                params.tile,
                params.margin,
                if params.invert { "-inv" } else { "" }
            );
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
    // Normalize BEFORE applying the limited-range complement. This also handles
    // platform transcodes that changed range; never interpret full-range bytes
    // as TV-range YUV. Keep the disabled path exactly as before.
    let decode_filter = if params.invert {
        format!("{decode_filter},scale=in_range=auto:out_range=tv,format=yuv420p")
    } else {
        decode_filter
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

    // The transformed track already carries the intro shift, so it is muxed
    // in place of the original input's audio.
    let audio_input = audio_temp.as_ref().map_or_else(
        || params.input.clone(),
        |temp| temp.path().to_string_lossy().into_owned(),
    );
    let hw = if params.gpu {
        hardware_encoder(tools)
    } else {
        None
    };
    let codec = hw.map_or("libx264", HwEncoder::codec);
    let mut encoder = command(&tools.ffmpeg);
    encoder
        .args(["-v", "error", "-nostats"])
        .args(["-f", "rawvideo", "-pix_fmt", "yuv420p"])
        .args([
            "-s",
            &format!("{}x{}", out_layout.width(), out_layout.height()),
        ])
        .args(["-framerate", &info.fps_rational, "-i", "-"])
        .args(["-i", &audio_input, "-map", "0:v", "-map", "1:a?"])
        .args(audio_args(params, intro_frames > 0, audio_temp.is_some()))
        .args(["-vf", &encode_filter])
        .args(video_codec_args(hw))
        .args(["-pix_fmt", "yuv420p"])
        .args(info.color.encoder_args())
        .args(["-movflags", "+faststart"]);
    if params.invert {
        encoder.args(["-color_range", "tv"]);
    }
    if params.mode == Mode::Scramble {
        encoder.args([
            "-metadata",
            &format!(
                "comment={METADATA_PREFIX} width={} height={} tile={} margin={} source={}x{} invert={} intro={} audio={} mirror={}",
                work.width,
                work.height,
                params.tile,
                params.margin,
                params.width,
                params.height,
                u8::from(params.invert),
                if intro_frames > 0 { (intro::INTRO_SECONDS * 1000.0) as u32 } else { 0 },
                audio_ms,
                u8::from(audio_mirror)
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
    let mut skipped = 0u64;
    let pump = (|| -> Result<(), String> {
        if let Some(frame) = &intro_frame {
            for _ in 0..intro_frames {
                frames_out
                    .write_all(frame)
                    .map_err(|e| format!("写入编码器失败: {e}"))?;
            }
        }
        while read_frame(&mut frames_in, &mut input).map_err(|e| format!("读取帧失败: {e}"))? {
            // The intro carries no picture; drop it on restore.
            if params.mode == Mode::Restore && skipped < intro_frames {
                skipped += 1;
                continue;
            }
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
            // Inversion commutes with tile copying. On restore, doing it after
            // discarding margins avoids processing pixels that will be thrown away.
            if params.invert {
                invert_yuv420_limited(out_layout, &mut output).map_err(|e| e.to_string())?;
            }
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

    if let Err(error) = pump {
        // A broken pipe usually means ffmpeg rejected its arguments; its own message is the useful one.
        let details = [decoder_errors.trim(), encoder_errors.trim()]
            .into_iter()
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("; ");
        return Err(if details.is_empty() {
            error
        } else {
            format!("{error} ({details})")
        });
    }
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
        intro_frames,
        work,
        upload_width: scrambled.width(),
        upload_height: scrambled.height(),
        encoder: codec.to_string(),
        audio_ms,
        audio_mirror,
    })
}

/// Audio is copied untouched unless the intro shifts the timeline: then it is
/// delayed (scramble) or trimmed (restore) by the intro length and re-encoded.
fn audio_args(params: &JobParams, intro: bool, transformed: bool) -> Vec<String> {
    let owned = |items: &[&str]| items.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    if transformed {
        // The separate pass already trimmed or delayed the track.
        return owned(&["-c:a", "aac", "-b:a", "192k"]);
    }
    if !intro {
        return owned(&["-c:a", "copy"]);
    }
    let ms = (intro::INTRO_SECONDS * 1000.0) as u32;
    let filter = match params.mode {
        Mode::Scramble => format!("adelay={ms}:all=1"),
        Mode::Restore => format!("atrim=start={},asetpts=PTS-STARTPTS", intro::INTRO_SECONDS),
    };
    owned(&["-af", &filter, "-c:a", "aac", "-b:a", "192k"])
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

/// Reads until the buffer is full or the stream ends; returns the bytes read.
fn fill(reader: &mut impl Read, buffer: &mut [u8]) -> std::io::Result<usize> {
    let mut filled = 0;
    while filled < buffer.len() {
        match reader.read(&mut buffer[filled..])? {
            0 => break,
            n => filled += n,
        }
    }
    Ok(filled)
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

#[cfg(test)]
mod tests {
    use super::{JobParams, parse_hint};

    #[test]
    fn inversion_hints_are_optional_and_strictly_boolean() {
        let legacy = "veilcast/1 width=80 height=48 tile=16 margin=4 source=78x46";
        let hint = parse_hint(legacy).unwrap();
        assert!(!hint.invert);
        assert_eq!((hint.width, hint.height), (78, 46));
        assert!(parse_hint(&format!("{legacy} invert=1")).unwrap().invert);
        assert!(!parse_hint(&format!("{legacy} invert=0")).unwrap().invert);
        assert!(parse_hint(&format!("{legacy} invert=2")).is_none());
    }

    #[test]
    fn files_without_a_mirror_tag_were_reversed_only() {
        let reversed = "veilcast/1 width=80 height=48 tile=16 margin=4 source=78x46 audio=50";
        let hint = parse_hint(reversed).unwrap();
        assert_eq!((hint.audio_ms, hint.audio_mirror), (50, false));
        assert!(
            parse_hint(&format!("{reversed} mirror=1"))
                .unwrap()
                .audio_mirror
        );
        assert!(parse_hint(&format!("{reversed} mirror=2")).is_none());
        let value = serde_json::json!({
            "input": "test.mp4", "outputDir": "", "mode": "restore",
            "width": 80, "height": 48, "tile": 16, "margin": 4, "seed": "42", "audioMs": 50
        });
        assert!(
            !serde_json::from_value::<JobParams>(value)
                .unwrap()
                .audio_mirror
        );
    }

    #[test]
    fn legacy_job_requests_default_inversion_to_off() {
        let mut value = serde_json::json!({
            "input": "test.mp4", "outputDir": "", "mode": "scramble",
            "width": 80, "height": 48, "tile": 16, "margin": 4, "seed": "42"
        });
        assert!(
            !serde_json::from_value::<JobParams>(value.clone())
                .unwrap()
                .invert
        );
        value["invert"] = true.into();
        assert!(
            serde_json::from_value::<JobParams>(value.clone())
                .unwrap()
                .invert
        );
        value["invert"] = "false".into();
        assert!(serde_json::from_value::<JobParams>(value).is_err());
    }
}
