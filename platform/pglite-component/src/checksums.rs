//! PostgreSQL page checksums (`data_checksums`, `src/include/storage/checksum_impl.h`)
//! and `global/pg_control` checksum-version stamping (`src/bin/pg_checksums/pg_checksums.c`).
//!
//! Enables 16-bit FNV-1a page checksums on newly initialized clusters so that
//! PostgreSQL verifies every 8 KiB heap or index page on read (`PageIsVerifiedExtended`,
//! raising SQLSTATE `XX001` on corruption) and stamps `pd_checksum` on every page write
//! (`PageSetChecksumCopy` / `PageSetChecksumInplace`).

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;

/// PostgreSQL page size (`BLCKSZ`).
pub const BLCKSZ: usize = 8192;

/// Version recorded in `ControlFileData.data_checksum_version` when enabled.
pub const PG_DATA_CHECKSUM_VERSION: u32 = 1;

/// Blocks per relation segment file (`RELSEG_SIZE = 1 GiB / 8 KiB`).
pub const RELSEG_SIZE: u32 = 131_072;

/// Byte offset of `pd_checksum` (`uint16`) in `PageHeaderData`.
const PD_CHECKSUM_OFFSET: usize = 8;

/// Byte offset of `pd_upper` (`uint16`) in `PageHeaderData`.
const PD_UPPER_OFFSET: usize = 14;

/// Byte offset of `blcksz` (`uint32`) in `ControlFileData`.
const CONTROL_BLCKSZ_OFFSET: usize = 216;

/// Byte offset of `data_checksum_version` (`uint32`) in `ControlFileData`.
const CONTROL_CHECKSUM_VERSION_OFFSET: usize = 252;

/// Byte offset of `crc` (`pg_crc32c`) in PostgreSQL 18 `ControlFileData` (`PG_CONTROL_VERSION = 1800`),
/// following `data_checksum_version` (`252..256`), `default_char_signedness` (`256`),
/// `mock_authentication_nonce[32]` (`257..289`), and 3 bytes of alignment padding (`289..292`).
const CONTROL_CRC_OFFSET: usize = 292;

/// Minimum bytes needed to inspect and update `ControlFileData` through `crc`.
const CONTROL_MIN_LEN: usize = CONTROL_CRC_OFFSET + 4;

/// Parallel FNV-1a lanes (`N_SUMS` in `checksum_impl.h`).
const N_SUMS: usize = 32;

/// 32-bit FNV-1a prime (`FNV_PRIME` in `checksum_impl.h`).
const FNV_PRIME: u32 = 16_777_619;

/// Initial state for the 32 parallel FNV-1a accumulators (`checksumBaseOffsets`).
const CHECKSUM_BASE_OFFSETS: [u32; N_SUMS] = [
    0x5B1F_36E9,
    0xB852_5960,
    0x02AB_50AA,
    0x1DE6_6D2A,
    0x79FF_467A,
    0x9BB9_F8A3,
    0x217E_7CD2,
    0x83E1_3D2C,
    0xF8D4_474F,
    0xE39E_B970,
    0x42C6_AE16,
    0x9932_16FA,
    0x7B09_3B5D,
    0x98DA_FF3C,
    0xF718_902A,
    0x0B1C_9CDB,
    0xE58F_764B,
    0x1876_36BC,
    0x5D7B_3BB1,
    0xE73D_E7DE,
    0x92BE_C979,
    0xCCA6_C0B2,
    0x304A_0979,
    0x85AA_43D4,
    0x7831_25BB,
    0x6CA8_EAA2,
    0xE407_EAC6,
    0x4B5C_FC3E,
    0x9FBF_8C76,
    0x15CA_20BE,
    0xF2CA_9FD3,
    0x959B_D756,
];

#[inline]
fn checksum_comp(checksum: u32, value: u32) -> u32 {
    let tmp = checksum ^ value;
    tmp.wrapping_mul(FNV_PRIME) ^ (tmp >> 17)
}

/// Whether `page` is uninitialized (`PageIsNew`: `pd_upper == 0`).
///
/// PostgreSQL skips checksum computation and verification on new pages.
#[inline]
pub fn is_new_page(page: &[u8; BLCKSZ]) -> bool {
    u16::from_le_bytes([page[PD_UPPER_OFFSET], page[PD_UPPER_OFFSET + 1]]) == 0
}

