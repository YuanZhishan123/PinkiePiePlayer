; PinkiePiePlayer NSIS 安装器自定义钩子
; 由 tauri.conf.json -> bundle.windows.nsis.installerHooks 引用
; 可用钩子: NSIS_HOOK_PREINSTALL / NSIS_HOOK_POSTINSTALL
;           NSIS_HOOK_PREUNINSTALL / NSIS_HOOK_POSTUNINSTALL

!macro NSIS_HOOK_PREINSTALL
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; ---- 注册应用能力,让 PinkiePiePlayer 出现在系统"默认应用"应用列表中 ----
  WriteRegStr HKCU "Software\PinkiePiePlayer\Capabilities" "ApplicationName" "PinkiePiePlayer"
  WriteRegStr HKCU "Software\PinkiePiePlayer\Capabilities" "ApplicationDescription" "PinkiePiePlayer 本地视频/音频播放器"
  WriteRegStr HKCU "Software\PinkiePiePlayer\Capabilities\FileAssociations" ".mp4" "PinkiePiePlayer.Video"
  WriteRegStr HKCU "Software\PinkiePiePlayer\Capabilities\FileAssociations" ".m4v" "PinkiePiePlayer.Video"
  WriteRegStr HKCU "Software\PinkiePiePlayer\Capabilities\FileAssociations" ".mkv" "PinkiePiePlayer.Video"
  WriteRegStr HKCU "Software\PinkiePiePlayer\Capabilities\FileAssociations" ".avi" "PinkiePiePlayer.Video"
  WriteRegStr HKCU "Software\PinkiePiePlayer\Capabilities\FileAssociations" ".mov" "PinkiePiePlayer.Video"
  WriteRegStr HKCU "Software\PinkiePiePlayer\Capabilities\FileAssociations" ".wmv" "PinkiePiePlayer.Video"
  WriteRegStr HKCU "Software\PinkiePiePlayer\Capabilities\FileAssociations" ".flv" "PinkiePiePlayer.Video"
  WriteRegStr HKCU "Software\PinkiePiePlayer\Capabilities\FileAssociations" ".webm" "PinkiePiePlayer.Video"
  WriteRegStr HKCU "Software\PinkiePiePlayer\Capabilities\FileAssociations" ".mpg" "PinkiePiePlayer.Video"
  WriteRegStr HKCU "Software\PinkiePiePlayer\Capabilities\FileAssociations" ".mpeg" "PinkiePiePlayer.Video"
  WriteRegStr HKCU "Software\PinkiePiePlayer\Capabilities\FileAssociations" ".ts" "PinkiePiePlayer.Video"
  WriteRegStr HKCU "Software\PinkiePiePlayer\Capabilities\FileAssociations" ".rmvb" "PinkiePiePlayer.Video"
  WriteRegStr HKCU "Software\PinkiePiePlayer\Capabilities\FileAssociations" ".mp3" "PinkiePiePlayer.Audio"
  WriteRegStr HKCU "Software\PinkiePiePlayer\Capabilities\FileAssociations" ".flac" "PinkiePiePlayer.Audio"
  WriteRegStr HKCU "Software\PinkiePiePlayer\Capabilities\FileAssociations" ".wav" "PinkiePiePlayer.Audio"
  WriteRegStr HKCU "Software\PinkiePiePlayer\Capabilities\FileAssociations" ".m4a" "PinkiePiePlayer.Audio"
  WriteRegStr HKCU "Software\PinkiePiePlayer\Capabilities\FileAssociations" ".aac" "PinkiePiePlayer.Audio"
  WriteRegStr HKCU "Software\PinkiePiePlayer\Capabilities\FileAssociations" ".ogg" "PinkiePiePlayer.Audio"
  WriteRegStr HKCU "Software\PinkiePiePlayer\Capabilities\FileAssociations" ".opus" "PinkiePiePlayer.Audio"
  WriteRegStr HKCU "Software\RegisteredApplications" "PinkiePiePlayer" "Software\PinkiePiePlayer\Capabilities"

  ; ---- 询问是否打开系统设置完成"设为默认播放器"(静默安装时跳过) ----
  ; Windows 10/11 禁止程序直接改写默认应用(UserChoice 有哈希保护),
  ; 只能引导用户在设置页中逐个格式确认
  IfSilent skip_default_prompt
  MessageBox MB_YESNO|MB_ICONQUESTION "安装完成!是否打开系统设置,将 PinkiePiePlayer 设为默认视频/音频播放器?$\n$\n(Windows 10/11 要求在设置页中逐个格式点击右侧按钮确认,耗时约半分钟)" IDNO skip_default_prompt
  ExecShell "open" "ms-settings:defaultapps?registeredUser=PinkiePiePlayer"
  skip_default_prompt:
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; ---- 卸载时清理本钩子写入的注册表项 ----
  ; (文件关联本体由 Tauri 安装器模板自行清理)
  DeleteRegValue HKCU "Software\RegisteredApplications" "PinkiePiePlayer"
  DeleteRegKey /ifempty HKCU "Software\PinkiePiePlayer\Capabilities\FileAssociations"
  DeleteRegKey /ifempty HKCU "Software\PinkiePiePlayer\Capabilities"
  DeleteRegKey /ifempty HKCU "Software\PinkiePiePlayer"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
!macroend
