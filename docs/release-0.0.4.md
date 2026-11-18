# v0.0.4 预览

- 新增电脑声音录制：macOS 14.2+ Apple Silicon 使用 Core Audio tap；Windows x64 使用默认播放设备 WASAPI 回环。使用耳机时也可直接采集播放音频，麦克风关闭。
- 复用实时转写、历史回放、校对、检索和分享到新会话。电脑声音报告采用学习笔记格式，报告语言可选。
- 纳入会议体检表盘和「表达解读（潜台词）」。两项功能均为实验分析，逐次预览全文并确认模型，不覆盖原文；潜台词推测与事实分开显示。
- 开始录制前确认系统混音范围；切换输出设备、连接中断或插件退出时停止。音频本机保存，原生组件无网络接口、不读取 API 设置，启动前核对版本和 SHA-256。

电脑声音最长 60 分钟，暂不支持指定应用或混入麦克风。时间戳为录音进度。macOS 组件为临时签名、未公证；Windows 组件无发行证书。未要求关闭系统保护。

验证包括本机自动化测试、macOS/Windows 原生组件合成 PCM 自检、安装包完整性检查，以及隔离 Harness 的安装和公开四人录音转写。macOS 侧验证了 56.9 秒音频、15 个发言段、4 个说话人标签。界面检查覆盖 1080 px 和 390 px，趣味功能无需展开转写即可打开。

真实音频设备的授权、耳机录制及不同播放器兼容性尚未实测；真实模型对会议体检和潜台词的判断质量尚未验证。本次以预览版发布，不触发旧版自动更新。测试没有采集个人录音或调用个人模型账户。

安装：下载 `dsh-voice-notes-0.0.4.tgz` 和 `SHA256SUMS`，验证后在 Harness「插件」页添加安装包，启用并重启。两个平台使用同一包。

# English

v0.0.4 preview adds Computer audio recording, using Core Audio taps on macOS 14.2+ Apple Silicon and default-device WASAPI loopback on Windows x64. Playback can be captured while using headphones; the microphone stays off. Live transcription, history, correction, search and sharing use the existing workflow. Optional reports use Learning Notes in the selected language.

This version also includes the experimental Meeting check dial and Expression interpretation (subtext). Both require transcript preview and model confirmation for each analysis, preserve source text and distinguish inference from facts.

Computer audio captures the system mix, which may include other apps and notifications. Limit: 60 minutes; no per-app selection or microphone mixing. Changing the output device or disconnecting stops capture. Audio is stored locally; native helpers have no network interface or model configuration access, and are version/hash verified before launch. macOS uses an ad-hoc signature without notarization; Windows has no publisher certificate.

Verification covers automated tests, synthetic native PCM self-tests, package integrity, isolated Harness installation, and public four-speaker transcription. Real-device permissions, headphone capture and player compatibility remain unverified, as does real-model analysis quality. This is a prerelease and is not offered by the stable auto-updater. No personal recording or model account was used in tests.

Download the shared `.tgz` and `SHA256SUMS`, verify, add the archive on the Harness Plugins page, enable and restart.