/// Read `pd_checksum` from an 8 KiB page header.
#[inline]
pub fn page_checksum(page: &[u8; BLCKSZ]) -> u16 {
    u16::from_le_bytes([page[PD_CHECKSUM_OFFSET], page[PD_CHECKSUM_OFFSET + 1]])
}

/// Compute PostgreSQL's 16-bit FNV-1a checksum (`pg_checksum_page`) for `page` at `blkno`.
///
/// Bytes `8..10` (`pd_checksum`) are treated as zero during the calculation, matching
/// `pg_checksum_page` in `src/include/storage/checksum_impl.h`.
pub fn compute_page_checksum(page: &[u8; BLCKSZ], blkno: u32) -> u16 {
    let mut sums = CHECKSUM_BASE_OFFSETS;
    const ROWS: usize = BLCKSZ / (4 * N_SUMS);
    for row in 0..ROWS {
        let row_base = row * (4 * N_SUMS);
        for (col, sum) in sums.iter_mut().enumerate() {
            let offset = row_base + col * 4;
            let word = if offset == PD_CHECKSUM_OFFSET {
                // Zero out the 16-bit `pd_checksum` (bytes 8..10), keeping `pd_flags` (bytes 10..12).
                u32::from_le_bytes([0, 0, page[offset + 2], page[offset + 3]])
            } else {
                u32::from_le_bytes([
                    page[offset],
                    page[offset + 1],
                    page[offset + 2],
                    page[offset + 3],
                ])
            };
            *sum = checksum_comp(*sum, word);
        }
    }
    for _ in 0..2 {
        for sum in &mut sums {
            *sum = checksum_comp(*sum, 0);
        }
    }
    let mut result = 0u32;
    for sum in sums {
        result ^= sum;
    }
    result ^= blkno;
    ((result % 65535) + 1) as u16
}

/// Stamp `pd_checksum` on `page` in place if it is initialized and does not already
/// carry the expected checksum. Returns `true` when `page` was modified.
pub fn stamp_page_checksum(page: &mut [u8; BLCKSZ], blkno: u32) -> bool {
    if is_new_page(page) {
        return false;
    }
    let expected = compute_page_checksum(page, blkno);
    if page_checksum(page) == expected {
        return false;
    }
    let bytes = expected.to_le_bytes();
    page[PD_CHECKSUM_OFFSET] = bytes[0];
    page[PD_CHECKSUM_OFFSET + 1] = bytes[1];
    true
}

/// Castagnoli CRC-32C (`pg_comp_crc32c` + `FIN_CRC32C`).
pub fn crc32c(bytes: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &byte in bytes {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0x82F6_3B78 & mask);
        }
    }
    !crc
}

/// Read `data_checksum_version` from a `global/pg_control` buffer after validating
/// its size, `blcksz`, and CRC-32C.
pub fn control_checksum_version(control: &[u8]) -> Result<u32, String> {
    if control.len() < CONTROL_MIN_LEN {
        return Err(format!(
            "pg_control is too short ({} bytes, expected at least {CONTROL_MIN_LEN})",
            control.len()
        ));
    }
    let stored_crc = u32::from_le_bytes([
        control[CONTROL_CRC_OFFSET],
        control[CONTROL_CRC_OFFSET + 1],
        control[CONTROL_CRC_OFFSET + 2],
        control[CONTROL_CRC_OFFSET + 3],
    ]);
    let computed_crc = crc32c(&control[..CONTROL_CRC_OFFSET]);
    if stored_crc != computed_crc {
        return Err(format!(
            "pg_control CRC mismatch: stored 0x{stored_crc:08x}, computed 0x{computed_crc:08x}"
        ));
    }
    let blcksz = u32::from_le_bytes([
        control[CONTROL_BLCKSZ_OFFSET],
        control[CONTROL_BLCKSZ_OFFSET + 1],
        control[CONTROL_BLCKSZ_OFFSET + 2],
        control[CONTROL_BLCKSZ_OFFSET + 3],
    ]);
    if blcksz as usize != BLCKSZ {
        return Err(format!(
            "incompatible pg_control block size {blcksz} (expected {BLCKSZ})"
        ));
    }
    Ok(u32::from_le_bytes([
        control[CONTROL_CHECKSUM_VERSION_OFFSET],
        control[CONTROL_CHECKSUM_VERSION_OFFSET + 1],
        control[CONTROL_CHECKSUM_VERSION_OFFSET + 2],
        control[CONTROL_CHECKSUM_VERSION_OFFSET + 3],
    ]))
}

