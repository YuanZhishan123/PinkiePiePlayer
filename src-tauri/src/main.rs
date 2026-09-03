// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod mpv;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Listener, Manager, PhysicalPosition, PhysicalSize};

/// 播放列表窗口是否已被用户独立拖开(脱离主窗口的位置跟随)
static PLAYLIST_DETACHED: AtomicBool = AtomicBool::new(false);

/// 当前文件是否有视频轨(mpv 视频子窗口应否显示;心跳据此恢复显示)
static VIDEO_SHOWN: AtomicBool = AtomicBool::new(false);

#[derive(serde::Serialize, Clone)]
pub struct MediaItem {
    pub name: String,
    pub path: String,
    /// 是否为纯音频文件(前端据此显示唱片界面)
    pub audio: bool,
}

const VIDEO_EXTS: &[&str] = &[
    "mp4", "mkv", "webm", "mov", "m4v", "avi", "flv", "ts", "m2ts", "wmv", "mpg", "mpeg",
    "vob", "ogv", "3gp", "rmvb", "mpe", "wm", "ogm",
];

/// libmpv 几乎支持所有音频格式,这里仅用于扫描过滤与列表标记
const AUDIO_EXTS: &[&str] = &["mp3", "flac", "wav", "ogg", "oga", "opus", "m4a", "aac", "weba", "wma", "ape", "mka"];

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
                "mpeg", "vob", "ogv", "3gp", "rmvb", "wm", "ogm",
            ],
        )
        .add_filter("音频文件", AUDIO_EXTS)
        .add_filter("所有文件", &["*"])
        .set_title("打开媒体文件")
        .pick_file()
        .map(|p| p.to_string_lossy().to_string())
}

/// Open a native file picker for a subtitle file, returning the chosen path (if any).
#[tauri::command]
fn open_subtitle_dialog() -> Option<String> {
    rfd::FileDialog::new()
        .add_filter("字幕文件", &["srt", "ass", "ssa", "sub", "vtt"])
        .add_filter("所有文件", &["*"])
        .set_title("打开字幕文件")
        .pick_file()
        .map(|p| p.to_string_lossy().to_string())
}

/// Startup file passed via command line arguments (e.g. "Open with...").
struct StartupFile(pub Option<String>);

#[tauri::command]
fn get_startup_file(state: tauri::State<StartupFile>) -> Option<String> {
    state.0.clone()
}

/* ============ mpv 播放控制命令(前端桥接) ============ */

#[tauri::command]
fn mpv_loadfile(path: String) -> Result<(), String> {
    // 加载期间(首帧渲染前)先兜底显示黑色视频子窗口,
    // 与前端 #stage.loading 底色双保险,避免透明窗口透出桌面
    #[cfg(target_os = "windows")]
    video_child::force_shown_bottom();
    // 异步执行:大文件打开/建索引不能阻塞 invoke
    mpv::command_async(&["loadfile", &path])
}

#[tauri::command]
fn mpv_set_pause(paused: bool) -> Result<(), String> {
    mpv::set_flag("pause", paused)
}

#[tauri::command]
fn mpv_seek(t: f64) -> Result<(), String> {
    mpv::command(&["seek", &format!("{t}"), "absolute+exact"])
}

#[tauri::command]
fn mpv_seek_rel(d: f64) -> Result<(), String> {
    mpv::command(&["seek", &format!("{d}"), "relative"])
}

#[tauri::command]
fn mpv_set_speed(v: f64) -> Result<(), String> {
    mpv::set_double("speed", v)
}

#[tauri::command]
fn mpv_set_volume(v: f64) -> Result<(), String> {
    mpv::set_double("volume", v)
}

#[tauri::command]
fn mpv_set_mute(m: bool) -> Result<(), String> {
    mpv::set_flag("mute", m)
}

#[tauri::command]
fn mpv_get_timepos() -> Option<f64> {
    mpv::get_double("time-pos")
}

/// 前端就绪握手:页面加载完成后调用,Rust 回发 mpv://ready。
/// 修复竞态:事件线程启动时立即 emit 的 ready 早于前端 listen 注册而被丢弃,
/// 导致 mpvReady 永 false、轮询/暂停/进度全部静默失效。
#[tauri::command]
fn mpv_ready_ping(app: tauri::AppHandle) {
    let _ = app.emit("mpv://ready", ());
}

