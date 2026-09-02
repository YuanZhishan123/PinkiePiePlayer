// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Listener, Manager, PhysicalPosition, PhysicalSize};

/// 播放列表窗口是否已被用户独立拖开(脱离主窗口的位置跟随)
static PLAYLIST_DETACHED: AtomicBool = AtomicBool::new(false);

#[derive(serde::Serialize, Clone)]
pub struct MediaItem {
    pub name: String,
    pub path: String,
    /// 是否为纯音频文件(前端据此显示唱片界面)
    pub audio: bool,
}

const VIDEO_EXTS: &[&str] = &[
    "mp4", "mkv", "webm", "mov", "m4v", "avi", "flv", "ts", "m2ts", "wmv", "mpg", "mpeg",
    "vob", "ogv", "3gp", "rmvb", "mpe",
];

/// WebView2(Chromium 内核)可解码的音频格式
const AUDIO_EXTS: &[&str] = &["mp3", "flac", "wav", "ogg", "oga", "opus", "m4a", "aac", "weba"];

fn ext_of(p: &std::path::Path) -> Option<String> {
    p.extension()
        .map(|e| e.to_string_lossy().to_lowercase())
}

fn is_video_file(p: &std::path::Path) -> bool {
    p.is_file()
        && ext_of(p)
            .map(|e| VIDEO_EXTS.contains(&e.as_str()))
            .unwrap_or(false)
}

fn is_audio_file(p: &std::path::Path) -> bool {
    p.is_file()
        && ext_of(p)
            .map(|e| AUDIO_EXTS.contains(&e.as_str()))
            .unwrap_or(false)
}

/// Natural order comparison: "ep2" < "ep10", case-insensitive, numeric aware.
fn nat_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let av: Vec<char> = a.chars().collect();
    let bv: Vec<char> = b.chars().collect();
    let (mut i, mut j) = (0usize, 0usize);
    while i < av.len() && j < bv.len() {
        let ca = av[i];
        let cb = bv[j];
        if ca.is_ascii_digit() && cb.is_ascii_digit() {
            let mut na = String::new();
            let mut nb = String::new();
            while i < av.len() && av[i].is_ascii_digit() {
                na.push(av[i]);
                i += 1;
            }
            while j < bv.len() && bv[j].is_ascii_digit() {
                nb.push(bv[j]);
                j += 1;
            }
            // Compare numeric value (strip leading zeros), shorter first when equal value.
            let ta = na.trim_start_matches('0');
            let tb = nb.trim_start_matches('0');
            let ord = ta.len().cmp(&tb.len()).then_with(|| ta.cmp(tb));
            if ord != std::cmp::Ordering::Equal {
                return ord;
            }
        } else {
            let la = ca.to_lowercase().next().unwrap_or(ca);
            let lb = cb.to_lowercase().next().unwrap_or(cb);
            if la != lb {
                return la.cmp(&lb);
            }
            i += 1;
            j += 1;
        }
    }
    (av.len() - i).cmp(&(bv.len() - j))
}

/// Scan the directory of `path` (or the directory itself) for media files
/// (video + audio), returning them naturally sorted.
#[tauri::command]
fn scan_video_dir(path: String) -> Result<Vec<MediaItem>, String> {
    let p = PathBuf::from(&path);
    let dir = if p.is_dir() {
        p
    } else {
        p.parent()
            .map(|x| x.to_path_buf())
            .ok_or_else(|| "无法获取文件所在目录".to_string())?
    };

    let mut items: Vec<MediaItem> = Vec::new();
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("读取目录失败: {e}"))?;
    for entry in entries.flatten() {
        let ep = entry.path();
        let (is_video, is_audio) = (is_video_file(&ep), is_audio_file(&ep));
        if is_video || is_audio {
            items.push(MediaItem {
                name: ep
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default(),
                path: ep.to_string_lossy().to_string(),
                audio: is_audio,
            });
        }
    }
    items.sort_by(|a, b| nat_cmp(&a.name, &b.name));
    Ok(items)
}

/// Open a native file picker, returning the chosen media path (if any).
#[tauri::command]
fn open_file_dialog() -> Option<String> {
    rfd::FileDialog::new()
        .add_filter(
            "视频文件",
            &[
                "mp4", "mkv", "webm", "mov", "m4v", "avi", "flv", "ts", "m2ts", "wmv", "mpg",
                "mpeg", "vob", "ogv", "3gp", "rmvb",
            ],
        )
        .add_filter("音频文件", AUDIO_EXTS)
        .add_filter("所有文件", &["*"])
        .set_title("打开媒体文件")
        .pick_file()
        .map(|p| p.to_string_lossy().to_string())
}

/// Startup file passed via command line arguments (e.g. "Open with...").
struct StartupFile(pub Option<String>);

#[tauri::command]
fn get_startup_file(state: tauri::State<StartupFile>) -> Option<String> {
    state.0.clone()
}

