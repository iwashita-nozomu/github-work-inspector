use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const SKILL: &str = include_str!("../.agents/skills/github-work-inspector/SKILL.md");
const POLICY: &str = include_str!("../.agents/skills/github-work-inspector/agents/openai.yaml");
const NAME: &str = "github-work-inspector";
const MANIFEST: &str = ".install.json";

#[derive(Serialize, Deserialize)]
struct Manifest {
    version: String,
    binary: PathBuf,
    binary_sha256: String,
    files: BTreeMap<String, String>,
}

fn io<T>(r: std::io::Result<T>) -> Result<T> {
    r.map_err(|_| Error::new("install_io"))
}
pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}
fn regular(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| m.is_file())
}
fn sources() -> BTreeMap<String, Vec<u8>> {
    BTreeMap::from([
        ("SKILL.md".into(), SKILL.as_bytes().to_vec()),
        ("agents/openai.yaml".into(), POLICY.as_bytes().to_vec()),
    ])
}

pub fn destinations(
    bin_dir: Option<PathBuf>,
    skill_root: Option<PathBuf>,
) -> Result<(PathBuf, PathBuf)> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| Error::new("install_io"))?;
    let cwd = io(std::env::current_dir())?;
    let absolute = |p: PathBuf| if p.is_absolute() { p } else { cwd.join(p) };
    let bin_dir = absolute(bin_dir.unwrap_or_else(|| home.join(".local/bin")));
    let skill_root = absolute(skill_root.unwrap_or_else(|| home.join(".agents/skills")));
    Ok((
        bin_dir.join(if cfg!(windows) {
            "github-work-inspector.exe"
        } else {
            NAME
        }),
        skill_root.join(NAME),
    ))
}

fn enumerate(dir: &Path, prefix: &Path, files: &mut Vec<String>) -> Result<()> {
    for entry in io(fs::read_dir(dir))? {
        let entry = io(entry)?;
        let kind = io(entry.file_type())?;
        let relative = prefix.join(entry.file_name());
        if kind.is_symlink() {
            return Err(Error::new("install_conflict"));
        }
        if kind.is_dir() {
            enumerate(&entry.path(), &relative, files)?;
        } else if kind.is_file() {
            files.push(relative.to_string_lossy().replace('\\', "/"));
        } else {
            return Err(Error::new("install_conflict"));
        }
    }
    Ok(())
}

fn verify(binary: &Path, skill: &Path) -> Result<Manifest> {
    if !exists(&skill.join(MANIFEST)) {
        return Err(Error::new("not_installed"));
    }
    if !regular(binary)
        || !regular(&skill.join(MANIFEST))
        || fs::symlink_metadata(skill).is_ok_and(|m| m.is_symlink())
    {
        return Err(Error::new("install_conflict"));
    }
    let bytes = io(fs::read(skill.join(MANIFEST)))?;
    if bytes.len() > 65536 {
        return Err(Error::new("install_conflict"));
    }
    let manifest: Manifest =
        serde_json::from_slice(&bytes).map_err(|_| Error::new("install_conflict"))?;
    let expected = sources();
    if manifest.binary != binary
        || manifest.files.keys().ne(expected.keys())
        || hash(&io(fs::read(binary))?) != manifest.binary_sha256
    {
        return Err(Error::new("install_conflict"));
    }
    let mut actual = Vec::new();
    enumerate(skill, Path::new(""), &mut actual)?;
    actual.sort();
    let mut allowed: Vec<_> = manifest.files.keys().cloned().collect();
    allowed.push(MANIFEST.into());
    allowed.sort();
    if actual != allowed {
        return Err(Error::new("install_conflict"));
    }
    for (path, expected_hash) in &manifest.files {
        if !regular(&skill.join(path)) || hash(&io(fs::read(skill.join(path)))?) != *expected_hash {
            return Err(Error::new("install_conflict"));
        }
    }
    Ok(manifest)
}

fn write_new(path: &Path, bytes: &[u8], executable: bool) -> Result<()> {
    let mut file = io(OpenOptions::new().write(true).create_new(true).open(path))?;
    io(file.write_all(bytes))?;
    io(file.sync_all())?;
    #[cfg(unix)]
    if executable {
        use std::os::unix::fs::PermissionsExt;
        io(fs::set_permissions(path, fs::Permissions::from_mode(0o755)))?;
    }
    #[cfg(not(unix))]
    let _ = executable;
    Ok(())
}

