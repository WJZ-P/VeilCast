//! End-to-end scramble → restore through real ffmpeg processes.
//! Skips (passes) when ffmpeg or the sample clip is not available.

use std::path::Path;

use veilcast_app_lib::ffmpeg::{
    JobParams, Mode, Tools, WorkSize, fit, hardware_encoder, probe, run_job,
};

const SAMPLE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../target/experiment/d49672a5defc39413b8979e3dfb5f134-yuv420p/source.mp4"
);

#[test]
fn fit_pads_up_to_the_next_tile_multiple() {
    let work = |w, h, pr, pb| WorkSize {
        width: w,
        height: h,
        pad_right: pr,
        pad_bottom: pb,
    };
    assert_eq!(fit(1920, 1080, 40), work(1920, 1080, 0, 0));
    assert_eq!(fit(1920, 1078, 40), work(1920, 1080, 0, 2));
    assert_eq!(fit(1920, 1078, 16), work(1920, 1088, 0, 10));
    assert_eq!(fit(1366, 768, 40), work(1400, 800, 34, 32));
    assert_eq!(fit(720, 1274, 40), work(720, 1280, 0, 6));
    assert_eq!(fit(100, 100, 0), work(100, 100, 0, 0));
}

#[test]
fn padded_sources_scramble_to_the_work_size_and_restore_to_the_source_size() {
    let Ok(tools) = Tools::locate() else {
        eprintln!("skipped: ffmpeg not found");
        return;
    };
    if !Path::new(SAMPLE).is_file() {
        eprintln!("skipped: sample clip not found at {SAMPLE}");
        return;
    }
    let out_dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join("pipeline-padded");
    std::fs::create_dir_all(&out_dir).unwrap();
    let out_dir_str = out_dir.to_string_lossy().into_owned();

    // 720×1274 does not divide by 40: six rows of padding are needed.
    let odd = out_dir.join("odd.mp4");
    let status = std::process::Command::new(tools_ffmpeg())
        .args([
            "-v",
            "error",
            "-y",
            "-i",
            SAMPLE,
            "-vf",
            "crop=720:1274:0:0",
            "-c:v",
            "libx264",
            "-crf",
            "18",
            "-an",
        ])
        .arg(&odd)
        .status()
        .unwrap();
    assert!(status.success());
    let odd = odd.to_string_lossy().into_owned();
    let info = probe(&tools, &odd).unwrap();
    assert_eq!((info.width, info.height), (720, 1274));

    let params = |input: &str, mode| JobParams {
        input: input.to_string(),
        output_dir: out_dir_str.clone(),
        mode,
        width: 720,
        height: 1274,
        tile: 40,
        margin: 0,
        seed: "pad".into(),
        invert: false,
        intro: false,
        seed_in_intro: false,
        gpu: false,
        audio_ms: 0,
        audio_mirror: false,
    };
    let scrambled = run_job(&tools, &params(&odd, Mode::Scramble), |_| {}).unwrap();
    assert_eq!(scrambled.work, fit(720, 1274, 40));
    assert_eq!(
        (scrambled.upload_width, scrambled.upload_height),
        (720, 1280)
    );
    let scrambled_info = probe(&tools, &scrambled.output).unwrap();
    assert_eq!((scrambled_info.width, scrambled_info.height), (720, 1280));
    let hint = scrambled_info.hint.expect("hint");
    assert_eq!(
        (hint.width, hint.height, hint.tile, hint.margin),
        (720, 1274, 40, 0)
    );

    let restored = run_job(&tools, &params(&scrambled.output, Mode::Restore), |_| {}).unwrap();
    let restored_info = probe(&tools, &restored.output).unwrap();
    assert_eq!((restored_info.width, restored_info.height), (720, 1274));
    assert_eq!(restored.frames, info.frames);
}

fn tools_ffmpeg() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tools/ffmpeg/ffmpeg.exe")
}

