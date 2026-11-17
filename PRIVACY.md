# 隐私与安全 / Privacy and Security

| 数据 | 用途和存放位置 |
| --- | --- |
| 麦克风和导入音频 | 录音时申请麦克风权限。SenseVoice 在本机识别音频。工作台录音和导入文件保存于 Harness 数据目录下的 `voice-live/recordings`。聊天听写默认不写入历史。 |
| 转写、校对、译文和报告 | 原文及衍生文本可保存在本机历史中。启用翻译、整理或报告时，转写文字发给界面显示的模型。分享只创建未发送的 Harness 草稿。 |
| 模型和安装包 | 首次准备模型会访问模型下载源。版本检查访问公开 GitHub Releases 接口；点击更新才下载安装包。请求不包含录音、转写或个人 API 凭据。 |

录音归档为明文。macOS 目录使用 `0700`、文件使用 `0600`；Windows 限制为当前用户和系统账户访问。语音接口仅接受 Harness 签发的本机桌面会话。安装包按版本、大小和 SHA-256 校验后交给 Harness 安装。

可在历史逐条删除录音。卸载保留录音、模型和更新缓存。导出文件、备份和已发出的聊天内容在各自位置管理。

## English

Microphone and imported audio are transcribed locally. Studio recordings, imports, transcripts and related text are kept under `voice-live/recordings` in the Harness data directory. Chat dictation does not write to the archive by default.

Translation, editing and reports send transcript text to the selected model. Sharing creates an unsent Harness draft. Model setup and update checks access their download sources without sending audio, transcript text or personal API credentials.

The archive is unencrypted. Access is restricted by macOS file permissions or Windows ACLs. The API requires an authenticated local Harness Desktop session. Update files are checked before installation. Uninstalling keeps the archive and caches; delete recordings from history.
