# 语音速记 · 录音转文字 / Voice Notes · Audio Transcription

[中文](#使用) · [English](#english) · [下载安装包 / Releases](https://github.com/WinterOne-hub/dsh-voice-notes/releases)

DeepSeek Harness 桌面插件，支持在聊天输入框听写，也可以在侧栏工作台录制和回听长录音。SenseVoiceSmall 在本机识别音频。支持导入本地录音、录音转写、会议纪要、转写检索和转写分享。

## 使用

- 在聊天输入框点麦克风开始听写。录音时显示实时字幕。停录后，完成的原始转写会尝试插入开始听写的会话草稿。开启翻译、模型整理或存在待转写片段时，会先显示结果，供你选择插入或复制。
- 在「语音速记 → 聊天听写偏好」可关闭「同时保存到录音历史」，也可选择一个在 Harness 窗口内生效的开始／停止快捷键。新安装默认仅插入草稿，快捷键默认关闭。仅插入草稿时，听写音频和转写结果不会写入录音历史。侧栏工作台的录音仍会保存。
- 录音时，Harness 窗口顶部一直显示计时和「停止」按钮，切换会话或面板也可停止。停录后的状态会分别显示保存和转写进度。
- 在左侧打开「语音速记」可以录制、查看结果和管理历史。停录后的文字留在工作台。在「录音历史」可搜索标题、原始转写、整理稿、译文或会议报告，也可以重命名、播放和下载音频。展开「转写与时间戳」，点时间跳到音频对应位置，播放时会高亮当前段。有片段命中搜索时，可以点「定位匹配片段」。在片段旁选「校对」可单独保存校对稿，原始转写可随时展开查看。两版均可下载为 TXT。没有时间戳的旧录音支持全文校对和导出。
- 在工作台点「导入本地录音」，选择 MP3、WAV、M4A、FLAC、OGG、Opus 或 WebM。每个文件最多 128 MiB，且时长不超过 2 小时。插件在本机解码、保存原音频并逐段转写。
- 对已有录音，在卡片上点「重新转写音频」，再选择识别语言。新转写作为一条独立历史保存，含一份相同的音频；原转写和校对稿可用于对照。
- 在单条录音里可搜索转写和定位匹配片段。选择「报告语言」可生成总结报告。点「分享到新会话」可将整篇转写带入 Harness 新草稿。在转写里选中文字时，可将选中的片段带入新草稿。卡片的分享、重新转写和报告入口可以直接使用；长转写可在卡片内滚动和收起。
- 「识别语言」仅传给本机识别引擎。自动识别、中文、英文、粤语、日语和韩语可选。录制期间固定这次录音的识别语言。
- 在工作台展开「翻译、整理和报告」可使用模型选项。「模型整理」默认关闭，可选择为原始转写生成单独的整理稿。「翻译」可从输入框或工作台启用，译文会在一段话完成转写后出现。「会议报告」可在工作台设置为停录后自动生成，也可在结果里手动操作。较长的报告按段处理后汇总。
- 整理、翻译和报告会把转写文字发给界面显示的默认模型。分享到新会话会在最近使用的 Harness 工作区创建未发送的草稿，用户可编辑、补充问题和选择模型。音频只在本机处理和保存。模型许可绑定提供方和模型，改用其他模型需要重新开启相关功能。

首次使用时，插件会提示下载 SenseVoiceSmall，支持进度、取消和切换下载源。麦克风权限由系统授予 DeepSeek Harness。Windows 可在「设置 → 隐私和安全性 → 麦克风」中启用桌面应用访问。

原文优先显示临时字幕，识别尝试间隔约 1.3 秒。停顿约 1.4 秒会触发正式转写，连续说话时约每 28 秒切段。正式转写的文字由所选模型翻译，实际等待时间还受本机识别、模型响应和网络影响。

## 录音保存和恢复

音频以 MediaRecorder 输出的压缩格式逐块保存。停录或退出时，已成功写入的音频保留在历史里。录制期间每约五秒为正在说的片段留一个本地 PCM 检查点。短暂停顿或达到片段长度时，本机识别已保存的片段。识别失败的片段留在历史里，可点「重转此段」。如果应用意外退出，最近一次保存之后的音频或检查点可能尚未写入。重开后约 25 秒没有新分块的录音会显示为已中断。

模型缓存位于 `~/.dsh/speech-to-text/sensevoice`，录音位于 `~/.dsh/voice-live/recordings`。新版录音中，JSON 记录保存原始片段、时间范围和派生文本，压缩音频保存在同名 `.parts` 目录。成功识别后会清理该片段的临时 PCM。超过 48 MiB 的新录音可继续分块保存，实际容量取决于可用磁盘。旧版 JSON 和单文件音频可继续播放、搜索和重命名，历史中没有时间戳的旧录音仍显示原有文本。

## 安装和开发

适用于 DeepSeek Harness 桌面端。macOS 已在 Harness 0.2.2-rc.3 上实测。Windows x64 是预览支持，需在支持访问控制的文件系统上使用 Harness 的本机数据目录。

1. 从 [v0.0.2 发布页](https://github.com/WinterOne-hub/dsh-voice-notes/releases/tag/v0.0.2) 下载对应安装包。macOS 下载 `dsh-voice-notes-0.0.2.tgz` 和 `SHA256SUMS`，运行 `shasum -a 256 -c SHA256SUMS`。Windows 下载 `dsh-voice-notes-0.0.2-windows-x64-preview.tgz` 和 `SHA256SUMS-windows-x64-preview`，运行 `Get-FileHash .\dsh-voice-notes-0.0.2-windows-x64-preview.tgz -Algorithm SHA256`，然后比对文件中的哈希。
2. 打开 Harness 的「插件」，添加该本地压缩包并按提示启用。也可以完全退出桌面应用，使用已安装的 Harness CLI，在压缩包目录运行对应命令。

   ```sh
   dsh plugin --profile desktop add ./dsh-voice-notes-0.0.2.tgz
   ```

   ```powershell
   dsh plugin --profile desktop add .\dsh-voice-notes-0.0.2-windows-x64-preview.tgz
   ```

3. 完全退出再打开 Harness，从侧栏打开「语音速记」。如果已安装语音速记的旧本地包，请先卸载旧包再启用新版；两个包提供同一套语音服务和面板。旧录音继续使用同一个本地数据目录。
4. 卸载可使用「插件」页面，或运行 `dsh plugin --profile desktop remove dsh-voice-notes`。

打开语音速记工作台时会检查 GitHub 上的正式版本，也可以手动点「检查更新」。发现更新后，点「一键更新」即可下载并校验安装包，由 Harness 的插件管理器安装。按界面提示重启 Harness 即可生效。更新不会改动录音文件。已经安装较早的 v0.0.2 用户需要先手动安装带更新入口的构建。

从源码打包时运行 `npm test` 和 `npm pack --ignore-scripts`。本插件使用 Harness 随附的语音服务和 SenseVoice provider。请按应用提示准备模型。

- `client.js` 注册输入框和侧栏，负责麦克风、字幕和历史。
- `index.js` 注册本机路由，调用 SenseVoice 和可选的默认模型。
- `storage.js` 写入音频分块和检查点，提供历史、Range 播放和串行更新。
- `npm test` 在临时目录测试录音恢复、并发写入、快捷键、保存反馈、跨会话行为、校对导出、会话鉴权、错误来源拒绝、并发上限和旧录音权限。

卸载插件后，模型和录音文件仍保存在上述目录。录音可以在工作台历史中逐条删除。

[隐私与安全说明](PRIVACY.md)


## English

Voice Notes brings local speech-to-text to DeepSeek Harness Desktop. Dictate in chat, record or import audio in the sidebar, and review timestamped transcripts. Verified on macOS. Windows x64 support is in preview.

### Install

Download the package from the [v0.0.2 release](https://github.com/WinterOne-hub/dsh-voice-notes/releases/tag/v0.0.2). On macOS, run `shasum -a 256 -c SHA256SUMS`. For the Windows x64 preview, compare `Get-FileHash .\dsh-voice-notes-0.0.2-windows-x64-preview.tgz -Algorithm SHA256` with `SHA256SUMS-windows-x64-preview`. Add the package on the **Plugins** page, enable it, and restart Harness. If an earlier local Voice Notes package is installed, remove it before enabling this package. Both packages use the same recording archive.

Voice Notes checks the official GitHub release when you open the studio. You can check again manually. **Update now** downloads and verifies the package, then installs it through the Harness plugin manager. Follow the restart prompt to apply the update. An earlier v0.0.2 build needs a manual installation of the build with the updater first.

### Use Voice Notes

- **Dictate or record.** Use the microphone in chat or open **Voice Notes · Audio Transcription** from the sidebar. Chat dictation inserts into the draft by default. Studio audio is saved as you record.
- **Import audio.** Use **Import audio file**. Supported containers are MP3, WAV, M4A, FLAC, OGG, Opus and WebM, up to 128 MiB and two hours per file. Harness decodes the file on your device and transcribes it with SenseVoice.
- **Transcribe an existing recording.** Select **Transcribe audio again** on its history card and choose the recognition language. A separate entry keeps the earlier transcript and corrections available for comparison.
- **Find, review and export.** Search across history or inside one transcript. Open a matching timestamp to replay it. Corrections can be saved separately and exported as TXT.
- **Summarize or share.** Pick a report language and generate a summary for the current recording. Use **Share to new conversation** to bring the full transcript into a new Harness draft. Select specific text to share an excerpt. You can edit the draft, choose a model and send it when ready.
- **Translate as you record.** Interim captions are refreshed when local recognition runs, at least 1.3 seconds apart. A pause of about 1.4 seconds or a roughly 28-second segment triggers final recognition. Translation starts after that segment is transcribed, and its latency depends on the model and network.

The audio stays in the local Harness installation. Reports, translations and model editing send transcript text to the provider shown in the app. Sharing opens an unsent draft in the most recently used Harness workspace with the transcript or the selected excerpt. Harness handles model requests once you send the draft. See [Privacy and Security](PRIVACY.md) for retention and access details.

Run `npm test` to test the package and `npm pack --ignore-scripts` to build a tarball. Licensed under [MIT](LICENSE).
