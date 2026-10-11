use std::io::Read;
use base64::Engine;
use minisign_verify::{PublicKey, Signature};
use semver::Version;
use sha2::{Digest, Sha256};

pub fn verify_signature(bytes: &[u8], signature: &str, key: &str, version: &str) -> Result<(), String> {
    let decode = |value: &str| -> Result<String,String> {
        let bytes = base64::engine::general_purpose::STANDARD.decode(value.trim()).map_err(|_| "Invalid signature encoding")?;
        String::from_utf8(bytes).map_err(|_| "Invalid signature text".into())
    };
    let key = PublicKey::decode(&decode(key)?).map_err(|_| "Invalid updater public key")?;
    let signature = Signature::decode(&decode(signature)?).map_err(|_| "Invalid updater signature")?;
    key.verify(bytes,&signature,true).map_err(|_| "Updater signature verification failed")?;
    let signed = signature.trusted_comment().split('\t').find_map(|field|field.strip_prefix("version:")).ok_or("Missing signed version")?;
    if Version::parse(signed).map_err(|_| "Invalid signed version")? != Version::parse(version).map_err(|_| "Invalid release version")? { return Err("Signed version mismatch".into()); }
    Ok(())
}

// Compatibility is checked in authenticated archive bytes, never in unsigned channel policy.
pub fn validate_bundle(bytes: &[u8], version: &str) -> Result<(), String> {
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(bytes));
    let mut metadata = None; let mut plist = None; let mut app = false; let mut bun = false; let mut agent = None;
    let mut total = 0u64; let mut count = 0;
    let entries = archive.entries().map_err(|_| "Invalid app archive")?;
    for entry in entries {
        count += 1; if count > 50_000 { return Err("App archive has too many entries".into()); }
        let mut entry = entry.map_err(|_| "Invalid app archive")?;
        let path = entry.path().map_err(|_| "Invalid archive path")?.into_owned();
        if path.components().any(|c|!matches!(c,std::path::Component::Normal(_) | std::path::Component::CurDir)) || !path.starts_with("Nortuscc.app") { return Err("Unexpected app archive path".into()); }
        total = total.checked_add(entry.size()).ok_or("App archive is too large")?;
        if total > 1_073_741_824 { return Err("App archive is too large".into()); }
        let name = path.to_str().ok_or("Invalid archive path")?;
        if name.ends_with("/Contents/Resources/agent-runtime/runtime.json") || name == "Nortuscc.app/Contents/Info.plist" {
            if !entry.header().entry_type().is_file() || entry.size() > 16_384 { return Err("Invalid app metadata".into()); }
            let mut data = Vec::new(); entry.read_to_end(&mut data).map_err(|_| "Invalid app metadata")?;
            let slot = if name.ends_with("runtime.json") { &mut metadata } else { &mut plist };
            if slot.replace(data).is_some() { return Err("Duplicate app metadata".into()); }
        } else if name == "Nortuscc.app/Contents/MacOS/nortuscc-desktop-validation" || name == "Nortuscc.app/Contents/Resources/agent-runtime/bun" {
            if !entry.header().entry_type().is_file() { return Err("Invalid app executable".into()); }
            let mut header = [0;8]; entry.read_exact(&mut header).map_err(|_| "Invalid app executable")?;
            if u32::from_le_bytes(header[..4].try_into().unwrap()) != 0xfeedfacf || u32::from_le_bytes(header[4..].try_into().unwrap()) != 0x100000c { return Err("Update requires macOS Apple Silicon executables".into()); }
            let slot = if name.ends_with("/bun") { &mut bun } else { &mut app };
            if *slot { return Err("Duplicate app executable".into()); } *slot = true;
        } else if name == "Nortuscc.app/Contents/Resources/agent-runtime/agent.mjs" {
            if !entry.header().entry_type().is_file() || entry.size() > 67_108_864 || agent.is_some() { return Err("Invalid bundled agent".into()); }
            let mut hash = Sha256::new(); let mut chunk = [0u8;8192];
            loop { let count = entry.read(&mut chunk).map_err(|_| "Invalid bundled agent")?; if count == 0 { break; } hash.update(&chunk[..count]); }
            agent = Some(format!("{:x}",hash.finalize()));
        }
    }
    let metadata: serde_json::Value = serde_json::from_slice(&metadata.ok_or("Missing runtime metadata")?).map_err(|_| "Invalid runtime metadata")?;
    if metadata["target"] != "darwin-arm64" || metadata["appVersion"] != version || metadata["maintenanceProtocol"] != 1 || metadata["agentVersion"].as_str() != agent.as_deref() || agent.is_none() || !app || !bun { return Err("App update compatibility mismatch".into()); }
    let plist = plist::Value::from_reader(std::io::Cursor::new(plist.ok_or("Missing app identity")?)).map_err(|_| "Invalid app identity")?;
    let plist = plist.as_dictionary().ok_or("Invalid app identity")?;
    if plist.get("CFBundleShortVersionString").and_then(plist::Value::as_string) != Some(version) || plist.get("CFBundleIdentifier").and_then(plist::Value::as_string) != Some("com.nortuscc.desktop") { return Err("App update identity mismatch".into()); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    const DATA: &[u8] = include_bytes!("../checks/test-update.txt");
    const KEY: &str = include_str!("../checks/test-only.pub");
    const SIG: &str = include_str!("../checks/test-update.txt.sig");
    #[test]
    fn signature_authenticates_bytes_and_version() {
        assert!(verify_signature(DATA,SIG,KEY,"0.2.0").is_ok());
        assert!(verify_signature(b"corrupt",SIG,KEY,"0.2.0").is_err());
        assert!(verify_signature(DATA,SIG,KEY,"9.9.9").is_err());
        assert!(verify_signature(DATA,"malformed",KEY,"0.2.0").is_err());
        assert!(verify_signature(DATA,SIG,"wrong-key","0.2.0").is_err());
        let decoded=String::from_utf8(base64::engine::general_purpose::STANDARD.decode(KEY.trim()).unwrap()).unwrap();
        let mut lines=decoded.lines();let comment=lines.next().unwrap();
        let mut other=base64::engine::general_purpose::STANDARD.decode(lines.next().unwrap()).unwrap();other[10]^=1;
        let text=format!("{comment}\n{}\n",base64::engine::general_purpose::STANDARD.encode(other));
        assert!(PublicKey::decode(&text).is_ok());
        let other=base64::engine::general_purpose::STANDARD.encode(text);
        assert!(verify_signature(DATA,SIG,&other,"0.2.0").is_err());
    }
    fn bundle(target: &str, version: &str, protocol: u64, cpu: u32) -> Vec<u8> {
        let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(Vec::new(),flate2::Compression::fast()));
        for (path, data) in [
            ("Nortuscc.app/Contents/Resources/agent-runtime/runtime.json",serde_json::to_vec(&serde_json::json!({"target":target,"appVersion":version,"maintenanceProtocol":protocol,"agentVersion":format!("{:x}",Sha256::digest(b"agent test bytes"))})).unwrap()),
            ("Nortuscc.app/Contents/Resources/agent-runtime/agent.mjs",b"agent test bytes".to_vec()),
            ("Nortuscc.app/Contents/MacOS/nortuscc-desktop-validation",[0xfeedfacfu32.to_le_bytes(),cpu.to_le_bytes()].concat()),
            ("Nortuscc.app/Contents/Resources/agent-runtime/bun",[0xfeedfacfu32.to_le_bytes(),cpu.to_le_bytes()].concat()),
            ("Nortuscc.app/Contents/Info.plist",format!("<plist><dict><key>CFBundleShortVersionString</key><string>{version}</string><key>CFBundleIdentifier</key><string>com.nortuscc.desktop</string></dict></plist>").into_bytes()),
        ] {
            let mut header = tar::Header::new_gnu(); header.set_size(data.len() as u64); header.set_mode(0o755); header.set_cksum();
            builder.append_data(&mut header,path,data.as_slice()).unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap()
    }
    #[test]
    fn signed_payload_must_match_apple_silicon_version_and_maintenance_contract() {
        assert!(validate_bundle(&bundle("darwin-arm64","0.2.0",1,0x100000c),"0.2.0").is_ok());
        for data in [bundle("darwin-x64","0.2.0",1,0x1000007),bundle("darwin-arm64","0.1.0",1,0x100000c),bundle("darwin-arm64","0.2.0",2,0x100000c),bundle("darwin-arm64","0.2.0",1,0x1000007),vec![0,1,2]] {
            assert!(validate_bundle(&data,"0.2.0").is_err());
        }
    }
}