#[test]
fn scramble_then_restore_round_trips_through_ffmpeg() {
    let Ok(tools) = Tools::locate() else {
        eprintln!("skipped: ffmpeg not found");
        return;
    };
    if !Path::new(SAMPLE).is_file() {
        eprintln!("skipped: sample clip not found at {SAMPLE}");
        return;
    }
    let out_dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join("pipeline");
    std::fs::create_dir_all(&out_dir).unwrap();
    let out_dir_str = out_dir.to_string_lossy().into_owned();

    let info = probe(&tools, SAMPLE).unwrap();
    assert_eq!((info.width, info.height), (720, 1280));
    assert!(info.has_audio);
    assert!(info.hint.is_none());

    let params = |input: &str, mode| JobParams {
        input: input.to_string(),
        output_dir: out_dir_str.clone(),
        mode,
        width: 720,
        height: 1280,
        tile: 16,
        margin: 4,
        seed: "veilcast".into(),
        invert: false,
        intro: false,
        seed_in_intro: false,
        gpu: false,
        audio_ms: 0,
        audio_mirror: false,
    };

    let mut progress = Vec::new();
    let scrambled = run_job(&tools, &params(SAMPLE, Mode::Scramble), |p| {
        progress.push(p)
    })
    .unwrap();
    assert_eq!(scrambled.frames, info.frames);
    assert_eq!(
        (scrambled.upload_width, scrambled.upload_height),
        (1080, 1920)
    );
    assert!(scrambled.output.ends_with("source.veilcast-t16m4.mp4"));
    assert!(
        progress
            .last()
            .is_some_and(|p| p.done == p.total && p.total == info.frames)
    );

    let scrambled_info = probe(&tools, &scrambled.output).unwrap();
    assert_eq!((scrambled_info.width, scrambled_info.height), (1080, 1920));
    assert!(scrambled_info.has_audio, "audio track must be copied");
    let hint = scrambled_info
        .hint
        .expect("scrambled file carries the plan geometry");
    assert_eq!(
        (hint.width, hint.height, hint.tile, hint.margin),
        (720, 1280, 16, 4)
    );

    let restored = run_job(&tools, &params(&scrambled.output, Mode::Restore), |_| {}).unwrap();
    assert_eq!(restored.frames, info.frames);
    assert!(restored.output.ends_with("source.restored.mp4"));
    let restored_info = probe(&tools, &restored.output).unwrap();
    assert_eq!((restored_info.width, restored_info.height), (720, 1280));

    // Wrong original size must be rejected before any ffmpeg is spawned.
    let mut wrong = params(SAMPLE, Mode::Scramble);
    wrong.width = 1440;
    let error = run_job(&tools, &wrong, |_| {}).unwrap_err();
    assert!(error.contains("720×1280"), "{error}");
}

#[test]
fn intro_qr_survives_metadata_loss_and_a_low_resolution_transcode() {
    let Ok(tools) = Tools::locate() else {
        eprintln!("skipped: ffmpeg not found");
        return;
    };
    if !Path::new(SAMPLE).is_file() {
        eprintln!("skipped: sample clip not found at {SAMPLE}");
        return;
    }
    let out_dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join("pipeline-intro");
    std::fs::create_dir_all(&out_dir).unwrap();
    let out_dir_str = out_dir.to_string_lossy().into_owned();
    let info = probe(&tools, SAMPLE).unwrap();

    let params = |input: &str, mode, seed_in_intro| JobParams {
        input: input.to_string(),
        output_dir: out_dir_str.clone(),
        mode,
        width: 720,
        height: 1280,
        tile: 40,
        margin: 0,
        seed: "veilcast".into(),
        invert: false,
        intro: true,
        seed_in_intro,
        gpu: false,
        audio_ms: 0,
        audio_mirror: false,
    };

    // Scramble with a one-second intro carrying the seed.
    let scrambled = run_job(&tools, &params(SAMPLE, Mode::Scramble, true), |_| {}).unwrap();
    assert_eq!(scrambled.intro_frames, 30);
    assert_eq!(scrambled.frames, info.frames);
    let scrambled_info = probe(&tools, &scrambled.output).unwrap();
    assert_eq!(scrambled_info.frames, info.frames + 30);
    assert!(
        scrambled_info.has_audio,
        "delayed audio must be re-encoded, not dropped"
    );
    assert!((scrambled_info.duration - info.duration - 1.0).abs() < 0.15);
    let hint = scrambled_info.hint.expect("metadata hint");
    assert_eq!(
        (
            hint.width,
            hint.height,
            hint.tile,
            hint.margin,
            hint.intro_ms
        ),
        (720, 1280, 40, 0, 1000)
    );

    // Strip the container metadata, as a platform would: the QR intro is now the only source.
    let stripped = out_dir.join("stripped.mp4");
    assert!(
        std::process::Command::new(tools_ffmpeg())
            .args([
                "-v",
                "error",
                "-y",
                "-i",
                &scrambled.output,
                "-map_metadata",
                "-1",
                "-c",
                "copy"
            ])
            .arg(&stripped)
            .status()
            .unwrap()
            .success()
    );
    let stripped = stripped.to_string_lossy().into_owned();
    let hint = probe(&tools, &stripped)
        .unwrap()
        .hint
        .expect("hint from the QR intro");
    assert_eq!(
        (
            hint.width,
            hint.height,
            hint.tile,
            hint.margin,
            hint.invert,
            hint.intro_ms
        ),
        (720, 1280, 40, 0, false, 1000)
    );
    assert_eq!(
        hint.seed.as_deref(),
        Some("9859592623650262946"),
        "seed_from_text(\"veilcast\")"
    );

    // Restore from the stripped file: the intro is skipped and the picture returns to 720×1280.
    let restored = run_job(&tools, &params(&stripped, Mode::Restore, false), |_| {}).unwrap();
    assert_eq!(restored.frames, info.frames);
    let restored_info = probe(&tools, &restored.output).unwrap();
    assert_eq!(
        (
            restored_info.width,
            restored_info.height,
            restored_info.frames
        ),
        (720, 1280, info.frames)
    );
    assert!((restored_info.duration - info.duration).abs() < 0.15);

    // A platform-style transcode to 360p at a low bitrate must still leave the QR readable.
    let low = out_dir.join("low.mp4");
    assert!(
        std::process::Command::new(tools_ffmpeg())
            .args([
                "-v",
                "error",
                "-y",
                "-i",
                &stripped,
                "-vf",
                "scale=360:640",
                "-c:v",
                "libx264",
                "-preset",
                "medium",
                "-b:v",
                "400k",
                "-maxrate",
                "600k",
                "-bufsize",
                "800k",
                "-pix_fmt",
                "yuv420p",
                "-an"
            ])
            .arg(&low)
            .status()
            .unwrap()
            .success()
    );
    let hint = probe(&tools, &low.to_string_lossy())
        .unwrap()
        .hint
        .expect("QR readable after 360p transcode");
    assert_eq!((hint.width, hint.height, hint.tile), (720, 1280, 40));
    assert_eq!(hint.seed.as_deref(), Some("9859592623650262946"));

    // Files without an intro are untouched: the original clip yields no hint.
    assert!(info.hint.is_none());
}

