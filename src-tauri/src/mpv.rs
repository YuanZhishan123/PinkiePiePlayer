//! libmpv 动态加载 FFI(运行时加载 libmpv-2.dll,缺失时优雅降级为仅 UI 模式)
#![allow(non_snake_case)]

use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::path::Path;
use std::sync::atomic::{AtomicPtr, Ordering};
use std::sync::OnceLock;

pub type MpvHandle = *mut c_void;

/* ---- mpv_format(client.h) ---- */
pub const MPV_FORMAT_NONE: c_int = 0;
pub const MPV_FORMAT_STRING: c_int = 1;
pub const MPV_FORMAT_FLAG: c_int = 3;
pub const MPV_FORMAT_INT64: c_int = 4;
pub const MPV_FORMAT_DOUBLE: c_int = 5;

/* ---- mpv_event_id(节选) ---- */
pub const MPV_EVENT_NONE: c_int = 0;
pub const MPV_EVENT_SHUTDOWN: c_int = 1;
pub const MPV_EVENT_LOG_MESSAGE: c_int = 2;
pub const MPV_EVENT_END_FILE: c_int = 7;
pub const MPV_EVENT_FILE_LOADED: c_int = 8;
pub const MPV_EVENT_PROPERTY_CHANGE: c_int = 22;

/* ---- mpv_event_end_file.reason(节选) ---- */
pub const MPV_END_FILE_REASON_EOF: c_int = 0;
pub const MPV_END_FILE_REASON_ERROR: c_int = 4;

type MpvCreateFn = unsafe extern "C" fn() -> MpvHandle;
type MpvInitializeFn = unsafe extern "C" fn(MpvHandle) -> c_int;
type MpvTerminateDestroyFn = unsafe extern "C" fn(MpvHandle);
type MpvCommandFn = unsafe extern "C" fn(MpvHandle, *const *const c_char) -> c_int;
type MpvCommandAsyncFn = unsafe extern "C" fn(MpvHandle, u64, *const *const c_char) -> c_int;
type MpvSetPropFn = unsafe extern "C" fn(MpvHandle, *const c_char, c_int, *mut c_void) -> c_int;
type MpvSetOptionFn = unsafe extern "C" fn(MpvHandle, *const c_char, *const c_char) -> c_int;
type MpvGetPropFn = unsafe extern "C" fn(MpvHandle, *const c_char, c_int, *mut c_void) -> c_int;
type MpvObserveFn = unsafe extern "C" fn(MpvHandle, u64, *const c_char, c_int) -> c_int;
type MpvWaitEventFn = unsafe extern "C" fn(MpvHandle, f64) -> *mut MpvEvent;
type MpvFreeFn = unsafe extern "C" fn(*mut c_void);
type MpvFreeStrFn = unsafe extern "C" fn(*mut c_char);
type MpvErrStrFn = unsafe extern "C" fn(c_int) -> *const c_char;
type MpvReqLogFn = unsafe extern "C" fn(MpvHandle, *const c_char) -> c_int;

#[repr(C)]
pub struct MpvEvent {
    pub event_id: c_int,
    pub reply_userdata: u32,
    pub error: c_int,
    pub data: *mut c_void,
}

#[repr(C)]
pub struct MpvEventProperty {
    pub name: *const c_char,
    pub format: c_int,
    pub data: *mut c_void,
}

/// 仅需 reason(首个字段),后续字段布局无需完整还原
#[repr(C)]
pub struct MpvEventEndFile {
    pub reason: c_int,
}

#[repr(C)]
pub struct MpvEventLogMessage {
    pub prefix: *const c_char,
    pub level: *const c_char,
    pub text: *const c_char,
    pub log_level: c_int,
}

pub struct MpvApi {
    pub create: MpvCreateFn,
    pub initialize: MpvInitializeFn,
    pub terminate_destroy: MpvTerminateDestroyFn,
    pub command: MpvCommandFn,
    pub command_async: MpvCommandAsyncFn,
    pub set_property: MpvSetPropFn,
    pub set_option_string: MpvSetOptionFn,
    pub get_property: MpvGetPropFn,
    pub observe_property: MpvObserveFn,
    pub wait_event: MpvWaitEventFn,
    pub free: MpvFreeFn,
    pub free_string: MpvFreeStrFn,
    pub error_string: MpvErrStrFn,
    pub request_log_messages: MpvReqLogFn,
}

static API: OnceLock<MpvApi> = OnceLock::new();
static HANDLE: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());

