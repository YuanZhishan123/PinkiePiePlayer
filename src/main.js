import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { getCurrentWindow, Window, PhysicalPosition, PhysicalSize, currentMonitor } from '@tauri-apps/api/window';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { emit, listen } from '@tauri-apps/api/event';

const $ = (id) => document.getElementById(id);

/* ---------------- 元素 ---------------- */
const app = $('app');
const video = $('video');
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
const playlistWin = await Window.getByLabel('playlist');

/* ---------------- 常量与状态 ---------------- */
const RATES = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0];
const IDLE_MS = 2600; // 鼠标静止多久后隐藏 UI
const VOLUME_STEP = 0.05;
const SEEK_STEP = 5; // ← 短按快退秒数
const PLAYLIST_W = 300; // 播放列表窗口宽度(逻辑像素)

let playlist = []; // [{name, path}]
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
  app.classList.remove('ui-idle');
  scheduleHide();
}

function scheduleHide() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    // 播放中、鼠标不在控件上、无弹出菜单时才隐藏
    if (video.src && !video.paused && !uiHovered && !menuOpen && !seeking) {
      app.classList.add('ui-idle');
    } else {
      scheduleHide();
    }
  }, IDLE_MS);
}

window.addEventListener('mousemove', wake);

// 窗口模式:鼠标移出窗口时立即隐藏 UI,移回时立即恢复
// (全屏不适用;菜单展开/拖动进度条中不隐藏)
document.documentElement.addEventListener('mouseleave', () => {
  // 按住画面后鼠标移出窗口:立即开始窗口拖动
  // (否则贴着窗口边缘按下时,向外移不足 4px 阈值就丢失事件,永远无法触发拖动)
  if (pressPos && !dragged) {
    dragged = true;
    pressPos = null;
    win.startDragging().catch(() => {});
  }
  // 窗口模式:鼠标移出窗口时立即隐藏 UI
  // (全屏不适用;菜单展开/拖动进度条中不隐藏)
  if (isFullscreen || !video.src || menuOpen || seeking) return;
  clearTimeout(idleTimer);
  app.classList.add('ui-idle');
});

document.documentElement.addEventListener('mouseenter', wake);

// 悬停在控制栏的实际交互区(进度条/按钮行)时不自动隐藏
for (const el of [document.querySelector('#button-bar'), document.querySelector('#progress-area')]) {
  el.addEventListener('mouseenter', () => { uiHovered = true; });
  el.addEventListener('mouseleave', () => { uiHovered = false; });
}

/* ---------------- 播放控制 ---------------- */
const ICON_PLAY = '<svg viewBox="0 0 24 24"><path d="M8 5.2v13.6L19 12z" fill="currentColor"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24"><path d="M7 5h3.4v14H7zM13.6 5H17v14h-3.4z" fill="currentColor"/></svg>';

function togglePlay() {
  if (!video.src) return;
  if (video.paused) video.play().catch(() => {});
  else video.pause();
}

video.addEventListener('play', () => { btnPlay.innerHTML = ICON_PAUSE; btnPlay.title = '暂停(空格)'; });
video.addEventListener('pause', () => { btnPlay.innerHTML = ICON_PLAY; btnPlay.title = '播放(空格)'; });
video.addEventListener('ended', () => playNext());

btnPlay.addEventListener('click', togglePlay);

// 点击画面切换播放/暂停;双击切换全屏(单击延迟消歧)
video.addEventListener('click', () => {
  if (dragged) { dragged = false; return; } // 刚拖完窗口,忽略这次 click
  if (clickTimer) return;
  clickTimer = setTimeout(() => { clickTimer = null; togglePlay(); }, 220);
});
video.addEventListener('dblclick', () => {
  if (dragged) return;
  clearTimeout(clickTimer);
  clickTimer = null;
  toggleFullscreen();
});

/* ---------------- 按住画面拖动窗口 ---------------- */
let pressPos = null; // mousedown 时的屏幕坐标
let dragged = false; // 本次按压是否已转为窗口拖动

stage.addEventListener('mousedown', (e) => {
  // 空状态(无视频)时同样允许按住画面拖动窗口;按钮等交互控件除外
  if (e.button !== 0 || e.target.closest('button, input')) return;
  pressPos = { x: e.screenX, y: e.screenY };
  dragged = false;
});

// 顶部标题栏:按住空白处(标题文字/窗口按钮以外)直接拖动窗口
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

/* ---------------- 打开视频 ---------------- */
async function openVideo(path, { fromPlaylist = false } = {}) {
  stopBoost();
  video.src = convertFileSrc(path);
  titleText.textContent = fileName(path);
  emptyState.classList.add('hidden');
  video.playbackRate = rate;
  video.play().catch(() => {});
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
  const d = video.duration || 0;
  const r = d ? video.currentTime / d : 0;
  playedBar.style.width = (r * 100) + '%';
  dot.style.left = (r * 100) + '%';
}

video.addEventListener('timeupdate', () => {
  timeCurrent.textContent = fmtTime(video.currentTime);
  if (!seeking) updateProgressUI();
});

video.addEventListener('progress', () => {
  try {
    if (video.buffered.length && video.duration) {
      const end = video.buffered.end(video.buffered.length - 1);
      bufferedBar.style.width = (end / video.duration * 100) + '%';
    }
  } catch { /* ignore */ }
});

video.addEventListener('loadedmetadata', () => {
  timeTotal.textContent = fmtTime(video.duration);
  updateProgressUI();
});

function ratioFromEvent(e) {
  const rect = track.getBoundingClientRect();
  return clamp((e.clientX - rect.left) / rect.width, 0, 1);
}

