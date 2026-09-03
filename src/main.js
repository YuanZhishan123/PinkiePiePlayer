import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow, Window, PhysicalPosition, PhysicalSize, currentMonitor } from '@tauri-apps/api/window';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { emit, listen } from '@tauri-apps/api/event';

const $ = (id) => document.getElementById(id);

/* ---------------- 元素 ---------------- */
const app = $('app');
const stage = $('stage');
const titleText = $('title-text');
const emptyState = $('empty-state');
const btnOpen = $('btn-open');
const btnPlay = $('btn-play');
const btnPrev = $('btn-prev');
const btnNext = $('btn-next');
const btnSubtitle = $('btn-subtitle');
const btnSpeed = $('btn-speed');
const speedMenu = $('speed-menu');
const speedMenuItems = speedMenu.querySelector('.menu-items');
const volumeControl = $('volume-control');
const volumeSlider = $('volume-slider');
const volumeNum = $('volume-num');
const btnVolume = $('btn-volume');
const btnFit = $('btn-fit');
const btnFullscreen = $('btn-fullscreen');
const btnPlaylist = $('btn-playlist');
const timeCurrent = $('time-current');
const timeTotal = $('time-total');
const track = $('progress-track');
const playedBar = $('progress-played');
const bufferedBar = $('progress-buffered');
const dot = $('progress-dot');
const tip = $('progress-tip');
const speedBadge = $('speed-badge');
const toastEl = $('toast');
const win = getCurrentWindow();
let playlistWin = null; // 播放列表窗口句柄(冷启动时窗口创建可能晚于本页 JS,改为惰性获取)

// 获取播放列表窗口句柄:未取到时轮询重试(最长约 10s),避免冷启动竞态导致列表永久失效
async function getPlaylistWin() {
  if (playlistWin) return playlistWin;
  for (let i = 0; i < 40; i++) {
    playlistWin = await Window.getByLabel('playlist');
    if (playlistWin) return playlistWin;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}
getPlaylistWin(); // 启动时尽早预热句柄

/* ---------------- 常量与状态 ---------------- */
const RATES = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0];
const IDLE_MS = 2600; // 鼠标静止多久后隐藏 UI
const VOLUME_STEP = 0.05;
const SEEK_STEP = 5; // ← 短按快退秒数
const PLAYLIST_W = 300; // 播放列表窗口宽度(逻辑像素)
const SUBPOS_SHOWN = 85; // 控制栏可见时字幕上移避让
const SUBPOS_IDLE = 100; // UI 隐藏时字幕回到底部

let playlist = []; // [{name, path, audio}]
let currentDir = null; // 当前播放列表对应的目录
let currentIndex = -1;
let playlistOpen = false;
let rate = clamp(parseFloat(localStorage.getItem('vp-rate') || '1') || 1, 0.25, 4);
let volume = clamp(parseFloat(localStorage.getItem('vp-volume') ?? '0.8'), 0, 1);
let isFullscreen = false;
let boostRate = null; // 长按 → 之前的速率
let seeking = false;
let uiHovered = false; // 鼠标是否悬停在控件上
let menuOpen = false; // 倍速菜单是否展开
let clickTimer = null; // 单击/双击消歧
let idleTimer = null;
let volumeFlashTimer = null;
let toastTimer = null;

// 播放状态(mpv 为唯一数据源,经事件同步)
let mpvReady = false; // libmpv 加载成功
let hasMedia = false; // 当前是否已加载媒体
let playing = false;
let duration = 0;
let currentTime = 0;

/* ---------------- 工具 ---------------- */
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

function fmtRate(r) { return (Math.round(r * 100) / 100).toString().replace(/\.?0+$/, '') + 'x'; }