/// With `gpu` on, the job reports the detected hardware encoder and still
/// round-trips; without one it must quietly use libx264.
#[test]
fn gpu_jobs_use_the_detected_hardware_encoder_or_fall_back_to_x264() {
    let Ok(tools) = Tools::locate() else {
        eprintln!("skipped: ffmpeg not found");
        return;
    };
    if !Path::new(SAMPLE).is_file() {
        eprintln!("skipped: sample clip not found at {SAMPLE}");
        return;
    }
    let out_dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join("pipeline-gpu");
    std::fs::create_dir_all(&out_dir).unwrap();
    let out_dir_str = out_dir.to_string_lossy().into_owned();
    let info = probe(&tools, SAMPLE).unwrap();
    let expected = hardware_encoder(&tools).map_or("libx264", |encoder| encoder.codec());
    assert_eq!(
        hardware_encoder(&tools),
        hardware_encoder(&tools),
        "detection is cached"
    );
    eprintln!("hardware encoder: {expected}");

    let params = |input: &str, mode, gpu| JobParams {
        input: input.to_string(),
        output_dir: out_dir_str.clone(),
        mode,
        width: 720,
        height: 1280,
        tile: 40,
        margin: 0,
        seed: "veilcast".into(),
        invert: false,
        intro: true,
        seed_in_intro: false,
        gpu,
        audio_ms: 0,
        audio_mirror: false,
    };

    let scrambled = run_job(&tools, &params(SAMPLE, Mode::Scramble, true), |_| {}).unwrap();
    assert_eq!(scrambled.encoder, expected);
    assert_eq!(scrambled.frames, info.frames);
    let scrambled_info = probe(&tools, &scrambled.output).unwrap();
    assert_eq!(
        scrambled_info.codec, "h264",
        "every encoder must produce H.264"
    );
    assert_eq!((scrambled_info.width, scrambled_info.height), (720, 1280));
    assert!(
        scrambled_info
            .hint
            .is_some_and(|hint| hint.intro_ms == 1000)
    );

    let restored = run_job(
        &tools,
        &params(&scrambled.output, Mode::Restore, true),
        |_| {},
    )
    .unwrap();
    assert_eq!(restored.encoder, expected);
    assert_eq!(restored.frames, info.frames);
    let restored_info = probe(&tools, &restored.output).unwrap();
    assert_eq!((restored_info.width, restored_info.height), (720, 1280));
    assert!((restored_info.duration - info.duration).abs() < 0.1);

    let cpu = run_job(&tools, &params(SAMPLE, Mode::Scramble, false), |_| {}).unwrap();
    assert_eq!(cpu.encoder, "libx264");
}
