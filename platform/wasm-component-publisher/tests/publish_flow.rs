//! End-to-end publish flow against fake `wash` and `oras` executables: the
//! publisher uploads the layer and config blobs, pushes the manifest under
//! the commit tag, verifies it with a `wash` pull by digest, and only then
//! points the version tag at it. That manifest (and so its digest) depends
//! only on the component, not on when or under which tag it is published. Single test
//! function: it edits the process environment, so scenarios run sequentially.
#![cfg(unix)]

use sha2::{Digest, Sha256};
use std::{
    env, fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};
use wasm_component_publisher::{ComponentSpec, run};

const MANIFEST_PUSH: &str =
    "oras manifest push --plain-http --media-type application/vnd.oci.image.manifest.v1+json";

fn script(dir: &Path, name: &str, body: &str) {
    let path = dir.join(name);
    fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
}

fn spec() -> ComponentSpec {
    ComponentSpec {
        wasm_file: "c.wasm",
        wit_file: "c.wit",
        build_info_file: "BUILD-INFO.txt",
        required_export: "a:b/c@0.2.0",
        default_repository: "o/r",
        report_file_name: "report.json",
        log_prefix: "test",
        version_tag: Some("0.2.0".to_owned()),
        import_prefixes: Some(&["wasi:"]),
    }
}