/// Update `data_checksum_version` and recompute `crc` in a `global/pg_control` buffer.
/// Returns `Ok(true)` if the version changed.
pub fn set_control_checksum_version(control: &mut [u8], version: u32) -> Result<bool, String> {
    let current = control_checksum_version(control)?;
    if current == version {
        return Ok(false);
    }
    control[CONTROL_CHECKSUM_VERSION_OFFSET..CONTROL_CHECKSUM_VERSION_OFFSET + 4]
        .copy_from_slice(&version.to_le_bytes());
    let new_crc = crc32c(&control[..CONTROL_CRC_OFFSET]);
    control[CONTROL_CRC_OFFSET..CONTROL_CRC_OFFSET + 4].copy_from_slice(&new_crc.to_le_bytes());
    Ok(true)
}

/// Whether a file inside `global/` or `base/<dboid>/` is excluded from page checksums
/// (`skip[]` and temporary prefixes in `src/bin/pg_checksums/pg_checksums.c`).
pub fn is_skipped_file(name: &str) -> bool {
    matches!(
        name,
        "pg_control" | "pg_filenode.map" | "PG_VERSION" | ".DS_Store"
    ) || name.starts_with("pg_internal.init")
        || name.starts_with("pgsql_tmp")
        || name.starts_with("config_exec_params")
        || name.ends_with(".di-tmp")
}

/// Parse the segment number from a relation file name (e.g. `"1259.2"` -> `Some(2)`,
/// `"1259"` or `"1259_fsm"` -> `Some(0)`). Returns `None` if a `.` suffix is not a
/// positive integer.
pub fn parse_segment_number(name: &str) -> Option<u32> {
    match name.split_once('.') {
        None => Some(0),
        Some((_, seg)) => {
            let n: u32 = seg.parse().ok()?;
            (n > 0).then_some(n)
        }
    }
}

/// Stamp valid checksums on all initialized pages of a single relation file.
/// Returns the number of blocks rewritten.
pub fn stamp_relation_file(path: &Path, segmentno: u32) -> Result<usize, String> {
    let mut buf = fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    if buf.is_empty() {
        return Ok(0);
    }
    if buf.len() % BLCKSZ != 0 {
        return Err(format!(
            "relation file {} has non-page-aligned size {}",
            path.display(),
            buf.len()
        ));
    }
    let base_blkno = segmentno
        .checked_mul(RELSEG_SIZE)
        .ok_or_else(|| format!("segment number overflow in {}", path.display()))?;
    let mut rewritten = 0usize;
    for (block_idx, page) in buf.as_chunks_mut::<BLCKSZ>().0.iter_mut().enumerate() {
        let blkno = base_blkno + (block_idx as u32);
        if stamp_page_checksum(page, blkno) {
            rewritten += 1;
        }
    }
    if rewritten > 0 {
        // Overwrite in place without `O_TRUNC` (`fs::write`) or `rename` (`write_atomic`):
        // 1. Avoiding `O_TRUNC` ensures the relation file is never truncated to 0 bytes.
        // 2. Avoiding `rename` preserves the inode that `BOOTSTRAP_ENGINE`'s `VfdCache`
        //    already holds open between `pgl_initdb()` and `pgl_backend()` (`RePostgresSingleUserMain`).
        // Crash atomicity is governed by `global/pg_control`, which is updated last via
        // `write_atomic` after all relation pages carry valid checksums.
        let mut file = OpenOptions::new()
            .write(true)
            .open(path)
            .map_err(|e| format!("open {}: {e}", path.display()))?;
        file.write_all(&buf)
            .map_err(|e| format!("write {}: {e}", path.display()))?;
    }
    Ok(rewritten)
}

