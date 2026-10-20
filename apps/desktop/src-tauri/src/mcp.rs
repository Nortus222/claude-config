use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use sha2::{Digest, Sha256};

const INVALID_RUNTIME: &str = "Installed MCP runtime is unavailable or incompatible. Reinstall the Nortuscc app.";
const INVALID_STATE: &str = "App state could not be resolved. Open Nortuscc and complete setup, then retry MCP.";
#[cfg(unix)]
const TARGET: &str = "darwin-arm64";
#[cfg(windows)]
const TARGET: &str = "win32-x64";
#[cfg(unix)]
const BUN: &str = "bun";
#[cfg(windows)]
const BUN: &str = "bun.exe";

/// Resolves only the current installed app's fixed resource directory.
#[cfg(unix)]
pub fn installed_resources(executable: &Path) -> Result<PathBuf, String> {
    let executable = fs::canonicalize(executable).map_err(|_| INVALID_RUNTIME)?;
    let macos = executable.parent().ok_or(INVALID_RUNTIME)?;
    let contents = macos.parent().ok_or(INVALID_RUNTIME)?;
    let app = contents.parent().ok_or(INVALID_RUNTIME)?;
    if macos.file_name().is_none_or(|name| name != "MacOS")
        || contents.file_name().is_none_or(|name| name != "Contents")
        || app.extension().is_none_or(|name| name != "app") { return Err(INVALID_RUNTIME.into()); }
    let resources = contents.join("Resources/agent-runtime");
    if fs::canonicalize(&resources).map_err(|_| INVALID_RUNTIME)? != resources || !resources.is_dir() { return Err(INVALID_RUNTIME.into()); }
    Ok(resources)
}
/// Resolves only the installed app's fixed resource directory beside its executable.
#[cfg(windows)]
pub fn installed_resources(executable: &Path) -> Result<PathBuf, String> {
    let executable = fs::canonicalize(executable).map_err(|_| INVALID_RUNTIME)?;
    let resources = executable.parent().ok_or(INVALID_RUNTIME)?.join("agent-runtime");
    if fs::canonicalize(&resources).map_err(|_| INVALID_RUNTIME)? != resources || !resources.is_dir() { return Err(INVALID_RUNTIME.into()); }
    Ok(resources)
}

