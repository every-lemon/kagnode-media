//! UI-only patch management. No backend hooks, service restarts or arbitrary repositories.
pub mod cli;
pub mod server;
use anyhow::{Result, ensure};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{File, OpenOptions},
    io::{Read, Write},
    os::{
        fd::AsRawFd,
        unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    },
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
pub const REPOSITORY: &str = "every-lemon/kagnode-core";
pub const PUBLIC_KEY: &str = "uJzR4gg2djgIrWTepTgtJsPnlbvhUYz/mwO7ubtl8l4=";
const LIMIT: usize = 16 * 1024 * 1024;
pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
pub fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
fn random() -> Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| anyhow::anyhow!("OS randomness unavailable"))?;
    Ok(hex::encode(bytes))
}
fn getrandom_byte() -> Result<u8> {
    let mut b = [0u8; 1];
    getrandom::fill(&mut b).map_err(|_| anyhow::anyhow!("OS randomness unavailable"))?;
    Ok(b[0])
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Version(u32, bool, u32);
impl Version {
    pub fn parse(value: &str) -> Result<Self> {
        let (base, beta) = value
            .split_once("-beta.")
            .map_or((value, None), |(b, n)| (b, Some(n)));
        let Some(patch) = base.strip_prefix("5.0.") else {
            anyhow::bail!("Core requires a reviewed 5.0.x version")
        };
        let number = |v: &str| -> Result<u32> {
            ensure!(
                !v.is_empty()
                    && v.len() <= 8
                    && v.bytes().all(|b| b.is_ascii_digit())
                    && (v == "0" || !v.starts_with('0')),
                "Invalid Core version"
            );
            Ok(v.parse()?)
        };
        let n = number(patch)?;
        let beta_n = beta.map(number).transpose()?.unwrap_or(0);
        ensure!(beta.is_none() || beta_n > 0, "Invalid beta sequence");
        Ok(Self(n, beta.is_none(), beta_n))
    }
}
pub fn application(name: &str) -> Result<()> {
    ensure!(
        !name.is_empty()
            && name.len() <= 64
            && name.as_bytes()[0].is_ascii_lowercase()
            && name
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'),
        "Invalid application identity"
    );
    Ok(())
}
fn automatic_allowed(version: &str, channel: &str) -> bool {
    Version::parse(version).is_ok() && !version.contains('-') && channel == "stable"
}
fn asset_name(name: &str) -> bool {
    name.len() <= 120
        && !name.is_empty()
        && !name.starts_with('.')
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        && [".js", ".css", ".svg", ".woff2"]
            .iter()
            .any(|e| name.ends_with(e))
}
fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}
fn protected(path: &Path, limit: u64) -> Result<Vec<u8>> {
    let m = path.symlink_metadata()?;
    ensure!(
        m.is_file()
            && !m.file_type().is_symlink()
            && m.nlink() == 1
            && m.uid() == 0
            && m.mode() & 0o022 == 0
            && m.len() <= limit,
        "Unsafe or oversized Core metadata"
    );
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let opened = file.metadata()?;
    ensure!(
        m.ino() == opened.ino() && m.dev() == opened.dev(),
        "Core metadata changed while opening"
    );
    let mut bytes = Vec::new();
    std::io::Read::by_ref(&mut file)
        .take(limit + 1)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= limit,
        "Core metadata exceeded its bound"
    );
    Ok(bytes)
}
fn path_guard(path: &Path) -> Result<()> {
    ensure!(
        path.is_absolute()
            && !path
                .components()
                .any(|p| matches!(p, std::path::Component::ParentDir)),
        "Use an absolute protected Core root"
    );
    for p in path.ancestors().filter(|p| p.exists()) {
        let m = p.symlink_metadata()?;
        ensure!(
            m.is_dir()
                && !m.file_type().is_symlink()
                && m.uid() == 0
                && (m.mode() & 0o022 == 0 || (p == Path::new("/tmp") && m.mode() & 0o1000 != 0)),
            "Core paths must be protected root-owned directories"
        );
    }
    Ok(())
}
fn atomic(path: &Path, value: &Value) -> Result<()> {
    path_guard(path.parent().unwrap())?;
    if path.exists() {
        let _ = protected(path, 1024 * 1024)?;
    }
    let temp = path.with_file_name(format!(
        ".{}.{}",
        path.file_name().unwrap().to_string_lossy(),
        random()?
    ));
    let mut f = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o644)
        .open(&temp)?;
    let bytes = serde_json::to_vec(value)?;
    f.write_all(&bytes)?;
    f.sync_all()?;
    std::fs::rename(&temp, path)?;
    File::open(path.parent().unwrap())?.sync_all()?;
    Ok(())
}
fn json_file(path: &Path, default: Value) -> Result<Value> {
    if !path.exists() {
        ensure!(!path.is_symlink(), "Unsafe Core metadata link");
        return Ok(default);
    }
    Ok(serde_json::from_slice(&protected(path, 512 * 1024)?)?)
}
pub struct Guard(File);
impl Drop for Guard {
    fn drop(&mut self) {
        unsafe { libc::flock(self.0.as_raw_fd(), libc::LOCK_UN) };
    }
}
fn file_lock(path: &Path) -> Result<Guard> {
    if path.exists() {
        let _ = protected(path, 0)?;
    }
    let f = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let m = f.metadata()?;
    ensure!(
        m.is_file() && m.nlink() == 1 && m.uid() == 0 && m.mode() & 0o022 == 0,
        "Unsafe Core lock"
    );
    ensure!(
        unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0,
        "Another Core operation is running"
    );
    Ok(Guard(f))
}
pub fn validate_summary(value: &Value) -> Result<()> {
    let text = |v: &Value, max: usize| {
        v.as_str().is_some_and(|s| {
            !s.is_empty()
                && s.len() <= max
                && !s.chars().any(|c| c.is_control() || c == '<' || c == '>')
        })
    };
    ensure!(
        value.as_object().is_some_and(|m| m.len() == 2)
            && text(&value["title"], 120)
            && value["items"]
                .as_array()
                .is_some_and(|a| !a.is_empty() && a.len() <= 8 && a.iter().all(|v| text(v, 240))),
        "Invalid public UI summary"
    );
    Ok(())
}
pub fn verified_manifest(raw: &[u8], signature: &[u8]) -> Result<Value> {
    let key = base64::engine::general_purpose::STANDARD.decode(PUBLIC_KEY)?;
    ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, key)
        .verify(raw, signature)
        .map_err(|_| anyhow::anyhow!("Core release signature verification failed"))?;
    let v: Value = serde_json::from_slice(raw)?;
    validate_manifest(&v)?;
    Ok(v)
}
pub fn validate_manifest(v: &Value) -> Result<()> {
    ensure!(
        v["schema"] == 1
            && v["repository"] == REPOSITORY
            && v["kind"] == "ui"
            && v["ui_api"] == 1
            && v["adapter_api"] == 1,
        "Incompatible Core UI contract; review the server adapter"
    );
    Version::parse(v["version"].as_str().unwrap_or(""))?;
    let source = v["source_commit"].as_str().unwrap_or("");
    ensure!(
        source.len() == 40
            && source
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()),
        "Invalid Core source provenance"
    );
    let files = v["files"]
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("Invalid Core asset inventory"))?;
    ensure!(
        !files.is_empty() && files.len() <= 32,
        "Invalid Core asset inventory size"
    );
    let mut total = 0u64;
    for (name, item) in files {
        let size = item["size"].as_u64().unwrap_or(0);
        ensure!(
            asset_name(name)
                && hash(item["sha256"].as_str().unwrap_or(""))
                && size > 0
                && size <= 512 * 1024,
            "Invalid Core asset metadata"
        );
        total += size;
    }
    ensure!(
        total <= LIMIT as u64,
        "Core asset payload exceeds its bound"
    );
    let entries = v["entrypoints"]
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("Missing Core entrypoints"))?;
    ensure!(
        entries.len() == 3
            && ["theme", "script", "style"].iter().all(|k| entries
                .get(*k)
                .and_then(Value::as_str)
                .is_some_and(|n| files.contains_key(n))),
        "Invalid Core entrypoints"
    );
    let archive = &v["archive"];
    let name = archive["name"].as_str().unwrap_or("");
    ensure!(
        name == format!("kagnode-core-{}-ui.tar.gz", v["version"].as_str().unwrap())
            && hash(archive["sha256"].as_str().unwrap_or(""))
            && archive["size"]
                .as_u64()
                .is_some_and(|n| n > 0 && n <= LIMIT as u64),
        "Invalid signed UI archive"
    );
    if !v["user_summary"].is_null() {
        validate_summary(&v["user_summary"])?;
    }
    Ok(())
}
fn download(url: &str, limit: usize) -> Result<Vec<u8>> {
    let url = reqwest::Url::parse(url)?;
    ensure!(
        url.scheme() == "https"
            && url.port_or_known_default() == Some(443)
            && url.username().is_empty()
            && url.password().is_none()
            && ((url.host_str() == Some("api.github.com")
                && url
                    .path()
                    .starts_with("/repos/every-lemon/kagnode-core/releases"))
                || (url.host_str() == Some("github.com")
                    && url
                        .path()
                        .starts_with("/every-lemon/kagnode-core/releases/download/"))),
        "Untrusted Core download location"
    );
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(4))
        // Four bounded fetches fit inside the adapters' 45-second request timeout.
        .timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() > 5 {
                return attempt.error("Too many Core redirects");
            }
            let u = attempt.url();
            if u.scheme() == "https"
                && u.port_or_known_default() == Some(443)
                && u.username().is_empty()
                && u.password().is_none()
                && matches!(
                    u.host_str(),
                    Some(
                        "github.com"
                            | "api.github.com"
                            | "release-assets.githubusercontent.com"
                            | "objects.githubusercontent.com"
                    )
                )
            {
                attempt.follow()
            } else {
                attempt.error("Untrusted Core redirect")
            }
        }))
        .user_agent("KagNode-Core-Rust-Manager/5.0")
        .build()?;
    let response = client.get(url).send()?.error_for_status()?;
    ensure!(
        response.content_length().is_none_or(|n| n <= limit as u64),
        "Core download exceeds its bound"
    );
    let mut bytes = Vec::new();
    response.take(limit as u64 + 1).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= limit, "Core download exceeds its bound");
    Ok(bytes)
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Candidate {
    pub version: String,
    pub channel: String,
    pub release_id: u64,
    pub manifest: Value,
    pub raw: String,
    pub signature: String,
    pub url: String,
    pub changed: bool,
}
fn candidate(release: &Value, beta: bool) -> Result<Candidate> {
    ensure!(
        release["draft"] != true && (release["prerelease"] != true || beta),
        "This release is outside the selected channel"
    );
    let assets = release["assets"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("Release has no assets"))?;
    let mut lookup = BTreeMap::new();
    for a in assets {
        if let Some(name) = a["name"].as_str() {
            ensure!(
                lookup.insert(name, a).is_none(),
                "Duplicate release asset name"
            );
        }
    }
    let asset = |name: &str| -> Result<&str> {
        lookup
            .get(name)
            .and_then(|a| a["browser_download_url"].as_str())
            .ok_or_else(|| anyhow::anyhow!("Release is missing a signed UI asset"))
    };
    let raw = download(asset("core-manifest.json")?, 128 * 1024)?;
    let signature = download(asset("core-manifest.sig")?, 64)?;
    let manifest = verified_manifest(&raw, &signature)?;
    let version = manifest["version"].as_str().unwrap().to_owned();
    ensure!(
        release["tag_name"] == format!("v{version}")
            && (release["prerelease"] == true) == version.contains("-beta."),
        "Release tag/channel differs from its signed manifest"
    );
    let archive = manifest["archive"]["name"].as_str().unwrap();
    let url = asset(archive)?.to_owned();
    Ok(Candidate {
        version,
        channel: if release["prerelease"] == true {
            "beta"
        } else {
            "stable"
        }
        .into(),
        release_id: release["id"]
            .as_u64()
            .ok_or_else(|| anyhow::anyhow!("Invalid release identity"))?,
        manifest,
        raw: base64::engine::general_purpose::STANDARD.encode(raw),
        signature: base64::engine::general_purpose::STANDARD.encode(signature),
        url,
        changed: true,
    })
}