#[tauri::command]
fn mpv_toggle_sub() -> Result<(), String> {
    let cur = mpv::get_flag("sub-visibility").unwrap_or(true);
    mpv::set_flag("sub-visibility", !cur)
}

#[tauri::command]
fn mpv_sub_add(path: String) -> Result<(), String> {
    mpv::command(&["sub-add", &path, "select"])
}

#[tauri::command]
fn mpv_has_sub() -> bool {
    has_track_type("sub")
}

#[tauri::command]
fn mpv_set_panscan(v: f64) -> Result<(), String> {
    mpv::set_double("panscan", v)
}

#[tauri::command]
fn mpv_set_subpos(v: f64) -> Result<(), String> {
    mpv::set_double("sub-pos", v)
}

fn has_track_type(t: &str) -> bool {
    let n = mpv::get_int("track-list/count").unwrap_or(0);
    (0..n).any(|i| mpv::get_string(&format!("track-list/{i}/type")).as_deref() == Some(t))
}

/* ============ 播放列表窗口跟随 / z 序 ============ */

/// 播放列表窗口实时跟随主窗口:贴在主窗口右侧、同高。
/// 在原生事件回调中直接同步,拖动/缩放过程中即时生效。
fn sync_playlist_window(main: &tauri::Window) {
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

/* ============ mpv 视频子窗口(渲染在 WebView 之下) ============ */

#[cfg(target_os = "windows")]
mod video_child {
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicPtr, Ordering};
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::Graphics::Gdi::{GetStockObject, HBRUSH};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, GetClientRect, MoveWindow, RegisterClassW,
        SetWindowPos, ShowWindow, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SW_HIDE, SW_SHOW,
        WNDCLASSW, WS_CHILD, WS_VISIBLE,
    };

    static CHILD: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain([0]).collect()
    }

    /// 创建 mpv 渲染子窗口并压到主窗口子窗口最底层(WebView2 之下,透出视频)
    pub fn create(parent: HWND) -> Result<HWND, String> {
        unsafe {
            let hinstance = GetModuleHandleW(std::ptr::null());
            let class_w = wide("PinkieMpvHost");
            let mut wc: WNDCLASSW = std::mem::zeroed();
            wc.lpfnWndProc = Some(DefWindowProcW);
            wc.hInstance = hinstance;
            wc.lpszClassName = class_w.as_ptr();
            // 黑色背景画刷,加载期不闪白(BLACK_BRUSH = 4)
            wc.hbrBackground = GetStockObject(4) as HBRUSH;
            if RegisterClassW(&wc) == 0 {
                return Err("RegisterClassW 失败".into());
            }
            let title = wide("mpv-video");
            let hwnd = CreateWindowExW(
                0,
                class_w.as_ptr(),
                title.as_ptr(),
                (WS_CHILD | WS_VISIBLE) as u32,
                0,
                0,
                1,
                1,
                parent,
                std::ptr::null_mut(),
                hinstance,
                std::ptr::null(),
            );
            if hwnd.is_null() {
                return Err("CreateWindowExW 失败".into());
            }
            // 压到 z 序最底(HWND_BOTTOM = 1),WebView2 在其上且背景透明
            SetWindowPos(hwnd, 1 as HWND, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            sync_size(parent);
            CHILD.store(hwnd, Ordering::SeqCst);
            Ok(hwnd)
        }
    }

    /// 子窗口尺寸同步为主窗口客户区(物理像素)
    pub fn sync_size(parent: HWND) {
        unsafe {
            let mut rc = std::mem::zeroed();
            if GetClientRect(parent, &mut rc) != 0 {
                if let Some(child) = child() {
                    MoveWindow(child, 0, 0, rc.right, rc.bottom, 1);
                    // 缩放过程中 WebView2 可能被提到上面,保持 mpv 在最底
                    SetWindowPos(child, 1 as HWND, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
                }
            }
        }
    }

    /// 音频文件隐藏视频层(露出 WebView 的唱片界面)
    pub fn set_visible(visible: bool) {
        VIDEO_SHOWN_STORE(visible);
        if let Some(child) = child() {
            unsafe {
                ShowWindow(child, if visible { SW_SHOW } else { SW_HIDE });
            }
        }
    }

    /// 心跳保活:强制视频子窗口显示并压回最底层。
    /// 修复偶发“画面全透明”:最小化恢复/显示器切换/DWM 事件后,
    /// 子窗口可能被系统改动 z 序或隐藏,WebView 全透明背景会直接透出桌面。
    pub fn ensure_visible_bottom() {
        if !super::VIDEO_SHOWN.load(Ordering::Relaxed) {
            return;
        }
        if let Some(child) = child() {
            unsafe {
                ShowWindow(child, SW_SHOW);
                SetWindowPos(child, 1 as HWND, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            }
        }
    }

    /// 加载文件期间兜底显示黑色子窗口(不检查 VIDEO_SHOWN):
    /// loadfile 处理中与首帧渲染前,WebView 侧仅靠前端 loading 底色占位,
    /// 这里保证底层子窗口也在,双保险防止透明窗口透出桌面。
    pub fn force_shown_bottom() {
        if let Some(child) = child() {
            unsafe {
                ShowWindow(child, SW_SHOW);
                SetWindowPos(child, 1 as HWND, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            }
        }
    }

    fn VIDEO_SHOWN_STORE(v: bool) {
        super::VIDEO_SHOWN.store(v, Ordering::Relaxed);
    }

    pub fn child() -> Option<HWND> {
        let c = CHILD.load(Ordering::SeqCst);
        (!c.is_null()).then_some(c)
    }
}

/// 载入 dll、创建视频子窗口、初始化 mpv 实例
#[cfg(target_os = "windows")]
fn mpv_host_init(app: &tauri::AppHandle) -> Result<(), String> {
    let main_win = app.get_webview_window("main").ok_or("无主窗口")?;

    // 1. 定位 libmpv-2.dll:安装目录 → 安装目录/resources → 开发模式 vendor
    let dll = {
        let mut candidates: Vec<PathBuf> = Vec::new();
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                candidates.push(dir.join("libmpv-2.dll"));
                candidates.push(dir.join("resources").join("libmpv-2.dll"));
            }
        }
        candidates.push(
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../vendor/mpv/libmpv-2.dll"),
        );
        candidates
            .into_iter()
            .find(|p| p.exists())
            .ok_or("未找到 libmpv-2.dll,解码组件缺失")?
    };
    mpv::load(&dll)?;

    // 2. 视频子窗口(tauri hwnd() 返回 windows crate 的 HWND,.0 为裸指针)
    let parent = main_win.hwnd().map_err(|e| e.to_string())?;
    let child = video_child::create(parent.0)?;

    // 3. mpv 实例(wid 绑定子窗口)
    let h = mpv::create_with_wid(child as usize)?;
    mpv::set_handle(h);

    // 4. 观察需要同步到前端的属性
    mpv::observe("duration", mpv::MPV_FORMAT_DOUBLE);
    mpv::observe("pause", mpv::MPV_FORMAT_FLAG);
    mpv::observe("demuxer-cache-time", mpv::MPV_FORMAT_DOUBLE);
    mpv::observe("sub-visibility", mpv::MPV_FORMAT_FLAG);
    // 转发 mpv 内部日志到 stderr,便于诊断个别文件的解码问题
    let _ = mpv::request_log_messages("warn");
    Ok(())
}

/// mpv 事件线程:阻塞等待并转发为 Tauri 事件
fn spawn_mpv_events(app: tauri::AppHandle) {
    std::thread::spawn(move || unsafe {
        let Some(h) = mpv::handle() else { return };
        let _ = app.emit("mpv://ready", ());
        loop {
            // 3s 超时轮询:空闲时做子窗口 z 序/显示状态保活(修复偶发全透明)
            let ev = mpv::wait_event(h, 3.0);
            if ev.is_null() {
                video_child::ensure_visible_bottom();
                continue;
            }
            match (*ev).event_id {
                mpv::MPV_EVENT_NONE => {
                    video_child::ensure_visible_bottom();
                }
                mpv::MPV_EVENT_PROPERTY_CHANGE => {
                    if (*ev).data.is_null() {
                        continue;
                    }
                    let p = (*ev).data as *const mpv::MpvEventProperty;
                    let name = std::ffi::CStr::from_ptr((*p).name).to_string_lossy().into_owned();
                    let payload = match (*p).format {
                        mpv::MPV_FORMAT_FLAG if !(*p).data.is_null() => Some(serde_json::json!({
                            "name": name,
                            "flag": *((*p).data as *const i32) != 0
                        })),
                        mpv::MPV_FORMAT_DOUBLE if !(*p).data.is_null() => Some(serde_json::json!({
                            "name": name,
                            "num": *((*p).data as *const f64)
                        })),
                        mpv::MPV_FORMAT_INT64 if !(*p).data.is_null() => Some(serde_json::json!({
                            "name": name,
                            "num": *((*p).data as *const i64) as f64
                        })),
                        _ => None,
                    };
                    if let Some(pl) = payload {
                        let _ = app.emit("mpv://prop", pl);
                    }
                }
                mpv::MPV_EVENT_FILE_LOADED => {
                    // 轨道查询失败时保守视为有视频(宁显示黑窗口,不透明透出桌面)
                    let has_video = match mpv::get_int("track-list/count") {
                        Some(n) => (0..n).any(|i| {
                            mpv::get_string(&format!("track-list/{i}/type")).as_deref() == Some("video")
                        }),
                        None => true,
                    };
                    video_child::set_visible(has_video);
                    let _ = app.emit("mpv://file-loaded", serde_json::json!({ "hasVideo": has_video }));
                }
                mpv::MPV_EVENT_END_FILE => {
                    let reason = if (*ev).data.is_null() {
                        -1
                    } else {
                        ((*ev).data as *const mpv::MpvEventEndFile).read().reason
                    };
                    let _ = app.emit("mpv://end-file", serde_json::json!({ "reason": reason }));
                }
                mpv::MPV_EVENT_LOG_MESSAGE => {
                    // mpv 内部日志(仅 debug 构建输出,便于诊断个别文件问题)
                    if (*ev).data.is_null() {
                        continue;
                    }
                    #[cfg(debug_assertions)]
                    {
                        let m = (*ev).data as *const mpv::MpvEventLogMessage;
                        let prefix = std::ffi::CStr::from_ptr((*m).prefix).to_string_lossy();
                        let text = std::ffi::CStr::from_ptr((*m).text).to_string_lossy();
                        eprintln!("[mpv:{}] {}", prefix.trim_end(), text.trim_end());
                    }
                }
                mpv::MPV_EVENT_SHUTDOWN => break,
                _ => {}
            }
        }
    });
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
            let handle = app.handle().clone();

            // 主窗口启用 Windows 11 系统圆角
            #[cfg(target_os = "windows")]
            if let Some(main_win) = app.get_webview_window("main") {
                apply_rounded_corners(&main_win);
            }

            // mpv 播放内核初始化(组件缺失时通知前端降级提示)
            #[cfg(target_os = "windows")]
            match mpv_host_init(&handle) {
                Ok(()) => spawn_mpv_events(handle.clone()),
                Err(e) => {
                    let _ = handle.emit("mpv://unavailable", e);
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
            open_subtitle_dialog,
            get_startup_file,
            mpv_loadfile,
            mpv_ready_ping,
            mpv_set_pause,
            mpv_seek,
            mpv_seek_rel,
            mpv_set_speed,
            mpv_set_volume,
            mpv_set_mute,
            mpv_get_timepos,
            mpv_toggle_sub,
            mpv_sub_add,
            mpv_has_sub,
            mpv_set_panscan,
            mpv_set_subpos
        ])
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            match event {
                // 拖动/缩放过程中实时同步外挂播放列表窗口
                tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
                    sync_playlist_window(window);
                    #[cfg(target_os = "windows")]
                    {
                        if let Ok(parent) = window.hwnd() {
                            video_child::sync_size(parent.0);
                        }
                    }
                }
                // 主窗口被激活时,把播放列表提到主窗口正上方,
                // 避免被其他窗口遮盖(如 alt-tab 切换后再切回)
                tauri::WindowEvent::Focused(true) => {
                    sync_playlist_window(window);
                    #[cfg(target_os = "windows")]
                    {
                        sync_playlist_zorder(window);
                        if let Ok(parent) = window.hwnd() {
                            video_child::sync_size(parent.0);
                        }
                        video_child::ensure_visible_bottom();
                    }
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
        assert_eq!(names, vec!["a.mp3", "b.mp4", "c.flac"]);
        assert!(items[0].audio);
        assert!(!items[1].audio);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
