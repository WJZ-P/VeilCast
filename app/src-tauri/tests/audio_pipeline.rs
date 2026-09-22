//! Audio block reversal through real ffmpeg processes.
//! Skips (passes) when ffmpeg or the sample clip is not available.

use std::path::{Path, PathBuf};
use std::process::Command;

use veilcast_app_lib::ffmpeg::{JobParams, Mode, Tools, probe, run_job, scramble_audio};

const SAMPLE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../target/experiment/d49672a5defc39413b8979e3dfb5f134-yuv420p/source.mp4"
);

fn ffmpeg() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tools/ffmpeg/ffmpeg.exe")
}

/// Every audio sample of `path` as interleaved 16-bit stereo at 48 kHz.
fn pcm(path: &Path) -> Vec<i16> {
    let output = Command::new(ffmpeg())
        .args(["-v", "error", "-i"])
        .arg(path)
        .args(["-vn", "-f", "s16le", "-ar", "48000", "-ac", "2", "-"])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    output
        .stdout
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]))
        .collect()
}

/// Signal-to-error ratio in dB over the common length; higher is closer.
fn snr_db(reference: &[i16], candidate: &[i16]) -> f64 {
    let n = reference.len().min(candidate.len());
    let (mut signal, mut error) = (0f64, 0f64);
    for (&a, &b) in reference[..n].iter().zip(&candidate[..n]) {
        signal += f64::from(a).powi(2);
        error += (f64::from(a) - f64::from(b)).powi(2);
    }
    10.0 * (signal / error.max(1.0)).log10()
}

/// The audio pass alone is lossless: FLAC in between, and only whole frames
/// move, so reversing twice must give back every sample, including the
/// partial tail and the channel order.
#[test]
fn the_audio_pass_restores_every_sample() {
    let Ok(tools) = Tools::locate() else {
        eprintln!("skipped: ffmpeg not found");
        return;
    };
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join("audio-pass");
    std::fs::create_dir_all(&dir).unwrap();
    // A tone on the left and noise on the right; 3.3 s leaves a 50 ms tail
    // after thirteen 250 ms blocks.
    let source = dir.join("source.wav");
    let status = Command::new(ffmpeg())
        .args(["-v", "error", "-y"])
        .args([
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000:duration=3.3",
        ])
        .args([
            "-f",
            "lavfi",
            "-i",
            "anoisesrc=d=3.3:c=pink:r=48000:a=0.3:seed=7",
        ])
        .args([
            "-filter_complex",
            "[0][1]join=inputs=2:channel_layout=stereo",
        ])
        .args(["-c:a", "pcm_s16le"])
        .arg(&source)
        .status()
        .unwrap();
    assert!(status.success());
    let original = pcm(&source);
    assert_eq!(original.len(), 158_400 * 2);

    let source_str = source.to_string_lossy();
    let scrambled = scramble_audio(&tools, &source_str, Mode::Scramble, 250, 2, Some(1.0)).unwrap();
    let scrambled_pcm = pcm(scrambled.path());
    assert_eq!(
        scrambled_pcm.len(),
        original.len() + 48_000 * 2,
        "exactly one second of silence goes in front"
    );
    assert!(scrambled_pcm[..48_000 * 2].iter().all(|&s| s == 0));
    // Block 0 is the first 250 ms backwards: its first frame is frame 11999.
    let content = &scrambled_pcm[48_000 * 2..];
    assert_eq!(content[..2], original[11_999 * 2..12_000 * 2]);
    assert_eq!(content[11_999 * 2..12_000 * 2], original[..2]);
    // The 50 ms tail stays in order.
    assert_eq!(content[156_000 * 2..], original[156_000 * 2..]);

    let scrambled_str = scrambled.path().to_string_lossy().into_owned();
    let restored =
        scramble_audio(&tools, &scrambled_str, Mode::Restore, 250, 2, Some(1.0)).unwrap();
    assert_eq!(
        pcm(restored.path()),
        original,
        "the round trip must be bit-exact"
    );

    // Scratch files go away with their handles.
    let path = restored.path().to_path_buf();
    drop(restored);
    assert!(!path.exists());
}

