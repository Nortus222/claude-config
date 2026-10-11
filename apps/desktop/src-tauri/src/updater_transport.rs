use std::{sync::Arc,time::Duration};
use base64::Engine;
use tauri::AppHandle;
use tauri_plugin_updater::{Update,UpdaterExt};
use crate::{updates::{Artifact,UpdateSource,FutureResult,Release,Progress,ENDPOINT,release_policy},update_payload};

pub struct NativeSource { app: AppHandle }
struct NativeArtifact { update: Update }
fn validate_config(raw: &serde_json::Value) -> Result<(),String> {
    let config:tauri_plugin_updater::Config=serde_json::from_value(raw.clone()).map_err(|_|"Invalid updater release configuration")?;
    if !config.require_signed_version || config.allow_downgrades || config.dangerous_insecure_transport_protocol || config.dangerous_accept_invalid_certs || config.dangerous_accept_invalid_hostnames || config.endpoints.len()!=1 || config.endpoints[0].as_str()!=ENDPOINT {return Err("Updater release policy is not supported".into());}
    let key=base64::engine::general_purpose::STANDARD.decode(config.pubkey).map_err(|_|"Invalid updater release public key")?;
    let key=std::str::from_utf8(&key).map_err(|_|"Invalid updater release public key")?;
    minisign_verify::PublicKey::decode(key).map_err(|_|"Invalid updater release public key")?;
    Ok(())
}
pub fn source(app: &AppHandle) -> Result<Option<Arc<dyn UpdateSource>>,String> {
    if !cfg!(all(target_os="macos",target_arch="aarch64")) { return Ok(None); }
    let Some(raw)=app.config().plugins.0.get("updater") else {return Ok(None);};
    validate_config(raw)?;
    app.plugin(tauri_plugin_updater::Builder::new().build()).map_err(|_|"Cannot initialize signed updater")?;
    Ok(Some(Arc::new(NativeSource {app:app.clone()})))
}
impl UpdateSource for NativeSource {
    fn check(&self) -> FutureResult<'_,Option<Arc<dyn Artifact>>> {
        Box::pin(async {
            let updater=self.app.updater_builder().target("darwin-aarch64").timeout(Duration::from_secs(15))
                .configure_client(|client|client.https_only(true).connect_timeout(Duration::from_secs(5)).redirect(reqwest::redirect::Policy::limited(5)))
                .build().map_err(|_|"Cannot initialize update check")?;
            let Some(mut update)=updater.check().await.map_err(|_|"Update check failed; retry later")? else {return Ok(None);};
            release_policy(&self.app.package_info().version.to_string(),&update.version,update.download_url.as_str(),&update.target)?;
            let platforms=update.raw_json["platforms"].as_object().ok_or("Invalid stable update metadata")?;
            if platforms.len()!=1 || !platforms.contains_key("darwin-aarch64") || update.raw_json["version"]!=update.version || update.signature.len()>4096 {return Err("Invalid stable update metadata".into());}
            // Released updater does not carry its check timeout into the Update.
            update.timeout=Some(Duration::from_secs(300));
            Ok(Some(Arc::new(NativeArtifact {update}) as Arc<dyn Artifact>))
        })
    }
}
impl Artifact for NativeArtifact {
    fn release(&self)->Release {Release {version:self.update.version.clone(),notes:self.update.body.clone(),url:self.update.download_url.to_string(),target:self.update.target.clone()}}
    fn download(&self,progress:Progress)->FutureResult<'_,Vec<u8>> {
        Box::pin(async move {
            let bytes=self.update.download(move |chunk,total|progress(chunk,total),||{}).await.map_err(|_|"Update download or signed-version verification failed")?;
            update_payload::validate_bundle(&bytes,&self.update.version)?;
            Ok(bytes)
        })
    }
    fn install(&self,bytes:&[u8])->Result<(),String> {self.update.install(bytes).map_err(|_|"App replacement failed".into())}
}
#[cfg(test)]
mod tests {
    use super::*;
    fn config()->serde_json::Value {serde_json::json!({"pubkey":include_str!("../checks/test-only.pub").trim(),"endpoints":[ENDPOINT],"requireSignedVersion":true,"allowDowngrades":false})}
    #[test]
    fn production_policy_requires_key_signed_version_fixed_https_and_no_downgrade() {
        assert!(validate_config(&config()).is_ok());
        for (key,value) in [("requireSignedVersion",serde_json::json!(false)),("allowDowngrades",serde_json::json!(true)),("dangerousAcceptInvalidCerts",serde_json::json!(true)),("dangerousAcceptInvalidHostnames",serde_json::json!(true)),("dangerousInsecureTransportProtocol",serde_json::json!(true)),("endpoints",serde_json::json!(["http://localhost/latest.json"])),("pubkey",serde_json::json!("not-a-ready-key"))] {let mut raw=config();raw[key]=value;assert!(validate_config(&raw).is_err());}
    }
}
