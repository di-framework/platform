//! End-to-end publish flow against fake `wash` and `oras` executables:
//! one push, extra tags pointed at the same manifest digest, and a failure
//! when a tag resolves elsewhere. Single test function: it edits the process
//! environment, so scenarios run sequentially.
#![cfg(unix)]

use sha2::{Digest, Sha256};
use std::{
    env, fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};
use wasm_component_publisher::{ComponentSpec, run};

const DIGEST: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

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

#[test]
fn version_tag_points_at_the_pushed_manifest() {
    let root = env::temp_dir().join(format!("publish-flow-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    let (bin, package) = (root.join("bin"), root.join("pkg"));
    let dist = package.join("dist");
    fs::create_dir_all(&bin).unwrap();
    fs::create_dir_all(&dist).unwrap();
    let files = [
        ("c.wasm", b"wasm-bytes".to_vec()),
        (
            "c.wit",
            b"world root {\n  import wasi:io/error@0.2.9;\n  export a:b/c@0.2.0;\n}\n".to_vec(),
        ),
        ("BUILD-INFO.txt", b"info".to_vec()),
    ];
    let mut sums = String::new();
    for (name, bytes) in &files {
        fs::write(dist.join(name), bytes).unwrap();
        sums.push_str(&format!("{:x}  {name}\n", Sha256::digest(bytes)));
    }
    fs::write(dist.join("SHA256SUMS"), sums).unwrap();

    let log: PathBuf = root.join("calls.log");
    script(
        &bin,
        "wash",
        &format!(
            "echo \"wash $*\" >> '{log}'\n\
             if [ -n \"$FAKE_PUSH_FAIL\" ]; then\n\
               auth=$(sed -n 's/.*\"auth\": *\"\\([^\"]*\\)\".*/\\1/p' \"$DOCKER_CONFIG/config.json\" | head -n 1)\n\
               echo \"{{\\\"success\\\":false,\\\"message\\\":\\\"denied for $auth\\\",\\\"env\\\":\\\"[$GHCR_TOKEN$GITHUB_TOKEN$DI_OCI_PASSWORD]\\\"}}\"; exit 1\n\
             fi\n\
             case \"$2\" in\n\
               push) echo '{{\"success\":true,\"data\":{{\"digest\":\"{DIGEST}\"}}}}' ;;\n\
               pull) for last; do :; done; cp '{wasm}' \"$last\" ;;\n\
             esac",
            log = log.display(),
            wasm = dist.join("c.wasm").display(),
        ),
    );
    script(
        &bin,
        "oras",
        &format!(
            "echo \"oras $*\" >> '{log}'\n\
             if [ \"$1\" = resolve ]; then echo \"${{FAKE_RESOLVE:-{DIGEST}}}\"; fi",
            log = log.display(),
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
        ] {
            env::remove_var(key);
        }
    }

    run(&package, &spec(), true).expect("publish");
    let calls = fs::read_to_string(&log).unwrap();
    assert_eq!(calls.matches("wash oci push").count(), 1, "{calls}");
    assert!(
        calls.contains(&format!(
            "oras tag --plain-http localhost:5000/o/r@{DIGEST} 0.2.0"
        )),
        "{calls}"
    );
    assert!(calls.contains("oras resolve --plain-http localhost:5000/o/r:0.2.0"));
    let report: serde_json::Value =
        serde_json::from_slice(&fs::read(dist.join("report.json")).unwrap()).unwrap();
    assert_eq!(report["manifestDigest"], DIGEST);
    for entry in report["tags"].as_array().unwrap() {
        assert_eq!(entry["manifestDigest"], DIGEST);
    }
    assert_eq!(report["tags"].as_array().unwrap().len(), 2);

    // A version tag that resolves to another manifest must fail the publish.
    unsafe { env::set_var("FAKE_RESOLVE", "sha256:bbbb") };
    let _ = fs::write(&log, "");
    let error = run(&package, &spec(), true).unwrap_err().to_string();
    assert!(
        error.contains("no digest") || error.contains("resolves to"),
        "{error}"
    );
    unsafe {
        env::set_var(
            "FAKE_RESOLVE",
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        )
    };
    let error = run(&package, &spec(), true).unwrap_err().to_string();
    assert!(error.contains("resolves to"), "{error}");

    // Single-tag components (oci-registry) never call oras.
    unsafe { env::remove_var("FAKE_RESOLVE") };
    fs::write(&log, "").unwrap();
    let single = ComponentSpec {
        version_tag: None,
        ..spec()
    };
    run(&package, &single, true).expect("single tag");
    let calls = fs::read_to_string(&log).unwrap();
    assert!(!calls.contains("oras"), "{calls}");

    // A failed push reports what wash printed on stdout (its --output json
    // error). wash never inherits the token env; it sees the credential only
    // as the base64 auth in DOCKER_CONFIG, and that is masked when echoed.
    unsafe {
        env::set_var("FAKE_PUSH_FAIL", "1");
        env::set_var("GHCR_USERNAME", "bot");
        env::set_var("GHCR_TOKEN", "ghs_faketoken123");
        env::set_var("GITHUB_TOKEN", "ghs_othertoken456");
        env::set_var("DI_OCI_PASSWORD", "di-password-789");
    }
    let error = run(&package, &single, true).unwrap_err().to_string();
    assert!(
        error.starts_with("wash oci push failed (exit status: 1): stdout: {\"success\":false"),
        "{error}"
    );
    assert!(
        error.contains("\"message\":\"denied for [REDACTED]\",\"env\":\"[]\""),
        "{error}"
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