pub fn install(binary: &Path, skill: &Path, update: bool) -> Result<Value> {
    install_bytes(
        binary,
        skill,
        update,
        &io(fs::read(io(std::env::current_exe())?))?,
    )
}

pub fn install_bytes(binary: &Path, skill: &Path, update: bool, bytes: &[u8]) -> Result<Value> {
    if update {
        verify(binary, skill)?;
    } else if exists(binary) || exists(skill) {
        return Err(Error::new("install_conflict"));
    }
    let bin_parent = binary.parent().ok_or_else(|| Error::new("install_io"))?;
    let skill_parent = skill.parent().ok_or_else(|| Error::new("install_io"))?;
    io(fs::create_dir_all(bin_parent))?;
    io(fs::create_dir_all(skill_parent))?;
    let id = format!(
        "{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );
    let staging_bin = bin_parent.join(format!(".gwi-bin-new-{id}"));
    let staging_skill = skill_parent.join(format!(".gwi-skill-new-{id}"));
    let backup_bin = bin_parent.join(format!(".gwi-bin-old-{id}"));
    let backup_skill = skill_parent.join(format!(".gwi-skill-old-{id}"));
    let prepare = (|| {
        write_new(&staging_bin, bytes, true)?;
        io(fs::create_dir(&staging_skill))?;
        let files = sources();
        for (path, content) in &files {
            let target = staging_skill.join(path);
            io(fs::create_dir_all(target.parent().unwrap()))?;
            write_new(&target, content, false)?;
        }
        let manifest = Manifest {
            version: env!("CARGO_PKG_VERSION").into(),
            binary: binary.into(),
            binary_sha256: hash(bytes),
            files: files.iter().map(|(p, b)| (p.clone(), hash(b))).collect(),
        };
        write_new(
            &staging_skill.join(MANIFEST),
            &serde_json::to_vec_pretty(&manifest).unwrap(),
            false,
        )
    })();
    if let Err(error) = prepare {
        let _ = fs::remove_file(&staging_bin);
        let _ = fs::remove_dir_all(&staging_skill);
        return Err(error);
    }
    let commit = (|| {
        if update {
            verify(binary, skill)?;
            io(fs::rename(binary, &backup_bin))?;
            if let Err(error) = fs::rename(skill, &backup_skill) {
                let _ = fs::rename(&backup_bin, binary);
                return Err(Error::new(
                    if error.kind() == std::io::ErrorKind::AlreadyExists {
                        "install_conflict"
                    } else {
                        "install_io"
                    },
                ));
            }
        } else if exists(binary) || exists(skill) {
            return Err(Error::new("install_conflict"));
        }
        if let Err(error) = fs::hard_link(&staging_bin, binary) {
            if update {
                let _ = fs::rename(&backup_bin, binary);
                let _ = fs::rename(&backup_skill, skill);
            }
            return Err(Error::new(
                if error.kind() == std::io::ErrorKind::AlreadyExists {
                    "install_conflict"
                } else {
                    "install_io"
                },
            ));
        }
        if fs::rename(&staging_skill, skill).is_err() {
            let _ = fs::remove_file(binary);
            if update {
                let _ = fs::rename(&backup_bin, binary);
                let _ = fs::rename(&backup_skill, skill);
            }
            return Err(Error::new("install_io"));
        }
        Ok(())
    })();
    let _ = fs::remove_file(&staging_bin);
    let _ = fs::remove_dir_all(&staging_skill);
    commit?;
    if update {
        io(fs::remove_file(backup_bin))?;
        io(fs::remove_dir_all(backup_skill))?;
    }
    Ok(
        json!({"version":env!("CARGO_PKG_VERSION"),"binary":binary,"binary_sha256":hash(bytes),"skill":skill,"updated":update}),
    )
}

pub fn uninstall(binary: &Path, skill: &Path) -> Result<Value> {
    verify(binary, skill)?;
    io(fs::remove_file(binary))?;
    io(fs::remove_dir_all(skill))?;
    Ok(json!({"binary":binary,"skill":skill,"removed":true}))
}
