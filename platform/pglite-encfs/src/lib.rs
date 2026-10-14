//! Encrypting `wasi:filesystem@0.2.9` layer for the di-framework pglite component.
//!
//! `wac plug --plug pglite-encfs.wasm di-framework-pglite.wasm` puts it
//! between pglite and the host. Every regular file under a preopen is stored
//! as `[4 KiB header][AES-256-XTS units...]`:
//!
//! - [`keys`]: the master key from `DI_PGLITE_KEY` (and `DI_PGLITE_KEY_PREVIOUS`
//!   during rotation), the KEK and key-check value derived from it.
//! - [`header`]: the per-file header holding a random DEK wrapped by the KEK.
//! - [`codec`]: AES-256-XTS over 4 KiB units.
//! - [`file`]: logical reads, writes and resizes over the physical file.
//! - [`marker`]: the key marker that locks a preopen before anything is touched.
//! - [`rotation`]: the sweep that re-wraps every header during a key rotation.
//!
//! The WASI glue (`component`) is only built for Wasm; everything else is
//! plain Rust with host unit tests. See README.md for the threat model, key
//! custody and rotation.

pub mod codec;
pub mod file;
pub mod header;
pub mod keys;
pub mod marker;
pub mod rotation;

#[cfg(target_arch = "wasm32")]
mod component;