fn scan_checksum_dir(dir: &Path) -> Result<usize, String> {
    let mut rewritten = 0usize;
    for entry in fs::read_dir(dir).map_err(|e| format!("read_dir {}: {e}", dir.display()))? {
        let entry = entry.map_err(|e| format!("read_dir entry {}: {e}", dir.display()))?;
        let file_name = entry.file_name();
        let Some(name) = file_name.to_str() else {
            continue;
        };
        if is_skipped_file(name) {
            continue;
        }
        let file_type = entry
            .file_type()
            .map_err(|e| format!("file_type {}: {e}", entry.path().display()))?;
        let path = entry.path();
        if file_type.is_dir() {
            rewritten += scan_checksum_dir(&path)?;
        } else if file_type.is_file() {
            let segmentno = parse_segment_number(name).ok_or_else(|| {
                format!("invalid segment number in relation file {}", path.display())
            })?;
            rewritten += stamp_relation_file(&path, segmentno)?;
        }
    }
    Ok(rewritten)
}

/// Enable `data_checksums` across `data` (`global/` and `base/`) and update
/// `global/pg_control` (`data_checksum_version = 1` + CRC-32C).
///
/// Mirrors `pg_checksums --enable`: stamps all relation pages first and updates
/// `global/pg_control` last so an interrupted pass leaves `data_checksum_version`
/// disabled until every page carries a valid checksum.
pub fn enable_cluster_checksums(data: &Path) -> Result<usize, String> {
    let mut rewritten = 0usize;
    for subdir in ["global", "base"] {
        let dir = data.join(subdir);
        if dir.is_dir() {
            rewritten += scan_checksum_dir(&dir)?;
        }
    }
    let control_path = data.join("global/pg_control");
    let mut control =
        fs::read(&control_path).map_err(|e| format!("read {}: {e}", control_path.display()))?;
    if set_control_checksum_version(&mut control, PG_DATA_CHECKSUM_VERSION)? {
        crate::engine::write_atomic(&control_path, &control, false)?;
    }
    Ok(rewritten)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "df-pglite-csum-{name}-{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn sample_control_file(version: u32) -> Vec<u8> {
        let mut buf = vec![0u8; BLCKSZ];
        // pg_control_version = 1800 at offset 8
        buf[8..12].copy_from_slice(&1800u32.to_le_bytes());
        // blcksz = 8192 at offset 216
        buf[CONTROL_BLCKSZ_OFFSET..CONTROL_BLCKSZ_OFFSET + 4]
            .copy_from_slice(&(BLCKSZ as u32).to_le_bytes());
        buf[CONTROL_CHECKSUM_VERSION_OFFSET..CONTROL_CHECKSUM_VERSION_OFFSET + 4]
            .copy_from_slice(&version.to_le_bytes());
        let crc = crc32c(&buf[..CONTROL_CRC_OFFSET]);
        buf[CONTROL_CRC_OFFSET..CONTROL_CRC_OFFSET + 4].copy_from_slice(&crc.to_le_bytes());
        buf
    }

    #[test]
    fn crc32c_matches_standard_check_value() {
        // Standard Castagnoli CRC-32C check value for ASCII "123456789".
        assert_eq!(crc32c(b"123456789"), 0xE306_9283);
    }

    #[test]
    fn new_pages_are_skipped_and_initialized_pages_are_stamped_idempotently() {
        let mut page = [0u8; BLCKSZ];
        assert!(is_new_page(&page));
        assert!(!stamp_page_checksum(&mut page, 0));

        // Initialize pd_lower = 24, pd_upper = 8160.
        page[12..14].copy_from_slice(&24u16.to_le_bytes());
        page[PD_UPPER_OFFSET..PD_UPPER_OFFSET + 2].copy_from_slice(&8160u16.to_le_bytes());
        page[8160] = 0xAB;
        assert!(!is_new_page(&page));

        assert!(stamp_page_checksum(&mut page, 7));
        let csum = page_checksum(&page);
        assert_ne!(csum, 0);
        assert_eq!(compute_page_checksum(&page, 7), csum);
        // Second stamp is a no-op because pd_checksum already matches.
        assert!(!stamp_page_checksum(&mut page, 7));
        // Different block number changes the checksum (catches transposed pages).
        assert_ne!(compute_page_checksum(&page, 8), csum);
        // Flipping a payload bit invalidates the checksum.
        page[8160] ^= 1;
        assert_ne!(compute_page_checksum(&page, 7), csum);
    }

    #[test]
    fn control_file_checksum_version_validates_and_updates_crc() {
        let mut ctrl = sample_control_file(0);
        assert_eq!(control_checksum_version(&ctrl), Ok(0));
        assert_eq!(set_control_checksum_version(&mut ctrl, 1), Ok(true));
        assert_eq!(control_checksum_version(&ctrl), Ok(1));
        assert_eq!(set_control_checksum_version(&mut ctrl, 1), Ok(false));

        // Short buffer is rejected.
        assert!(control_checksum_version(&ctrl[..100]).is_err());

        // Bad block size is rejected.
        let mut bad_blk = sample_control_file(0);
        bad_blk[CONTROL_BLCKSZ_OFFSET..CONTROL_BLCKSZ_OFFSET + 4]
            .copy_from_slice(&4096u32.to_le_bytes());
        let crc = crc32c(&bad_blk[..CONTROL_CRC_OFFSET]);
        bad_blk[CONTROL_CRC_OFFSET..CONTROL_CRC_OFFSET + 4].copy_from_slice(&crc.to_le_bytes());
        assert!(control_checksum_version(&bad_blk)
            .unwrap_err()
            .contains("incompatible pg_control block size"));

        // Corrupted CRC is rejected.
        ctrl[0] ^= 0xFF;
        assert!(control_checksum_version(&ctrl)
            .unwrap_err()
            .contains("CRC mismatch"));
    }

    #[test]
    fn skip_and_segment_parsing_follow_pg_checksums_rules() {
        assert!(is_skipped_file("pg_control"));
        assert!(is_skipped_file("pg_filenode.map"));
        assert!(is_skipped_file("PG_VERSION"));
        assert!(is_skipped_file("pg_internal.init"));
        assert!(is_skipped_file("pg_internal.init.123"));
        assert!(is_skipped_file("pgsql_tmp1234"));
        assert!(is_skipped_file("1259.di-tmp"));
        assert!(!is_skipped_file("1259"));
        assert!(!is_skipped_file("1259_fsm"));
        assert!(!is_skipped_file("1259.1"));

        assert_eq!(parse_segment_number("1259"), Some(0));
        assert_eq!(parse_segment_number("1259_vm"), Some(0));
        assert_eq!(parse_segment_number("1259.1"), Some(1));
        assert_eq!(parse_segment_number("1259_fsm.3"), Some(3));
        assert_eq!(parse_segment_number("1259.0"), None);
        assert_eq!(parse_segment_number("1259.bad"), None);
    }

    #[test]
    fn enable_cluster_checksums_stamps_relations_and_control_file() {
        let tmp = TempDir::new("cluster");
        let data = &tmp.0;
        fs::create_dir_all(data.join("global")).unwrap();
        fs::create_dir_all(data.join("base/5")).unwrap();
        fs::write(data.join("global/pg_control"), sample_control_file(0)).unwrap();
        fs::write(data.join("global/pg_filenode.map"), [1u8; 524]).unwrap();
        fs::write(data.join("base/5/PG_VERSION"), "18\n").unwrap();
        fs::write(data.join("base/5/1259_vm"), []).unwrap();

        let mut rel = vec![0u8; BLCKSZ * 2];
        // Block 0: initialized; Block 1: new (pd_upper == 0).
        rel[PD_UPPER_OFFSET..PD_UPPER_OFFSET + 2].copy_from_slice(&8000u16.to_le_bytes());
        fs::write(data.join("base/5/1259"), &rel).unwrap();

        let rewritten = enable_cluster_checksums(data).unwrap();
        assert_eq!(rewritten, 1);
        let ctrl = fs::read(data.join("global/pg_control")).unwrap();
        assert_eq!(control_checksum_version(&ctrl), Ok(1));

        let stamped = fs::read(data.join("base/5/1259")).unwrap();
        let page0: &[u8; BLCKSZ] = stamped[..BLCKSZ].try_into().unwrap();
        let page1: &[u8; BLCKSZ] = stamped[BLCKSZ..].try_into().unwrap();
        assert_eq!(page_checksum(page0), compute_page_checksum(page0, 0));
        assert_eq!(page_checksum(page1), 0);

        // Re-running is idempotent and rewrites 0 blocks.
        assert_eq!(enable_cluster_checksums(data).unwrap(), 0);

        // Non-page-aligned relation file fails cleanly.
        fs::write(data.join("base/5/bad_align"), [0u8; 100]).unwrap();
        assert!(enable_cluster_checksums(data)
            .unwrap_err()
            .contains("non-page-aligned"));
    }
}
