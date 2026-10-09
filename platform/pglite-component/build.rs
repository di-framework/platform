use std::{env, fs, path::Path};

fn main() {
    let root = Path::new("target/engine/runtime");
    println!("cargo:rerun-if-changed=scripts/tool-versions.env");
    println!("cargo:rerun-if-changed=target/engine/stamp");
    assert!(
        root.join("bin/pglite.wasi").exists(),
        "run scripts/prepare-engine.py before cargo build"
    );
    fn collect(dir: &Path, files: &mut Vec<std::path::PathBuf>) {
        // Build-time helper on the host: `expect` documents unreachable I/O
        // (a missing `target/engine/runtime` is caught by the assert above).
        for entry in fs::read_dir(dir).expect("unreachable: engine runtime dir is prepared") {
            let path = entry
                .expect("unreachable: engine runtime entry is readable")
                .path();
            if path.is_dir() {
                collect(&path, files);
            } else {
                files.push(path);
            }
        }
    }
    let mut files = Vec::new();
    collect(root, &mut files);
    files.sort();
    let mut source = String::from("const ASSETS: &[(&str, &[u8])] = &[\n");
    for path in files {
        let name = path
            .strip_prefix(root)
            .expect("unreachable: asset path is under the runtime dir")
            .to_str()
            .expect("unreachable: asset names are UTF-8");
        if name == "bin/pglite.wasi" {
            continue;
        }
        source.push_str(&format!(
            "({name:?}, include_bytes!({:?})),\n",
            fs::canonicalize(&path).expect("unreachable: asset file exists")
        ));
    }
    source.push_str("];\n");
    let out_dir = env::var("OUT_DIR").expect("unreachable: cargo sets OUT_DIR");
    fs::write(Path::new(&out_dir).join("assets.rs"), source)
        .expect("unreachable: OUT_DIR is writable");
}
