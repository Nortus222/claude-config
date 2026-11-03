use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};

/// Keep the main window and agent alive until the user explicitly quits from the tray.
pub fn install(app: &tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Nortuscc", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Nortuscc", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let icon = app
        .default_window_icon()
        .ok_or_else(|| std::io::Error::other("Missing Nortuscc tray icon"))?;
    TrayIconBuilder::with_id("nortuscc")
        .icon(icon.clone())
        .tooltip("Nortuscc is running. Right-click to open or quit.")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

pub fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if window.label() != "main" {
        return;
    }
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        if let Err(error) = hide_for_close(|| window.hide(), || api.prevent_close()) {
            eprintln!("Could not hide Nortuscc to the tray: {error}");
        }
    }
}

// A failed hide must leave normal close available rather than trap an inaccessible window.
fn hide_for_close<E>(
    hide: impl FnOnce() -> Result<(), E>,
    prevent_close: impl FnOnce(),
) -> Result<(), E> {
    hide()?;
    prevent_close();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn closing_hides_before_preventing_window_destruction() {
        let events = RefCell::new(Vec::new());
        hide_for_close(
            || {
                events.borrow_mut().push("hide");
                Ok::<_, &str>(())
            },
            || events.borrow_mut().push("prevent close"),
        )
        .unwrap();
        assert_eq!(*events.borrow(), ["hide", "prevent close"]);
    }

    #[test]
    fn a_failed_hide_leaves_normal_close_available() {
        let result = hide_for_close(
            || Err("window unavailable"),
            || panic!("Do not trap the user"),
        );
        assert_eq!(result, Err("window unavailable"));
    }
}
