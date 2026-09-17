//! End-to-end scramble → restore through real ffmpeg processes.
//! Skips (passes) when ffmpeg or the sample clip is not available.

use std::path::Path;

use veilcast_app_lib::ffmpeg::{JobParams, Mode, Tools, probe, run_job};

const SAMPLE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../target/experiment/d49672a5defc39413b8979e3dfb5f134-yuv420p/source.mp4"
);

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