/// The whole job, AAC included: the restored track must come back as close to
/// the source as a plain re-encode does, while the uploaded track is not.
#[test]
fn reversed_audio_survives_the_full_job() {
    let Ok(tools) = Tools::locate() else {
        eprintln!("skipped: ffmpeg not found");
        return;
    };
    if !Path::new(SAMPLE).is_file() {
        eprintln!("skipped: sample clip not found at {SAMPLE}");
        return;
    }
    let info = probe(&tools, SAMPLE).unwrap();
    assert_eq!(info.audio_channels, 2);

    let job = |name: &str, audio_ms: u32| {
        let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("audio-job-{name}"));
        std::fs::create_dir_all(&dir).unwrap();
        let params = |input: &str, mode| JobParams {
            input: input.to_string(),
            output_dir: dir.to_string_lossy().into_owned(),
            mode,
            width: 720,
            height: 1280,
            tile: 40,
            margin: 0,
            seed: "veilcast".into(),
            invert: false,
            intro: true,
            seed_in_intro: false,
            gpu: false,
            audio_ms,
        };
        let scrambled = run_job(&tools, &params(SAMPLE, Mode::Scramble), |_| {}).unwrap();
        assert_eq!(
            scrambled.audio_ms, audio_ms,
            "the result reports the audio pass"
        );
        let hint = probe(&tools, &scrambled.output).unwrap().hint.unwrap();
        assert_eq!(
            hint.audio_ms, audio_ms,
            "the metadata tag records the block length"
        );
        let restored = run_job(&tools, &params(&scrambled.output, Mode::Restore), |_| {}).unwrap();
        (
            PathBuf::from(scrambled.output),
            PathBuf::from(restored.output),
        )
    };

    let original = pcm(Path::new(SAMPLE));
    let (_, plain) = job("plain", 0);
    let (scrambled, restored) = job("reversed", 250);

    // What survives an upload: no metadata, audio re-encoded by the platform.
    // The intro QR alone must still say the audio was reversed. The two files
    // are also the fixtures for userscript/tests/audio.html: B站 serves audio
    // as a separate fragmented .m4s, which browsers decode without trimming
    // the AAC priming samples.
    let dir = scrambled.parent().unwrap();
    for (name, args) in [
        (
            "platform.mp4",
            &[
                "-map_metadata",
                "-1",
                "-c:v",
                "copy",
                "-c:a",
                "aac",
                "-b:a",
                "64k",
            ][..],
        ),
        (
            "platform.m4s",
            &[
                "-map_metadata",
                "-1",
                "-vn",
                "-c:a",
                "aac",
                "-b:a",
                "64k",
                "-f",
                "mp4",
                "-movflags",
                "+frag_keyframe+empty_moov+default_base_moof",
                "-frag_duration",
                "1000000",
            ][..],
        ),
    ] {
        let status = Command::new(ffmpeg())
            .args(["-v", "error", "-y", "-i"])
            .arg(&scrambled)
            .args(args)
            .arg(dir.join(name))
            .status()
            .unwrap();
        assert!(status.success(), "{name}");
    }
    let uploaded = probe(&tools, &dir.join("platform.mp4").to_string_lossy()).unwrap();
    let hint = uploaded.hint.expect("the intro QR survives the upload");
    assert_eq!(hint.audio_ms, 250, "the intro QR carries the block length");

    let restored_info = probe(&tools, &restored.to_string_lossy()).unwrap();
    assert_eq!(restored_info.audio_channels, 2);
    assert!((restored_info.duration - info.duration).abs() < 0.1);

    let baseline = snr_db(&original, &pcm(&plain));
    let reversed = snr_db(&original, &pcm(&restored));
    // The upload, intro second skipped, against the source it hides.
    let exposed = snr_db(&original, &pcm(&scrambled)[48_000 * 2..]);
    eprintln!(
        "SNR vs source: plain re-encode {baseline:.1} dB, reversed round trip {reversed:.1} dB, upload {exposed:.1} dB"
    );
    assert!(baseline > 15.0, "plain re-encode baseline {baseline:.1} dB");
    assert!(
        reversed > baseline - 3.0,
        "reversal must cost at most 3 dB over a plain re-encode: {reversed:.1} vs {baseline:.1} dB"
    );
    assert!(
        exposed < 3.0,
        "the upload must not resemble the source: {exposed:.1} dB"
    );
}