fn sha256(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

/// Writes `dist/` with `wasm` and a build time in BUILD-INFO.txt.
fn write_dist(dist: &Path, wasm: &[u8], built: &str) {
    let files = [
        ("c.wasm", wasm.to_vec()),
        (
            "c.wit",
            b"world root {\n  import wasi:io/error@0.2.9;\n  export a:b/c@0.2.0;\n}\n".to_vec(),
        ),
        ("BUILD-INFO.txt", format!("built: {built}\n").into_bytes()),
    ];
    let mut sums = String::new();
    for (name, bytes) in &files {
        fs::write(dist.join(name), bytes).unwrap();
        sums.push_str(&format!("{:x}  {name}\n", Sha256::digest(bytes)));
    }
    fs::write(dist.join("SHA256SUMS"), sums).unwrap();
}

/// The published manifest digest and bytes, after checking the report.
fn published(root: &Path, dist: &Path) -> (String, Vec<u8>) {
    let manifest = fs::read(root.join("manifest.json")).unwrap();
    let report: serde_json::Value =
        serde_json::from_slice(&fs::read(dist.join("report.json")).unwrap()).unwrap();
    let digest = sha256(&manifest);
    assert_eq!(report["manifestDigest"], digest);
    for entry in report["tags"].as_array().unwrap() {
        assert_eq!(entry["manifestDigest"], digest);
    }
    (digest, manifest)
}

#[test]
fn publishes_one_deterministic_manifest_for_every_tag() {
    let root = env::temp_dir().join(format!("publish-flow-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    let (bin, package) = (root.join("bin"), root.join("pkg"));
    let dist = package.join("dist");
    fs::create_dir_all(&bin).unwrap();
    fs::create_dir_all(&dist).unwrap();
    write_dist(&dist, b"wasm-bytes", "2026-01-01T00:00:00Z");

    let log: PathBuf = root.join("calls.log");
    // wash only pulls; a push through wash would stamp the wall clock.
    // FAKE_PULL=fail makes the pull fail, FAKE_PULL=corrupt returns other bytes.
    script(
        &bin,
        "wash",
        &format!(
            "echo \"wash $*\" >> '{log}'\n\
             case \"$2\" in\n\
               pull)\n\
                 if [ \"$FAKE_PULL\" = fail ]; then echo 'manifest unknown'; exit 1; fi\n\
                 for last; do :; done; cp '{wasm}' \"$last\"\n\
                 if [ \"$FAKE_PULL\" = corrupt ]; then echo x >> \"$last\"; fi ;;\n\
               *) exit 3 ;;\n\
             esac",
            log = log.display(),
            wasm = dist.join("c.wasm").display(),
        ),
    );
    // Blob pushes must match their digest; the manifest and config are kept
    // for inspection, and resolve answers with the pushed manifest's digest.
    script(
        &bin,
        "oras",
        &format!(
            "echo \"oras $*\" >> '{log}'\n\
             sum() {{ (sha256sum \"$1\" 2>/dev/null || shasum -a 256 \"$1\") | cut -d' ' -f1; }}\n\
             if [ -n \"$FAKE_PUSH_FAIL\" ]; then\n\
               auth=$(sed -n 's/.*\"auth\": *\"\\([^\"]*\\)\".*/\\1/p' \"$DOCKER_CONFIG/config.json\" | head -n 1)\n\
               echo \"denied for $auth env=[$GHCR_TOKEN$GITHUB_TOKEN$DI_OCI_PASSWORD]\"; exit 1\n\
             fi\n\
             for last; do :; done\n\
             case \"$1 $2\" in\n\
               'blob push')\n\
                 for arg; do case \"$arg\" in *@sha256:*) ref=\"$arg\" ;; esac; done\n\
                 if [ \"${{ref##*@}}\" != \"sha256:$(sum \"$last\")\" ]; then echo 'digest mismatch'; exit 1; fi\n\
                 case \"$last\" in *config.json) cp \"$last\" '{root}/config.json' ;; esac ;;\n\
               'manifest push') cp \"$last\" '{root}/manifest.json' ;;\n\
             esac\n\
             if [ \"$1\" = resolve ]; then\n\
               if [ -n \"$FAKE_RESOLVE\" ]; then echo \"$FAKE_RESOLVE\"\n\
               else echo \"sha256:$(sum '{root}/manifest.json')\"; fi\n\
             fi",
            log = log.display(),
            root = root.display(),
        ),
    );

    // SAFETY: this is the only test in this binary, so no other thread reads
    // or writes the environment while it changes.
    unsafe {
        let path = format!("{}:{}", bin.display(), env::var("PATH").unwrap());
        env::set_var("PATH", path);
        for (key, value) in [
            ("DI_OCI_REGISTRY", "localhost:5000"),
            ("DI_OCI_CLUSTER_REGISTRY", "localhost:5000"),
            ("DI_OCI_TAG", "commit1"),
        ] {
            env::set_var(key, value);
        }
        for key in [
            "DI_OCI_USERNAME",
            "DI_OCI_PASSWORD",
            "GHCR_USERNAME",
            "GHCR_TOKEN",
            "GITHUB_ACTOR",
            "GITHUB_TOKEN",
            "DI_OCI_REPOSITORY",
            "DI_OCI_DIST_DIR",
            "SOURCE_DATE_EPOCH",
        ] {
            env::remove_var(key);
        }
    }

    run(&package, &spec(), true).expect("publish");
    let calls = fs::read_to_string(&log).unwrap();
    assert!(!calls.contains("wash oci push"), "{calls}");
    let (digest, manifest) = published(&root, &dist);
    // Order: both blobs, then the manifest under the commit tag only, then
    // the wash pull by digest, and only then the movable version tag.
    let blob = "oras blob push --plain-http localhost:5000/o/r@sha256:";
    let steps: Vec<&str> = calls.lines().collect();
    let expected = [
        blob,
        blob,
        &format!("{MANIFEST_PUSH} localhost:5000/o/r:commit1 "),
        "oras resolve --plain-http localhost:5000/o/r:commit1",
        &format!("wash oci pull --non-interactive --insecure localhost:5000/o/r@{digest} "),
        &format!("oras tag --plain-http localhost:5000/o/r@{digest} 0.2.0"),
        "oras resolve --plain-http localhost:5000/o/r:0.2.0",
    ];
    assert_eq!(steps.len(), expected.len(), "{calls}");
    for (step, prefix) in steps.iter().zip(expected) {
        assert!(
            step.starts_with(prefix),
            "{step:?} should start with {prefix:?}\n{calls}"
        );
    }
    let report: serde_json::Value =
        serde_json::from_slice(&fs::read(dist.join("report.json")).unwrap()).unwrap();
    assert_eq!(report["tags"].as_array().unwrap().len(), 2);
    let config: serde_json::Value =
        serde_json::from_slice(&fs::read(root.join("config.json")).unwrap()).unwrap();
    assert_eq!(config["created"], "1970-01-01T00:00:00Z");
    assert_eq!(config["layerDigests"][0], sha256(b"wasm-bytes"));
    assert_eq!(config["component"]["imports"][0], "wasi:io/error@0.2.9");
    assert_eq!(config["component"]["exports"][0], "a:b/c@0.2.0");

    // Publishing the same component again, from another commit and after a
    // rebuild that only changed BUILD-INFO.txt, gives byte-identical config
    // and manifest, so the digest is unchanged.
    let config_bytes = fs::read(root.join("config.json")).unwrap();
    write_dist(&dist, b"wasm-bytes", "2026-02-02T00:00:00Z");
    unsafe { env::set_var("DI_OCI_TAG", "commit2") };
    run(&package, &spec(), true).expect("republish");
    assert_eq!(published(&root, &dist), (digest.clone(), manifest.clone()));
    assert_eq!(fs::read(root.join("config.json")).unwrap(), config_bytes);

    // SOURCE_DATE_EPOCH sets the created time, and with it the digest.
    unsafe { env::set_var("SOURCE_DATE_EPOCH", "1700000000") };
    run(&package, &spec(), true).expect("dated publish");
    let (dated, _) = published(&root, &dist);
    assert_ne!(dated, digest);
    let config: serde_json::Value =
        serde_json::from_slice(&fs::read(root.join("config.json")).unwrap()).unwrap();
    assert_eq!(config["created"], "2023-11-14T22:13:20Z");
    unsafe { env::set_var("SOURCE_DATE_EPOCH", "yesterday") };
    let error = run(&package, &spec(), true).unwrap_err().to_string();
    assert!(error.starts_with("SOURCE_DATE_EPOCH must be"), "{error}");
    // The publish workflows clear it (`SOURCE_DATE_EPOCH: ''`): empty is unset.
    unsafe { env::set_var("SOURCE_DATE_EPOCH", "") };
    run(&package, &spec(), true).expect("publish with a cleared epoch");
    assert_eq!(published(&root, &dist), (digest.clone(), manifest.clone()));
    unsafe { env::remove_var("SOURCE_DATE_EPOCH") };

    // A different component gets a different digest.
    write_dist(&dist, b"other-wasm-bytes", "2026-01-01T00:00:00Z");
    run(&package, &spec(), true).expect("publish other");
    let (other, _) = published(&root, &dist);
    assert_ne!(other, digest);
    assert_ne!(other, dated);

    // A pull that fails, or returns other bytes, stops the publish before
    // the version tag moves.
    for (mode, reason) in [
        (
            "fail",
            "wash oci pull failed (exit status: 1): stdout: manifest unknown",
        ),
        ("corrupt", "pulled Wasm differs from the local build"),
    ] {
        unsafe { env::set_var("FAKE_PULL", mode) };
        fs::write(&log, "").unwrap();
        let error = run(&package, &spec(), true).unwrap_err().to_string();
        assert_eq!(error, reason);
        let calls = fs::read_to_string(&log).unwrap();
        assert!(calls.contains("wash oci pull"), "{calls}");
        assert!(!calls.contains("oras tag"), "{calls}");
        assert!(!calls.contains(":0.2.0"), "{calls}");
    }
    unsafe { env::remove_var("FAKE_PULL") };

    // A tag that resolves to another manifest must fail the publish.
    unsafe { env::set_var("FAKE_RESOLVE", "sha256:bbbb") };
    let error = run(&package, &spec(), true).unwrap_err().to_string();
    assert!(error.contains("no digest"), "{error}");
    unsafe {
        env::set_var(
            "FAKE_RESOLVE",
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        )
    };
    let error = run(&package, &spec(), true).unwrap_err().to_string();
    assert!(error.contains("resolves to"), "{error}");

    // Single-tag components (oci-registry) push the manifest under the
    // commit tag and add no other tag.
    unsafe {
        env::remove_var("FAKE_RESOLVE");
        env::set_var("DI_OCI_TAG", "commit1");
    }
    fs::write(&log, "").unwrap();
    let single = ComponentSpec {
        version_tag: None,
        ..spec()
    };
    run(&package, &single, true).expect("single tag");
    let calls = fs::read_to_string(&log).unwrap();
    assert!(
        calls.contains(&format!("{MANIFEST_PUSH} localhost:5000/o/r:commit1 ")),
        "{calls}"
    );
    assert_eq!(calls.matches("oras resolve").count(), 1, "{calls}");
    assert!(!calls.contains("oras tag"), "{calls}");

    // A failed push reports what oras printed. oras never inherits the token
    // env; it sees the credential only as the base64 auth in DOCKER_CONFIG,
    // and that is masked when echoed.
    unsafe {
        env::set_var("FAKE_PUSH_FAIL", "1");
        env::set_var("GHCR_USERNAME", "bot");
        env::set_var("GHCR_TOKEN", "ghs_faketoken123");
        env::set_var("GITHUB_TOKEN", "ghs_othertoken456");
        env::set_var("DI_OCI_PASSWORD", "di-password-789");
    }
    let error = run(&package, &single, true).unwrap_err().to_string();
    assert_eq!(
        error,
        "oras blob push failed (exit status: 1): stdout: denied for [REDACTED] env=[]"
    );
    for secret in [
        "ghs_faketoken123",
        "ghs_othertoken456",
        "di-password-789",
        "Ym90OmRpLXBhc3N3b3JkLTc4OQ==",
    ] {
        assert!(!error.contains(secret), "{error}");
    }
    unsafe {
        for key in [
            "FAKE_PUSH_FAIL",
            "GHCR_USERNAME",
            "GHCR_TOKEN",
            "GITHUB_TOKEN",
            "DI_OCI_PASSWORD",
        ] {
            env::remove_var(key);
        }
    }
    let _ = fs::remove_dir_all(&root);
}
