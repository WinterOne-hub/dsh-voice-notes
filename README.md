# 语音速记 / Voice Notes

DeepSeek Harness Desktop 插件。支持本地听写、录音、文件转写和录音历史。

[中文](#安装和开发) · [English](#english) · [Releases](https://github.com/WinterOne-hub/dsh-voice-notes/releases)

## 安装和开发

| 平台 | v0.0.2 安装包 | SHA-256 |
| --- | --- | --- |
| macOS（Apple Silicon） | [下载](https://github.com/WinterOne-hub/dsh-voice-notes/releases/download/v0.0.2/dsh-voice-notes-0.0.2.tgz) | [SHA256SUMS](https://github.com/WinterOne-hub/dsh-voice-notes/releases/download/v0.0.2/SHA256SUMS) |
| Windows x64（预览） | [下载](https://github.com/WinterOne-hub/dsh-voice-notes/releases/download/v0.0.2/dsh-voice-notes-0.0.2-windows-x64-preview.tgz) | [SHA256SUMS-windows-x64-preview](https://github.com/WinterOne-hub/dsh-voice-notes/releases/download/v0.0.2/SHA256SUMS-windows-x64-preview) |

1. 在 macOS 上运行 `shasum -a 256 -c SHA256SUMS`。在 Windows 上运行 `Get-FileHash .\dsh-voice-notes-0.0.2-windows-x64-preview.tgz -Algorithm SHA256`，与校验文件比对。
2. 在 Harness 的「插件」页添加对应的 `.tgz`，启用后重启。在侧栏打开「语音速记」。若已安装其他语音速记本地包，先卸载旧包。

macOS 测试使用 Harness Desktop 0.2.2-rc.3。Windows x64 已验证安装、本地转写和历史回放，实体麦克风尚未验证。参见 [Windows 测试记录](https://github.com/WinterOne-hub/dsh-voice-notes/actions/runs/43909750463)。

打开工作台时会检查更新。找到新版本后，可在界面下载、校验和安装，重启生效。较早的 v0.0.2 构建需手动安装一次带更新入口的版本。

## 使用

- **听写：** 点击聊天输入框的麦克风。默认将文字插入草稿；可在偏好中启用历史保存和窗口内快捷键。
- **录音和导入：** 在侧栏工作台录音，或导入 MP3、WAV、M4A、FLAC、OGG、Opus、WebM（最多 128 MiB、2 小时）。首次转写需下载 SenseVoice 模型。
- **历史：** 支持搜索、按时间戳回听、校对和导出 TXT。「重新转写音频」会另存一条历史。
- **报告和分享：** 可选报告语言。「分享到新会话」将全文或选中文字放入未发送的 Harness 草稿。

录音和识别在本机处理。启用翻译、整理或报告时，转写文字交给界面所示模型。录音保存在 `~/.dsh/voice-live/recordings`；可从历史中删除。卸载插件不会删除录音或模型缓存。见 [隐私与安全](PRIVACY.md)。

录音时的临时字幕识别间隔约 1.3 秒。正式转写通常在停顿约 1.4 秒时触发；连续发言约每 28 秒切段。译文在该段正式转写后生成，耗时取决于所用模型和网络。

运行 `npm test` 执行测试，运行 `npm pack --ignore-scripts` 生成安装包。许可证：[MIT](LICENSE)。

## English

Voice Notes is a DeepSeek Harness Desktop plugin for local dictation, recording and transcription.

### Install

Download the [macOS Apple Silicon package](https://github.com/WinterOne-hub/dsh-voice-notes/releases/download/v0.0.2/dsh-voice-notes-0.0.2.tgz) or the [Windows x64 preview](https://github.com/WinterOne-hub/dsh-voice-notes/releases/download/v0.0.2/dsh-voice-notes-0.0.2-windows-x64-preview.tgz). Verify the download against the corresponding SHA-256 file in the table above. Add the `.tgz` on the **Plugins** page, enable it, and restart Harness.

Tested with Harness Desktop 0.2.2-rc.3 on macOS. Installation, local transcription, and archive playback were verified on the official Windows x64 build. Physical microphone capture on Windows has yet to be tested. See the [Windows test run](https://github.com/WinterOne-hub/dsh-voice-notes/actions/runs/43909750463).

The studio checks GitHub for updates. Use **Update now** to download, verify and install a newer version, then restart Harness. Earlier v0.0.2 builds require a manual installation of the updater-enabled package.

### Use

- Dictate in chat or record from the Voice Notes sidebar. Chat dictation inserts text into the draft by default.
- Import MP3, WAV, M4A, FLAC, OGG, Opus or WebM, up to 128 MiB and two hours. Download the SenseVoice model before the first transcription.
- Search recordings, replay from timestamps, correct transcripts and export TXT. Re-transcription creates a separate history entry.
- Generate a report in a selected language, or share the full transcript or an excerpt to an unsent Harness draft.

Audio is processed and stored locally. Optional translation, editing and reports send transcript text to the selected model. Uninstalling leaves the archive and model cache on disk. See [Privacy and Security](PRIVACY.md).

Run `npm test` to test the plugin and `npm pack --ignore-scripts` to build the installation package.
