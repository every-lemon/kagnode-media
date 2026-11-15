use kagnode_core_manager::{
    Manager, Version, digest, validate_manifest, validate_summary, verified_manifest,
};
use serde_json::{Value, json};
use std::{io::Read, os::unix::fs::PermissionsExt};
const MANIFEST: &[u8] = include_bytes!("fixtures/core-manifest.json");
const SIGNATURE: &[u8] = include_bytes!("fixtures/core-manifest.sig");
const ARCHIVE: &[u8] = include_bytes!("fixtures/kagnode-core-5.0.11-ui.tar.gz");

#[test]
fn versions_are_bounded_to_reviewed_line_and_order_beta_before_stable() {
    assert!(Version::parse("5.0.11-beta.2").unwrap() < Version::parse("5.0.11").unwrap());
    assert!(Version::parse("5.0.10").unwrap() < Version::parse("5.0.11-beta.1").unwrap());
    for bad in [
        "5.1.0",
        "6.0.0",
        "5.0.01",
        "5.0.-1",
        "5.0.1-beta.0",
        "5.0.1/../2",
        "5.0.1-alpha.1",
    ] {
        assert!(Version::parse(bad).is_err(), "{bad}");
    }
}
#[test]
fn signed_public_fixture_rejects_tampering_and_wrong_contracts() {
    let value = verified_manifest(MANIFEST, SIGNATURE).unwrap();
    assert_eq!(value["version"], "5.0.11");
    let mut corrupt = MANIFEST.to_vec();
    corrupt[20] ^= 1;
    assert!(verified_manifest(&corrupt, SIGNATURE).is_err());
    assert!(verified_manifest(MANIFEST, &[0; 64]).is_err());
    for mutation in [
        json!({"version":"5.1.0"}),
        json!({"repository":"attacker/core"}),
        json!({"ui_api":2}),
        json!({"files":{"../escape.js":{"size":1,"sha256":"0".repeat(64)}}}),
    ] {
        let mut altered = value.clone();
        altered
            .as_object_mut()
            .unwrap()
            .extend(mutation.as_object().unwrap().clone());
        assert!(validate_manifest(&altered).is_err());
    }
    assert!(
        validate_summary(&json!({"title":"New controls","items":["Clearer focus states"]})).is_ok()
    );
    assert!(validate_summary(&json!({"title":"<script>","items":["bad"]})).is_err());
}
fn fixture() -> Option<(tempfile::TempDir, Manager)> {
    if unsafe { libc::geteuid() } != 0 {
        eprintln!("Run privileged cache fixtures under sudo; CI does this explicitly");
        return None;
    }
    let dir = tempfile::tempdir().unwrap();
    let manager = Manager::new(dir.path().join("core")).unwrap();
    manager.bind("fixture", 123, 456, "5.0.11").unwrap();
    Some((dir, manager))
}
fn cache(manager: &Manager) {
    let dir = manager.root.join("releases/5.0.11");
    std::fs::create_dir(&dir).unwrap();
    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(ARCHIVE));
    for entry in tar.entries().unwrap() {
        let mut entry = entry.unwrap();
        let name = entry.path().unwrap().file_name().unwrap().to_owned();
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes).unwrap();
        std::fs::write(dir.join(name), bytes).unwrap();
    }
    std::fs::write(dir.join("manifest.json"), MANIFEST).unwrap();
    std::fs::write(dir.join("core-manifest.json"), MANIFEST).unwrap();
    std::fs::write(dir.join("core-manifest.sig"), SIGNATURE).unwrap();
}
#[test]
fn policy_conflicts_and_unimplemented_offloading_cannot_silently_activate() {
    let Some((_dir, m)) = fixture() else {
        return;
    };
    let first = m.status("fixture").unwrap();
    assert_eq!(first["mode"], "manual");
    assert!(first["uid"].is_null());
    assert!(
        m.state("fixture").unwrap()["check_jitter"]
            .as_u64()
            .unwrap()
            <= 1800
    );
    assert!(m.bind("fixture", 0, 0, "5.0.12").is_err());
    let next = m
        .dispatch(
            "fixture",
            json!({"action":"policy","expected_revision":0,"automatic":true}),
        )
        .unwrap();
    assert_eq!(next["policy_revision"], 1);
    assert!(
        m.dispatch(
            "fixture",
            json!({"action":"policy","expected_revision":0,"automatic":false})
        )
        .is_err()
    );
    assert!(
        m.dispatch(
            "fixture",
            json!({"action":"policy","expected_revision":1,"offloading":true})
        )
        .is_err()
    );
    assert!(
        m.dispatch(
            "fixture",
            json!({"action":"status","repository":"attacker/other"})
        )
        .is_err()
    );
    assert!(
        m.dispatch("fixture", json!({"action":"shell","command":"true"}))
            .is_err()
    );
    assert!(m.state("fixture").unwrap()["automatic"] == true);
}
#[test]
fn cached_payload_is_signature_checked_and_asset_tampering_is_rejected() {
    let Some((_dir, m)) = fixture() else {
        return;
    };
    cache(&m);
    let value = m.cached("5.0.11").unwrap();
    let name = value["files"].as_object().unwrap().keys().next().unwrap();
    let file = m.root.join("releases/5.0.11").join(name);
    std::fs::write(&file, b"tampered").unwrap();
    assert!(m.cached("5.0.11").is_err());
    std::fs::remove_file(&file).unwrap();
    std::os::unix::fs::symlink("/etc/hostname", &file).unwrap();
    assert!(m.cached("5.0.11").is_err());
}
#[test]
fn state_paths_hardlinks_and_writable_metadata_are_rejected() {
    let Some((dir, m)) = fixture() else {
        return;
    };
    for name in ["../escape", "UPPER", "a/b", "", "a.sock/"] {
        assert!(m.state(name).is_err());
    }
    let file = m.root.join("apps/fixture/state.json");
    std::fs::hard_link(&file, dir.path().join("alias")).unwrap();
    assert!(m.state("fixture").is_err());
    std::fs::remove_file(dir.path().join("alias")).unwrap();
    std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o666)).unwrap();
    assert!(m.state("fixture").is_err());
    let outside = dir.path().join("outside");
    std::fs::create_dir(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, dir.path().join("linked")).unwrap();
    assert!(Manager::new(dir.path().join("linked")).is_err());
}
#[test]
fn public_status_does_not_expand_private_candidate_signature_payloads() {
    let Some((_dir, m)) = fixture() else {
        return;
    };
    let candidate = json!({"version":"5.0.11","raw":"private signed manifest encoding","signature":"signature","release_id":1});
    std::fs::write(
        m.root.join("apps/fixture/candidate.json"),
        serde_json::to_vec(&candidate).unwrap(),
    )
    .unwrap();
    let status = m.status("fixture").unwrap();
    assert!(status["candidate"]["raw"].is_null());
    assert!(status["candidate"]["signature"].is_null());
    assert_eq!(status["candidate"]["release_id"], 1);
    assert_eq!(
        digest(ARCHIVE),
        serde_json::from_slice::<Value>(MANIFEST).unwrap()["archive"]["sha256"]
    );
}

#[test]
fn manager_does_not_adopt_unrelated_or_shared_root_directories() {
    if unsafe { libc::geteuid() } != 0 {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("unrelated-file"), "retained").unwrap();
    let manager = Manager::new(dir.path()).unwrap();
    assert!(manager.bind("fixture", 0, 0, "5.0.11").is_err());
    assert_eq!(
        std::fs::read_to_string(dir.path().join("unrelated-file")).unwrap(),
        "retained"
    );
    assert!(!dir.path().join("apps").exists());
    std::fs::remove_file(dir.path().join("unrelated-file")).unwrap();
    std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o777)).unwrap();
    assert!(Manager::new(dir.path()).is_err());
    assert_eq!(
        dir.path().metadata().unwrap().permissions().mode() & 0o777,
        0o777
    );
}