fn file_hash(path: &Path, limit: u64) -> Result<String, String> {
    let metadata = fs::symlink_metadata(path).map_err(|_| INVALID_RUNTIME)?;
    if !metadata.is_file() || metadata.len() > limit { return Err(INVALID_RUNTIME.into()); }
    let mut file = File::open(path).map_err(|_| INVALID_RUNTIME)?;
    let mut hash = Sha256::new(); let mut chunk = [0u8; 65536]; let mut total = 0u64;
    loop {
        let count = file.read(&mut chunk).map_err(|_| INVALID_RUNTIME)?;
        if count == 0 { break; }
        total += count as u64; if total > limit { return Err(INVALID_RUNTIME.into()); }
        hash.update(&chunk[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

/// Agent identity keeps its original agent-only hash; MCP and Bun have independent hashes.
fn verify_resources(resources: &Path) -> Result<(), String> {
    let metadata_path = resources.join("runtime.json");
    let metadata = fs::symlink_metadata(&metadata_path).map_err(|_| INVALID_RUNTIME)?;
    if !metadata.is_file() || metadata.len() > 16384 { return Err(INVALID_RUNTIME.into()); }
    let metadata: serde_json::Value = serde_json::from_slice(&fs::read(metadata_path).map_err(|_| INVALID_RUNTIME)?).map_err(|_| INVALID_RUNTIME)?;
    if metadata["target"] != TARGET || metadata["appVersion"] != env!("CARGO_PKG_VERSION")
        || metadata["maintenanceProtocol"] != 1 || metadata["executable"] != BUN
        || metadata["mcp"]["protocol"] != 1 || metadata["mcp"]["executable"] != "mcp.mjs"
        || metadata["mcp"]["sdk"] != "2.3.1"
        || metadata["agentVersion"].as_str() != Some(file_hash(&resources.join("agent.mjs"), 67_108_864)?.as_str())
        || metadata["mcp"]["sha256"].as_str() != Some(file_hash(&resources.join("mcp.mjs"), 67_108_864)?.as_str())
        || metadata["bunSha256"].as_str() != Some(file_hash(&resources.join(BUN), 268_435_456)?.as_str()) { return Err(INVALID_RUNTIME.into()); }
    Ok(())
}

fn launch_command(resources: &Path, executable: &Path, state_root: &Path) -> Result<Command, String> {
    if !state_root.is_absolute() || state_root.to_str().is_none_or(|path| path.chars().any(char::is_control)) { return Err(INVALID_STATE.into()); }
    let executable = fs::canonicalize(executable).map_err(|_| INVALID_RUNTIME)?;
    if executable.to_str().is_none_or(|path| path.chars().any(char::is_control))
        || installed_resources(&executable)? != resources { return Err(INVALID_RUNTIME.into()); }
    let mut command = Command::new(resources.join(BUN));
    command.arg(resources.join("mcp.mjs")).arg("--app").arg(executable)
        .env("NORTUSCC_STATE_DIR", state_root)
        .env_remove("NODE_OPTIONS").env_remove("NODE_PATH").env_remove("BUN_OPTIONS")
        .current_dir(resources).stdin(Stdio::inherit()).stdout(Stdio::inherit()).stderr(Stdio::inherit());
    Ok(command)
}

/// Replaces this hidden process with MCP (on Windows, runs it and returns its exit code). The background
/// agent and accepted runs remain independent.
pub fn run_mcp(resources: &Path) -> Result<i32, String> {
    if !cfg!(any(all(target_os = "macos", target_arch = "aarch64"), all(windows, target_arch = "x86_64"))) { return Err(INVALID_RUNTIME.into()); }
    let executable = std::env::current_exe().and_then(fs::canonicalize).map_err(|_| INVALID_RUNTIME)?;
    if installed_resources(&executable)? != resources { return Err(INVALID_RUNTIME.into()); }
    verify_resources(resources)?;
    let state_root = crate::host::setup_agent(resources, crate::host::Setup::Paths).map_err(|_| INVALID_STATE)?;
    let mut command = launch_command(resources, &executable, &state_root)?;
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let _ = command.exec();
        Err(INVALID_RUNTIME.into())
    }
    #[cfg(windows)]
    {
        // The windowless app has no console for Bun to share; its stdio stays inherited.
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        let status = command.status().map_err(|_| INVALID_RUNTIME)?;
        Ok(status.code().unwrap_or(1))
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;
    use sha2::{Digest, Sha256};

    fn fixture() -> (PathBuf, PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("ncc-mcp-native-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir_all(&root).unwrap(); let root = fs::canonicalize(root).unwrap();
        let app = root.join("App With Spaces.app/Contents/MacOS/Nortuscc");
        let resources = root.join("App With Spaces.app/Contents/Resources/agent-runtime");
        fs::create_dir_all(app.parent().unwrap()).unwrap(); fs::create_dir_all(&resources).unwrap();
        fs::write(&app, b"native").unwrap();
        for (name, body) in [("bun", "#!/bin/sh\nexit 99\n"), ("agent.mjs", "agent"), ("mcp.mjs", "mcp")] { fs::write(resources.join(name), body).unwrap(); }
        fs::set_permissions(resources.join("bun"), fs::Permissions::from_mode(0o755)).unwrap();
        let hash = |name| format!("{:x}", Sha256::digest(fs::read(resources.join(name)).unwrap()));
        fs::write(resources.join("runtime.json"), serde_json::to_vec(&json!({"target":"darwin-arm64","appVersion":env!("CARGO_PKG_VERSION"),"maintenanceProtocol":1,"executable":"bun","bun":"1.3.14","bunSha256":hash("bun"),"agentVersion":hash("agent.mjs"),"mcp":{"protocol":1,"executable":"mcp.mjs","sdk":"2.3.1","sha256":hash("mcp.mjs")}})).unwrap()).unwrap();
        (root, app, resources)
    }
    #[test]
    fn installed_resources_are_fixed_and_uninstalled_paths_are_refused() {
        let (root, app, resources) = fixture();
        assert_eq!(installed_resources(&app).unwrap(), fs::canonicalize(&resources).unwrap());
        assert!(installed_resources(&root.join("Nortuscc")).is_err());
        assert!(installed_resources(&resources.join("bun")).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn verified_launch_uses_private_exact_app_identity_and_validated_state_root() {
        let (root, app, resources) = fixture();
        let state = root.join("state with spaces");
        let command = launch_command(&resources, &app, &state).unwrap();
        assert_eq!(command.get_program(), resources.join("bun"));
        assert_eq!(command.get_args().collect::<Vec<_>>(), [resources.join("mcp.mjs").as_os_str(), std::ffi::OsStr::new("--app"), app.as_os_str()]);
        assert!(command.get_envs().any(|(key,value)| key=="NORTUSCC_STATE_DIR" && value==Some(state.as_os_str())));
        assert!(launch_command(&resources, &app, std::path::Path::new("relative")).is_err());
        assert!(launch_command(&resources, &app, std::path::Path::new("/tmp/control\n")).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn each_payload_hash_is_verified_independently_before_any_helper() {
        for name in ["bun", "agent.mjs", "mcp.mjs"] {
            let (root, _app, resources) = fixture();
            fs::write(resources.join(name), "corrupt").unwrap();
            assert!(verify_resources(&resources).is_err(), "{name}");
            fs::remove_dir_all(root).unwrap();
        }
        let (root, _app, resources) = fixture();
        fs::remove_file(resources.join("mcp.mjs")).unwrap();
        assert!(verify_resources(&resources).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn incompatible_metadata_or_external_symlink_is_refused() {
        for (field,value) in [("target", json!("linux-x64")), ("executable", json!("../../bun")), ("appVersion",json!("99.0.0")), ("mcp",json!({"protocol":2,"executable":"mcp.mjs"}))] {
            let (root, _app, resources) = fixture();
            let mut metadata: serde_json::Value = serde_json::from_slice(&fs::read(resources.join("runtime.json")).unwrap()).unwrap();
            metadata[field]=value; fs::write(resources.join("runtime.json"),serde_json::to_vec(&metadata).unwrap()).unwrap();
            assert!(verify_resources(&resources).is_err(),"{field}"); fs::remove_dir_all(root).unwrap();
        }
        let (root, _app, resources) = fixture();
        fs::rename(resources.join("mcp.mjs"),root.join("external.mjs")).unwrap();
        std::os::unix::fs::symlink(root.join("external.mjs"),resources.join("mcp.mjs")).unwrap();
        assert!(verify_resources(&resources).is_err()); fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;
    #[test]
    fn installed_resources_sit_beside_the_executable() {
        let root = std::env::temp_dir().join(format!("ncc-mcp-windows-{}", std::process::id()));
        fs::create_dir_all(root.join("agent-runtime")).unwrap(); let root = fs::canonicalize(root).unwrap();
        fs::write(root.join("Nortuscc.exe"), b"native").unwrap();
        assert_eq!(installed_resources(&root.join("Nortuscc.exe")).unwrap(), root.join("agent-runtime"));
        assert!(installed_resources(&root.join("agent-runtime/Nortuscc.exe")).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