/// 播放列表窗口实时跟随主窗口:贴在主窗口右侧、同高。
/// 在原生事件回调中直接同步,拖动/缩放过程中即时生效。
fn sync_playlist_window(main: &tauri::Window) {
    // 用户已把播放列表独立拖开:不再强制跟随主窗口
    if PLAYLIST_DETACHED.load(Ordering::Relaxed) {
        return;
    }
    let Some(pl) = main.app_handle().get_webview_window("playlist") else {
        return;
    };
    if !pl.is_visible().unwrap_or(false) {
        return;
    }
    let Ok(scale) = main.scale_factor() else { return };
    let (Ok(pos), Ok(size)) = (main.outer_position(), main.outer_size()) else {
        return;
    };
    let pw = (300.0 * scale).round() as i32;
    let mut x = pos.x + size.width as i32;
    let mut y = pos.y;
    // 限制在主窗口所在显示器范围内
    if let Ok(Some(mon)) = main.current_monitor() {
        let mpos = mon.position();
        let msize = mon.size();
        let max_x = mpos.x + msize.width as i32 - pw;
        if x > max_x {
            x = mpos.x.max(max_x);
        }
        if y < mpos.y {
            y = mpos.y;
        }
        let max_y = mpos.y + msize.height as i32 - size.height as i32;
        if y > max_y {
            y = max_y;
        }
    }
    let _ = pl.set_position(PhysicalPosition::new(x, y));
    let _ = pl.set_size(PhysicalSize::new(pw as u32, size.height));
}

/// 将播放列表窗口插入主窗口正上方(z 序紧邻):
/// 不会被其他窗口插在两者之间,也不会浮在所有窗口之上。
#[cfg(target_os = "windows")]
fn sync_playlist_zorder(main: &tauri::Window) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    };
    let Some(pl) = main.app_handle().get_webview_window("playlist") else {
        return;
    };
    if !pl.is_visible().unwrap_or(false) {
        return;
    }
    let (Ok(main_h), Ok(pl_h)) = (main.hwnd(), pl.hwnd()) else {
        return;
    };
    unsafe {
        SetWindowPos(
            pl_h.0 as _,
            main_h.0 as _,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
    }
}

/// Windows 11:为无边框窗口启用系统圆角(旧系统/其他平台自动忽略)。
#[cfg(target_os = "windows")]
fn apply_rounded_corners(window: &tauri::WebviewWindow) {
    use windows_sys::Win32::Graphics::Dwm::DwmSetWindowAttribute;

    const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
    const DWMWCP_ROUND: u32 = 2;

    let Ok(hwnd) = window.hwnd() else { return };
    let pref = DWMWCP_ROUND;
    unsafe {
        DwmSetWindowAttribute(
            hwnd.0 as _,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &pref as *const u32 as *const std::ffi::c_void,
            std::mem::size_of::<u32>() as u32,
        );
    }
}

fn main() {
    let startup: Option<String> = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .filter(|p| p.is_file())
        .map(|p| p.to_string_lossy().to_string());

    tauri::Builder::default()
        .manage(StartupFile(startup))
        .setup(|app| {
            // 主窗口启用 Windows 11 系统圆角
            #[cfg(target_os = "windows")]
            {
                if let Some(main_win) = app.get_webview_window("main") {
                    apply_rounded_corners(&main_win);
                }
            }

            // 播放列表独立拖动:前端拖动时脱离跟随,主窗口重新打开列表时恢复
            app.listen("playlist://detach", |_| {
                PLAYLIST_DETACHED.store(true, Ordering::Relaxed);
            });
            app.listen("playlist://attach", |_| {
                PLAYLIST_DETACHED.store(false, Ordering::Relaxed);
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scan_video_dir,
            open_file_dialog,
            get_startup_file
        ])
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            match event {
                // 拖动/缩放过程中实时同步外挂播放列表窗口
                tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
                    sync_playlist_window(window);
                }
                // 主窗口被激活时,把播放列表提到主窗口正上方,
                // 避免被其他窗口遮盖(如 alt-tab 切换后再切回)
                tauri::WindowEvent::Focused(true) => {
                    sync_playlist_window(window);
                    #[cfg(target_os = "windows")]
                    sync_playlist_zorder(window);
                }
                // 主窗口关闭时直接退出应用,避免外挂播放列表窗口残留进程
                tauri::WindowEvent::CloseRequested { .. } => {
                    window.app_handle().exit(0);
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_returns_video_and_audio() {
        let dir = std::env::temp_dir().join("ppp_scan_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for name in ["b.mp4", "a.mp3", "c.flac", "d.txt"] {
            std::fs::write(dir.join(name), b"x").unwrap();
        }
        let items = scan_video_dir(dir.to_string_lossy().to_string()).unwrap();
        let names: Vec<&str> = items.iter().map(|i| i.name.as_str()).collect();
        assert_eq!(names, vec!["a.mp3", "b.mp4", "c.flac"]); // 自然排序,d.txt 排除
        assert!(items[0].audio); // mp3 标记为音频
        assert!(!items[1].audio); // mp4 标记为视频
        let _ = std::fs::remove_dir_all(&dir);
    }
}