function fmtTime(t) {
  if (!isFinite(t) || t < 0) t = 0;
  t = Math.floor(t);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const mm = String(m).padStart(h > 0 ? 2 : 1, '0');
  return (h > 0 ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
}

function fileName(p) {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return i >= 0 ? p.slice(i + 1) : p;
}

function normPath(p) {
  return p.replace(/\//g, '\\').replace(/\\+/, '\\').toLowerCase().replace(/\\$/, '');
}

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
}

/* ---------------- UI 显隐(鼠标静止自动隐藏) ---------------- */
function wake() {
  const wasIdle = app.classList.contains('ui-idle');
  app.classList.remove('ui-idle');
  if (wasIdle && mpvReady) invoke('mpv_set_subpos', { v: SUBPOS_SHOWN }).catch(() => {});
  scheduleHide();
}

function scheduleHide() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    // 播放中、鼠标不在控件上、无弹出菜单时才隐藏
    if (hasMedia && playing && !uiHovered && !menuOpen && !seeking) {
      app.classList.add('ui-idle');
      if (mpvReady) invoke('mpv_set_subpos', { v: SUBPOS_IDLE }).catch(() => {});
    } else {
      scheduleHide();
    }
  }, IDLE_MS);
}

window.addEventListener('mousemove', wake);

document.documentElement.addEventListener('mouseleave', () => {
  // 按住画面后鼠标移出窗口:立即开始窗口拖动
  // (否则贴着窗口边缘按下时,向外移不足 4px 阈值就丢失事件,永远无法触发拖动)
  if (pressPos && !dragged) {
    dragged = true;
    pressPos = null;
    win.startDragging().catch(() => {});
  }
  // 窗口模式:鼠标移出窗口时立即隐藏 UI
  if (isFullscreen || !hasMedia || menuOpen || seeking) return;
  clearTimeout(idleTimer);
  app.classList.add('ui-idle');
  if (mpvReady) invoke('mpv_set_subpos', { v: SUBPOS_IDLE }).catch(() => {});
});

document.documentElement.addEventListener('mouseenter', wake);

// 悬停在控制栏的实际交互区(进度条/按钮行)时不自动隐藏
for (const el of [document.querySelector('#button-bar'), document.querySelector('#progress-area')]) {
  el.addEventListener('mouseenter', () => { uiHovered = true; });
  el.addEventListener('mouseleave', () => { uiHovered = false; });
}

/* ---------------- 播放控制(mpv) ---------------- */
const ICON_PLAY = '<svg viewBox="0 0 24 24"><path d="M8 5.2v13.6L19 12z" fill="currentColor"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24"><path d="M7 5h3.4v14H7zM13.6 5H17v14h-3.4z" fill="currentColor"/></svg>';

function setPlayingUI(p) {
  playing = p;
  btnPlay.innerHTML = p ? ICON_PAUSE : ICON_PLAY;
  btnPlay.title = p ? '暂停(空格)' : '播放(空格)';
  app.classList.toggle('is-playing', p);
}

function togglePlay() {
  if (!mpvReady || !hasMedia) return;
  invoke('mpv_set_pause', { paused: playing }).catch(() => {});
  setPlayingUI(playing ? false : true); // 乐观更新,mpv 事件随后校准
  if (!playing) wake();
}

btnPlay.addEventListener('click', togglePlay);

// 点击画面切换播放/暂停;双击切换全屏(单击延迟消歧)
// (mpv 视频渲染在 WebView 之下,画面区域的事件全部由 stage 接收)
stage.addEventListener('click', (e) => {
  if (dragged) { dragged = false; return; } // 刚拖完窗口,忽略这次 click
  if (e.target.closest('button, input') || app.classList.contains('drag-over')) return;
  if (clickTimer) return;
  clickTimer = setTimeout(() => { clickTimer = null; togglePlay(); }, 220);
});
stage.addEventListener('dblclick', (e) => {
  if (dragged || e.target.closest('button, input')) return;
  clearTimeout(clickTimer);
  clickTimer = null;
  toggleFullscreen();
});

/* ---------------- mpv 事件同步 ---------------- */
listen('mpv://ready', () => {
  mpvReady = true;
  // mpv 默认属性与用户偏好对齐(localStorage 记忆)
  invoke('mpv_set_volume', { v: Math.round(volume * 100) }).catch(() => {});
  invoke('mpv_set_speed', { v: rate }).catch(() => {});
  invoke('mpv_set_panscan', { v: fitMode === 'cover' ? 1 : 0 }).catch(() => {});
});

