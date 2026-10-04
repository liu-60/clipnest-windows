//! Exact, bounded CF_DIB contract shared by the host provider and Win32 writer.

use crate::protocol::{MAX_IMAGE_DIB_BYTES, MAX_IMAGE_PIXELS};

const BITMAPINFOHEADER_BYTES: usize = 40;
const BI_RGB: u32 = 0;

pub fn is_supported_dib(bytes: &[u8]) -> bool {
    if !(BITMAPINFOHEADER_BYTES..=MAX_IMAGE_DIB_BYTES).contains(&bytes.len())
        || read_u32(bytes, 0) != Some(BITMAPINFOHEADER_BYTES as u32)
    {
        return false;
    }
    let Some(width) = read_i32(bytes, 4).filter(|width| *width > 0) else {
        return false;
    };
    let Some(height) = read_i32(bytes, 8).filter(|height| *height != 0) else {
        return false;
    };
    let Some(pixel_count) = u64::from(width as u32).checked_mul(u64::from(height.unsigned_abs()))
    else {
        return false;
    };
    if pixel_count > MAX_IMAGE_PIXELS {
        return false;
    }
    if read_u16(bytes, 12) != Some(1)
        || !matches!(read_u16(bytes, 14), Some(24 | 32))
        || read_u32(bytes, 16) != Some(BI_RGB)
        || read_u32(bytes, 32) != Some(0)
    {
        return false;
    }

    let bits_per_pixel = u64::from(read_u16(bytes, 14).unwrap_or_default());
    let row_bits = u64::from(width as u32).checked_mul(bits_per_pixel);
    let Some(stride) = row_bits
        .and_then(|bits| bits.checked_add(31))
        .map(|bits| (bits / 32) * 4)
    else {
        return false;
    };
    let Some(pixel_bytes) = stride.checked_mul(u64::from(height.unsigned_abs())) else {
        return false;
    };
    let Some(total_bytes) = (BITMAPINFOHEADER_BYTES as u64).checked_add(pixel_bytes) else {
        return false;
    };
    let Some(image_size) = read_u32(bytes, 20) else {
        return false;
    };
    total_bytes == bytes.len() as u64 && (image_size == 0 || u64::from(image_size) == pixel_bytes)
}

fn read_u16(bytes: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_le_bytes(
        bytes.get(offset..offset + 2)?.try_into().ok()?,
    ))
}

fn read_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_le_bytes(
        bytes.get(offset..offset + 4)?.try_into().ok()?,
    ))
}

fn read_i32(bytes: &[u8], offset: usize) -> Option<i32> {
    Some(i32::from_le_bytes(
        bytes.get(offset..offset + 4)?.try_into().ok()?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dib(width: i32, height: i32, bits: u16) -> Vec<u8> {
        let stride = ((u64::from(width as u32) * u64::from(bits) + 31) / 32) * 4;
        let pixels = stride * u64::from(height.unsigned_abs());
        let mut bytes = vec![0; 40 + pixels as usize];
        bytes[0..4].copy_from_slice(&40u32.to_le_bytes());
        bytes[4..8].copy_from_slice(&width.to_le_bytes());
        bytes[8..12].copy_from_slice(&height.to_le_bytes());
        bytes[12..14].copy_from_slice(&1u16.to_le_bytes());
        bytes[14..16].copy_from_slice(&bits.to_le_bytes());
        bytes[20..24].copy_from_slice(&(pixels as u32).to_le_bytes());
        bytes
    }

    #[test]
    fn accepts_exact_rgb_dib_rows_and_top_down_height() {
        assert!(is_supported_dib(&dib(2, 2, 24)));
        assert!(is_supported_dib(&dib(1, -3, 32)));
    }

    #[test]
    fn rejects_bad_headers_geometry_and_pixel_spans() {
        assert!(!is_supported_dib(&[0; 12]));
        let mut value = dib(1, 1, 32);
        value[12..14].copy_from_slice(&2u16.to_le_bytes());
        assert!(!is_supported_dib(&value));
        let mut value = dib(1, 1, 32);
        value[16..20].copy_from_slice(&3u32.to_le_bytes());
        assert!(!is_supported_dib(&value));
        let mut value = dib(1, 1, 32);
        value.pop();
        assert!(!is_supported_dib(&value));
        let mut value = dib(1, 1, 32);
        value[20..24].copy_from_slice(&3u32.to_le_bytes());
        assert!(!is_supported_dib(&value));
        let mut value = dib(1, 1, 32);
        value[4..8].copy_from_slice(&i32::MAX.to_le_bytes());
        value[8..12].copy_from_slice(&i32::MAX.to_le_bytes());
        value[20..24].copy_from_slice(&0u32.to_le_bytes());
        assert!(!is_supported_dib(&value));
    }

    #[test]
    fn enforces_pixel_and_expanded_dib_limits_independently() {
        let max_pixels = dib(4_000, 4_000, 32);
        assert_eq!(max_pixels.len(), MAX_IMAGE_DIB_BYTES);
        assert!(is_supported_dib(&max_pixels));

        // This 24bpp DIB is below the expanded-byte ceiling, but exceeds 16MP.
        let too_many_pixels = dib(4_000, 4_001, 24);
        assert!(too_many_pixels.len() < MAX_IMAGE_DIB_BYTES);
        assert!(!is_supported_dib(&too_many_pixels));

        let mut oversized = max_pixels;
        oversized.push(0);
        assert!(!is_supported_dib(&oversized));
    }
}
