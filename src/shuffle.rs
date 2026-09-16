use crate::{Error, FrameLayout};

/// One tile of the original frame and the block that holds it in the scrambled frame.
#[derive(Debug, Clone, Copy)]
struct TilePair {
    /// Tile grid position in the original frame; needed to clamp the margin at frame edges.
    column: usize,
    row: usize,
    /// Byte offset of the tile's top-left pixel in the original frame.
    original: usize,
    /// Byte offset of the block's top-left pixel, margin included, in the scrambled frame.
    scrambled: usize,
}

/// A reusable spatial permutation for frames with the same layout.
///
/// Tiles are numbered in row-major order, starting at zero. The mapping is
/// `permutation[scrambled_block] = original_tile`. Every tile must occur once.
/// Tile dimensions are in pixels and must divide the frame dimensions exactly.
///
/// With a nonzero margin every tile is carried together with `margin` pixels of
/// its neighbours on each side, so the scrambled frame is larger than the
/// original: each block is `(tile_width + 2 * margin) × (tile_height + 2 * margin)`
/// pixels. Neighbours outside the frame are replaced by the nearest edge pixel.
/// Restoring copies only the inner tile, so compression artefacts that gather
/// at block edges land in the discarded margin. With margin zero both layouts
/// are identical.
///
/// No cropping, colour conversion, or frame-order changes are performed.
#[derive(Debug, Clone)]
pub struct ShufflePlan {
    original: FrameLayout,
    scrambled: FrameLayout,
    tile_width: usize,
    tile_height: usize,
    margin: usize,
    pairs: Vec<TilePair>,
}

impl ShufflePlan {
    /// A plan without margins: original and scrambled frames share `layout`.
    pub fn new(
        layout: FrameLayout,
        tile_width: usize,
        tile_height: usize,
        permutation: &[usize],
    ) -> Result<Self, Error> {
        Self::with_margin(layout, tile_width, tile_height, 0, permutation)
    }

    /// A plan whose scrambled blocks carry `margin` pixels of context on every side.
    ///
    /// The scrambled layout keeps the original pixel format and row padding;
    /// see [`Self::scrambled_layout`] for its dimensions.
    pub fn with_margin(
        layout: FrameLayout,
        tile_width: usize,
        tile_height: usize,
        margin: usize,
        permutation: &[usize],
    ) -> Result<Self, Error> {
        if tile_width == 0 || tile_height == 0 {
            return Err(Error::EmptyTile);
        }
        if layout.width() % tile_width != 0 || layout.height() % tile_height != 0 {
            return Err(Error::UnalignedTileGrid);
        }
        let columns = layout.width() / tile_width;
        let rows = layout.height() / tile_height;
        // FrameLayout bounds the full byte size, which also bounds the tile count.
        let tile_count = columns * rows;
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

        let bytes_per_pixel = layout.format().bytes_per_pixel();
        let block_width = margin
            .checked_mul(2)
            .and_then(|m| m.checked_add(tile_width))
            .ok_or(Error::SizeOverflow)?;
        let block_height = margin
            .checked_mul(2)
            .and_then(|m| m.checked_add(tile_height))
            .ok_or(Error::SizeOverflow)?;
        let scrambled_width = columns
            .checked_mul(block_width)
            .ok_or(Error::SizeOverflow)?;
        let scrambled_height = rows.checked_mul(block_height).ok_or(Error::SizeOverflow)?;
        // Carry the original row padding over so a margin of zero reproduces the layout exactly.
        let row_padding = layout.stride() - layout.width() * bytes_per_pixel;
        let scrambled_stride = scrambled_width
            .checked_mul(bytes_per_pixel)
            .and_then(|bytes| bytes.checked_add(row_padding))
            .ok_or(Error::SizeOverflow)?;
        let scrambled = FrameLayout::new(
            scrambled_width,
            scrambled_height,
            layout.format(),
            scrambled_stride,
        )?;

        let pairs = permutation
            .iter()
            .enumerate()
            .map(|(block, &tile)| {
                let (column, row) = (tile % columns, tile / columns);
                TilePair {
                    column,
                    row,
                    original: row * tile_height * layout.stride()
                        + column * tile_width * bytes_per_pixel,
                    scrambled: (block / columns) * block_height * scrambled.stride()
                        + (block % columns) * block_width * bytes_per_pixel,
                }
            })
            .collect();
        Ok(Self {
            original: layout,
            scrambled,
            tile_width,
            tile_height,
            margin,
            pairs,
        })
    }