function moveTip(e) {
  const rect = track.getBoundingClientRect();
  const ratio = ratioFromEvent(e);
  tip.textContent = fmtTime(ratio * (video.duration || 0));
  tip.style.left = (ratio * rect.width) + 'px';
  tip.classList.add('show');
}

track.addEventListener('pointerdown', (e) => {
  if (!video.duration) return;
  seeking = true;
  track.setPointerCapture(e.pointerId);
  const r = ratioFromEvent(e);
  video.currentTime = r * video.duration;
  updateProgressUI();
  moveTip(e);
  wake();
});

track.addEventListener('pointermove', (e) => {
  moveTip(e);
  if (seeking && video.duration) {
    const r = ratioFromEvent(e);
    video.currentTime = r * video.duration;
    updateProgressUI();
  }
});

track.addEventListener('pointerup', () => { seeking = false; });
track.addEventListener('pointerleave', () => {
  if (!seeking) tip.classList.remove('show');
});
track.addEventListener('pointerenter', (e) => moveTip(e));

/* ---------------- 音量 ---------------- */
let volumeMutedByUser = false;

function setVolume(v, { flash = true, persist = true } = {}) {
  volume = clamp(v, 0, 1);
  video.volume = volume;
  if (volume > 0 && video.muted && !volumeMutedByUser) video.muted = false;
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
  const muted = video.muted || volume === 0;
  btnVolume.classList.toggle('muted', muted);
  btnVolume.classList.toggle('low', !muted && volume < 0.5);
}

btnVolume.addEventListener('click', () => {
  volumeMutedByUser = !video.muted;
  video.muted = volumeMutedByUser;
  updateVolumeIcon();
});

volumeSlider.addEventListener('input', () => {
  volumeMutedByUser = false;
  setVolume(volumeSlider.value / 100, { flash: false });
});

// 键盘调整音量时临时展开滑块
window.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    volumeMutedByUser = false;
    video.muted = false;
    setVolume(volume + VOLUME_STEP);
    toast(`音量 ${Math.round(volume * 100)}%`);
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    volumeMutedByUser = false;
    video.muted = false;
    setVolume(volume - VOLUME_STEP);
    toast(`音量 ${Math.round(volume * 100)}%`);
  }
});

/* ---------------- 倍速 ---------------- */
function setRate(r, { persist = true } = {}) {
  rate = clamp(r, 0.25, 4);
  if (boostRate === null) video.playbackRate = rate;
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
  if (!video.src || boostRate !== null) return;
  boostRate = video.playbackRate;
  video.playbackRate = 3;
  speedBadge.classList.add('show');
}

function stopBoost() {
  if (boostRate === null) return;
  video.playbackRate = boostRate;
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
      if (video.src) {
        video.currentTime = Math.max(0, video.currentTime - SEEK_STEP);
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
  video.style.objectFit = fitMode;
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
  if (!playlistWin) return;
  try {
    const [factor, pos, size, mon] = await Promise.all([
      win.scaleFactor(),
      win.outerPosition(),
      win.outerSize(),
      currentMonitor(),
    ]);
    const pw = Math.round(PLAYLIST_W * factor);
    let x = pos.x + size.width;
    let y = pos.y;
    // 限制在所在显示器范围内
    if (mon && mon.size && mon.position) {
      const maxX = mon.position.x + mon.size.width - pw;
      if (x > maxX) x = Math.max(mon.position.x, maxX);
      if (y < mon.position.y) y = mon.position.y;
    }
    await playlistWin.setPosition(new PhysicalPosition(x, y));
    await playlistWin.setSize(new PhysicalSize(pw, size.height));
  } catch { /* ignore */ }
}

function sendPlaylistData() {
  emit('playlist://data', { items: playlist, index: currentIndex });
}

async function setPlaylistOpen(open) {
  if (open && isFullscreen) open = false;
  playlistOpen = open;
  btnPlaylist.classList.toggle('active', playlistOpen);
  if (!playlistWin) return;
  try {
    if (playlistOpen) {
      await emit('playlist://attach'); // 若播放列表曾被独立拖开,重新恢复跟随
      await positionPlaylistWindow();
      await playlistWin.show();
      await win.setFocus(); // 焦点还给主窗口
      sendPlaylistData(); // 确保列表数据同步(避免启动时的就绪竞态)
    } else {
      await playlistWin.hide();
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
      if (playlistWin && await playlistWin.isVisible()) await playlistWin.hide();
    }
  } catch { /* ignore */ }
});

win.onFocusChanged(async ({ payload: focused }) => {
  try {
    if (focused && playlistOpen && playlistWin && !(await playlistWin.isVisible())) {
      await positionPlaylistWindow();
      await playlistWin.show();
    }
  } catch { /* ignore */ }
});

// 主窗口移动/缩放时,播放列表窗口由 Rust 原生事件实时同步(见 main.rs)

/* ---------------- 字幕(占位) ---------------- */
btnSubtitle.addEventListener('click', () => toast('字幕功能开发中,敬请期待'));

/* ---------------- 窗口控制 ---------------- */
$('btn-minimize').addEventListener('click', () => win.minimize());
$('btn-close').addEventListener('click', () => win.close());

// 按钮点击后失焦,避免空格误触发
document.querySelectorAll('button').forEach((b) => {
  b.addEventListener('click', () => b.blur());
});

/* ---------------- 视频错误处理 ---------------- */
video.addEventListener('error', () => {
  if (video.src && video.src !== location.href) {
    toast('无法播放此文件,可能是不支持的编码格式');
  }
});

/* ---------------- 初始化 ---------------- */
setVolume(volume, { flash: false, persist: false });
setRate(rate, { persist: false });
applyFit();
updateVolumeIcon();
scheduleHide();
