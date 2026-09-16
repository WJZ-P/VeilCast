use crate::{Error, FrameLayout};

#[derive(Debug, Clone, Copy)]
struct TileCopy {
    source: usize,
    destination: usize,
}

/// A reusable spatial permutation for frames with the same layout.
///
/// Tiles are numbered in row-major order, starting at zero. The mapping is
/// `permutation[destination_tile] = source_tile`. Every tile must occur once.
/// Tile dimensions are in pixels and must divide the frame dimensions exactly.
/// No cropping, padding, color conversion, or frame-order changes are performed.
#[derive(Debug, Clone)]
pub struct ShufflePlan {
    layout: FrameLayout,
    tile_height: usize,
    tile_row_bytes: usize,
    copies: Vec<TileCopy>,
}

impl ShufflePlan {
    pub fn new(
        layout: FrameLayout,
        tile_width: usize,
        tile_height: usize,
        permutation: &[usize],
    ) -> Result<Self, Error> {
        if tile_width == 0 || tile_height == 0 {
            return Err(Error::EmptyTile);
        }
        if layout.width() % tile_width != 0 || layout.height() % tile_height != 0 {
            return Err(Error::UnalignedTileGrid);
        }
        let columns = layout.width() / tile_width;
        // FrameLayout bounds the full byte size, which also bounds the tile count.
        let tile_count = columns * (layout.height() / tile_height);
        if permutation.len() != tile_count {
            return Err(Error::PermutationLength {
                expected: tile_count,
                actual: permutation.len(),
            });
        }
        let mut seen = vec![false; tile_count];
        for &index in permutation {
            if index >= tile_count {
                return Err(Error::TileOutOfRange { index, tile_count });
            }
            if seen[index] {
                return Err(Error::DuplicateTile { index });
            }
            seen[index] = true;
        }

        let tile_row_bytes = tile_width * layout.format().bytes_per_pixel();
        let offset = |index: usize| {
            (index / columns) * tile_height * layout.stride() + (index % columns) * tile_row_bytes
        };
        let copies = permutation
            .iter()
            .enumerate()
            .map(|(destination, &source)| TileCopy {
                source: offset(source),
                destination: offset(destination),
            })
            .collect();
        Ok(Self {
            layout,
            tile_height,
            tile_row_bytes,
            copies,
        })
    }

    pub const fn layout(&self) -> FrameLayout {
        self.layout
    }

    /// Copies tiles into their scrambled positions without allocating.
    ///
    /// Both buffers use this plan's layout. Destination row padding and bytes
    /// beyond `layout.buffer_len()` are left untouched. On validation failure,
    /// the destination is unchanged. Source and destination must be separate.
    pub fn scramble(&self, source: &[u8], destination: &mut [u8]) -> Result<(), Error> {
        self.apply(source, destination, false)
    }

    /// Restores tiles using the inverse mapping and the same buffer contract as
    /// [`Self::scramble`]. Loss introduced outside this crate is not recovered.
    pub fn restore(&self, source: &[u8], destination: &mut [u8]) -> Result<(), Error> {
        self.apply(source, destination, true)
    }

    fn apply(&self, source: &[u8], destination: &mut [u8], inverse: bool) -> Result<(), Error> {
        let required = self.layout.buffer_len();
        for (buffer, actual) in [("source", source.len()), ("destination", destination.len())] {
            if actual < required {
                return Err(Error::BufferTooSmall {
                    buffer,
                    required,
                    actual,
                });
            }
        }

        for tile in &self.copies {
            let (source_start, destination_start) = if inverse {
                (tile.destination, tile.source)
            } else {
                (tile.source, tile.destination)
            };
            for row in 0..self.tile_height {
                let source_offset = source_start + row * self.layout.stride();
                let destination_offset = destination_start + row * self.layout.stride();
                destination[destination_offset..destination_offset + self.tile_row_bytes]
                    .copy_from_slice(&source[source_offset..source_offset + self.tile_row_bytes]);
            }
        }
        Ok(())
    }
}
