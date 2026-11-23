# 隐私与安全 / Privacy and Security

| 数据 | 用途和存放位置 |
| --- | --- |
| 麦克风和导入音频 | 录音时申请麦克风权限。SenseVoice 在本机识别音频。工作台录音和导入文件保存于 Harness 数据目录下的 `voice-live/recordings`。聊天听写默认不写入历史。 |
| 转写、校对、译文和报告 | 原文及衍生文本可保存在本机历史中。启用翻译、整理或报告时，转写文字发给界面显示的模型。分享只创建未发送的 Harness 草稿。 |
| 模型和安装包 | 首次准备模型会访问模型下载源。说话人模型从 Hugging Face 下载。版本检查访问公开 GitHub Releases 接口；点击更新才下载安装包。请求不包含录音、转写或个人 API 凭据。 |

录音归档为明文。macOS 目录使用 `0700`、文件使用 `0600`；Windows 限制为当前用户和系统账户访问。语音接口仅接受 Harness 签发的本机桌面会话。安装包按版本、大小和 SHA-256 校验后交给 Harness 安装。

多人会议在本机区分说话人。只保存当次录音的编号、名称、时间戳和文字，不保存可跨录音匹配的声纹。模型另外存放在 `voice-live/meeting-models`。

v0.0.4 的「会议体检」和「表达解读（潜台词）」仅在逐次确认后调用界面所示模型。发送内容为预览中的完整转写及所填议题；会议体检可能分批重复发送全文，表达解读一次提供全文。不发送音频或说话人名称字段，但原话中的姓名、身份及其他敏感信息仍会包含在文字中；这不构成匿名化。可先校对敏感文字，再核对预览。模型的访问凭据由 Harness 管理，不写入分析结果或安装包。模型名称、分类理由及人工保留决定保存在同一条本机历史中，精简版由这些数据生成。会议体检保存分析原文副本；表达解读保存引文、相邻上下文和各项解释。删除录音时一并删除这些分析。取消或请求失败不会替换已保存的结果，已经发出的文字无法从模型服务撤回。导出的解读 TXT 含原话及相邻上下文，需单独管理。

可在历史逐条删除录音。卸载保留录音、模型和更新缓存。导出文件、备份和已发出的聊天内容在各自位置管理。

电脑声音录制只在选择该来源并逐次确认开始后启动。采集系统播放混音，可能包括其他应用与通知；不采集屏幕、不打开麦克风。macOS 还需系统音频权限。组件不枚举或保存播放应用名称、设备标识，不读取模型配置或访问网络。输出设备变化、断开连接或插件退出时停止，不回退到麦克风。最多录制 60 分钟，PCM 归档按受保护的本机目录权限保存；临时传输队列有大小限制。学习笔记与其他报告共用模型确认流程，原始音频不发送给报告模型。原生文件在启动前检查版本和哈希，清单本身不是数字发行签名。

## English

Microphone and imported audio are transcribed locally. Studio recordings, imports, transcripts and related text are kept under `voice-live/recordings` in the Harness data directory. Chat dictation does not write to the archive by default.

Translation, editing and reports send transcript text to the selected model. Sharing creates an unsent Harness draft. Speaker model setup downloads from Hugging Face. Model setup and update checks access their download sources without sending audio, transcript text or personal API credentials.

The archive is unencrypted. Access is restricted by macOS file permissions or Windows ACLs. The API requires an authenticated local Harness Desktop session. Update files are checked before installation. Uninstalling keeps the archive and caches; delete recordings from history.

Speaker analysis runs locally. Speaker numbers, names, timestamps and text are saved with that recording. No voiceprints are retained. The model cache is under `voice-live/meeting-models`.

v0.0.4 Meeting check and Expression interpretation (subtext) send the previewed transcript and optional topic to the displayed model only after each confirmation. Meeting check may repeat full context across batches; interpretation sends it in one call. Audio and speaker-name fields are omitted, but names and sensitive details spoken in the transcript remain. This is not anonymization; correct sensitive text and review the preview before confirming. Harness manages model credentials; credentials are not written into the analysis or package. Checks store a source snapshot, model name, labels, reasons and retention decisions. Interpretations store quotes, adjacent context and explanatory text. Both are saved with the local recording and removed when it is deleted. Canceled or failed requests do not replace saved results. Text already sent cannot be recalled from the model service. Exported TXT files include quotes and adjacent context and must be managed separately.

Computer audio starts only after selecting that source and confirming each start. It captures system playback, potentially including other apps and notifications, without screen or microphone capture. macOS also requires system audio permission. Helpers do not retain device identifiers or application names, access model configuration, or use the network. Device changes, disconnection or plugin shutdown stop capture without microphone fallback. Capture is limited to 60 minutes; PCM archives use the existing private local directory and transport queues are bounded. Learning Notes use the existing model consent flow; report models receive text, not raw audio. Native files are version/hash checked; the manifest is not a publisher signature.