listen('mpv://unavailable', (e) => {
  toast(`解码组件缺失:${e.payload}`);
});

listen('mpv://prop', (e) => {
  const { name, flag, num } = e.payload;
  switch (name) {
    case 'pause':
      setPlayingUI(!flag);
      break;
    case 'duration':
      if (isFinite(num)) {
        duration = num;
        timeTotal.textContent = fmtTime(duration);
        updateProgressUI();
      }
      break;
    case 'demuxer-cache-time':
      if (isFinite(num) && duration > 0) {
        bufferedBar.style.width = clamp(num / duration, 0, 1) * 100 + '%';
      }
      break;
    case 'sub-visibility':
      btnSubtitle.classList.toggle('active', !!flag);
      btnSubtitle.title = flag ? '关闭字幕' : '显示字幕';
      break;
  }
});

listen('mpv://file-loaded', (e) => {
  const audioOnly = !e.payload.hasVideo;
  app.classList.toggle('audio-mode', audioOnly);
  hasMedia = true;
  playing = true;
  setPlayingUI(true);
  wake();
  // 等首帧短暂呈现后再撤掉加载底色,避免移除瞬间又透出空白
  setTimeout(() => stage.classList.remove('loading'), 160);
});

listen('mpv://end-file', (e) => {
  const reason = e.payload.reason;
  if (reason === 0) {
    playNext(); // 自然播完 → 循环下一个
  } else if (reason === 4) {
    toast('无法播放此文件,可能是不支持的格式');
    stage.classList.remove('loading'); // 加载失败:撤掉占位底色,回到可交互状态
  }
  // reason === 2 (STOP) 为主动切换文件,忽略
});

// 就绪握手:页面就绪后主动 ping,Rust 回发 mpv://ready。
// (Rust 在 setup 时发出的 ready 可能早于本页 listen 注册而被丢弃,
//  竞态下 mpvReady 永 false,导致轮询/暂停/进度全部静默失效)
invoke('mpv_ready_ping').catch(() => {});

// 进度/时间轮询(mpv 不推送高频 time-pos,低频拉取)
setInterval(async () => {
  if (!mpvReady || !hasMedia || seeking) return;
  try {
    const t = await invoke('mpv_get_timepos');
    if (t != null) {
      currentTime = t;
      timeCurrent.textContent = fmtTime(t);
      updateProgressUI();
    }
  } catch { /* ignore */ }
}, 250);

/* ---------------- 按住画面拖动窗口 ---------------- */
let pressPos = null; // mousedown 时的屏幕坐标
let dragged = false; // 本次按压是否已转为窗口拖动

stage.addEventListener('mousedown', (e) => {
  // 空状态(无媒体)时同样允许按住画面拖动窗口;按钮等交互控件除外
  if (e.button !== 0 || e.target.closest('button, input')) return;
  pressPos = { x: e.screenX, y: e.screenY };
  dragged = false;
});

// 顶部标题栏:按住空白处(窗口按钮以外)直接拖动窗口
$('titlebar').addEventListener('mousedown', (e) => {
  if (e.button !== 0 || e.target.closest('button')) return;
  win.startDragging().catch(() => {});
});

window.addEventListener('mousemove', (e) => {
  if (pressPos && !dragged) {
    const dx = e.screenX - pressPos.x;
    const dy = e.screenY - pressPos.y;
    if (Math.hypot(dx, dy) > 4) {
      dragged = true;
      pressPos = null;
      win.startDragging().catch(() => {});
    }
  }
});

window.addEventListener('mouseup', () => { pressPos = null; });

