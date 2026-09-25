use veilcast_core::{HEADER_VERSION, HeaderError, IntroHeader};

fn sample() -> IntroHeader {
    IntroHeader {
        width: 2560,
        height: 1370,
        tile: 40,
        margin: 0,
        invert: true,
        audio_ms: 0,
        seed: None,
    }
}

#[test]
fn known_answer_vectors_pin_the_layout() {
    // Any other implementation (e.g. the browser side) must reproduce these.
    assert_eq!(HEADER_VERSION, 1);
    assert_eq!(sample().encode().unwrap(), "0125601370040001000017");
    let with_seed = IntroHeader {
        seed: Some(0x88d4_4f40_babc_4fa2), // seed_from_text("veilcast")
        ..sample()
    };
    assert_eq!(
        with_seed.encode().unwrap(),
        "012560137004000100000985959262365026294677"
    );
    let with_audio = IntroHeader {
        audio_ms: 250,
        ..sample()
    };
    assert_eq!(with_audio.encode().unwrap(), "0125601370040001025073");
    assert_eq!(
        IntroHeader {
            seed: with_seed.seed,
            ..with_audio
        }
        .encode()
        .unwrap(),
        "012560137004000102500985959262365026294691"
    );
    let portrait = IntroHeader {
        width: 720,
        height: 1280,
        tile: 16,
        margin: 4,
        invert: false,
        audio_ms: 0,
        seed: None,
    };
    assert_eq!(portrait.encode().unwrap(), "0107201280016040000016");
}

#[test]
fn parse_inverts_encode() {
    for header in [
        sample(),
        IntroHeader {
            seed: Some(u64::MAX),
            ..sample()
        },
        IntroHeader {
            seed: Some(0),
            invert: false,
            ..sample()
        },
        IntroHeader {
            width: 1,
            height: 9999,
            tile: 998,
            margin: 98,
            invert: true,
            audio_ms: 9999,
            seed: Some(1),
        },
        IntroHeader {
            audio_ms: 250,
            ..sample()
        },
    ] {
        let digits = header.encode().unwrap();
        assert!(digits.len() == 22 || digits.len() == 42);
        assert_eq!(IntroHeader::parse(&digits).unwrap(), header);
    }
}

#[test]
fn rejects_malformed_strings() {
    assert_eq!(
        IntroHeader::parse("012560137004000100001").unwrap_err(),
        HeaderError::Length(21)
    );
    assert_eq!(
        IntroHeader::parse("012560137004000100001x").unwrap_err(),
        HeaderError::NotDigits
    );
    assert_eq!(
        IntroHeader::parse("0125601370040001000018").unwrap_err(),
        HeaderError::Checksum
    );
    // Version 02 with a valid checksum for its payload must still be refused.
    assert_eq!(
        IntroHeader::parse("0225601370040001000009").unwrap_err(),
        HeaderError::Version(2)
    );
    // Flags 2 (reserved bit) — checksum recomputed for the altered payload.
    assert_eq!(
        IntroHeader::parse("0125601370040002000026").unwrap_err(),
        HeaderError::Field("flags")
    );
    // Seed larger than u64::MAX.
    assert_eq!(
        IntroHeader::parse("012560137004000100001844674407370955161641").unwrap_err(),
        HeaderError::Field("seed")
    );
}

#[test]
fn legacy_headers_without_audio_remain_readable() {
    assert_eq!(IntroHeader::parse("012560137004000145").unwrap(), sample());
    let with_seed = IntroHeader {
        seed: Some(0x88d4_4f40_babc_4fa2),
        ..sample()
    };
    assert_eq!(
        IntroHeader::parse("01256013700400010985959262365026294684").unwrap(),
        with_seed
    );
    let portrait = IntroHeader {
        width: 720,
        height: 1280,
        tile: 16,
        margin: 4,
        invert: false,
        audio_ms: 0,
        seed: None,
    };
    assert_eq!(IntroHeader::parse("010720128001604088").unwrap(), portrait);
    assert_eq!(
        IntroHeader::parse("012560137004000145")
            .unwrap()
            .encode()
            .unwrap(),
        "0125601370040001000017"
    );
}

#[test]
fn legacy_headers_still_require_checksum_version_flags_and_seed_bounds() {
    for (text, expected) in [
        ("012560137004000146", HeaderError::Checksum),
        ("022560137004000148", HeaderError::Version(2)),
        ("012560137004000246", HeaderError::Field("flags")),
        (
            "01256013700400011844674407370955161648",
            HeaderError::Field("seed"),
        ),
    ] {
        assert_eq!(IntroHeader::parse(text).unwrap_err(), expected);
    }
}

#[test]
fn rejects_out_of_range_fields_before_encoding() {
    for (header, name) in [
        (
            IntroHeader {
                width: 0,
                ..sample()
            },
            "width",
        ),
        (
            IntroHeader {
                height: 10000,
                ..sample()
            },
            "height",
        ),
        (
            IntroHeader {
                tile: 41,
                ..sample()
            },
            "tile",
        ),
        (
            IntroHeader {
                tile: 0,
                ..sample()
            },
            "tile",
        ),
        (
            IntroHeader {
                margin: 3,
                ..sample()
            },
            "margin",
        ),
        (
            IntroHeader {
                margin: 100,
                ..sample()
            },
            "margin",
        ),
    ] {
        assert_eq!(header.encode().unwrap_err(), HeaderError::Field(name));
    }
}