/// 从指定路径加载 libmpv-2.dll 并解析全部所需导出函数
pub fn load(dll: &Path) -> Result<(), String> {
    use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};

    if API.get().is_some() {
        return Ok(());
    }
    if !dll.exists() {
        return Err(format!("找不到解码组件 {}", dll.display()));
    }
    let wide: Vec<u16> = dll.to_string_lossy().encode_utf16().chain([0]).collect();
    let lib = unsafe { LoadLibraryW(wide.as_ptr()) };
    if lib.is_null() {
        return Err("加载 libmpv-2.dll 失败".into());
    }

    unsafe fn sym<T>(lib: *mut c_void, name: &str) -> Result<T, String> {
        let n = CString::new(name).unwrap();
        let p = GetProcAddress(lib, n.as_ptr() as *const u8);
        p.map(|f| std::mem::transmute_copy::<_, T>(&f))
            .ok_or_else(|| format!("libmpv 缺少导出函数 {name}"))
    }

    let api = MpvApi {
        create: unsafe { sym(lib, "mpv_create") }?,
        initialize: unsafe { sym(lib, "mpv_initialize") }?,
        terminate_destroy: unsafe { sym(lib, "mpv_terminate_destroy") }?,
        command: unsafe { sym(lib, "mpv_command") }?,
        command_async: unsafe { sym(lib, "mpv_command_async") }?,
        set_property: unsafe { sym(lib, "mpv_set_property") }?,
        set_option_string: unsafe { sym(lib, "mpv_set_option_string") }?,
        get_property: unsafe { sym(lib, "mpv_get_property") }?,
        observe_property: unsafe { sym(lib, "mpv_observe_property") }?,
        wait_event: unsafe { sym(lib, "mpv_wait_event") }?,
        free: unsafe { sym(lib, "mpv_free") }?,
        free_string: unsafe { sym(lib, "mpv_free") }?,
        error_string: unsafe { sym(lib, "mpv_error_string") }?,
        request_log_messages: unsafe { sym(lib, "mpv_request_log_messages") }?,
    };
    API.set(api).map_err(|_| "libmpv 重复加载".to_string())
}

pub fn loaded() -> bool {
    API.get().is_some()
}

fn api() -> &'static MpvApi {
    API.get().expect("libmpv 尚未加载")
}

pub fn set_handle(h: MpvHandle) {
    HANDLE.store(h, Ordering::SeqCst);
}

pub fn handle() -> Option<MpvHandle> {
    let h = HANDLE.load(Ordering::SeqCst);
    (!h.is_null()).then_some(h)
}

fn err_text(code: c_int) -> String {
    unsafe { CStr::from_ptr((api().error_string)(code)).to_string_lossy().into_owned() }
}

fn check(r: c_int) -> Result<(), String> {
    if r == 0 { Ok(()) } else { Err(format!("mpv 调用失败({r}): {}", err_text(r))) }
}

/* ---------------- 实例创建 ---------------- */

/// 创建 mpv 实例并绑定 wid 视频子窗口(须在 initialize 之前设置 wid)
pub fn create_with_wid(wid: usize) -> Result<MpvHandle, String> {
    let api = api();
    let h = unsafe { (api.create)() };
    if h.is_null() {
        return Err("mpv_create 失败".into());
    }
    let result = (|| {
        // wid 必须成功
        set_option_on(h, "wid", &wid.to_string())?;
        // 其余选项:失败仅忽略(不同版本行为差异)
        let optional = [
            ("hwdec", "auto-safe"),
            ("input-default-bindings", "no"),
            ("input-vo-keyboard", "no"),
            ("input-cursor", "no"),
            ("osc", "no"),
            ("osd-level", "0"),
            ("keep-open", "no"),
            ("sub-auto", "fuzzy"),
            ("sub-font-size", "46"),
            ("ytdl", "no"),
            ("cursor-autohide", "no"),
            ("audio-pitch-correction", "yes"),
        ];
        for (k, v) in optional {
            let _ = set_option_on(h, k, v);
        }
        let r = unsafe { (api.initialize)(h) };
        if r != 0 {
            return Err(format!("mpv_initialize 失败({r})"));
        }
        Ok(())
})();
    if let Err(e) = result {
        unsafe { (api.terminate_destroy)(h) };
        return Err(e);
    }
    Ok(h)
}

fn set_option_on(h: MpvHandle, name: &str, value: &str) -> Result<(), String> {
    let n = CString::new(name).unwrap();
    let v = CString::new(value).unwrap();
    let api = api();
    // 初始化前必须用 mpv_set_option_string(mpv_set_property 在未初始化句柄上未定义)
    let r = unsafe { (api.set_option_string)(h, n.as_ptr(), v.as_ptr()) };
    check(r)
}

/* ---------------- 属性读写 ---------------- */

