use serde::Deserialize;
use serde_json::Value;

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Notification {
    pub id: String,
    pub title: String,
    pub body: String,
}
pub fn valid_id(id: &str) -> bool {
    id.len() == 64 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub fn valid_receipt(receipt: &str) -> bool {
    !receipt.is_empty() && receipt.encode_utf16().count() <= 100
}
impl Notification {
    pub fn validate(&self) -> Result<(), String> {
        if !valid_id(&self.id) || self.title.encode_utf16().count() > 100 || self.body.encode_utf16().count() > 500 {
            return Err("Invalid notification payload".into());
        }
        Ok(())
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Delivery {
    pub version: u8,
    pub event: String,
    pub notification: Notification,
    pub receipt: String,
    #[serde(skip, default = "std::time::Instant::now")]
    pub received_at: std::time::Instant,
}
impl Delivery {
    pub fn decode(value: Value) -> Result<Self, String> {
        let delivery: Self = serde_json::from_value(value).map_err(|_| "Invalid notification event")?;
        delivery.notification.validate()?;
        if delivery.version != 3 || delivery.event != "notification" || !valid_receipt(&delivery.receipt) {
            return Err("Invalid notification event contract".into());
        }
        Ok(delivery)
    }
}

pub fn notify_argument(args: &[String]) -> Result<Option<String>, String> {
    if !args.iter().any(|arg| arg.starts_with("--notify")) { return Ok(None); }
    if args.len() != 2 || args[0] != "--notify" || !valid_id(&args[1]) {
        return Err("Usage: --notify <notification id>".into());
    }
    Ok(Some(args[1].clone()))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Lookup { notification: Option<Notification>, receipt: Option<String> }
fn decode_lookup(value: Value, id: &str) -> Result<(Notification, String), String> {
    if value.get("notification").is_none() || value.get("receipt").is_none() { return Err("Invalid notification lookup".into()); }
    let lookup: Lookup = serde_json::from_value(value).map_err(|_| "Invalid notification lookup")?;
    let notification = lookup.notification.ok_or("Notification unavailable")?;
    notification.validate()?;
    let receipt = lookup.receipt.filter(|r| valid_receipt(r)).ok_or("Notification delivery expired")?;
    if notification.id != id { return Err("Notification id mismatch".into()); }
    Ok((notification, receipt))
}
pub type Poster<'a> = dyn Fn(&Notification, &dyn Fn() -> bool) -> bool + 'a;
/// Acknowledges only the native completion result while this connection still owns the generation.
pub fn deliver(agent: &crate::host::Agent, notification: &Notification, receipt: &str, active: &dyn Fn() -> bool, post: &Poster<'_>) -> Result<bool, String> {
    if !active() { return Ok(false); }
    let delivered = post(notification, active);
    if !active() { return Ok(false); }
    let result = agent.request(crate::host::Request::NotificationAck { notification_id:notification.id.clone(), receipt:receipt.into(), delivered })?;
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Ack { accepted: bool }
    let ack: Ack = serde_json::from_value(result).map_err(|_| "Invalid notification acknowledgment")?;
    Ok(delivered && ack.accepted)
}
pub fn notify_only(state_root: &std::path::Path, id: &str, deadline: std::time::Instant, post: impl Fn(&Notification, &dyn Fn() -> bool) -> bool) -> Result<bool, String> {
    if !valid_id(id) { return Err("Invalid notification id".into()); }
    if std::time::Instant::now() >= deadline { return Ok(false); }
    let agent = crate::host::Agent::connect_notification(state_root, deadline)?;
    let lookup = agent.request_before(crate::host::Request::Notification { notification_id:id.into() }, deadline)?;
    let (notification, receipt) = decode_lookup(lookup, id)?;
    deliver(&agent, &notification, &receipt, &||agent.is_connected() && std::time::Instant::now() < deadline, &post)
}
#[derive(Default)]
pub struct ReviewRoute(std::sync::atomic::AtomicBool);
impl ReviewRoute {
    pub fn request(&self) { self.0.store(true, std::sync::atomic::Ordering::SeqCst); }
    pub fn take(&self) -> bool { self.0.swap(false, std::sync::atomic::Ordering::SeqCst) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::{fixtures::Fixture};
    use serde_json::json;
    use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
    #[test]
    fn hidden_mode_fetches_without_subscribe_and_acknowledges_only_post_result() {
        for delivered in [true, false] {
            let fixture = Fixture::new(move |mut wire| {
                let hello = wire.next().unwrap(); assert_eq!(hello["command"], "hello"); assert_eq!(hello["client"], "app");
                wire.reply(&hello, json!({"agentVersion":"test","protocol":3,"policy":"notify","paused":null}));
                let lookup = wire.next().unwrap(); assert_eq!(lookup["command"],"notification"); assert_eq!(lookup["notificationId"], "a".repeat(64));
                wire.reply(&lookup,json!({"notification":{"id":"a".repeat(64),"title":"Review","body":"Items"},"receipt":"receipt"}));
                let ack = wire.next().unwrap(); assert_eq!(ack["command"],"notificationAck"); assert_eq!(ack["receipt"],"receipt"); assert_eq!(ack["delivered"],delivered);
                wire.reply(&ack,json!({"accepted":true})); assert!(wire.next().is_none());
            });
            let posted = AtomicBool::new(false);
            let result = notify_only(&fixture.root, &"a".repeat(64), std::time::Instant::now() + std::time::Duration::from_secs(3), |n, active| { assert_eq!(n.title,"Review"); assert!(active()); posted.store(true,Ordering::SeqCst); delivered });
            assert_eq!(result.unwrap(),delivered); assert!(posted.load(Ordering::SeqCst)); fixture.finish();
        }
    }
    #[test]
    fn expired_hidden_budget_does_not_connect() {
        assert!(!notify_only(std::path::Path::new("/nonexistent"), &"a".repeat(64), std::time::Instant::now(), |_,_|panic!("Expired delivery must not post")).unwrap());
    }
    #[test]
    fn lookup_refuses_expired_mismatched_or_unknown_fields() {
        for value in [json!({"notification":null,"receipt":null}), json!({"notification":{"id":"a".repeat(64),"title":"x","body":"y"},"receipt":null}), json!({"notification":{"id":"b".repeat(64),"title":"x","body":"y"},"receipt":"r"}), json!({"notification":{"id":"a".repeat(64),"title":"x","body":"y"},"receipt":"r","extra":true})] {
            assert!(decode_lookup(value, &"a".repeat(64)).is_err());
        }
    }
    #[test]
    fn notify_arguments_fail_closed() {
        assert_eq!(notify_argument(&[]).unwrap(),None);
        assert_eq!(notify_argument(&["--notify".into(),"a".repeat(64)]).unwrap(),Some("a".repeat(64)));
        for args in [vec!["--notify=bad".into()],vec!["--notify-extra".into()],vec!["--notify".into()],vec!["--notify".into(),"oops".into()],vec!["--notify".into(),"a".repeat(64),"extra".into()],vec!["extra".into(),"--notify".into(),"a".repeat(64)]] { assert!(notify_argument(&args).is_err()); }
    }
    #[test]
    fn stale_delivery_never_posts_or_acknowledges() {
        let fixture = Fixture::new(|mut wire| { wire.handshake(); assert!(wire.next().is_none()); });
        let agent = fixture.connect(Arc::new(|_| {}));
        let n = Notification { id:"a".repeat(64),title:"x".into(),body:"y".into() };
        assert!(!deliver(&agent,&n,"r",&||false, &|_,_|panic!("Stale generation must not post")).unwrap());
        drop(agent); fixture.finish();
    }
    #[test]
    fn review_click_before_renderer_is_ready_is_consumed_once() {
        let route = ReviewRoute::default(); route.request(); route.request(); assert!(route.take()); assert!(!route.take());
    }
}

#[cfg(target_os = "macos")]
mod native {
    use super::*;
    use block2::{DynBlock, RcBlock};
    use objc2::{define_class, msg_send, DefinedClass, AnyThread};
    use objc2::rc::Retained;
    use objc2::runtime::{NSObjectProtocol, ProtocolObject, Bool};
    use objc2_foundation::{NSObject, NSString, NSError, NSDate, NSRunLoop, NSDefaultRunLoopMode, MainThreadMarker};
    use objc2_user_notifications::*;
    use std::{ptr::NonNull, sync::{mpsc, Arc}, time::{Duration, Instant}};

    define_class!(
        #[unsafe(super(NSObject))]
        #[ivars = Arc<dyn Fn() + Send + Sync>]
        pub struct Delegate;
        unsafe impl NSObjectProtocol for Delegate {}
        unsafe impl UNUserNotificationCenterDelegate for Delegate {
            #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
            fn present(&self, _: &UNUserNotificationCenter, _: &UNNotification,
                completion: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>) {
                completion.call((UNNotificationPresentationOptions::Banner | UNNotificationPresentationOptions::List,));
            }
            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn clicked(&self, _: &UNUserNotificationCenter, response: &UNNotificationResponse,
                completion: &DynBlock<dyn Fn()>) {
                if response.actionIdentifier().isEqualToString(unsafe { UNNotificationDefaultActionIdentifier })
                    && valid_id(&response.notification().request().identifier().to_string()) {
                    (self.ivars())();
                }
                completion.call(());
            }
        }
    );
    /// Keep this strong reference alive because UserNotifications holds its delegate weakly.
    pub fn install(click: Arc<dyn Fn() + Send + Sync>) -> Option<Retained<Delegate>> {
        if !bundled() { return None; }
        let delegate = Delegate::alloc().set_ivars(click);
        let delegate: Retained<Delegate> = unsafe { msg_send![super(delegate), init] };
        UNUserNotificationCenter::currentNotificationCenter().setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        Some(delegate)
    }
    fn bundled() -> bool {
        std::env::current_exe().ok().is_some_and(|p| {
            p.parent().is_some_and(|p| p.file_name().is_some_and(|n| n == "MacOS"))
                && p.parent().and_then(|p|p.parent()).is_some_and(|p|p.file_name().is_some_and(|n|n == "Contents"))
                && p.parent().and_then(|p|p.parent()).and_then(|p|p.parent()).is_some_and(|p|p.extension().is_some_and(|e|e == "app") && p.join("Contents/Info.plist").is_file())
        })
    }
    pub fn request_permission() {
        if !bundled() { return; }
        let callback = RcBlock::new(|_: Bool, _: *mut NSError| {});
        UNUserNotificationCenter::currentNotificationCenter().requestAuthorizationWithOptions_completionHandler(UNAuthorizationOptions::Alert, &callback);
    }
    fn wait<T>(receiver: mpsc::Receiver<T>, end: Instant, active: &dyn Fn() -> bool) -> Option<T> {
        loop {
            match receiver.try_recv() {
                Ok(value) => return Some(value),
                Err(mpsc::TryRecvError::Disconnected) => return None,
                Err(mpsc::TryRecvError::Empty) => {},
            }
            if Instant::now() >= end || !active() { return None; }
            if MainThreadMarker::new().is_some() {
                NSRunLoop::mainRunLoop().runMode_beforeDate(unsafe { NSDefaultRunLoopMode }, &NSDate::dateWithTimeIntervalSinceNow(0.01));
            } else {
                match receiver.recv_timeout(Duration::from_millis(10).min(end.saturating_duration_since(Instant::now()))) {
                    Ok(value) => return Some(value),
                    Err(mpsc::RecvTimeoutError::Disconnected) => return None,
                    Err(mpsc::RecvTimeoutError::Timeout) => {},
                }
            }
        }
    }
    pub fn post(notification: &Notification, active: &dyn Fn() -> bool) -> bool {
        if !bundled() || !active() { return false; }
        objc2::rc::autoreleasepool(|_| {
            let end = Instant::now() + Duration::from_secs(3);
            let center = UNUserNotificationCenter::currentNotificationCenter();
            let (sent, received) = mpsc::channel();
            let settings = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
                let settings = unsafe { settings.as_ref() };
                let accepted = settings.authorizationStatus() == UNAuthorizationStatus::Authorized
                    && (settings.alertSetting() == UNNotificationSetting::Enabled || settings.notificationCenterSetting() == UNNotificationSetting::Enabled);
                let _ = sent.send(accepted);
            });
            center.getNotificationSettingsWithCompletionHandler(&settings);
            if wait(received, end, active) != Some(true) || Instant::now() >= end || !active() { return false; }
            let content = UNMutableNotificationContent::new();
            content.setTitle(&NSString::from_str(&notification.title));
            content.setBody(&NSString::from_str(&notification.body));
            let request = UNNotificationRequest::requestWithIdentifier_content_trigger(&NSString::from_str(&notification.id), &content, None);
            let (sent, received) = mpsc::channel();
            let completion = RcBlock::new(move |error: *mut NSError| { let _ = sent.send(error.is_null()); });
            center.addNotificationRequest_withCompletionHandler(&request, Some(&completion));
            wait(received, end, active) == Some(true)
        })
    }
}
#[cfg(target_os = "macos")]
pub use native::{install, post, request_permission};
#[cfg(not(target_os = "macos"))]
pub fn install(_: std::sync::Arc<dyn Fn() + Send + Sync>) -> Option<()> { None }
#[cfg(not(target_os = "macos"))]
pub fn request_permission() {}
#[cfg(not(target_os = "macos"))]
pub fn post(_: &Notification, _: &dyn Fn() -> bool) -> bool { false }
