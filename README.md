# 语音速记 / Voice Notes

DeepSeek Harness 桌面插件，支持本地录音转写、说话人区分、会议纪要和转写检索。适用于 macOS（Apple Silicon）和 Windows x64。

[中文](#安装和开发) · [English](#english) · [Releases](https://github.com/WinterOne-hub/dsh-voice-notes/releases)

## 安装和开发

| 平台 | v0.0.3 安装包 | SHA-256 |
| --- | --- | --- |
| macOS（Apple Silicon） | [下载](https://github.com/WinterOne-hub/dsh-voice-notes/releases/download/v0.0.3/dsh-voice-notes-0.0.3.tgz) | [SHA256SUMS](https://github.com/WinterOne-hub/dsh-voice-notes/releases/download/v0.0.3/SHA256SUMS) |
| Windows x64 | [下载](https://github.com/WinterOne-hub/dsh-voice-notes/releases/download/v0.0.3/dsh-voice-notes-0.0.3.tgz) | [SHA256SUMS](https://github.com/WinterOne-hub/dsh-voice-notes/releases/download/v0.0.3/SHA256SUMS) |

1. 在 macOS 上运行 `shasum -a 256 -c SHA256SUMS`。在 Windows 上运行 `Get-FileHash .\dsh-voice-notes-0.0.3.tgz -Algorithm SHA256`，与校验文件比对。
2. macOS 和 Windows 使用同一个安装包。在 Harness 的「插件」页添加 `.tgz`，启用后重启。在侧栏打开「语音速记」。若已安装其他语音速记本地包，先卸载旧包。

macOS 测试使用 Harness Desktop 0.2.2-rc.3。Windows x64 已验证安装、四人会议转写和历史回放，实体麦克风尚未验证。参见 [Windows 测试记录](https://github.com/WinterOne-hub/dsh-voice-notes/actions/workflows/windows-host-smoke.yml)。

打开工作台时会检查更新。找到新版本后，可在界面下载、校验和安装，重启生效。已有更新入口的 v0.0.2 可直接检查更新；更早的构建需手动安装 v0.0.3。

## 使用

- **听写：** 点击聊天输入框的麦克风。默认将文字插入草稿；可在偏好中启用历史保存和窗口内快捷键。
- **录音和导入：** 在侧栏工作台录音，或导入 MP3、WAV、M4A、FLAC、OGG、Opus、WebM（最多 128 MiB、2 小时）。首次转写需下载 SenseVoice 模型。
- **历史：** 支持搜索、按时间戳回听、校对和导出 TXT。「重新转写音频」会另存一条历史。
- **报告和分享：** 可选报告语言。「分享到新会话」将全文或选中文字放入未发送的 Harness 草稿。

录音和识别在本机处理。启用翻译、整理或报告时，转写文字交给界面所示模型。录音保存在 `~/.dsh/voice-live/recordings`；可从历史中删除。卸载插件不会删除录音或模型缓存。见 [隐私与安全](PRIVACY.md)。

录音时的临时字幕识别间隔约 1.3 秒。正式转写通常在停顿约 1.4 秒时触发；连续发言约每 28 秒切段。译文在该段正式转写后生成，耗时取决于所用模型和网络。

## 多人会议

v0.0.3 新增。

在工作台勾选「多人会议」，再录音或导入文件。字幕仍在录音时显示；说话人标签在录音结束后生成。已有录音可在历史点「识别说话人」。最长 60 分钟，单条音频最多 128 MiB。首次使用会下载约 38 MiB 的模型。下载失败时可通过工作台导入已下载的 ONNX 文件。

在「多人转写」中可改名、调整单段归属、回听和导出。报告及新会话草稿会带上时间戳和说话人。已知人数时可直接指定；重叠发言需回听核对。v0.0.4 可选择电脑声音；v0.0.3 需先另行录制或导出。

运行 `npm test` 执行测试，运行 `npm pack --ignore-scripts` 生成安装包。许可证：[MIT](LICENSE)。

## 电脑声音（v0.0.4 预览）

在工作台将「声音来源」设为「电脑声音」，点击录制并确认。直接采集输出音频，使用耳机也可录制；不启用麦克风，不采集屏幕画面。字幕、历史回放、校对、检索、分享及两项趣味分析使用相同流程。选择生成报告后，电脑声音采用学习笔记格式：概览、提纲、概念、示例和复习问题。报告语言仍可选择。

- macOS Apple Silicon：需要 macOS 14.2+，首次开始时需允许系统音频录制。使用 [Core Audio tap](https://developer.apple.com/documentation/coreaudio/capturing-system-audio-with-core-audio-taps)。
- Windows x64：使用默认播放设备的 [WASAPI 回环](https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording)，无需虚拟声卡。
- 采集系统混音，可能包含其他应用和通知声音。开始前请关闭无关声音。暂不提供指定应用录制或麦克风混录。
- 最长 60 分钟，存为本机单声道 WAV，约 1.9 MB/分钟。时间戳是录音时间，不是视频播放进度。切换输出设备会停止录制，保留已采集音频，不自动改用麦克风。
- 状态查询不申请录音权限。打开插件不开始采集；窗口断开或插件卸载时停止。学习报告和趣味分析发送的是文字，遵循现有模型确认流程。

本版本处于预览阶段。自动化验证使用合成音频，不采集开发设备正在播放的声音。真实设备授权、耳机和不同播放器兼容性仍需实机验证。macOS 组件使用本地临时签名，未公证；Windows 组件未使用发行证书签名。没有要求关闭系统保护。

### 构建采集组件

原生源码位于 `native/macos` 和 `native/windows`。在 macOS Apple Silicon 上安装 Xcode Command Line Tools 后运行 `npm run build:native`；Windows x64 使用 Visual Studio C++ 的 x64 Native Tools 命令行运行同一命令。发布包需包含两个平台生成的组件及 SHA-256 清单，再运行 `npm pack --ignore-scripts`。组件只通过标准流交换 PCM 和状态，不访问网络、不读取模型设置。运行前校验当前版本和组件哈希；哈希检查不替代发行者签名。

## 会议体检（v0.0.4 预览）

v0.0.4 同时包含会议体检、表达解读和电脑声音录制。上面的 v0.0.3 安装包不包含这些功能。在历史卡片点击「会议体检（实验）」，预览将发送的全文，选择中文或英文。确认界面所示模型后开始分析；可随时取消。

- 半圆表盘显示「废话含量」：模型标为重复信息、填充语或偏离指定议题的有效字符数，占全文有效字符数的比例。字符统计排除空白和标点。没有填写议题时不判断跑题。
- 可查看各分类的原文和理由，回听所属发言段，将误判片段标为「需要保留」。比例在本机重算，不再调用模型。
- 精简版按原文顺序保留有用内容、待确认及人工保留片段。转写变更后旧结果失效，需要重新分析。

支持已完成的转写，范围为 200–40,000 个有效字符、最多 80,000 个原始字符及 1,000 个分析片段。待确认文字达到 40% 时不显示总比例；这是实验规则，尚未经过真实会议数据校准。该比例不表示会议浪费的时间，也不评价参会者。

分析前会确认模型并预览全文；全文及所填议题会交给该模型，长文本可能分批重复提供上下文。模型服务的费用和数据处理方式取决于你的配置。结果仅在本机保存，不覆盖原录音或转写。当前测试覆盖计数、引用对应、人工保留、取消及并发修改，尚未验证真实模型判断的准确性。

### 表达解读（潜台词）

v0.0.4 的另一项实验功能。在历史卡片打开「表达解读（潜台词）」，预览全文、选择中英文并确认模型后生成报告。每份最多 8 条，分为原话、字面信息、可能含义、其他解释、不确定之处和澄清问法。原话及时间戳从转写提取，可回听所属发言段、查看相邻原文或导出 TXT。

不强制推测潜台词：没有需要解读的表达时返回空报告，上下文不足时标为「无法判断」。重叠发言或归属不明的片段会由程序设为「无法判断」；说话人归属修改后需要重新生成。推测不代表真实意图或事实，模型指令排除心理、人格评价和置信度分数。输入范围与会议体检相同。每条录音分别保存最新的体检和表达解读，互不覆盖；失败或取消保留旧结果，转写变更后旧报告失效。导出包含原话及相邻上下文，请按录音资料管理。真实会议解读质量尚未验证。

## English

### Computer audio (v0.0.4 preview)

Select **Computer audio** in the studio and confirm before recording. Captures playback directly, including when using headphones; microphone and screen capture stay off. Requires macOS 14.2+ on Apple Silicon (Core Audio tap, system audio permission) or Windows x64 (default playback device, WASAPI loopback). Both fun analysis tools are included in this version.

The system mix may include other apps and notifications. No per-app selection or microphone mixing yet. Recordings are local mono WAV files, limited to 60 minutes (about 1.9 MB/minute). Changing the output device stops capture and preserves recorded audio. Timestamps describe the recording timeline. Optional reports use Learning Notes: overview, outline, concepts, examples and review questions, in the selected report language. Text is sent only through the existing model consent flow.

Preview status: synthetic-audio tests do not verify real-device permissions, headphone capture or player compatibility. The macOS helper is ad-hoc signed and not notarized; the Windows helper has no publisher certificate. Do not disable system protections. Open sources are under `native/`; run `npm run build:native` on each target platform and include both platform bundles with SHA-256 manifests before packaging. Helpers exchange PCM/status through standard streams, with no network access or model credentials. Hash verification does not establish publisher identity.


Voice Notes provides local audio transcription, speaker diarization, meeting summaries and transcript search for DeepSeek Harness Desktop on macOS Apple Silicon and Windows x64.

### Install

Download the [macOS Apple Silicon package](https://github.com/WinterOne-hub/dsh-voice-notes/releases/download/v0.0.3/dsh-voice-notes-0.0.3.tgz) or the [Windows x64 package](https://github.com/WinterOne-hub/dsh-voice-notes/releases/download/v0.0.3/dsh-voice-notes-0.0.3.tgz). Verify the download against the corresponding SHA-256 file in the table above. Both platforms use the same package. Add the `.tgz` on the **Plugins** page, enable it, and restart Harness.

Tested with Harness Desktop 0.2.2-rc.3 on macOS. Installation, four-speaker transcription, and archive playback were verified on the official Windows x64 build. Physical microphone capture on Windows has yet to be tested. See the [Windows test run](https://github.com/WinterOne-hub/dsh-voice-notes/actions/workflows/windows-host-smoke.yml).

The studio checks GitHub for updates. Use **Update now** to download, verify and install a newer version, then restart Harness. Use **Check for updates** in v0.0.2 if available; older builds require manual installation of v0.0.3.

### Use

- Dictate in chat or record from the Voice Notes sidebar. Chat dictation inserts text into the draft by default.
- Import MP3, WAV, M4A, FLAC, OGG, Opus or WebM, up to 128 MiB and two hours. Download the SenseVoice model before the first transcription.
- Search recordings, replay from timestamps, correct transcripts and export TXT. Re-transcription creates a separate history entry.
- Generate a report in a selected language, or share the full transcript or an excerpt to an unsent Harness draft.

Audio is processed and stored locally. Optional translation, editing and reports send transcript text to the selected model. Uninstalling leaves the archive and model cache on disk. See [Privacy and Security](PRIVACY.md).

### Multi-speaker meetings

Added in v0.0.3.

Enable **Multi-speaker meeting** before recording or importing, or select **Identify speakers** for an existing recording. Speaker labels are added after recording or import. The limit is 60 minutes and 128 MiB. The first run downloads about 38 MiB of model data. If the download fails, import the model file in the studio. Open **Speaker transcript** to rename speakers, correct attribution, replay or export. Reports and shared drafts include timestamps and speaker labels. Set the speaker count when known and review overlapping speech. Import an audio file for online meetings.

Run `npm test` to test the plugin and `npm pack --ignore-scripts` to build the installation package.

### Meeting check (v0.0.4 preview)

v0.0.4 includes Meeting check, Expression interpretation and Computer audio. They are not included in the v0.0.3 release linked above. Open **Meeting check (experimental)** on a history card, preview the transcript, choose Chinese or English, and confirm the displayed model before analyzing. Analysis can be canceled.

The dial shows the share of letters and numbers classified as redundant repetition, filler or unrelated to the supplied topic. It measures text, not wasted meeting time. Without a topic, off-topic classification is disabled. Inspect original passages and reasons, replay their parent turns, and mark passages to retain. Retention recalculates the result locally. The compact text keeps useful, uncertain and manually retained passages in source order. Transcript edits invalidate previous results.

Completed transcripts must contain 200–40,000 letters and numbers, no more than 80,000 raw characters and 1,000 analysis units. The dial is withheld when at least 40% is uncertain. This experimental threshold has not been calibrated against real meetings.

The selected model receives the full transcript and optional topic after confirmation. Context may be sent repeatedly across batches. Provider charges and data handling depend on your configuration. Results are stored locally, separately from the original audio and transcript. Automated tests cover counting, source alignment, retention, cancellation and conflicting edits; real-model judgment quality has not yet been evaluated.

### Expression interpretation (subtext)

Another experimental feature in v0.0.4. Open the panel on a history card, preview the full transcript, choose Chinese or English, and confirm the displayed model. Up to eight entries separate original words, literal readings, possible meanings, alternative explanations, uncertainty and neutral clarifying questions. Quotes and timestamps are resolved from the transcript. Replay the parent turn, inspect adjacent source text or export TXT.

An empty report is allowed when no expression needs interpretation; insufficient context is marked **Cannot determine**. Overlapping or unattributed passages are programmatically marked uncertain. Attribution edits invalidate the report. Inferences are not verified intent or facts. The prompt excludes psychological or personality assessments and confidence scores. Input limits match Meeting check. Each recording stores the latest check and interpretation separately. Failed or canceled requests preserve previous results; transcript changes invalidate old reports. Exports include quotes and adjacent context. Real-meeting interpretation quality has not yet been evaluated.