pub fn set_flag(name: &str, v: bool) -> Result<(), String> {
    let h = handle().ok_or("mpv 未初始化")?;
    let n = CString::new(name).unwrap();
    let mut out = v as i32;
    let r = unsafe { (api().set_property)(h, n.as_ptr(), MPV_FORMAT_FLAG, &mut out as *mut i32 as *mut c_void) };
    check(r)
}

pub fn set_double(name: &str, v: f64) -> Result<(), String> {
    let h = handle().ok_or("mpv 未初始化")?;
    let n = CString::new(name).unwrap();
    let mut out = v;
    let r = unsafe { (api().set_property)(h, n.as_ptr(), MPV_FORMAT_DOUBLE, &mut out as *mut f64 as *mut c_void) };
    check(r)
}

pub fn get_flag(name: &str) -> Option<bool> {
    let h = handle()?;
    let n = CString::new(name).unwrap();
    let mut out: i32 = 0;
    let r = unsafe { (api().get_property)(h, n.as_ptr(), MPV_FORMAT_FLAG, &mut out as *mut i32 as *mut c_void) };
    (r == 0).then_some(out != 0)
}

pub fn get_double(name: &str) -> Option<f64> {
    let h = handle()?;
    let n = CString::new(name).unwrap();
    let mut out: f64 = 0.0;
    let r = unsafe { (api().get_property)(h, n.as_ptr(), MPV_FORMAT_DOUBLE, &mut out as *mut f64 as *mut c_void) };
    (r == 0).then_some(out)
}

pub fn get_int(name: &str) -> Option<i64> {
    let h = handle()?;
    let n = CString::new(name).unwrap();
    let mut out: i64 = 0;
    let r = unsafe { (api().get_property)(h, n.as_ptr(), MPV_FORMAT_INT64, &mut out as *mut i64 as *mut c_void) };
    (r == 0).then_some(out)
}

pub fn get_string(name: &str) -> Option<String> {
    let h = handle()?;
    let n = CString::new(name).unwrap();
    let mut out: *mut c_char = std::ptr::null_mut();
    let r = unsafe { (api().get_property)(h, n.as_ptr(), MPV_FORMAT_STRING, &mut out as *mut *mut c_char as *mut c_void) };
    if r != 0 || out.is_null() {
        return None;
    }
    let s = unsafe { CStr::from_ptr(out).to_string_lossy().into_owned() };
    unsafe { (api().free_string)(out) };
    Some(s)
}

pub fn observe(name: &str, format: c_int) {
    if let Some(h) = handle() {
        let n = CString::new(name).unwrap();
        unsafe { (api().observe_property)(h, 0, n.as_ptr(), format) };
    }
}

/// 阻塞等待下一个 mpv 事件(仅供事件线程调用)
pub unsafe fn wait_event(h: MpvHandle, timeout: f64) -> *mut MpvEvent {
    (api().wait_event)(h, timeout)
}

/// 开启 mpv 内部日志(转发到事件流)
pub fn request_log_messages(min_level: &str) -> Result<(), String> {
    let h = handle().ok_or("mpv 未初始化")?;
    let level = CString::new(min_level).unwrap();
    let r = unsafe { (api().request_log_messages)(h, level.as_ptr()) };
    check(r)
}

/* ---------------- 命令 ---------------- */

pub fn command(args: &[&str]) -> Result<(), String> {
    let h = handle().ok_or("mpv 未初始化")?;
    let cargs: Vec<CString> = args
        .iter()
        .map(|&s| CString::new(s).map_err(|_| "字符串包含 NUL".to_string()))
        .collect::<Result<_, _>>()?;
    let mut ptrs: Vec<*const c_char> = cargs.iter().map(|c| c.as_ptr()).collect();
    ptrs.push(std::ptr::null());
    let r = unsafe { (api().command)(h, ptrs.as_ptr()) };
    check(r)
}

/// 异步命令:立即返回,不等待 mpv 核心执行(loadfile 等耗时命令必须用这个,
/// 否则大文件 demux 建索引时会阻塞调用线程)
pub fn command_async(args: &[&str]) -> Result<(), String> {
    let h = handle().ok_or("mpv 未初始化")?;
    let cargs: Vec<CString> = args
        .iter()
        .map(|&s| CString::new(s).map_err(|_| "字符串包含 NUL".to_string()))
        .collect::<Result<_, _>>()?;
    let mut ptrs: Vec<*const c_char> = cargs.iter().map(|c| c.as_ptr()).collect();
    ptrs.push(std::ptr::null());
    let r = unsafe { (api().command_async)(h, 0, ptrs.as_ptr()) };
    check(r)
}
