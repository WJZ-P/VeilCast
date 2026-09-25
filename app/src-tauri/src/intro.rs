//! The one-second QR intro: rendering the header into raw yuv420p frames and
//! reading it back from a decoded frame. The intro is never scrambled or
//! inverted, so a viewer can read it before knowing any parameter.

use veilcast_core::{IntroHeader, Yuv420Layout};

/// Length of the intro; the browser scans this window for the QR code.
pub const INTRO_SECONDS: f64 = 1.0;
/// Fraction of the shorter frame side the symbol (with quiet zone) occupies.
const SYMBOL_FRACTION: (usize, usize) = (3, 5);
/// Quiet zone in modules on each side, as the QR standard requires.
const QUIET_ZONE: usize = 4;
const Y_BLACK: u8 = 16;
const Y_WHITE: u8 = 235;
const UV_NEUTRAL: u8 = 128;

/// Frames in a `seconds`-long intro at the given frame rate.
pub fn frame_count(fps: f64, seconds: f64) -> u64 {
    (fps * seconds).round().max(1.0) as u64
}

/// One intro frame: the header's QR code (error correction H) centred on a
/// white limited-range yuv420p frame of `layout`, with an integer number of
/// pixels per module so the edges stay crisp through our own encode.
pub fn render_frame(header: &IntroHeader, layout: Yuv420Layout) -> Result<Vec<u8>, String> {
    let digits = header.encode().map_err(|e| e.to_string())?;
    let code = qrcode::QrCode::with_error_correction_level(digits.as_bytes(), qrcode::EcLevel::H)
        .map_err(|e| format!("无法生成二维码: {e}"))?;
    let modules = code.width();
    let dark: Vec<bool> = code
        .to_colors()
        .into_iter()
        .map(|color| color == qrcode::Color::Dark)
        .collect();

    let shorter = layout.width().min(layout.height());
    let symbol_pixels = shorter * SYMBOL_FRACTION.0 / SYMBOL_FRACTION.1;
    let scale = symbol_pixels / (modules + 2 * QUIET_ZONE);
    if scale == 0 {
        return Err(format!(
            "画面 {}×{} 太小，放不下 {modules} 模块的二维码",
            layout.width(),
            layout.height()
        ));
    }
    let side = modules * scale;
    let x0 = (layout.width() - side) / 2;
    let y0 = (layout.height() - side) / 2;

    let mut frame = vec![0u8; layout.buffer_len()];
    let [y, u, v] = layout.split_mut(&mut frame).map_err(|e| e.to_string())?;
    y.fill(Y_WHITE);
    u.fill(UV_NEUTRAL);
    v.fill(UV_NEUTRAL);
    let stride = layout.luma().stride();
    for my in 0..modules {
        for mx in 0..modules {
            if !dark[my * modules + mx] {
                continue;
            }
            for row in 0..scale {
                let start = (y0 + my * scale + row) * stride + x0 + mx * scale;
                y[start..start + scale].fill(Y_BLACK);
            }
        }
    }
    Ok(frame)
}

/// Looks for a VeilCast header in an 8-bit greyscale frame (row-major, no
/// padding). Other QR codes in the frame are ignored.
pub fn read_frame(width: usize, height: usize, luma: &[u8]) -> Option<IntroHeader> {
    if luma.len() < width * height || width == 0 || height == 0 {
        return None;
    }
    let mut image =
        rqrr::PreparedImage::prepare_from_greyscale(width, height, |x, y| luma[y * width + x]);
    image
        .detect_grids()
        .iter()
        .filter_map(|grid| grid.decode().ok())
        .find_map(|(_, text)| IntroHeader::parse(text.trim()).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header() -> IntroHeader {
        IntroHeader {
            width: 1920,
            height: 1078,
            tile: 40,
            margin: 0,
            invert: true,
            audio_ms: 250,
            audio_mirror: true,
            seed: Some(0x88d4_4f40_babc_4fa2),
        }
    }

    #[test]
    fn rendered_frame_reads_back() {
        let layout = Yuv420Layout::packed(640, 360).unwrap();
        let frame = render_frame(&header(), layout).unwrap();
        let [y, u, v] = layout.split(&frame).unwrap();
        assert!(u.iter().chain(v).all(|&b| b == UV_NEUTRAL));
        assert!(y.iter().all(|&b| b == Y_BLACK || b == Y_WHITE));
        assert_eq!(read_frame(640, 360, y), Some(header()));
    }

    #[test]
    fn frames_without_our_code_read_as_none() {
        let layout = Yuv420Layout::packed(64, 64).unwrap();
        let blank = vec![Y_WHITE; layout.buffer_len()];
        assert_eq!(read_frame(64, 64, &blank[..64 * 64]), None);
        assert!(render_frame(&header(), Yuv420Layout::packed(40, 40).unwrap()).is_err());
    }

    #[test]
    fn intro_frame_count_follows_the_frame_rate() {
        assert_eq!(frame_count(30.0, INTRO_SECONDS), 30);
        assert_eq!(frame_count(29.97, INTRO_SECONDS), 30);
        assert_eq!(frame_count(60.0, 1.0), 60);
    }
}
