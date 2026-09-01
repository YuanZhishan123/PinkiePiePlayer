import { getCurrentWindow } from '@tauri-apps/api/window';
import { emit, listen } from '@tauri-apps/api/event';

const listEl = document.getElementById('pl-list');
const countEl = document.getElementById('pl-count');
const emptyEl = document.getElementById('pl-empty');
const win = getCurrentWindow();

let items = [];
let currentIndex = -1;

function stripExt(n) {
  const i = n.lastIndexOf('.');
  return i > 0 ? n.slice(0, i) : n;
}

function render() {
  listEl.innerHTML = '';
  emptyEl.classList.toggle('hidden', items.length > 0);
  countEl.textContent = items.length ? `(${items.length})` : '';
  items.forEach((it, i) => {
    const li = document.createElement('li');
    if (i === currentIndex) li.classList.add('active');
    li.innerHTML = `<span class="idx">${String(i + 1).padStart(2, '0')}</span><span class="nm"></span>`;
    li.querySelector('.nm').textContent = stripExt(it.name);
    li.title = it.name;
    li.addEventListener('click', () => {
      emit('playlist://select', { index: i });
    });
    listEl.appendChild(li);
  });
  const active = listEl.querySelector('.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

listen('playlist://data', (e) => {
  items = e.payload.items || [];
  currentIndex = e.payload.index ?? -1;
  render();
});

document.getElementById('pl-close').addEventListener('click', async () => {
  await emit('playlist://close');
  await win.hide();
});

// 按住标题栏可独立拖动播放列表窗口(脱离自动跟随主窗口)
document.querySelector('.pl-header').addEventListener('mousedown', async (e) => {
  if (e.button !== 0 || e.target.closest('#pl-close')) return;
  try {
    await emit('playlist://detach'); // 通知 Rust:停止位置跟随
    await win.startDragging();
  } catch { /* ignore */ }
});

// 通知主窗口:本页面已就绪,可下发列表数据
emit('playlist://ready');
