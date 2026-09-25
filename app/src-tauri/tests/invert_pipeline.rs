//! Synthetic SDR fixtures: range normalization, inversion, metadata and restore.
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use veilcast_app_lib::ffmpeg::{JobParams, Mode, Tools, probe, run_job};

fn ffmpeg() -> PathBuf {
    let executable = if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    };
    let folder = std::env::var_os("VEILCAST_FFMPEG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tools/ffmpeg"));
    let local = folder.join(executable);
    if local.is_file() {
        local
    } else {
        executable.into()
    }
}

fn command() -> Command {
    let mut command = Command::new(ffmpeg());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command.args(["-v", "error", "-nostdin"]);
    command
}

fn success(output: Output) -> Vec<u8> {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    output.stdout
}

fn rgb(path: &str) -> Vec<u8> {
    success(
        command()
            .args([
                "-i",
                path,
                "-frames:v",
                "1",
                "-pix_fmt",
                "rgb24",
                "-f",
                "rawvideo",
                "-",
            ])
            .output()
            .unwrap(),
    )
}

#[test]
fn full_and_limited_range_inputs_round_trip_with_inversion() {
    let Ok(tools) = Tools::locate() else {
        eprintln!("skipped: ffmpeg not found");
        return;
    };
    let directory = Path::new(env!("CARGO_TARGET_TMPDIR")).join("invert-pipeline");
    std::fs::create_dir_all(&directory).unwrap();
    for range in ["tv", "pc"] {
        let input = directory.join(format!("source-{range}.mkv"));
        success(
            command()
                .args([
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    "testsrc2=size=80x48:rate=6:duration=1",
                    "-vf",
                    &format!("scale=in_range=tv:out_range={range}"),
                    "-c:v",
                    "ffv1",
                    "-pix_fmt",
                    "yuv420p",
                    "-color_range",
                    range,
                ])
                .arg(&input)
                .output()
                .unwrap(),
        );
        let mut params = JobParams {
            input: input.to_string_lossy().into_owned(),
            output_dir: directory.to_string_lossy().into_owned(),
            mode: Mode::Scramble,
            width: 80,
            height: 48,
            tile: 16,
            margin: 4,
            seed: "20260916".into(),
            invert: true,
            intro: false,
            seed_in_intro: false,
            gpu: false,
            audio_ms: 0,
            audio_mirror: false,
        };
        let reference = rgb(&params.input);
        let scrambled = run_job(&tools, &params, |_| {}).unwrap();
        assert!(scrambled.output.ends_with("-inv.mp4"));
        let info = probe(&tools, &scrambled.output).unwrap();
        let hint = info.hint.unwrap();
        assert!(hint.invert);
        assert_eq!(
            (hint.width, hint.height, hint.tile, hint.margin),
            (80, 48, 16, 4)
        );
        params.input = scrambled.output;
        params.mode = Mode::Restore;
        params.invert = hint.invert;
        let restored = run_job(&tools, &params, |_| {}).unwrap();
        assert_eq!(restored.frames, 6);
        let actual = rgb(&restored.output);
        assert_eq!(actual.len(), reference.len());
        let mae = actual
            .iter()
            .zip(&reference)
            .map(|(&a, &b)| f64::from(a.abs_diff(b)))
            .sum::<f64>()
            / actual.len() as f64;
        eprintln!("invert pipeline {range}: RGB MAE={mae:.3}");
        assert!(mae < 12.0, "range={range}, RGB MAE={mae}");

        // A missing inverse operation should measurably leave a negative image.
        let wrong_dir = directory.join(format!("wrong-{range}"));
        std::fs::create_dir_all(&wrong_dir).unwrap();
        params.output_dir = wrong_dir.to_string_lossy().into_owned();
        params.invert = false;
        let wrong = run_job(&tools, &params, |_| {}).unwrap();
        let negative = rgb(&wrong.output);
        let wrong_mae = negative
            .iter()
            .zip(&reference)
            .map(|(&a, &b)| f64::from(a.abs_diff(b)))
            .sum::<f64>()
            / negative.len() as f64;
        assert!(
            wrong_mae > 40.0,
            "unchecked inversion must leave a negative image: {wrong_mae}"
        );
    }
}