/* ---------------- 打开媒体 ---------------- */
// mpv 尚未就绪(冷启动竞态)时等待,避免 invoke 静默失败导致“拖入/打开无反应”
function waitMpvReady(timeout = 5000) {
  if (mpvReady) return Promise.resolve();
  return new Promise((resolve) => {
    const t0 = performance.now();
    const iv = setInterval(() => {
      if (mpvReady || performance.now() - t0 > timeout) {
        clearInterval(iv);
        resolve();
      }
    }, 50);
  });
}

async function openVideo(path, { fromPlaylist = false } = {}) {
  stopBoost();
  await waitMpvReady();
  const ok = await invoke('mpv_loadfile', { path }).catch(() => false);
  if (ok === false) {
    toast('无法打开文件,请稍后重试');
    return;
  }
  // 隐藏 emptyState 后、mpv 首帧渲染前:用不透明底色占位,防止透出桌面
  stage.classList.add('loading');
  titleText.textContent = fileName(path);
  emptyState.classList.add('hidden');
  duration = 0;
  currentTime = 0;
  timeTotal.textContent = '00:00';
  timeCurrent.textContent = '00:00';
  playedBar.style.width = '0%';
  bufferedBar.style.width = '0%';
  wake();

  const dir = dirname(path);
  if (!fromPlaylist || dir !== currentDir) {
    // 新目录:自动展开播放列表并扫描
    if (!fromPlaylist && !isFullscreen) setPlaylistOpen(true);
    currentDir = dir;
    await refreshPlaylist(path);
  } else {
    currentIndex = playlist.findIndex((it) => normPath(it.path) === normPath(path));
    sendPlaylistData();
  }
}

function dirname(p) {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return i > 0 ? p.slice(0, i) : p;
}

async function refreshPlaylist(path) {
  try {
    const items = await invoke('scan_video_dir', { path });
    playlist = items;
    currentIndex = items.findIndex((it) => normPath(it.path) === normPath(path));
  } catch {
    playlist = [];
    currentIndex = -1;
  }
  sendPlaylistData();
}

function playIndex(i) {
  if (i < 0 || i >= playlist.length) return;
  currentIndex = i;
  openVideo(playlist[i].path, { fromPlaylist: true });
}

function playPrev() {
  if (!playlist.length) { toast('播放列表为空'); return; }
  playIndex((currentIndex - 1 + playlist.length) % playlist.length);
}

function playNext() {
  if (!playlist.length) { toast('播放列表为空'); return; }
  playIndex((currentIndex + 1) % playlist.length);
}

btnPrev.addEventListener('click', playPrev);
btnNext.addEventListener('click', playNext);

// 文件对话框
btnOpen.addEventListener('click', async () => {
  const p = await invoke('open_file_dialog');
  if (p) openVideo(p);
});

/* ---------------- 拖拽文件打开 ---------------- */
getCurrentWebview().onDragDropEvent((ev) => {
  const t = ev.payload.type;
  if (t === 'enter' || t === 'over') app.classList.add('drag-over');
  else app.classList.remove('drag-over');
  if (t === 'drop') {
    const p = ev.payload.paths && ev.payload.paths[0];
    if (p) openVideo(p);
  }
});

/* ---------------- 启动参数打开(右键"打开方式") ---------------- */
(async () => {
  try {
    const f = await invoke('get_startup_file');
    if (f) openVideo(f);
  } catch { /* ignore */ }
})();

/* ---------------- 进度条 ---------------- */
function updateProgressUI() {
  const r = duration > 0 ? clamp(currentTime / duration, 0, 1) : 0;
  playedBar.style.width = (r * 100) + '%';
  dot.style.left = (r * 100) + '%';
}

function ratioFromEvent(e) {
  const rect = track.getBoundingClientRect();
  return clamp((e.clientX - rect.left) / rect.width, 0, 1);
}

function moveTip(e) {
  const rect = track.getBoundingClientRect();
  const ratio = ratioFromEvent(e);
  tip.textContent = fmtTime(ratio * duration);
  tip.style.left = (ratio * rect.width) + 'px';
  tip.classList.add('show');
}

