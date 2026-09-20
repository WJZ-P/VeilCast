use veilcast_core::{HEADER_VERSION, HeaderError, IntroHeader};

fn sample() -> IntroHeader {
    IntroHeader {
        width: 2560,
        height: 1370,
        tile: 40,
        margin: 0,
        invert: true,
        seed: None,
    }
}

#[test]
fn known_answer_vectors_pin_the_layout() {
    // Any other implementation (e.g. the browser side) must reproduce these.
    assert_eq!(HEADER_VERSION, 1);
    assert_eq!(sample().encode().unwrap(), "012560137004000145");
    let with_seed = IntroHeader {
        seed: Some(0x88d4_4f40_babc_4fa2), // seed_from_text("veilcast")
        ..sample()
    };
    assert_eq!(
        with_seed.encode().unwrap(),
        "01256013700400010985959262365026294684"
    );
    let portrait = IntroHeader {
        width: 720,
        height: 1280,
        tile: 16,
        margin: 4,
        invert: false,
        seed: None,
    };
    assert_eq!(portrait.encode().unwrap(), "010720128001604088");
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
            seed: Some(1),
        },
    ] {
        let digits = header.encode().unwrap();
        assert!(digits.len() == 18 || digits.len() == 38);
        assert_eq!(IntroHeader::parse(&digits).unwrap(), header);
    }
}

#[test]
fn rejects_malformed_strings() {
    assert_eq!(
        IntroHeader::parse("01256013700400014").unwrap_err(),
        HeaderError::Length(17)
    );
    assert_eq!(
        IntroHeader::parse("01256013700400014x").unwrap_err(),
        HeaderError::NotDigits
    );
    assert_eq!(
        IntroHeader::parse("012560137004000146").unwrap_err(),
        HeaderError::Checksum
    );
    // Version 02 with a valid checksum for its payload must still be refused.
    assert_eq!(
        IntroHeader::parse("022560137004000148").unwrap_err(),
        HeaderError::Version(2)
    );
    // Flags 2 (reserved bit) — checksum recomputed for the altered payload.
    assert_eq!(
        IntroHeader::parse("012560137004000246").unwrap_err(),
        HeaderError::Field("flags")
    );
    // Seed larger than u64::MAX.
    assert_eq!(
        IntroHeader::parse("01256013700400011844674407370955161648").unwrap_err(),
        HeaderError::Field("seed")
    );
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
