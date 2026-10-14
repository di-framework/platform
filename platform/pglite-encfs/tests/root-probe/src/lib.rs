//! Smoke probe for the root guard (#207): every directory descriptor that
//! names the preopen root, however it was opened, must hide the `.di-encfs`
//! marker from listings and refuse to touch it. pglite's own I/O cannot reach
//! these paths on demand, so this component drives encfs's `wasi:filesystem`
//! export directly.
//!
//! The same holds for a path that reaches the root through a symlink partway
//! through it, or a chain of them (#349), while ordinary symlinks keep working.

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
/// Below `pglite`: `up -> ..` (the root), `c1 -> c2 -> ..` (a chain to it)
/// and `ok -> data` (an ordinary link).
const UP: &str = "root-probe-up";
const CHAIN: &str = "root-probe-c1";
const CHAIN_NEXT: &str = "root-probe-c2";
const OK: &str = "root-probe-ok";

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

    // #349: symlinks partway through the path. Every link is removed again,
    // whatever the checks found.
    let links = [
        ("..", UP),
        (CHAIN_NEXT, CHAIN),
        ("..", CHAIN_NEXT),
        ("data", OK),
    ];
    let mut made = Vec::new();
    let mut result = Ok(());
    for (target, name) in links {
        let link = format!("pglite/{name}");
        match root.symlink_at(target, &link) {
            Ok(()) => made.push(link),
            Err(e) => {
                result = Err(format!("symlink {link} -> {target}: {e:?}"));
                break;
            }
        }
    }
    let result = result.and_then(|()| mid_path(&root));
    for link in made.iter().rev() {
        root.unlink_file_at(link)
            .map_err(|e| format!("unlink {link}: {e:?}"))?;
    }
    result?;

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

/// Paths that reach the root through `pglite/root-probe-*` links (#349).
fn mid_path(root: &Descriptor) -> Result<(), String> {
    let up = format!("pglite/{UP}");
    let chain = format!("pglite/{CHAIN}");
    for prefix in [
        up.clone(),
        chain.clone(),
        format!("pglite/{CHAIN_NEXT}"),
        format!("{up}/"),
        format!("{up}/."),
        format!("{chain}/pglite/{UP}"),
        format!("pglite/data/../{UP}"),
    ] {
        check_unreachable(root, &prefix)?;
        // The directory itself is the root under another name.
        let dir = open_dir(root, PathFlags::SYMLINK_FOLLOW, &prefix)?;
        check_root(&prefix, &dir)?;
    }
    // From a descriptor below the root, through the same links.
    let pglite = open_dir(root, PathFlags::empty(), "pglite")?;
    for prefix in [UP, CHAIN] {
        check_unreachable(&pglite, prefix)?;
    }

    // A link whose target names a marker is never created.
    for target in [MARKER, "../.di-encfs", "../.di-encfs.tmp", "x/.di-encfs/y"] {
        let link = format!("pglite/{LOOP}");
        match root.symlink_at(target, &link) {
            Err(ErrorCode::Access) => {}
            other => {
                let _ = root.unlink_file_at(&link);
                return Err(format!(
                    "symlink {link} -> {target}: expected access, got {other:?}"
                ));
            }
        }
    }

    // Ordinary links keep working: `pglite/root-probe-ok` is `pglite/data`.
    let ok = format!("pglite/{OK}");
    let data = open_dir(root, PathFlags::SYMLINK_FOLLOW, &ok)?;
    let names = list(&ok, &data)?;
    if !names.iter().any(|n| n == "PG_VERSION") {
        return Err(format!("{ok}: not pglite/data: {names:?}"));
    }
    for (dir, path) in [
        (root, format!("{ok}/PG_VERSION")),
        (&pglite, format!("{OK}/PG_VERSION")),
        (root, format!("pglite/{CHAIN}/pglite/{OK}/PG_VERSION")),
    ] {
        let file = dir
            .open_at(
                PathFlags::empty(),
                &path,
                OpenFlags::empty(),
                DescriptorFlags::READ,
            )
            .map_err(|e| format!("open {path}: {e:?}"))?;
        let (bytes, _) = file
            .read(16, 0)
            .map_err(|e| format!("read {path}: {e:?}"))?;
        if bytes.is_empty() || !bytes.iter().all(u8::is_ascii) {
            return Err(format!("{path}: not readable plaintext: {bytes:?}"));
        }
    }
    // A marker name below the root is an ordinary, absent name.
    for (dir, path) in [
        (root, format!("{ok}/{MARKER}")),
        (&pglite, format!("{OK}/{MARKER}")),
    ] {
        match dir.stat_at(PathFlags::empty(), &path) {
            Err(ErrorCode::NoEntry) => {}
            other => {
                return Err(format!(
                    "{path}: expected no-entry, got {:?}",
                    other.map(|_| ())
                ))
            }
        }
    }
    Ok(())
}

/// Every operation on `<prefix>/.di-encfs` (and the temporary name) from
/// `dir` must fail with `access` and leave the marker as it was.
fn check_unreachable(dir: &Descriptor, prefix: &str) -> Result<(), String> {
    for name in [MARKER, MARKER_TMP] {
        let path = format!("{prefix}/{name}");
        let refused = |what: &str, result: Result<(), ErrorCode>| match result {
            Err(ErrorCode::Access) => Ok(()),
            other => Err(format!("{what} {path}: expected access, got {other:?}")),
        };
        for flags in [PathFlags::empty(), PathFlags::SYMLINK_FOLLOW] {
            refused("stat", dir.stat_at(flags, &path).map(|_| ()))?;
            refused(
                "metadata-hash",
                dir.metadata_hash_at(flags, &path).map(|_| ()),
            )?;
        }
        refused(
            "open",
            dir.open_at(
                PathFlags::empty(),
                &path,
                OpenFlags::empty(),
                DescriptorFlags::READ,
            )
            .map(|_| ()),
        )?;
        refused(
            "create",
            dir.open_at(
                PathFlags::empty(),
                &path,
                OpenFlags::CREATE | OpenFlags::TRUNCATE,
                DescriptorFlags::READ | DescriptorFlags::WRITE,
            )
            .map(|_| ()),
        )?;
        refused("rename from", dir.rename_at(&path, dir, "root-probe-moved"))?;
        // The source does not exist: only the guard can answer `access`.
        refused("rename to", dir.rename_at("root-probe-none", dir, &path))?;
        refused("unlink", dir.unlink_file_at(&path))?;
        refused("readlink", dir.readlink_at(&path).map(|_| ()))?;
        refused("mkdir", dir.create_directory_at(&path))?;
        refused("rmdir", dir.remove_directory_at(&path))?;
        refused("symlink", dir.symlink_at("pglite", &path))?;
    }
    Ok(())
}

fn list(label: &str, dir: &Descriptor) -> Result<Vec<String>, String> {
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
    Ok(names)
}

fn open_dir(root: &Descriptor, flags: PathFlags, path: &str) -> Result<Descriptor, String> {
    root.open_at(flags, path, OpenFlags::DIRECTORY, DescriptorFlags::READ)
        .map_err(|e| format!("open {path}: {e:?}"))
}

fn check_root(label: &str, dir: &Descriptor) -> Result<(), String> {
    let names = list(label, dir)?;
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