#[derive(Clone)]
pub struct Manager {
    pub root: PathBuf,
}
impl Manager {
    pub fn new(root: impl Into<PathBuf>) -> Result<Self> {
        let root = root.into();
        path_guard(&root)?;
        Ok(Self { root })
    }
    fn ensure(&self) -> Result<()> {
        ensure!(
            unsafe { libc::geteuid() } == 0,
            "Core management requires root"
        );
        path_guard(&self.root)?;
        if self.root.exists() {
            ensure!(
                self.root.metadata()?.mode() & 0o022 == 0,
                "Core root cannot be a shared writable directory"
            );
            let names = std::fs::read_dir(&self.root)?
                .map(|e| e.map(|e| e.file_name()))
                .collect::<std::io::Result<Vec<_>>>()?;
            ensure!(
                names.iter().all(|n| matches!(
                    n.to_str(),
                    Some("apps" | "releases" | "run" | ".operation.lock" | ".daemon.lock")
                )),
                "Existing unrelated directory retained; choose a dedicated Core root"
            );
        }
        std::fs::create_dir_all(&self.root)?;
        std::fs::set_permissions(&self.root, std::fs::Permissions::from_mode(0o755))?;
        for name in ["apps", "releases", "run"] {
            let p = self.root.join(name);
            path_guard(&p)?;
            std::fs::create_dir_all(&p)?;
            std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755))?;
        }
        Ok(())
    }
    fn lock(&self) -> Result<Guard> {
        self.ensure()?;
        file_lock(&self.root.join(".operation.lock"))
    }
    fn app(&self, name: &str) -> Result<PathBuf> {
        application(name)?;
        let p = self.root.join("apps").join(name);
        path_guard(&p)?;
        Ok(p)
    }
    pub fn state(&self, name: &str) -> Result<Value> {
        let v = json_file(&self.app(name)?.join("state.json"), Value::Null)?;
        ensure!(v.is_object(), "Bind this application before managing Core");
        for field in ["version", "baseline", "adapter"] {
            Version::parse(v[field].as_str().unwrap_or(""))?;
        }
        ensure!(
            v["uid"].as_u64().is_some_and(|n| n <= u32::MAX as u64)
                && v["gid"].as_u64().is_some_and(|n| n <= u32::MAX as u64)
                && v["automatic"].is_boolean(),
            "Invalid protected Core binding"
        );
        Ok(v)
    }
    pub fn status(&self, name: &str) -> Result<Value> {
        let mut value = self.state(name)?;
        let map = value.as_object_mut().unwrap();
        map.remove("uid");
        map.remove("gid");
        map.insert("enabled".into(), json!(true));
        let automatic = value["automatic"] == true;
        let channel = value["channel"].as_str().unwrap_or("stable").to_owned();
        value["channel"] = json!(channel);
        value["mode"] = json!(if automatic { "auto" } else { "manual" });
        value["summaries"] = json!(value["summaries"].as_bool().unwrap_or(true));
        value["capabilities"] = json!({"update_summaries":true,"automatic_ui_patches":true,"release_channels":true,"policy_revisions":true,"server_offloading":false});
        value["policy_revision"] = json!(value["policy_revision"].as_u64().unwrap_or(0));
        value["candidate"] = json_file(&self.app(name)?.join("candidate.json"), Value::Null)?;
        if let Some(candidate) = value["candidate"].as_object_mut() {
            candidate.remove("raw");
            candidate.remove("signature");
        }
        value["operation"] = json_file(&self.app(name)?.join("operation.json"), json!({}))?;
        Ok(value)
    }
    pub fn bind(&self, name: &str, uid: u32, gid: u32, baseline: &str) -> Result<Value> {
        let _guard = self.lock()?;
        Version::parse(baseline)?;
        let path = self.app(name)?;
        ensure!(
            !path.join("state.json").exists(),
            "Existing Core binding retained; use reviewed adoption"
        );
        std::fs::create_dir_all(&path)?;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))?;
        atomic(
            &path.join("state.json"),
            &json!({"version":baseline,"baseline":baseline,"adapter":baseline,"uid":uid,"gid":gid,"automatic":false,"channel":"stable","previous":null,"last_check":0,"policy_revision":0,"offloading":false,"check_jitter":u16::from_be_bytes([getrandom_byte()?,getrandom_byte()?]) % 1801}),
        )?;
        self.status(name)
    }
    fn recover(&self, name: &str) -> Result<()> {
        let path = self.app(name)?.join("operation.json");
        let mut op = json_file(&path, json!({}))?;
        if op["phase"] != "downloading" {
            return Ok(());
        }
        let state = self.state(name)?;
        let committed = op["version"] == state["version"]
            && (op["action"] != "adopt"
                || (op["version"] == state["baseline"]
                    && op["declaration_sha256"] == state["declaration_sha256"]))
            && self.cached(state["version"].as_str().unwrap()).is_ok();
        op["phase"] = json!(if committed { "complete" } else { "interrupted" });
        op["recovered"] = json!(true);
        op["message"] = json!(if committed {
            "Current Core UI verified after an interrupted operation; services were retained"
        } else {
            "Core update was interrupted; current UI retained. Check and review before retrying"
        });
        atomic(&path, &op)
    }
    pub fn check(&self, name: &str) -> Result<Value> {
        let _guard = self.lock()?;
        self.check_locked(name)
    }
    fn check_locked(&self, name: &str) -> Result<Value> {
        self.recover(name)?;
        let mut state = self.state(name)?;
        let current = Version::parse(state["version"].as_str().unwrap())?;
        let beta = state["channel"] == "beta";
        let releases: Vec<Value> = serde_json::from_slice(&download(
            "https://api.github.com/repos/every-lemon/kagnode-core/releases?per_page=50",
            4 * 1024 * 1024,
        )?)?;
        let mut choices: Vec<_> = releases
            .iter()
            .filter_map(|r| {
                let tag = r["tag_name"].as_str()?.strip_prefix('v')?;
                let v = Version::parse(tag).ok()?;
                if r["draft"] == true
                    || (r["prerelease"] == true && !beta)
                    || v < current
                    || ((r["prerelease"] == true) != tag.contains("-beta."))
                {
                    None
                } else {
                    Some((v, r))
                }
            })
            .collect();
        choices.sort_by_key(|(v, _)| std::cmp::Reverse(*v));
        let next = if let Some((_, release)) = choices.first() {
            let mut c = candidate(release, beta)?;
            c.changed = c.version != state["version"];
            serde_json::to_value(c)?
        } else {
            Value::Null
        };
        atomic(&self.app(name)?.join("candidate.json"), &next)?;
        state["last_check"] = json!(now());
        state["last_error"] = json!("");
        atomic(&self.app(name)?.join("state.json"), &state)?;
        self.status(name)
    }
    pub fn cached(&self, version: &str) -> Result<Value> {
        Version::parse(version)?;
        let path = self.root.join("releases").join(version);
        path_guard(&path)?;
        let raw = protected(&path.join("core-manifest.json"), 128 * 1024)?;
        let signature = protected(&path.join("core-manifest.sig"), 64)?;
        let manifest = verified_manifest(&raw, &signature)?;
        ensure!(
            manifest["version"] == version
                && json_file(&path.join("manifest.json"), Value::Null)? == manifest,
            "Cached manifest differs from its signed source"
        );
        for (name, item) in manifest["files"].as_object().unwrap() {
            let bytes = protected(&path.join(name), 512 * 1024)?;
            ensure!(
                bytes.len() as u64 == item["size"].as_u64().unwrap()
                    && digest(&bytes) == item["sha256"],
                "Installed Core asset integrity failed"
            );
        }
        Ok(manifest)
    }
    fn cache(&self, c: &Candidate) -> Result<Value> {
        let raw = base64::engine::general_purpose::STANDARD.decode(&c.raw)?;
        let signature = base64::engine::general_purpose::STANDARD.decode(&c.signature)?;
        let manifest = verified_manifest(&raw, &signature)?;
        ensure!(
            manifest == c.manifest && manifest["version"] == c.version,
            "Core candidate differs from its signed manifest"
        );
        let target = self.root.join("releases").join(&c.version);
        if target.exists() {
            let installed = self.cached(&c.version)?;
            ensure!(
                installed == manifest,
                "Cached release differs from reviewed assets"
            );
            return Ok(installed);
        }
        let c_path = std::ffi::CString::new(self.root.as_os_str().as_encoded_bytes())?;
        let mut space = std::mem::MaybeUninit::<libc::statvfs>::uninit();
        ensure!(
            unsafe { libc::statvfs(c_path.as_ptr(), space.as_mut_ptr()) } == 0,
            "Cannot inspect Core cache free space"
        );
        let space = unsafe { space.assume_init() };
        ensure!(
            (space.f_bavail as u128) * (space.f_frsize as u128) >= (64 * 1024 * 1024) as u128,
            "Core cache needs at least 64 MiB free before staging"
        );
        let archive = download(&c.url, LIMIT)?;
        ensure!(
            archive.len() as u64 == manifest["archive"]["size"].as_u64().unwrap()
                && digest(&archive) == manifest["archive"]["sha256"],
            "Core archive integrity failed"
        );
        let stage = self
            .root
            .join("releases")
            .join(format!(".stage-{}", random()?));
        std::fs::create_dir(&stage)?;
        std::fs::set_permissions(&stage, std::fs::Permissions::from_mode(0o700))?;
        atomic(
            &stage.join(".kagnode-stage.json"),
            &json!({"schema":1,"kind":"ui-cache","root":self.root}),
        )?;
        let result = (|| -> Result<()> {
            let decoder = flate2::read::GzDecoder::new(&archive[..]);
            let mut tar = tar::Archive::new(decoder.take(LIMIT as u64 + 1));
            let mut seen = BTreeSet::new();
            let prefix = format!("kagnode-core-{}", c.version);
            for entry in tar.entries()? {
                let mut entry = entry?;
                ensure!(
                    entry.header().entry_type().is_file(),
                    "UI archives cannot contain links or special files"
                );
                let path = entry.path()?.into_owned();
                let parts: Vec<_> = path.components().collect();
                ensure!(
                    parts.len() == 2
                        && parts[0].as_os_str() == prefix.as_str()
                        && matches!(parts[1], std::path::Component::Normal(_)),
                    "Unsafe Core archive path"
                );
                let name = parts[1]
                    .as_os_str()
                    .to_str()
                    .ok_or_else(|| anyhow::anyhow!("Invalid Core asset name"))?;
                let item = &manifest["files"][name];
                ensure!(
                    asset_name(name)
                        && !item.is_null()
                        && seen.insert(name.to_owned())
                        && entry.size() == item["size"].as_u64().unwrap(),
                    "Unexpected, duplicate or oversized Core archive member"
                );
                let mut bytes = Vec::new();
                entry
                    .by_ref()
                    .take(512 * 1024 + 1)
                    .read_to_end(&mut bytes)?;
                ensure!(
                    digest(&bytes) == item["sha256"]
                        && bytes.len() as u64 == item["size"].as_u64().unwrap(),
                    "Core asset checksum failed"
                );
                let mut f = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(0o644)
                    .open(stage.join(name))?;
                f.write_all(&bytes)?;
                f.sync_all()?;
            }
            ensure!(
                seen.len() == manifest["files"].as_object().unwrap().len(),
                "Core archive is incomplete"
            );
            atomic(&stage.join("manifest.json"), &manifest)?;
            for (name, bytes) in [
                ("core-manifest.json", raw.as_slice()),
                ("core-manifest.sig", signature.as_slice()),
            ] {
                let mut f = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(0o644)
                    .open(stage.join(name))?;
                f.write_all(bytes)?;
                f.sync_all()?;
            }
            std::fs::remove_file(stage.join(".kagnode-stage.json"))?;
            std::fs::set_permissions(&stage, std::fs::Permissions::from_mode(0o755))?;
            std::fs::rename(&stage, &target)?;
            File::open(target.parent().unwrap())?.sync_all()?;
            Ok(())
        })();
        if result.is_err() && stage.exists() {
            let _ = std::fs::remove_dir_all(&stage);
        }
        result?;
        self.cached(&c.version)
    }
    fn ensure_version(&self, version: &str) -> Result<Value> {
        Version::parse(version)?;
        if self.root.join("releases").join(version).exists() {
            return self.cached(version);
        }
        let release: Value = serde_json::from_slice(&download(
            &format!(
                "https://api.github.com/repos/every-lemon/kagnode-core/releases/tags/v{version}"
            ),
            1024 * 1024,
        )?)?;
        let c = candidate(&release, version.contains("-beta."))?;
        ensure!(
            c.version == version,
            "Release tag differs from requested Core baseline"
        );
        self.cache(&c)
    }
    pub fn apply(&self, name: &str, release_id: Option<u64>, automatic: bool) -> Result<Value> {
        let _guard = self.lock()?;
        let checked = self.check_locked(name)?;
        if checked["candidate"].is_null() {
            return Ok(checked);
        }
        let c: Candidate = serde_json::from_value(json_file(
            &self.app(name)?.join("candidate.json"),
            Value::Null,
        )?)?;
        ensure!(
            !automatic || automatic_allowed(&c.version, &c.channel),
            "Prerelease UI updates require administrator review; current assets retained"
        );
        ensure!(
            release_id.is_none_or(|id| id == c.release_id),
            "The reviewed release changed; check again"
        );
        let mut state = self.state(name)?;
        ensure!(
            !automatic || state["automatic"] == true,
            "Automatic UI patches are paused"
        );
        let operation = self.app(name)?.join("operation.json");
        atomic(
            &operation,
            &json!({"phase":"downloading","action":"apply","version":c.version,"at":now()}),
        )?;
        let result = (|| -> Result<Value> {
            self.cache(&c)?;
            let previous = state["version"].clone();
            state["version"] = json!(c.version);
            if previous != state["version"] {
                state["previous"] = previous;
                state["activation"] = if automatic {
                    json!({"id":digest(random()?.as_bytes()),"version":c.version,"automatic":true,"at":now()})
                } else {
                    Value::Null
                };
            }
            state["last_error"] = json!("");
            state["updated"] = json!(now());
            atomic(&self.app(name)?.join("state.json"), &state)?;
            atomic(
                &operation,
                &json!({"phase":"complete","version":c.version,"at":now(),"message":"Verified UI assets activated; services were retained"}),
            )?;
            self.status(name)
        })();
        if let Err(e) = &result {
            atomic(
                &operation,
                &json!({"phase":"failed","version":c.version,"at":now(),"message":e.to_string()}),
            )?;
        }
        result
    }
    pub fn policy(&self, name: &str, input: &Value) -> Result<Value> {
        let _guard = self.lock()?;
        let mut state = self.state(name)?;
        let revision = state["policy_revision"].as_u64().unwrap_or(0);
        if let Some(expected) = input.get("expected_revision") {
            ensure!(
                expected.as_u64() == Some(revision),
                "Core policy changed; reload before saving"
            );
        }
        let mut changed = false;
        for field in ["automatic", "summaries", "offloading"] {
            if let Some(value) = input.get(field) {
                ensure!(value.is_boolean(), "Core policies must be true or false");
                ensure!(
                    field != "offloading" || value != true,
                    "Core Server Offloading awaits a verified delivery adapter; local assets retained"
                );
                state[field] = value.clone();
                changed = true;
            }
        }
        if let Some(channel) = input.get("channel") {
            ensure!(
                channel == "stable" || channel == "beta",
                "Choose Stable or Beta"
            );
            if state["channel"] != *channel {
                atomic(&self.app(name)?.join("candidate.json"), &Value::Null)?;
            }
            state["channel"] = channel.clone();
            changed = true;
        }
        ensure!(changed, "Choose an update policy");
        state["policy_revision"] = json!(revision + 1);
        atomic(&self.app(name)?.join("state.json"), &state)?;
        self.status(name)
    }
    pub fn rollback(&self, name: &str) -> Result<Value> {
        let _guard = self.lock()?;
        self.recover(name)?;
        let mut state = self.state(name)?;
        let previous = state["previous"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("No retained previous UI bundle is selected"))?
            .to_owned();
        self.cached(&previous)?;
        let current = state["version"].clone();
        state["version"] = json!(previous);
        state["previous"] = current;
        state["automatic"] = json!(false);
        state["activation"] = Value::Null;
        atomic(&self.app(name)?.join("state.json"), &state)?;
        atomic(
            &self.app(name)?.join("operation.json"),
            &json!({"phase":"complete","version":previous,"at":now(),"message":"Previous verified UI restored; automatic patches paused"}),
        )?;
        self.status(name)
    }
    pub fn adopt(&self, name: &str, lock_file: &Path, expected_baseline: &str) -> Result<Value> {
        let _guard = self.lock()?;
        self.recover(name)?;
        let raw = protected(lock_file, 128 * 1024)?;
        let declaration: Value = serde_json::from_slice(&raw)?;
        let mut state = self.state(name)?;
        ensure!(
            state["baseline"] == expected_baseline,
            "Core baseline changed; reload and review the upgrade"
        );
        Version::parse(expected_baseline)?;
        ensure!(
            declaration["schema"] == 1
                && declaration["repository"] == REPOSITORY
                && declaration["ui_api"] == 1
                && declaration["patch_range"] == "5.0.x"
                && declaration["backend_updates"] == "reviewed"
                && declaration["automatic_ui_patches"].is_boolean()
                && (declaration["application"].is_null() || declaration["application"] == name),
            "Invalid application Core declaration"
        );
        let baseline = declaration["baseline"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Missing reviewed baseline"))?;
        let adapter = declaration["adapter"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Missing reviewed adapter"))?;
        Version::parse(baseline)?;
        Version::parse(adapter)?;
        let source = declaration["source_commit"].as_str().unwrap_or("");
        ensure!(
            source.len() == 40
                && source.bytes().all(|b| b.is_ascii_hexdigit())
                && hash(
                    declaration["fallback_manifest_sha256"]
                        .as_str()
                        .unwrap_or("")
                ),
            "Invalid application Core provenance"
        );
        let operation = self.app(name)?.join("operation.json");
        let decl_sha = digest(&raw);
        atomic(
            &operation,
            &json!({"phase":"downloading","action":"adopt","version":baseline,"declaration_sha256":decl_sha,"at":now()}),
        )?;
        let result = (|| -> Result<Value> {
            self.ensure_version(state["version"].as_str().unwrap())?;
            let manifest = self.ensure_version(baseline)?;
            ensure!(
                manifest["source_commit"] == source && protected(lock_file, 128 * 1024)? == raw,
                "Application declaration differs from the signed UI source or changed during review"
            );
            let old = state["version"].clone();
            if Version::parse(old.as_str().unwrap())? < Version::parse(baseline)? {
                state["version"] = json!(baseline);
                state["previous"] = old;
            }
            state["previous_baseline"] = state["baseline"].clone();
            state["baseline"] = json!(baseline);
            state["adapter"] = json!(adapter);
            state["source_commit"] = json!(source);
            state["fallback_manifest_sha256"] = declaration["fallback_manifest_sha256"].clone();
            state["declaration_sha256"] = json!(decl_sha);
            state["automatic"] =
                json!(state["automatic"] == true && declaration["automatic_ui_patches"] == true);
            atomic(&self.app(name)?.join("state.json"), &state)?;
            atomic(
                &operation,
                &json!({"phase":"complete","version":state["version"],"at":now(),"message":"Reviewed server baseline adopted; services were retained"}),
            )?;
            self.status(name)
        })();
        if let Err(e) = &result {
            atomic(
                &operation,
                &json!({"phase":"failed","version":baseline,"at":now(),"message":e.to_string()}),
            )?;
        }
        result
    }
    pub fn summary(&self, name: &str) -> Result<Value> {
        let state = self.state(name)?;
        let event = &state["activation"];
        if state["summaries"] == false
            || event["automatic"] != true
            || event["version"] != state["version"]
        {
            return Ok(json!({"available":true,"notice":null}));
        }
        let operation = json_file(&self.app(name)?.join("operation.json"), json!({}))?;
        if operation["phase"] != "complete" || operation["version"] != state["version"] {
            return Ok(json!({"available":true,"notice":null}));
        }
        let manifest = self.cached(state["version"].as_str().unwrap())?;
        if manifest["user_summary"].is_null() {
            return Ok(json!({"available":true,"notice":null}));
        }
        validate_summary(&manifest["user_summary"])?;
        Ok(
            json!({"available":true,"notice":{"id":event["id"],"version":state["version"],"title":manifest["user_summary"]["title"],"items":manifest["user_summary"]["items"]}}),
        )
    }
    pub fn dispatch(&self, name: &str, body: Value) -> Result<Value> {
        let action = body["action"].as_str().unwrap_or("");
        let allowed: &[&str] = match action {
            "status" | "summary" | "check" | "rollback" => &["action"],
            "apply" => &["action", "release_id"],
            "policy" => &[
                "action",
                "automatic",
                "summaries",
                "channel",
                "offloading",
                "expected_revision",
            ],
            _ => anyhow::bail!("Unknown Core manager action"),
        };
        ensure!(
            body.as_object()
                .is_some_and(|m| m.keys().all(|k| allowed.contains(&k.as_str()))),
            "Unknown Core request parameters"
        );
        match action {
            "status" => self.status(name),
            "summary" => self.summary(name),
            "check" => self.check(name),
            "apply" => {
                ensure!(
                    body.get("release_id").is_none() || body["release_id"].is_u64(),
                    "Invalid reviewed release identity"
                );
                self.apply(name, body["release_id"].as_u64(), false)
            }
            "policy" => self.policy(name, &body),
            "rollback" => self.rollback(name),
            _ => unreachable!(),
        }
    }
}

#[cfg(test)]
mod safety_tests {
    use super::*;
    #[test]
    fn automatic_policy_never_installs_prereleases_or_another_release_line() {
        assert!(automatic_allowed("5.0.11", "stable"));
        assert!(!automatic_allowed("5.0.12-beta.1", "beta"));
        assert!(!automatic_allowed("5.0.12-beta.1", "stable"));
        assert!(!automatic_allowed("5.1.0", "stable"));
    }
}
