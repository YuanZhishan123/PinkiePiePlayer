# PinkiePiePlayer

基于 [Tauri 2](https://tauri.app/) + [libmpv](https://mpv.io/) 的 Windows 本地视频播放器。UI 为 Rust + WebView2 + 原生 JavaScript / CSS(Vite 构建),视频画面由 mpv 内核直接渲染(无边框透明窗口 + 原生子窗口合成),全格式硬解/软解,安装包约 35 MB。

## 功能

- **全格式播放**:mpv 内核解码,支持 MP4 / MKV / AVI / MOV / WMV / FLV / TS / RMVB / WEBM 等几乎所有视频格式与 MP3 / FLAC / WAV / OGG / OPUS / APE 等音频格式;自动启用硬件解码(不可用时无缝回退软解),低配置机器同样流畅
- **倍速**:0.25x–4x 倍速菜单,长按 → 临时三倍速;音高校正保证变速不变调
- **字幕**:SRT / ASS / SSA / VTT,由 mpv 原生渲染(支持 ASS 特效);打开媒体时自动加载同名字幕,也可手动指定字幕文件
- **播放列表**:自动扫描所选目录(视频 + 音频混合)生成列表,自然排序(ep2 排在 ep10 前);列表为独立外挂窗口,可拖到任意位置,也可贴边自动跟随主窗口
- **音频模式**:纯音频文件显示旋转唱片 + 均衡器动画
- **无边框窗口**:自绘标题栏与控件,按住画面或标题栏即可拖动窗口,支持 Windows 11 系统圆角
- **UI 自动隐藏**:播放时鼠标静止数秒或移出窗口,控件自动淡出;顶部/底部有黑色渐变衬底,保证浅色画面下控件可读
- **全屏**:按钮 / 双击画面 / F / F11 进入,Esc 退出
- **快捷键**:空格 播放/暂停,← 快退 5s,↑/↓ 音量,F / F11 / Esc 全屏
- **文件关联**:安装时可勾选注册视频与音频格式,并引导设置系统默认播放器
- **多入口**:双击关联文件、拖拽文件到窗口、对话框选择、命令行参数启动,均可直接播放

## 下载安装

前往 [Releases](../../releases) 下载 `PinkiePiePlayer_x.y.z_x64-setup.exe`,双击安装即可。

- 系统要求:Windows 10 / 11(x64)
- 安装包内置 mpv 解码内核(libmpv),无需额外安装解码器
- 安装器内置 WebView2 引导,系统缺少 WebView2 时会自动下载安装
- 安装时可选:为常见视频格式注册打开方式、设为默认播放器

## 从源码构建

依赖:Node.js ≥ 18、Rust(MSVC 工具链)、Windows 10 / 11。

```bash
npm install
npm run tauri dev     # 开发调试
npm run tauri build   # 构建安装包(输出于 src-tauri/target/release/bundle/nsis/)
```

构建前需要将 `libmpv-2.dll` 放到 `vendor/mpv/`(开发运行)与 `src-tauri/resources/`(打包,已加入 .gitignore):

1. 从 [mpv-winbuild releases](https://github.com/zhongfly/mpv-winbuild/releases) 下载 `mpv-dev-x86_64-*.7z`(选 x86_64 基线版以兼容老 CPU)
2. 解压,将 `libmpv-2.dll` 复制到 `vendor/mpv/` 与 `src-tauri/resources/`

## 项目结构

```
├── index.html            # 主窗口页面
├── playlist.html         # 播放列表窗口页面
├── src/                  # 前端逻辑与样式(UI 层,视频渲染在 mpv 子窗口)
├── src-tauri/            # Rust 主进程(mpv 桥接、窗口管理、文件关联、安装器钩子)
│   └── src/mpv.rs        # libmpv 动态加载 FFI
├── vendor/mpv/           # libmpv-2.dll(构建依赖,不入库)
└── tools/                # 图标生成辅助脚本
```

## 许可

仅供学习交流使用。
