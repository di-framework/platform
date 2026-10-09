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
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
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
        let name = path.strip_prefix(root).unwrap().to_str().unwrap();
        if name == "bin/pglite.wasi" {
            continue;
        }
        source.push_str(&format!(
            "({name:?}, include_bytes!({:?})),\n",
            fs::canonicalize(&path).unwrap()
        ));
    }
    source.push_str("];\n");
    fs::write(
        Path::new(&env::var("OUT_DIR").unwrap()).join("assets.rs"),
        source,
    )
    .unwrap();
}
