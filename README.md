# PinkiePiePlayer

基于 [Tauri 2](https://tauri.app/) 的 Windows 本地视频播放器。主进程为 Rust + WebView2，前端使用原生 JavaScript / CSS（Vite 构建），无任何运行时框架依赖，安装包仅约 1 MB。

## 功能

- **播放**：常见视频格式（MP4 / MKV / AVI / MOV / WMV / FLV / WEBM 等，取决于系统解码器），支持 0.25x–4x 倍速、进度拖拽、音量调节与记忆
- **播放列表**：自动扫描所选目录生成列表；列表为独立外挂窗口，可按住标题栏拖到任意位置，也可贴边自动跟随主窗口
- **无边框窗口**：自绘标题栏与控件，按住画面或标题栏即可拖动窗口，支持 Windows 11 系统圆角
- **UI 自动隐藏**：播放时鼠标静止数秒或移出窗口，控件自动淡出；顶部/底部有黑色渐变衬底，保证浅色画面下控件可读
- **全屏**：按钮 / 双击画面 / F / F11 进入，Esc 退出
- **快捷键**：空格 播放/暂停，←/→ 快退/快进 5s，↑/↓ 音量，F / F11 / Esc 全屏，0–9 跳转进度
- **文件关联**：安装时可勾选注册视频格式，并引导设置系统默认播放器
- **多入口**：双击关联文件、拖拽文件到窗口、对话框选择、命令行参数启动，均可直接播放

## 下载安装

前往 [Releases](../../releases) 下载 `PinkiePiePlayer_x.y.z_x64-setup.exe`，双击安装即可。

- 系统要求：Windows 10 / 11（x64）
- 安装器内置 WebView2 引导，系统缺少 WebView2 时会自动下载安装
- 安装时可选：为常见视频格式注册打开方式、设为默认播放器

## 从源码构建

依赖：Node.js ≥ 18、Rust（MSVC 工具链）、Windows 10 / 11。

```bash
npm install
npm run tauri dev     # 开发调试
npm run tauri build   # 构建安装包（输出于 src-tauri/target/release/bundle/nsis/）
```

## 项目结构

```
├── index.html            # 主窗口页面
├── playlist.html         # 播放列表窗口页面
├── src/                  # 前端逻辑与样式
├── src-tauri/            # Rust 主进程（窗口管理、文件关联、安装器钩子）
└── tools/                # 图标生成辅助脚本
```

## 许可

仅供学习交流使用。