track.addEventListener('pointerdown', (e) => {
  if (!duration) return;
  seeking = true;
  track.setPointerCapture(e.pointerId);
  const r = ratioFromEvent(e);
  currentTime = r * duration;
  updateProgressUI();
  moveTip(e);
  wake();
});

track.addEventListener('pointermove', (e) => {
  moveTip(e);
  if (seeking && duration) {
    currentTime = ratioFromEvent(e) * duration;
    updateProgressUI();
  }
});

track.addEventListener('pointerup', (e) => {
  if (seeking && duration && mpvReady) {
    const t = ratioFromEvent(e) * duration;
    invoke('mpv_seek', { t }).catch(() => {});
    timeCurrent.textContent = fmtTime(t);
  }
  seeking = false;
});
track.addEventListener('pointercancel', () => { seeking = false; });
track.addEventListener('pointerleave', () => {
  if (!seeking) tip.classList.remove('show');
});
track.addEventListener('pointerenter', (e) => moveTip(e));

/* ---------------- 音量 ---------------- */
let volumeMutedByUser = false;

function setVolume(v, { flash = true, persist = true } = {}) {
  volume = clamp(v, 0, 1);
  if (mpvReady) invoke('mpv_set_volume', { v: Math.round(volume * 100) }).catch(() => {});
  volumeSlider.value = Math.round(volume * 100);
  volumeSlider.style.setProperty('--fill', Math.round(volume * 100) + '%');
  volumeNum.textContent = String(Math.round(volume * 100));
  updateVolumeIcon();
  if (persist) localStorage.setItem('vp-volume', String(volume));
  if (flash) flashVolume();
}

function flashVolume() {
  volumeControl.classList.add('flash');
  clearTimeout(volumeFlashTimer);
  volumeFlashTimer = setTimeout(() => volumeControl.classList.remove('flash'), 1400);
}

function updateVolumeIcon() {
  const muted = (volumeMutedByUser || volume === 0) && mpvReady;
  btnVolume.classList.toggle('muted', muted);
  btnVolume.classList.toggle('low', !muted && volume < 0.5);
}

btnVolume.addEventListener('click', () => {
  volumeMutedByUser = !volumeMutedByUser;
  if (mpvReady) invoke('mpv_set_mute', { m: volumeMutedByUser }).catch(() => {});
  updateVolumeIcon();
});

volumeSlider.addEventListener('input', () => {
  volumeMutedByUser = false;
  if (mpvReady) invoke('mpv_set_mute', { m: false }).catch(() => {});
  setVolume(volumeSlider.value / 100, { flash: false });
});

// 键盘调整音量时临时展开滑块
window.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    volumeMutedByUser = false;
    if (mpvReady) invoke('mpv_set_mute', { m: false }).catch(() => {});
    setVolume(volume + VOLUME_STEP);
    toast(`音量 ${Math.round(volume * 100)}%`);
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    volumeMutedByUser = false;
    if (mpvReady) invoke('mpv_set_mute', { m: false }).catch(() => {});
    setVolume(volume - VOLUME_STEP);
    toast(`音量 ${Math.round(volume * 100)}%`);
  }
});

/* ---------------- 倍速 ---------------- */
function setRate(r, { persist = true } = {}) {
  rate = clamp(r, 0.25, 4);
  if (boostRate === null && mpvReady) invoke('mpv_set_speed', { v: rate }).catch(() => {});
  btnSpeed.querySelector('span').textContent = fmtRate(rate);
  if (persist) localStorage.setItem('vp-rate', String(rate));
  for (const item of speedMenuItems.children) {
    item.classList.toggle('active', parseFloat(item.dataset.rate) === rate);
  }
}

// 构建倍速菜单
RATES.forEach((r) => {
  const item = document.createElement('div');
  item.className = 'menu-item';
  item.dataset.rate = String(r);
  item.textContent = fmtRate(r);
  item.addEventListener('click', (e) => {
    e.stopPropagation();
    setRate(r);
    closeSpeedMenu();
    toast(`倍速 ${fmtRate(r)}`);
  });
  speedMenuItems.appendChild(item);
});