    /// Layout of the original frame.
    pub const fn original_layout(&self) -> FrameLayout {
        self.original
    }

    /// Layout of the scrambled frame: `columns × (tile_width + 2 * margin)` by
    /// `rows × (tile_height + 2 * margin)` pixels, same format and row padding.
    pub const fn scrambled_layout(&self) -> FrameLayout {
        self.scrambled
    }

    pub const fn margin(&self) -> usize {
        self.margin
    }

    /// Copies tiles and their margins into their scrambled positions without allocating.
    ///
    /// `original` uses [`Self::original_layout`], `scrambled` uses
    /// [`Self::scrambled_layout`]. Row padding and bytes beyond the buffer
    /// length are left untouched. On validation failure `scrambled` is
    /// unchanged. The two buffers must be separate.
    pub fn scramble(&self, original: &[u8], scrambled: &mut [u8]) -> Result<(), Error> {
        check_len("original", original, self.original.buffer_len())?;
        check_len("scrambled", scrambled, self.scrambled.buffer_len())?;

        let bytes_per_pixel = self.original.format().bytes_per_pixel();
        let (width, height, stride) = (
            self.original.width(),
            self.original.height(),
            self.original.stride(),
        );
        let scrambled_stride = self.scrambled.stride();
        let margin = self.margin;
        let block_height = self.tile_height + 2 * margin;
        let block_row_bytes = (self.tile_width + 2 * margin) * bytes_per_pixel;

        for pair in &self.pairs {
            let tile_x = pair.column * self.tile_width;
            let tile_y = pair.row * self.tile_height;
            // Margin pixels outside the frame replicate the nearest edge pixel.
            let left_pad = margin.saturating_sub(tile_x);
            let right_pad = (tile_x + self.tile_width + margin).saturating_sub(width);
            let x_start = tile_x + left_pad - margin;
            let x_end = tile_x + self.tile_width + margin - right_pad;
            for block_row in 0..block_height {
                let y = (tile_y + block_row).saturating_sub(margin).min(height - 1);
                let source_row = &original[y * stride..][..width * bytes_per_pixel];
                let target_row = &mut scrambled[pair.scrambled + block_row * scrambled_stride..]
                    [..block_row_bytes];
                let (left, rest) = target_row.split_at_mut(left_pad * bytes_per_pixel);
                let (middle, right) = rest.split_at_mut((x_end - x_start) * bytes_per_pixel);
                middle.copy_from_slice(
                    &source_row[x_start * bytes_per_pixel..x_end * bytes_per_pixel],
                );
                for pixel in left.chunks_exact_mut(bytes_per_pixel) {
                    pixel.copy_from_slice(&source_row[..bytes_per_pixel]);
                }
                for pixel in right.chunks_exact_mut(bytes_per_pixel) {
                    pixel.copy_from_slice(&source_row[(width - 1) * bytes_per_pixel..]);
                }
            }
        }
        Ok(())
    }

    /// Copies the inner tile of every block back to its original position,
    /// discarding margins. Same buffer contract as [`Self::scramble`] with the
    /// roles swapped. Loss introduced outside this crate is not recovered.
    pub fn restore(&self, scrambled: &[u8], original: &mut [u8]) -> Result<(), Error> {
        check_len("scrambled", scrambled, self.scrambled.buffer_len())?;
        check_len("original", original, self.original.buffer_len())?;

        let bytes_per_pixel = self.original.format().bytes_per_pixel();
        let stride = self.original.stride();
        let scrambled_stride = self.scrambled.stride();
        let tile_row_bytes = self.tile_width * bytes_per_pixel;
        let inner_offset = self.margin * scrambled_stride + self.margin * bytes_per_pixel;

        for pair in &self.pairs {
            let inner = pair.scrambled + inner_offset;
            for tile_row in 0..self.tile_height {
                original[pair.original + tile_row * stride..][..tile_row_bytes].copy_from_slice(
                    &scrambled[inner + tile_row * scrambled_stride..][..tile_row_bytes],
                );
            }
        }
        Ok(())
    }
}

fn check_len(buffer: &'static str, bytes: &[u8], required: usize) -> Result<(), Error> {
    if bytes.len() < required {
        return Err(Error::BufferTooSmall {
            buffer,
            required,
            actual: bytes.len(),
        });
    }
    Ok(())
}
