use std::fmt;

/// Layout version this crate encodes and accepts.
pub const HEADER_VERSION: u8 = 1;

/// The plan parameters carried by the QR code in a scrambled video's intro.
///
/// The header is a string of decimal digits so the QR code can use numeric
/// mode (3⅓ bits per digit), which keeps the symbol at version 2–3 and its
/// modules large enough to survive platform transcodes. Version 1 layout,
/// every field zero-padded to a fixed width:
///
/// | offset | digits | field                                             |
/// |--------|--------|---------------------------------------------------|
/// | 0      | 2      | version, `01`                                     |
/// | 2      | 4      | source width, 1–9999                              |
/// | 6      | 4      | source height, 1–9999                             |
/// | 10     | 3      | tile, even, 2–998                                 |
/// | 13     | 2      | margin, even, 0–98                                |
/// | 15     | 1      | flags: bit 0 = invert, other bits must be zero    |
/// | 16     | 4      | audio block length in ms, 0 = audio untouched     |
/// | 20     | 20     | seed as a decimal `u64` (optional)                |
/// | end    | 2      | checksum: all preceding digits as an integer mod 97 |
///
/// Total length is 22 without a seed and 42 with one; the length alone says
/// which. The seed is the value produced by [`crate::seed_from_text`], never
/// the text the user typed. Padding is not transmitted: both ends derive it
/// from the source size and tile. Historical version-1 codes were 18/38 digits
/// without the audio field; readers accept those as audio_ms=0. Encoding always
/// uses the current 22/42-digit layout. Future layout changes must bump the version.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IntroHeader {
    pub width: usize,
    pub height: usize,
    pub tile: usize,
    pub margin: usize,
    pub invert: bool,
    /// Block length of the audio time reversal, see [`crate::reverse_blocks`];
    /// 0 when the audio was left alone.
    pub audio_ms: u32,
    pub seed: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HeaderError {
    /// Neither a current (22/42) nor historical (18/38) version-1 length.
    Length(usize),
    NotDigits,
    /// A version this crate does not understand.
    Version(u8),
    Checksum,
    /// A field outside its allowed range, named.
    Field(&'static str),
}

impl fmt::Display for HeaderError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Length(actual) => {
                write!(f, "header must be 18, 22, 38 or 42 digits, got {actual}")
            }
            Self::NotDigits => write!(f, "header must contain only decimal digits"),
            Self::Version(version) => write!(f, "unknown header version {version}"),
            Self::Checksum => write!(f, "header checksum mismatch"),
            Self::Field(name) => write!(f, "header field {name} is out of range"),
        }
    }
}

impl std::error::Error for HeaderError {}

const WITHOUT_SEED: usize = 22;
const WITH_SEED: usize = 42;

impl IntroHeader {
    /// The digit string for this header, or the field that cannot be represented.
    pub fn encode(&self) -> Result<String, HeaderError> {
        self.validate()?;
        let mut digits = format!(
            "{HEADER_VERSION:02}{:04}{:04}{:03}{:02}{}{:04}",
            self.width,
            self.height,
            self.tile,
            self.margin,
            u8::from(self.invert),
            self.audio_ms
        );
        if let Some(seed) = self.seed {
            digits.push_str(&format!("{seed:020}"));
        }
        digits.push_str(&format!("{:02}", checksum(&digits)));
        Ok(digits)
    }

    pub fn parse(text: &str) -> Result<Self, HeaderError> {
        if !text.bytes().all(|b| b.is_ascii_digit()) {
            return Err(HeaderError::NotDigits);
        }
        let legacy = text.len() == 18 || text.len() == 38;
        if !legacy && text.len() != WITHOUT_SEED && text.len() != WITH_SEED {
            return Err(HeaderError::Length(text.len()));
        }
        let (payload, check) = text.split_at(text.len() - 2);
        let version = field::<u8>(&text[0..2], "version")?;
        if version != HEADER_VERSION {
            return Err(HeaderError::Version(version));
        }
        if check != format!("{:02}", checksum(payload)) {
            return Err(HeaderError::Checksum);
        }
        let flags = field::<u8>(&text[15..16], "flags")?;
        if flags > 1 {
            return Err(HeaderError::Field("flags"));
        }
        let seed = if text.len() == 38 || text.len() == WITH_SEED {
            let offset = if legacy { 16 } else { 20 };
            Some(field::<u64>(&text[offset..offset + 20], "seed")?)
        } else {
            None
        };
        let header = Self {
            width: field(&text[2..6], "width")?,
            height: field(&text[6..10], "height")?,
            tile: field(&text[10..13], "tile")?,
            margin: field(&text[13..15], "margin")?,
            invert: flags == 1,
            audio_ms: if legacy {
                0
            } else {
                field(&text[16..20], "audio")?
            },
            seed,
        };
        header.validate()?;
        Ok(header)
    }

    fn validate(&self) -> Result<(), HeaderError> {
        if !(1..=9999).contains(&self.width) {
            return Err(HeaderError::Field("width"));
        }
        if !(1..=9999).contains(&self.height) {
            return Err(HeaderError::Field("height"));
        }
        if !(2..=998).contains(&self.tile) || self.tile % 2 != 0 {
            return Err(HeaderError::Field("tile"));
        }
        if self.margin > 98 || self.margin % 2 != 0 {
            return Err(HeaderError::Field("margin"));
        }
        if self.audio_ms > 9999 {
            return Err(HeaderError::Field("audio"));
        }
        Ok(())
    }
}

fn field<T: std::str::FromStr>(digits: &str, name: &'static str) -> Result<T, HeaderError> {
    digits.parse().map_err(|_| HeaderError::Field(name))
}

/// The digit string read as one integer, modulo 97, computed digit by digit
/// so no big-integer support is needed on either end.
fn checksum(digits: &str) -> u8 {
    digits
        .bytes()
        .fold(0u32, |r, b| (r * 10 + u32::from(b - b'0')) % 97) as u8
}
