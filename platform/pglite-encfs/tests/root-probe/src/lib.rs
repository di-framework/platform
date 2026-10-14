//! Smoke probe for the root guard (#207): every directory descriptor that
//! names the preopen root, however it was opened, must hide the `.di-encfs`
//! marker from listings and refuse to touch it. pglite's own I/O cannot reach
//! these paths on demand, so this component drives encfs's `wasi:filesystem`
//! export directly.

mod bindings {
    wit_bindgen::generate!({
        path: ["../../wit/world.wit", "wit"],
        world: "di-framework:pglite-encfs-probe/probe",
        generate_all,
    });
}

use bindings::wasi::filesystem::preopens;
use bindings::wasi::filesystem::types::{
    Descriptor, DescriptorFlags, ErrorCode, OpenFlags, PathFlags,
};

const MARKER: &str = ".di-encfs";
const MARKER_TMP: &str = ".di-encfs.tmp";
const LOOP: &str = "root-probe-loop";

struct Probe;

impl bindings::Guest for Probe {
    fn probe() -> String {
        match run() {
            Ok(()) => "root-probe ok".to_string(),
            Err(error) => format!("root-probe FAIL: {error}"),
        }
    }
}

bindings::export!(Probe with_types_in bindings);

fn run() -> Result<(), String> {
    let (root, _) = preopens::get_directories()
        .into_iter()
        .next()
        .ok_or("no preopened directory")?;
    check_root("the preopen", &root)?;
    for path in [".", "./", "pglite/..", "pglite/data/../.."] {
        let dir = open_dir(&root, PathFlags::empty(), path)?;
        check_root(path, &dir)?;
    }

    // A symlink back to the root: caught by identity, not by the path.
    root.symlink_at(".", LOOP)
        .map_err(|e| format!("symlink {LOOP} -> .: {e:?}"))?;
    let looped =
        open_dir(&root, PathFlags::SYMLINK_FOLLOW, LOOP).and_then(|dir| check_root(LOOP, &dir));
    root.unlink_file_at(LOOP)
        .map_err(|e| format!("unlink {LOOP}: {e:?}"))?;
    looped?;

    // Control: below the root the names are ordinary, so the guard is not
    // what refuses them there.
    let sub = open_dir(&root, PathFlags::empty(), "pglite")?;
    match sub.stat_at(PathFlags::empty(), MARKER) {
        Err(ErrorCode::NoEntry) => Ok(()),
        other => Err(format!(
            "pglite/{MARKER}: expected no-entry, got {:?}",
            other.map(|_| ())
        )),
    }
}

fn open_dir(root: &Descriptor, flags: PathFlags, path: &str) -> Result<Descriptor, String> {
    root.open_at(flags, path, OpenFlags::DIRECTORY, DescriptorFlags::READ)
        .map_err(|e| format!("open {path}: {e:?}"))
}

fn check_root(label: &str, dir: &Descriptor) -> Result<(), String> {
    let entries = dir
        .read_directory()
        .map_err(|e| format!("{label}: list: {e:?}"))?;
    let mut names = Vec::new();
    while let Some(entry) = entries
        .read_directory_entry()
        .map_err(|e| format!("{label}: list: {e:?}"))?
    {
        names.push(entry.name);
    }
    if !names.iter().any(|n| n == "pglite") {
        return Err(format!("{label}: not the data directory root: {names:?}"));
    }
    if names.iter().any(|n| n == MARKER || n == MARKER_TMP) {
        return Err(format!("{label}: the listing shows the marker"));
    }
    let refused = |what: &str, result: Result<(), ErrorCode>| match result {
        Err(ErrorCode::Access) => Ok(()),
        other => Err(format!(
            "{label}: {what} {MARKER}: expected access, got {other:?}"
        )),
    };
    refused("stat", dir.stat_at(PathFlags::empty(), MARKER).map(|_| ()))?;
    refused(
        "open",
        dir.open_at(
            PathFlags::empty(),
            MARKER,
            OpenFlags::empty(),
            DescriptorFlags::READ,
        )
        .map(|_| ()),
    )?;
    refused("rename", dir.rename_at(MARKER, dir, "root-probe-moved"))?;
    refused("unlink", dir.unlink_file_at(MARKER))?;
    Ok(())
}