function openSpeedMenu() { speedMenu.classList.add('open'); menuOpen = true; }
function closeSpeedMenu() { speedMenu.classList.remove('open'); menuOpen = false; }

btnSpeed.addEventListener('click', (e) => {
  e.stopPropagation();
  speedMenu.classList.contains('open') ? closeSpeedMenu() : openSpeedMenu();
});

document.addEventListener('click', (e) => {
  if (menuOpen && !speedMenu.contains(e.target)) closeSpeedMenu();
});

// 长按 → 临时三倍速
function startBoost() {
  if (!mpvReady || !hasMedia || boostRate !== null) return;
  boostRate = rate;
  invoke('mpv_set_speed', { v: 3 }).catch(() => {});
  speedBadge.classList.add('show');
}

function stopBoost() {
  if (boostRate === null) return;
  invoke('mpv_set_speed', { v: boostRate }).catch(() => {});
  boostRate = null;
  speedBadge.classList.remove('show');
}

/* ---------------- 键盘快捷键 ---------------- */
window.addEventListener('keydown', (e) => {
  if (e.repeat) {
    // 持续按住方向键时的重复事件:只拦默认行为
    if ([' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) e.preventDefault();
    if (e.key === 'ArrowRight') startBoost();
    return;
  }
  switch (e.key) {
    case ' ':
      e.preventDefault();
      togglePlay();
      break;
    case 'ArrowRight':
      e.preventDefault();
      startBoost(); // 长按进入三倍速
      break;
    case 'ArrowLeft':
      e.preventDefault();
      if (mpvReady && hasMedia) {
        invoke('mpv_seek_rel', { d: -SEEK_STEP }).catch(() => {});
        toast(`-${SEEK_STEP}s`);
        wake();
      }
      break;
    case 'f':
    case 'F':
      toggleFullscreen();
      break;
    case 'F11':
      e.preventDefault();
      toggleFullscreen();
      break;
    case 'Escape':
      if (isFullscreen) toggleFullscreen();
      break;
  }
});

window.addEventListener('keyup', (e) => {
  if (e.key === 'ArrowRight') stopBoost();
});

// 窗口失焦时恢复倍速,防止按键卡住
window.addEventListener('blur', stopBoost);

/* ---------------- 画面填充模式 ---------------- */
let fitMode = localStorage.getItem('vp-fit') === 'cover' ? 'cover' : 'contain';

function applyFit() {
  if (mpvReady) invoke('mpv_set_panscan', { v: fitMode === 'cover' ? 1 : 0 }).catch(() => {});
  btnFit.classList.toggle('cover', fitMode === 'cover');
  btnFit.title = fitMode === 'cover' ? '画面填充:铺满窗口(点击切换)' : '画面填充:适应窗口(点击切换)';
}

btnFit.addEventListener('click', () => {
  fitMode = fitMode === 'cover' ? 'contain' : 'cover';
  localStorage.setItem('vp-fit', fitMode);
  applyFit();
  toast(fitMode === 'cover' ? '画面铺满窗口' : '画面适应窗口');
});

/* ---------------- 全屏 ---------------- */
async function toggleFullscreen() {
  try {
    const cur = await win.isFullscreen();
    await win.setFullscreen(!cur);
    // 注意:@tauri-apps/api 2.x 的 Window 没有 onFullscreenChanged 事件,
    // 本应用所有全屏切换都经由这里(按钮/F/F11/Esc/双击),直接同步状态
    isFullscreen = !cur;
    updateFullscreenIcon(isFullscreen);
    if (isFullscreen && playlistOpen) setPlaylistOpen(false); // 进入全屏:收起播放列表
  } catch { /* ignore */ }
}

function updateFullscreenIcon(full) {
  btnFullscreen.classList.toggle('active', full);
  btnFullscreen.title = full ? '退出全屏' : '全屏';
}

btnFullscreen.addEventListener('click', toggleFullscreen);

/* ---------------- 播放列表(外挂窗口) ---------------- */
async function positionPlaylistWindow() {
  const pw = await getPlaylistWin();
  if (!pw) return;
  try {
    const [factor, pos, size, mon] = await Promise.all([
      win.scaleFactor(),
      win.outerPosition(),
      win.outerSize(),
      currentMonitor(),
    ]);
    const pwW = Math.round(PLAYLIST_W * factor);
    let x = pos.x + size.width;
    let y = pos.y;
    // 限制在所在显示器范围内
    if (mon && mon.size && mon.position) {
      const maxX = mon.position.x + mon.size.width - pwW;
      if (x > maxX) x = Math.max(mon.position.x, maxX);
      if (y < mon.position.y) y = mon.position.y;
    }
    await pw.setPosition(new PhysicalPosition(x, y));
    await pw.setSize(new PhysicalSize(pwW, size.height));
  } catch { /* ignore */ }
}

function sendPlaylistData() {
  emit('playlist://data', { items: playlist, index: currentIndex });
}

async function setPlaylistOpen(open) {
  if (open && isFullscreen) open = false;
  playlistOpen = open;
  btnPlaylist.classList.toggle('active', playlistOpen);
  const pw = await getPlaylistWin();
  if (!pw) {
    if (open) toast('播放列表窗口未就绪,请稍后重试');
    return;
  }
  try {
    if (playlistOpen) {
      await emit('playlist://attach'); // 若播放列表曾被独立拖开,重新恢复跟随
      await positionPlaylistWindow();
      await pw.show();
      await win.setFocus(); // 焦点还给主窗口
      sendPlaylistData(); // 确保列表数据同步(避免启动时的就绪竞态)
    } else {
      await pw.hide();
    }
  } catch { /* ignore */ }
}

btnPlaylist.addEventListener('click', () => setPlaylistOpen(!playlistOpen));

// 播放列表窗口 → 主窗口
listen('playlist://select', (e) => {
  playIndex(e.payload.index);
  win.setFocus(); // 归还焦点,空格等快捷键继续生效
});
listen('playlist://close', () => setPlaylistOpen(false));
listen('playlist://ready', () => sendPlaylistData());

// 主窗口最小化时隐藏外挂列表;恢复焦点时按需重新显示(保持 playlistOpen 状态)
win.onResized(async () => {
  try {
    if (await win.isMinimized()) {
      const pw = await getPlaylistWin();
      if (pw && await pw.isVisible()) await pw.hide();
    }
  } catch { /* ignore */ }
});

win.onFocusChanged(async ({ payload: focused }) => {
  try {
    if (focused && playlistOpen) {
      const pw = await getPlaylistWin();
      if (pw && !(await pw.isVisible())) {
        await positionPlaylistWindow();
        await pw.show();
      }
    }
  } catch { /* ignore */ }
});

// 主窗口移动/缩放时,播放列表窗口由 Rust 原生事件实时同步(见 main.rs)

/* ---------------- 字幕(mpv 原生渲染,支持 SRT/ASS/SSA/VTT) ---------------- */
btnSubtitle.addEventListener('click', async () => {
  if (!mpvReady || !hasMedia) return;
  try {
    if (await invoke('mpv_has_sub')) {
      // 已有字幕轨(含自动加载的同名字幕):切换可见性
      await invoke('mpv_toggle_sub');
    } else {
      const p = await invoke('open_subtitle_dialog');
      if (p) {
        await invoke('mpv_sub_add', { path: p });
        toast('字幕已加载');
      }
    }
  } catch { /* ignore */ }
});

/* ---------------- 窗口控制 ---------------- */
$('btn-minimize').addEventListener('click', () => win.minimize());
$('btn-close').addEventListener('click', () => win.close());

// 按钮点击后失焦,避免空格误触发
document.querySelectorAll('button').forEach((b) => {
  b.addEventListener('click', () => b.blur());
});

/* ---------------- 初始化 ---------------- */
setVolume(volume, { flash: false, persist: false });
setRate(rate, { persist: false });
applyFit();
updateVolumeIcon();
scheduleHide();
