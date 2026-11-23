/**
 * Client half of the live voice input bundle.
 *
 * A microphone control sits between the model selector and Send. While it
 * records, the plugin sends interim PCM for captions and checkpoints bounded
 * segments for recovery. Compressed audio is archived independently. Opt-in
 * text processing uses the disclosed model through the Host.
 */

window.__ModuleLoader__.load({
  id: 'dsh-voice-notes',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'voice-live';
    const BUILD = '0.0.5';
    const SOURCE_LANGUAGES = [
      ['auto', 'translate.auto'],
      ['zh', '简体中文'],
      ['en', 'English'],
      ['yue', '粤语'],
      ['ja', '日本語'],
      ['ko', '한국어'],
    ];
    const TARGETS = [
      ['off', 'translate.off'],
      ['en', 'English'],
      ['zh', '简体中文'],
      ['yue', '粤语'],
      ['ja', '日本語'],
      ['ko', '한국어'],
      ['fr', 'Français'],
      ['de', 'Deutsch'],
      ['es', 'Español'],
      ['ru', 'Русский'],
    ];
    const REPORT_LANGUAGES = [['auto', 'report.auto'], ...TARGETS.filter(([code]) => code !== 'off')];
    const AUDIO_FORMATS = {
      mp3: 'audio/mpeg',
      wav: 'audio/wav',
      m4a: 'audio/mp4',
      flac: 'audio/flac',
      ogg: 'audio/ogg',
      opus: 'audio/ogg',
      webm: 'audio/webm',
    };
    const MAX_IMPORT_BYTES = 128 * 1024 ** 2;
    const MAX_IMPORT_SECONDS = 2 * 3600;
    const MAX_MEETING_SECONDS = 3600;
    const SPEAKER_MODEL_URL = 'https://huggingface.co/Maxkuo/eres2net-base-sv-zh-cn-onnx/resolve/533e660fabc9553c0dc0cb5b395b24eac1ece0ad/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx';
    const SHORTCUTS = [
      ['off', 'shortcut.off'],
      ['KeyY', 'Ctrl+Shift+Y'],
      ['KeyL', 'Ctrl+Shift+L'],
      ['KeyK', 'Ctrl+Shift+K'],
    ];
    const API = '/api/voice-live';
    const SAMPLE_RATE = 16_000;
    /** Start a new recognition slice after this much continuous speech. */
    const SEGMENT_SECONDS = 28;
    /** Silence that closes a segment. */
    const SILENCE_MS = 1400;
    /** RMS above this counts as speech. */
    const VOICE_RMS = 0.008;
    /** Minimum slice worth sending. */
    const MIN_SECONDS = 0.45;
    /** Cadence of interim recognition while the current slice grows. */
    const PARTIAL_MS = 1_300;
    const CHECKPOINT_MS = 5000;

    /** AudioWorklet source: batch 128-frame renders into ~4096-sample messages. */
    const WORKLET_SOURCE = `
class VoiceLiveCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.parts = [];
    this.count = 0;
    this.port.onmessage = () => {
      this.flush();
      this.port.postMessage({ flushed: true });
    };
  }
  flush() {
    if (!this.count) return;
    const out = new Float32Array(this.count);
    let at = 0;
    for (const part of this.parts) {
      out.set(part, at);
      at += part.length;
    }
    this.parts = [];
    this.count = 0;
    this.port.postMessage(out, [out.buffer]);
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    this.parts.push(new Float32Array(channel));
    this.count += channel.length;
    if (this.count >= 4096) this.flush();
    return true;
  }
}
registerProcessor('voice-live-capture', VoiceLiveCapture);
`;

    const ZH = {
      "system.requesting": "正在请求系统音频权限…",
      "system.source": "声音来源",
      "system.microphone": "麦克风",
      "system.computer": "电脑声音",
      "system.hint": "麦克风关闭 · 最长 60 分钟",
      "system.confirm": "开始录制电脑声音（最长 60 分钟）？可能包含其他应用和通知声音。麦克风关闭，音频保存在本机。",
      "system.report": "学习笔记",
      "system.missing": "当前安装包缺少电脑声音组件，请安装完整版本。",
      "system.unsupported": "电脑声音需要 macOS 14.2+（Apple Silicon）或 Windows x64。",
      "system.unverified": "电脑声音组件校验失败，请重新安装。",
      "system.deviceChanged": "输出设备已变化，录音已停止。已采集的音频保留。",
      "system.limit": "电脑声音录制已达到 60 分钟上限。",
      "system.failed": "电脑声音录制失败或被中断。请检查系统音频权限和输出设备。",

      'interpret.title': '表达解读（潜台词）',
      'interpret.topicHint': '可填写会议背景，帮助理解上下文',
      'interpret.notice': '实验功能。以下为可能解释，不代表真实意图或事实；请结合上下文核对，必要时直接向对方确认。',
      'interpret.consent': '将这份转写全文（{n} 个有效字符）及所填议题发送给 {model}，生成表达解读（潜台词）。文字可能含有姓名等隐私。是否继续？',
      'interpret.invalidResult': '模型引用或报告格式不符，结果未保存，请重试。',
      'interpret.changed': '转写或表达解读已有更新，请收起后重新打开再试。',
      'interpret.empty': '未发现需要解读的表达。无需为普通表述推测潜台词。',
      'interpret.literal': '字面信息',
      'interpret.possible': '可能含义（推测）',
      'interpret.alternatives': '其他解释',
      'interpret.uncertainty': '不确定之处',
      'interpret.question': '澄清问法',
      'interpret.unknown': '无法判断',
      'interpret.attribution': '该段有重叠发言或说话人归属不明，暂不推测含义。',
      'interpret.quote': '原话',
      'interpret.context': '查看相邻原文',
      'interpret.before': '前文',
      'interpret.after': '后文',
      'interpret.waiting': '分析后会列出原话、可能含义、其他解释和澄清问法；最多 8 条。',
      'interpret.export': '导出解读 TXT',
      "check.title": "会议体检（实验）",
      "check.headline": "废话含量",
      "check.metric": "可压缩文字占比 · 模型估计",
      "check.score": "可压缩文字约 {n}%",
      "check.approx": "约 {n}%",
      "check.waiting": "待分析",
      "check.loading": "正在读取",
      "check.analyzing": "正在分析",
      "check.stale": "需要重新分析",
      "check.unassessable": "暂无法评估",
      "check.short": "至少需要 200 个有效字符才能评估。",
      "check.tooLong": "当前最多支持 40,000 个有效字符、1,000 段文字。",
      "check.pending": "请先结束录音并补全失败的转写片段。",
      "check.invalid": "分析参数无效。",
      "check.invalidResult": "模型标注不完整或格式不符，结果未保存，请重试。",
      "check.changed": "转写或分析结果已有更新，请收起并重新打开会议体检后再试。",
      "check.model": "请先选择本次分析使用的模型。",
      "check.explanation": "按文字字符计算，排除空白和标点。无法判断的文字单独统计；达到 40% 时不出总分。该比例不表示会议浪费的时间。",
      "check.counts": "可压缩 {removed} / 共 {total} 字符；待确认 {uncertain}%。",
      "check.topic": "会议议题（可选）",
      "check.language": "分析语言",
      "check.topicHint": "不填写时，不判断跑题",
      "check.preview": "查看将发送的全文（{n} 个有效字符）",
      "check.consent": "将这份转写全文（{n} 个有效字符）及所填议题发送给 {model}，生成会议体检。文字可能含有姓名等隐私。是否继续？",
      "check.analyze": "开始分析",
      "check.regenerate": "重新分析",
      "check.compact": "查看精简版",
      "check.cancelled": "已取消分析。",
      "check.locale": "zh",
      "check.categories": "分类明细",
      "check.repeat": "重复信息",
      "check.filler": "填充语",
      "check.offtopic": "可能跑题",
      "check.uncertain": "待确认",
      "check.keep": "需要保留",
      "check.all": "查看标注",
      "check.retain": "需要保留",
      "check.undoRetain": "恢复模型判断",
      "check.modelUsed": "模型：{model} · 分析议题：{topic}",
      "check.noTopic": "未指定",
      "check.parentTime": "回听所属发言段，非逐句时间戳",
      "check.compactHint": "按原文顺序保留有用、待确认和人工保留的片段；请对照原文核对。",
      "check.emptyCompact": "当前没有保留文字，请查看标注并核对。",
      "check.noMatches": "此分类没有片段。",
      "meeting.installModel": "导入模型文件",
      "meeting.getModel": "下载模型文件",
      "meeting.installingModel": "正在校验模型文件…",
      "meeting.modelReady": "模型已安装。可在录音卡片重新识别。",
      "meeting.mode": "多人会议",
      "meeting.modeHint": "停录或导入后识别说话人，最长 60 分钟。",
      "meeting.count": "说话人数",
      "meeting.auto": "自动",
      "meeting.locale": "zh",
      "meeting.action": "识别说话人",
      "meeting.view": "多人转写",
      "meeting.again": "重新识别说话人",
      "meeting.replace": "重新识别会替换这份多人转写及其校对。原始转写和录音会保留。",
      "meeting.download": "首次使用需从 GitHub 下载约 {size} 的模型。录音在本机处理。现在下载？",
      "meeting.downloading": "正在下载说话人模型…",
      "meeting.decoding": "正在读取录音…",
      "meeting.processing": "正在本机识别说话人并转写…",
      "meeting.ready": "多人转写已保存。",
      "meeting.cancelled": "已取消。录音和已有转写已保留。",
      "meeting.downloadFailed": "模型下载失败，请重试。",
      "meeting.integrity": "模型校验失败，请重新安装插件或重试下载。",
      "meeting.cachePermissions": "说话人模型目录权限不符合要求。",
      "meeting.analysisFailed": "说话人识别失败。原始录音和转写已保留。",
      "meeting.transcriptionFailed": "本地转写失败，请重试。",
      "meeting.prepare": "模型未准备好，请重新识别。",
      "meeting.unsupported": "当前 Harness 安装未提供兼容的说话人识别运行库。",
      "meeting.unavailable": "录音或转写状态已变更，请刷新后再试。",
      "meeting.tooLong": "多人转写最多处理 60 分钟、128 MiB 的录音。",
      "meeting.tooMany": "检测到的说话人数过多，请指定人数后重试。",
      "meeting.invalid": "录音参数无效或与原音频不符。",
      "meeting.timeout": "多人转写超时，请重试。",
      "meeting.noSpeech": "未识别到可转写的语音。",
      "meeting.speaker": "说话人 {n}",
      "meeting.unknown": "说话人待确认",
      "meeting.overlap": "重叠发言，待确认",
      "meeting.rename": "编辑说话人名称",
      "meeting.assign": "发言人",
      "meeting.export": "导出多人转写 TXT",
      "meeting.emptyTurn": "未识别出文字，可回听校对。",
      "meeting.reportStale": "转写已修改，请重新生成报告。",
      "report.kind": "报告模板",
      "report.kind.auto": "按声音来源",
      "report.kind.meeting": "会议纪要",
      "report.kind.learning": "学习笔记",
      "report.pending": "请先补转缺失片段，再生成报告。",
      "system.noSamples": "电脑声音已中断。已保存 {seconds} 秒。",
      "meeting.hint": "用时间戳回听。抢话、短插话和声音相近时，标签可能有误。",
      dictate: '语音输入（边录边写）',
      'phase.requesting': '正在请求麦克风…',
      'phase.recording': '正在聆听',
      'phase.finishing': '正在整理文字…',
      'phase.ready': '语音模型已就绪',
      'bar.stop': '停止并保留文字',
      'bar.cancel': '取消录音',
      'bar.translate': '同步翻译',
      'bar.translateOn': '已开启翻译，停顿后自动翻译',
      'translate.off': '不翻译',
      'translate.title': '翻译为',
      'translate.enable': '翻译',
      'translate.auto': '自动',
      'language.title': '识别语言',
      'language.hint': '仅用于本机语音识别。可以单独开启模型整理。',
      'bar.elapsed': '{time}',
      'bar.retry': '重新录音',
      'bar.close': '关闭',
      'live.empty': '开口说话，文字会实时出现在这里…',
      'live.hint': '停顿会自动分段；切到后台也会继续录音，停止后文字会插入下方草稿。',
      'live.translating': '翻译中…',
      'live.translation': '译文',
      'setup.title': '启用本地语音识别',
      'setup.body':
        'SenseVoiceSmall 在本机运行，音频不会离开这台电脑。首次使用需要下载模型（约 {size}）。',
      'setup.download': '下载并准备',
      'setup.later': '稍后',
      'setup.cancel': '取消下载',
      'setup.preparing': '正在准备模型…',
      'setup.ready': '模型已就绪，可以开始录音。',
      'setup.start': '开始录音',
      'setup.failed': '模型准备失败：{message}',
      'setup.retry': '重试',
      'setup.source': '下载源',
      'setup.sourceAuto': '自动选择',
      'setup.disk': '预计占用磁盘 {size}',
      'setup.step.check': '检查缓存',
      'setup.step.model': '下载识别模型',
      'setup.step.vad': '下载静音检测',
      'setup.step.verify': '校验文件',
      'setup.step.load': '加载模型',
      'setup.unavailable': '语音服务未连接，请确认语音插件已启用。',
      'result.title': '转写完成',
      'result.empty': '没有识别到语音',
      'result.insert': '插入草稿',
      'result.insertTranslation': '插入译文',
      'result.insertBoth': '插入双语',
      'result.copy': '复制',
      'result.discard': '关闭',
      'result.copied': '已复制',
      'error.title': '语音输入失败',
      'error.retry': '重试',
      'error.close': '关闭',
      'error.blocked': '麦克风权限被拒绝。请在系统隐私设置中打开麦克风访问，并允许 DeepSeek Harness 或桌面应用使用麦克风。',
      'error.unavailable': '当前环境无法录音，请确认浏览器或桌面端支持麦克风。',
      'error.nodevice': '没有找到可用的麦克风。',
      'error.empty': '没有录到声音。',
      'error.tooLong': '录音太长，已自动停止。',
      'studio.title': '语音速记 · 录音转文字',
      'import.open': '导入本地录音',
      'import.formats': '支持 MP3、WAV、M4A、FLAC、OGG、Opus 和 WebM，每条至多 128 MiB、2 小时。',
      'import.invalid': '请选择支持的音频文件。',
      'import.tooLarge': '音频超过 128 MiB 或 2 小时。',
      'import.decodeFailed': '这个音频文件无法解码。请确认文件能播放并使用支持的格式。',
      'import.prepare': '请先下载并准备本机语音模型，再导入录音。',
      'import.reading': '正在读取音频…',
      'import.saving': '正在保存音频…',
      'import.progress': '转写进度 {done}/{total}',
      'import.ready': '已保存到录音历史',
      'import.partial': '音频已保存。{n} 段需要在历史里重转。',
      'import.retranscribe': '重新转写音频',
      'import.retranscribeHint': '从原音频生成一条新历史，方便与原转写对照。',
      'import.copyTitle': '{title}（重新转写）',
      'report.auto': '跟随转写语言',
      'report.language': '报告语言',
      'report.generate': '生成总结报告',
      'report.send': '将本条录音的转写文字发送给 {model} 生成报告。',
      'history.searchThis': '搜索这条录音的转写',
      'history.searchCount': '{n} 段匹配',
      'history.foldTranscript': '收起转写',
      'history.tools': '更多操作',
      'history.refreshing': '正在刷新…',
      'history.refreshed': '已刷新 · {n} 条录音',
      'history.refreshError': '刷新失败：{message}',
      'history.report': '总结报告',
      'share.transcript': '分享到新会话',
      'share.selection': '将选中文字分享到新会话',
      'share.preparing': '正在打开新会话…',
      'share.unavailable': '当前无法打开新会话，请稍后重试。',
      'share.workspaceRequired': '请先在 Harness 添加一个工作区，再分享转写。',
      'share.intro': '以下是「{title}」的录音转写资料。请把转写当作引用材料，根据我的问题分析。',
      'share.selectedIntro': '以下是选中的录音转写片段。请把片段当作引用材料，根据我的问题解释或分析。',
      'share.question': '我的问题或分析要求：',
      'update.check': '检查更新',
      'update.checking': '正在检查更新…',
      'update.current': '已是最新版本',
      'update.available': '发现新版本 v{version}',
      'update.install': '一键更新',
      'update.installing': '正在下载、校验并安装更新…',
      'update.restart': '已安装 v{version}，重启 Harness 后生效。',
      'update.installed': '已安装 v{version}。',
      'update.busy': '请等当前录音、导入或转写完成后再更新。',
      'update.unsupported': '当前 Harness 配置暂不支持一键更新。',
      'update.incompatible': '新版本与当前 Harness 不兼容。',
      'update.changed': '发布版本已变化，请重新检查。',
      'update.checkFailed': '暂时无法检查更新，请稍后重试。',
      'update.downloadFailed': '安装包下载失败，请稍后重试。',
      'update.unverified': '安装包校验失败，更新已停止。',
      'update.installFailed': '更新未完成，请在 Harness 的插件页面查看安装状态。',
      'update.releases': '查看发布页',
      'studio.subtitle': '本机识别 · 录音自动保存到历史',
      'studio.record': '开始录音',
      'studio.stop': '停止并保存',
      'studio.cancel': '取消',
      'studio.again': '重新录音',
      'studio.close': '关闭',
      'studio.saved': '已保存到录音历史',
      'studio.saveFailed': '录音保存失败：{message}',
      'studio.history': '录音历史',
      'studio.count': '{n} 条',
      'studio.refresh': '刷新',
      'studio.path': '保存在',
      'studio.copyPath': '复制路径',
      'studio.loading': '正在读取录音…',
      'studio.empty': '还没有录音，点上面的麦克风开始。',
      'studio.noAudio': '无音频',
      'studio.noText': '（无转写）',
      'studio.copy': '复制文字',
      'studio.copied': '已复制',
      'studio.download': '下载音频',
      'studio.delete': '删除',
      'studio.confirmDelete': '删除这条录音和音频？',
      'studio.expand': '展开',
      'studio.collapse': '收起',
      'studio.retry': '重试',
      'studio.model': '语音模型',
      'studio.ready': '已就绪',
      'studio.preparing': '准备中',
      'studio.unprepared': '需要下载',
      'studio.historyEmpty': '历史为空',
      'studio.report': '生成报告',
      'studio.reportHint': '停录后由默认模型生成',
      'studio.generating': '正在生成会议报告…',
      'studio.generate': '生成会议报告',
      'studio.copyReport': '复制报告',
      'studio.reportFailed': '{message}',
      'studio.hint': '录音过程中自动保存。停录后可在这里查看转写，或到历史里回听。',
      'history.search': '搜索标题、转写或报告',
      'history.noMatch': '没有匹配的录音。',
      'history.more': '下一页',
      'history.previous': '上一页',
      'history.details': '转写与时间戳',
      'history.fullText': '查看转写',
      'history.rename': '重命名',
      'history.title': '录音标题',
      'history.save': '保存',
      'history.active': '录音中',
      'history.interrupted': '录音中断 · 已保留已保存的内容',
      'history.pending': '{n} 段待转写',
      'history.retrySegment': '重转此段',
      'history.retrying': '重转中…',
      'history.emptySegment': '未识别到文字',
      'history.derivedStale': '转写已更新，现有整理稿、译文或报告可能缺少新补转的内容。',
      'archive.noRecorder': '当前环境无法保存音频，仍会保存转写。',
      'archive.captureInterrupted': '麦克风或录音中断，正在保留已采集内容。',
      'archive.segmentFailed': '此片段转写失败',
      'archive.segmentWrites': '还有片段尚未保存',
      'archive.retrySave': '重试保存',
      'archive.saving': '正在保存…',
      'archive.pending': '{n} 段暂未转写。可到「语音速记 → 录音历史」重转。',
      'model.edit': '模型整理',
      'model.edited': '整理稿',
      'model.editing': '模型整理中…',
      'model.editError': '整理失败：{message}',
      'model.disclose': '整理、翻译和会议报告会将转写文字发送给 {provider}。音频保存在本机。',
      'model.unavailable': '默认模型未就绪。整理、翻译和会议报告需要可用的模型。',
      'result.insertEdited': '插入整理稿',
      'recording.live': '录音中',
      'recording.stop': '停止',
      'recording.open': '查看语音速记',
      'recording.stopping': '正在停止录音…',
      'recording.finishingDraft': '正在完成听写…',
      'recording.saving': '麦克风已关闭 · 正在保存',
      'recording.processing': '{n} 段正在转写',
      'recording.savedProcessing': '录音已保存 · {n} 段正在转写',
      'recording.saved': '录音已保存',
      'recording.saveFailed': '录音保存遇到问题',
      'recording.draft': '仅插入草稿',
      'recording.ready': '听写结果已就绪',
      'recording.inserted': '已插入草稿',
      'recording.insertedSaved': '已插入草稿 · 录音已保存',
      'recording.originalDraft': '回到开始听写的会话可插入草稿。也可以复制文字。',
      'recording.options': '翻译、整理和报告',
      'recording.dictationSettings': '聊天听写偏好',
      'recording.dictationHistory': '同时保存到录音历史',
      'recording.dictationHint': '仅插入草稿时，听写音频和转写结果不会写入录音历史。',
      'shortcut.label': '开始／停止听写',
      'shortcut.off': '关闭快捷键',
      'shortcut.hint': '快捷键在 Harness 窗口内生效。',
      'archive.localPending': '{n} 段听写失败，可在此重转。',
      'archive.retryLocal': '重转失败片段',
      'history.jump': '定位匹配片段',
      'history.nextMatch': '下一处匹配',
      'history.correct': '校对',
      'history.correction': '校对稿',
      'history.original': '原始转写',
      'history.restore': '恢复原始转写',
      'history.exportOriginal': '下载原始转写',
      'history.exportCorrected': '下载校对稿',
    };

    const EN = {
      "system.requesting": "Requesting system audio permission…",
      "system.source": "Audio source",
      "system.microphone": "Microphone",
      "system.computer": "Computer audio",
      "system.hint": "Microphone off · 60 min maximum",
      "system.confirm": "Record computer playback audio (up to 60 minutes)? Other apps and notification sounds may be included. The microphone stays off. Audio is saved locally.",
      "system.report": "Learning Notes",
      "system.missing": "Computer audio component is missing. Install the full package.",
      "system.unsupported": "Computer audio requires macOS 14.2+ (Apple Silicon) or Windows x64.",
      "system.unverified": "Computer audio integrity check failed. Reinstall the package.",
      "system.deviceChanged": "Output device changed. Recording stopped; captured audio is preserved.",
      "system.limit": "Computer audio reached its 60-minute limit.",
      "system.failed": "Computer audio failed or was interrupted. Check system audio permission and output device.",

      'interpret.title': 'Expression interpretation (subtext)',
      'interpret.topicHint': 'Optional meeting background for context',
      'interpret.notice': 'Experimental. These are possible readings, not verified intent or facts. Check the context and ask the speaker when clarification is needed.',
      'interpret.consent': 'Send the full transcript ({n} letters and numbers) and the optional topic to {model} for expression interpretation (subtext)? The text may contain names and other private details.',
      'interpret.invalidResult': 'The model returned invalid references or report data. Nothing was saved. Please retry.',
      'interpret.changed': 'The transcript or interpretation changed. Close and reopen this panel before retrying.',
      'interpret.empty': 'No expressions requiring interpretation were found. Ordinary statements do not need invented subtext.',
      'interpret.literal': 'Literal reading',
      'interpret.possible': 'Possible meaning (inference)',
      'interpret.alternatives': 'Other explanations',
      'interpret.uncertainty': 'Uncertainty',
      'interpret.question': 'Clarifying question',
      'interpret.unknown': 'Cannot determine',
      'interpret.attribution': 'Overlapping speech or uncertain attribution: interpretation withheld.',
      'interpret.quote': 'Original words',
      'interpret.context': 'View adjacent source text',
      'interpret.before': 'Before',
      'interpret.after': 'After',
      'interpret.waiting': 'Analysis lists original words, possible readings, alternatives and clarifying questions, with up to eight entries.',
      'interpret.export': 'Export interpretation TXT',
      "check.title": "Meeting check (experimental)",
      "check.headline": "Meeting verbosity",
      "check.metric": "Compressible text share · model estimate",
      "check.score": "Approximately {n}% compressible text",
      "check.approx": "~{n}%",
      "check.waiting": "Not analyzed",
      "check.loading": "Loading",
      "check.analyzing": "Analyzing",
      "check.stale": "Analysis out of date",
      "check.unassessable": "Not assessable",
      "check.short": "At least 200 letters or numbers are required.",
      "check.tooLong": "Currently limited to 40,000 letters or numbers and 1,000 text units.",
      "check.pending": "Finish recording and retry missing transcription segments first.",
      "check.invalid": "Invalid analysis parameters.",
      "check.invalidResult": "Model annotations were incomplete or invalid. No result was saved. Try again.",
      "check.changed": "The transcript or analysis changed. Close and reopen this panel to refresh.",
      "check.model": "Select a model before analyzing.",
      "check.explanation": "Counts letters and numbers, excluding spaces and punctuation. Uncertain text is counted separately; no score is shown at 40% or more. This is not wasted meeting time.",
      "check.counts": "Compressible: {removed} / {total} characters; uncertain: {uncertain}%.",
      "check.topic": "Meeting topic (optional)",
      "check.language": "Analysis language",
      "check.topicHint": "Leave blank to skip off-topic judgments",
      "check.preview": "Preview full text to be sent ({n} letters/numbers)",
      "check.consent": "Send the full transcript ({n} letters/numbers) and the entered topic to {model} for analysis? The text may contain names or other private information.",
      "check.analyze": "Analyze",
      "check.regenerate": "Analyze again",
      "check.compact": "View compact text",
      "check.cancelled": "Analysis cancelled.",
      "check.locale": "en",
      "check.categories": "Category breakdown",
      "check.repeat": "Repetition",
      "check.filler": "Filler",
      "check.offtopic": "Possibly off-topic",
      "check.uncertain": "Uncertain",
      "check.keep": "Keep",
      "check.all": "View annotations",
      "check.retain": "Keep this text",
      "check.undoRetain": "Restore model judgment",
      "check.modelUsed": "Model: {model} · Topic used: {topic}",
      "check.noTopic": "Not specified",
      "check.parentTime": "Replay the parent turn; timestamps are not sentence-level",
      "check.compactHint": "Keeps useful, uncertain and manually retained text in source order. Review against the original.",
      "check.emptyCompact": "No retained text. Review the annotations.",
      "check.noMatches": "No units in this category.",
      "meeting.installModel": "Import model file",
      "meeting.getModel": "Download model file",
      "meeting.installingModel": "Verifying model file…",
      "meeting.modelReady": "Model installed. Run speaker identification from the recording card.",
      "meeting.mode": "Multi-speaker meeting",
      "meeting.modeHint": "Identify speakers after recording or import. Up to 60 minutes.",
      "meeting.count": "Number of speakers",
      "meeting.auto": "Auto",
      "meeting.locale": "en",
      "meeting.action": "Identify speakers",
      "meeting.view": "Speaker transcript",
      "meeting.again": "Identify speakers again",
      "meeting.replace": "Replace this speaker transcript and its corrections? The original transcript and audio will be kept.",
      "meeting.download": "Download {size} of model files from GitHub? Audio is processed locally.",
      "meeting.downloading": "Downloading speaker model…",
      "meeting.decoding": "Decoding recording…",
      "meeting.processing": "Identifying speakers and transcribing locally…",
      "meeting.ready": "Speaker transcript saved.",
      "meeting.cancelled": "Cancelled. Audio and existing transcripts were kept.",
      "meeting.downloadFailed": "Model download failed. Try again.",
      "meeting.integrity": "Model verification failed. Reinstall the plugin or retry the download.",
      "meeting.cachePermissions": "The speaker model directory permissions are invalid.",
      "meeting.analysisFailed": "Speaker analysis failed. Audio and the original transcript were kept.",
      "meeting.transcriptionFailed": "Local transcription failed. Try again.",
      "meeting.prepare": "The model is unavailable. Run speaker identification again.",
      "meeting.unsupported": "This Harness installation lacks a compatible speaker runtime.",
      "meeting.unavailable": "The recording changed. Refresh and try again.",
      "meeting.tooLong": "Speaker transcription supports recordings up to 60 minutes and 128 MiB.",
      "meeting.tooMany": "Too many speakers were detected. Set a speaker count and try again.",
      "meeting.invalid": "Recording parameters do not match the source audio.",
      "meeting.timeout": "Speaker transcription timed out. Try again.",
      "meeting.noSpeech": "No speech could be transcribed.",
      "meeting.speaker": "Speaker {n}",
      "meeting.unknown": "Unknown speaker",
      "meeting.overlap": "Overlapping speech — review",
      "meeting.rename": "Edit speaker names",
      "meeting.assign": "Speaker",
      "meeting.export": "Export speaker transcript",
      "meeting.emptyTurn": "No text recognized. Replay to review.",
      "meeting.reportStale": "The transcript changed. Generate the report again.",
      "report.kind": "Report template",
      "report.kind.auto": "By audio source",
      "report.kind.meeting": "Meeting notes",
      "report.kind.learning": "Learning notes",
      "report.pending": "Retry missing transcript segments before generating a report.",
      "system.noSamples": "Computer audio stopped. Saved {seconds} seconds.",
      "meeting.hint": "Replay from a timestamp. Labels can be wrong with crosstalk, short turns, or similar voices.",
      dictate: 'Voice input (live transcription)',
      'phase.requesting': 'Requesting microphone…',
      'phase.recording': 'Listening',
      'phase.finishing': 'Finishing transcript…',
      'phase.ready': 'Speech model ready',
      'bar.stop': 'Stop and keep transcript',
      'bar.cancel': 'Cancel recording',
      'bar.translate': 'Live translation',
      'bar.translateOn': 'Translation is on; finished phrases are translated',
      'translate.off': 'No translation',
      'translate.title': 'Translate to',
      'translate.enable': 'Translate',
      'translate.auto': 'Auto',
      'language.title': 'Recognition language',
      'language.hint': 'Used for on-device recognition. Model editing is a separate option.',
      'bar.elapsed': '{time}',
      'bar.retry': 'Record again',
      'bar.close': 'Close',
      'live.empty': 'Speak and the words will appear here…',
      'live.hint': 'Pauses split phrases; recording continues in the background. Stop inserts the transcript.',
      'live.translating': 'Translating…',
      'live.translation': 'Translation',
      'setup.title': 'Set up local speech recognition',
      'setup.body':
        'SenseVoiceSmall runs on this machine; audio never leaves it. The first use downloads the model (about {size}).',
      'setup.download': 'Download and prepare',
      'setup.later': 'Later',
      'setup.cancel': 'Cancel download',
      'setup.preparing': 'Preparing the model…',
      'setup.ready': 'The model is ready. You can start recording.',
      'setup.start': 'Start recording',
      'setup.failed': 'Preparation failed: {message}',
      'setup.retry': 'Retry',
      'setup.source': 'Download source',
      'setup.sourceAuto': 'Automatic',
      'setup.disk': 'About {size} on disk',
      'setup.step.check': 'Checking cache',
      'setup.step.model': 'Downloading model',
      'setup.step.vad': 'Downloading VAD',
      'setup.step.verify': 'Verifying files',
      'setup.step.load': 'Loading model',
      'setup.unavailable': 'Speech service is not connected. Make sure the voice plugin is enabled.',
      'result.title': 'Transcript ready',
      'result.empty': 'No speech was recognized',
      'result.insert': 'Insert into draft',
      'result.insertTranslation': 'Insert translation',
      'result.insertBoth': 'Insert both',
      'result.copy': 'Copy',
      'result.discard': 'Close',
      'result.copied': 'Copied',
      'error.title': 'Voice input failed',
      'error.retry': 'Retry',
      'error.close': 'Close',
      'error.blocked': 'Microphone access was denied. In your system privacy settings, allow microphone access for DeepSeek Harness or desktop apps.',
      'error.unavailable': 'Recording is unavailable in this environment.',
      'error.nodevice': 'No microphone was found.',
      'error.empty': 'No audio was captured.',
      'error.tooLong': 'Recording is too long and was stopped.',
      'studio.title': 'Voice Notes · Audio Transcription',
      'import.open': 'Import audio file',
      'import.formats': 'MP3, WAV, M4A, FLAC, OGG, Opus and WebM. Up to 128 MiB and 2 hours per file.',
      'import.invalid': 'Choose a supported audio file.',
      'import.tooLarge': 'The file exceeds 128 MiB or 2 hours.',
      'import.decodeFailed': 'This audio file could not be decoded. Check that it plays and uses a supported format.',
      'import.prepare': 'Download and prepare the local speech model before importing audio.',
      'import.reading': 'Reading audio…',
      'import.saving': 'Saving audio…',
      'import.progress': 'Transcribing {done}/{total}',
      'import.ready': 'Saved to recording history',
      'import.partial': 'Audio saved. Retry {n} segments in recording history.',
      'import.retranscribe': 'Transcribe audio again',
      'import.retranscribeHint': 'Create a separate history entry so you can compare it with the original transcript.',
      'import.copyTitle': '{title} (new transcription)',
      'report.auto': 'Follow transcript language',
      'report.language': 'Report language',
      'report.generate': 'Generate summary report',
      'report.send': 'Send the transcript for this recording to {model} to generate a report.',
      'history.searchThis': 'Search this transcript',
      'history.searchCount': '{n} matching segments',
      'history.foldTranscript': 'Collapse transcript',
      'history.tools': 'More actions',
      'history.refreshing': 'Refreshing…',
      'history.refreshed': 'Refreshed · {n} recordings',
      'history.refreshError': 'Refresh failed: {message}',
      'history.report': 'Summary report',
      'share.transcript': 'Share to new conversation',
      'share.selection': 'Share selected text to new conversation',
      'share.preparing': 'Opening a new conversation…',
      'share.unavailable': 'Could not open a new conversation. Try again.',
      'share.workspaceRequired': 'Add a workspace in Harness before sharing a transcript.',
      'share.intro': 'The transcript below is from “{title}”. Use it as reference material when answering my question.',
      'share.selectedIntro': 'The excerpt below was selected from a recording transcript. Use it as reference material when explaining or analyzing my question.',
      'share.question': 'My question or analysis request:',
      'update.check': 'Check for updates',
      'update.checking': 'Checking for updates…',
      'update.current': 'Up to date',
      'update.available': 'Version v{version} is available',
      'update.install': 'Update now',
      'update.installing': 'Downloading, verifying and installing the update…',
      'update.restart': 'v{version} installed. Restart Harness to apply it.',
      'update.installed': 'v{version} installed.',
      'update.busy': 'Wait for recording, import or transcription to finish before updating.',
      'update.unsupported': 'One-click updates are unavailable in this Harness configuration.',
      'update.incompatible': 'The update is incompatible with this version of Harness.',
      'update.changed': 'The published version changed. Check again.',
      'update.checkFailed': 'Could not check for updates. Try again later.',
      'update.downloadFailed': 'Could not download the package. Try again later.',
      'update.unverified': 'Package verification failed. The update was stopped.',
      'update.installFailed': 'The update did not complete. Check its status on the Harness Plugins page.',
      'update.releases': 'View releases',
      'studio.subtitle': 'On-device recognition · recordings are archived automatically',
      'studio.record': 'Start recording',
      'studio.stop': 'Stop and save',
      'studio.cancel': 'Cancel',
      'studio.again': 'Record again',
      'studio.close': 'Close',
      'studio.saved': 'Saved to recording history',
      'studio.saveFailed': 'Could not save the recording: {message}',
      'studio.history': 'Recording history',
      'studio.count': '{n} items',
      'studio.refresh': 'Refresh',
      'studio.path': 'Saved in',
      'studio.copyPath': 'Copy path',
      'studio.loading': 'Loading recordings…',
      'studio.empty': 'No recordings yet. Start with the microphone above.',
      'studio.noAudio': 'No audio',
      'studio.noText': '(no transcript)',
      'studio.copy': 'Copy text',
      'studio.copied': 'Copied',
      'studio.download': 'Download audio',
      'studio.delete': 'Delete',
      'studio.confirmDelete': 'Delete this recording and its audio?',
      'studio.expand': 'Expand',
      'studio.collapse': 'Collapse',
      'studio.retry': 'Retry',
      'studio.model': 'Speech model',
      'studio.ready': 'Ready',
      'studio.preparing': 'Preparing',
      'studio.unprepared': 'Download needed',
      'studio.historyEmpty': 'History is empty',
      'studio.report': 'Generate report',
      'studio.reportHint': 'Generated by the default model after recording',
      'studio.generating': 'Writing the meeting report…',
      'studio.generate': 'Generate meeting report',
      'studio.copyReport': 'Copy report',
      'studio.reportFailed': '{message}',
      'studio.hint': 'Audio is saved as you record. After stopping, view the transcript here or listen in History.',
      'history.search': 'Search titles, transcripts or reports',
      'history.noMatch': 'No matching recordings.',
      'history.more': 'Next page',
      'history.previous': 'Previous page',
      'history.details': 'Transcript and timestamps',
      'history.fullText': 'View transcript',
      'history.rename': 'Rename',
      'history.title': 'Recording title',
      'history.save': 'Save',
      'history.active': 'Recording',
      'history.interrupted': 'Recording interrupted. Saved content is available.',
      'history.pending': '{n} segments awaiting transcription',
      'history.retrySegment': 'Retry segment',
      'history.retrying': 'Transcribing…',
      'history.emptySegment': 'No speech recognized',
      'history.derivedStale': 'The transcript was updated. Existing edits, translations or reports may be missing recovered text.',
      'archive.noRecorder': 'Audio cannot be archived in this environment. The transcript will still be saved.',
      'archive.captureInterrupted': 'The microphone or recorder disconnected. Captured content is being saved.',
      'archive.segmentFailed': 'Segment transcription failed',
      'archive.segmentWrites': 'Some segments have not been saved',
      'archive.retrySave': 'Retry saving',
      'archive.saving': 'Saving…',
      'archive.pending': '{n} segments still need transcription. Retry them in Voice Notes → Recording history.',
      'model.edit': 'Model editing',
      'model.edited': 'Edited transcript',
      'model.editing': 'Editing transcript…',
      'model.editError': 'Could not edit the transcript: {message}',
      'model.disclose': 'Editing, translation and reports send transcript text to {provider}. Audio stays on this device.',
      'model.unavailable': 'A default model is needed for editing, translation and reports.',
      'result.insertEdited': 'Insert edited transcript',
      'recording.live': 'Recording',
      'recording.stop': 'Stop',
      'recording.open': 'Open Voice Notes',
      'recording.stopping': 'Stopping recording…',
      'recording.finishingDraft': 'Finishing dictation…',
      'recording.saving': 'Microphone off · Saving',
      'recording.processing': 'Transcribing {n} segments',
      'recording.savedProcessing': 'Recording saved · Transcribing {n} segments',
      'recording.saved': 'Recording saved',
      'recording.saveFailed': 'Could not save the full recording',
      'recording.draft': 'Insert into draft only',
      'recording.ready': 'Dictation ready',
      'recording.inserted': 'Inserted into draft',
      'recording.insertedSaved': 'Inserted into draft · Recording saved',
      'recording.originalDraft': 'Return to the conversation where you started to insert the draft, or copy the text.',
      'recording.options': 'Translation, editing and reports',
      'recording.dictationSettings': 'Chat dictation preferences',
      'recording.dictationHistory': 'Also save to recording history',
      'recording.dictationHint': 'Draft-only dictation keeps audio and transcripts out of recording history.',
      'shortcut.label': 'Start or stop dictation',
      'shortcut.off': 'Shortcut off',
      'shortcut.hint': 'The shortcut works inside the Harness window.',
      'archive.localPending': '{n} segments failed. You can retry them here.',
      'archive.retryLocal': 'Retry failed segments',
      'history.jump': 'Go to matched segment',
      'history.nextMatch': 'Next match',
      'history.correct': 'Correct',
      'history.correction': 'Corrected transcript',
      'history.original': 'Original transcript',
      'history.restore': 'Restore original',
      'history.exportOriginal': 'Download original transcript',
      'history.exportCorrected': 'Download corrected transcript',
    };

    const CSS = `
.vl-root { display: flex; align-items: center; min-width: 0; }
.vl-trigger { display: inline-flex; flex: none; align-items: center; justify-content: center; width: 30px; height: 30px; padding: 0; border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.1)); border-radius: 999px; background: transparent; color: var(--dsw-alias-label-secondary, #666); cursor: pointer; transition: background .12s ease, color .12s ease, border-color .12s ease; }
.vl-trigger:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,.05)); color: var(--dsw-alias-label-primary, #111); }
.vl-trigger:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #4d6bfe); outline-offset: 1px; }
.vl-trigger:disabled { opacity: .45; cursor: default; }
.vl-trigger[data-recording="true"] { border-color: transparent; background: var(--dsw-alias-state-error-primary, #e5484d); color: #fff; }
.vl-bar { display: flex; flex: 1; flex-wrap: wrap; align-items: center; gap: 8px; row-gap: 4px; min-width: 0; }
.vl-round { display: inline-flex; flex: none; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 999px; background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,.05)); color: var(--dsw-alias-label-secondary, #666); cursor: pointer; }
.vl-round:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-3, rgba(0,0,0,.08)); color: var(--dsw-alias-label-primary, #111); }
.vl-round[data-danger="true"] { background: var(--dsw-alias-state-error-primary, #e5484d); color: #fff; }
.vl-round:disabled { opacity: .45; cursor: default; }
.vl-wave { display: inline-flex; flex: none; align-items: center; gap: 2px; width: 46px; height: 20px; }
.vl-wave i { display: block; width: 2px; min-height: 3px; border-radius: 2px; background: var(--dsw-alias-state-error-primary, #e5484d); transform-origin: center; transition: height .08s linear; }
.vl-timer { flex: none; font-variant-numeric: tabular-nums; font-size: 12px; color: var(--dsw-alias-label-secondary, #666); }
.vl-status { display: inline-flex; align-items: center; gap: 6px; min-width: 0; font-size: 12.5px; color: var(--dsw-alias-label-secondary, #666); }
.vl-status span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vl-pulse { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-state-error-primary, #e5484d); animation: vl-pulse 1.1s ease-in-out infinite; }
@keyframes vl-pulse { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: .35; transform: scale(.72); } }
.vl-spin { flex: none; width: 13px; height: 13px; border: 1.6px solid var(--dsw-alias-border-l2, rgba(0,0,0,.15)); border-top-color: var(--dsw-alias-brand-primary, #4d6bfe); border-radius: 50%; animation: vl-rotate .8s linear infinite; }
@keyframes vl-rotate { to { transform: rotate(360deg); } }
.vl-toggle { display: inline-flex; flex: none; align-items: center; gap: 5px; height: 26px; padding: 0 9px; border: 1px solid transparent; border-radius: 999px; background: transparent; color: var(--dsw-alias-label-secondary, #666); font: inherit; font-size: 12px; cursor: pointer; }
.vl-toggle:hover { background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,.05)); color: var(--dsw-alias-label-primary, #111); }
.vl-toggle[aria-pressed="true"] { border-color: var(--dsw-alias-border-l1, rgba(0,0,0,.12)); background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,.06)); color: var(--dsw-alias-brand-primary, #4d6bfe); }
.vl-overlay { position: absolute; left: 0; right: 0; bottom: 100%; z-index: 30; display: flex; justify-content: center; padding: 0 8px 8px; pointer-events: none; }
.vl-panel { box-sizing: border-box; width: 100%; max-width: var(--dsh-composer-card-max-width, 760px); max-height: min(38vh, 300px); display: flex; flex-direction: column; gap: 10px; padding: 13px 15px 12px; border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.1)); border-radius: 14px; background: var(--dsw-alias-bg-layer-1, #fff); box-shadow: 0 12px 36px -12px rgba(0,0,0,.28), 0 2px 10px -2px rgba(0,0,0,.12); color: var(--dsw-alias-label-primary, #111); pointer-events: auto; animation: vl-in .16s ease-out; }
@keyframes vl-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
.vl-head { display: flex; align-items: center; gap: 8px; min-height: 20px; }
.vl-title { font-size: 12.5px; font-weight: 600; letter-spacing: .01em; }
.vl-sub { font-size: 11.5px; color: var(--dsw-alias-label-tertiary, #888); }
.vl-body { flex: 1; min-height: 0; overflow-y: auto; scrollbar-width: thin; }
.vl-text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14.5px; line-height: 1.55; user-select: text; }
.vl-text[data-empty="true"] { color: var(--dsw-alias-label-caption, #999); }
.vl-partial { color: var(--dsw-alias-label-secondary, #777); }
.vl-translation { margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--dsw-alias-border-l1, rgba(0,0,0,.1)); }
.vl-label { display: inline-flex; align-items: center; gap: 5px; margin-bottom: 3px; font-size: 10.5px; font-weight: 600; letter-spacing: .05em; color: var(--dsw-alias-label-tertiary, #888); text-transform: uppercase; }
.vl-label b { padding: 0 4px; border-radius: 4px; background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,.06)); font-size: 9.5px; }
.vl-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; }
.vl-actions .vl-grow { flex: 1; }
.vl-btn { display: inline-flex; align-items: center; justify-content: center; gap: 5px; height: 28px; padding: 0 11px; border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.12)); border-radius: 8px; background: transparent; color: var(--dsw-alias-label-primary, #111); font: inherit; font-size: 12px; cursor: pointer; }
.vl-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,.05)); }
.vl-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #4d6bfe); outline-offset: 1px; }
.vl-btn:disabled { opacity: .5; cursor: default; }
.vl-btn[data-primary="true"] { border-color: transparent; background: var(--dsw-alias-button-info-fill, #4d6bfe); color: #fff; }
.vl-btn[data-primary="true"]:hover:not(:disabled) { background: var(--dsw-alias-button-info-hover, #3b57d6); }
.vl-btn[data-quiet="true"] { border-color: transparent; color: var(--dsw-alias-label-secondary, #666); }
.vl-error { color: var(--dsw-alias-state-error-primary, #d93036); font-size: 12px; }
.vl-note { font-size: 11.5px; line-height: 17px; color: var(--dsw-alias-label-secondary, #666); }
.vl-note[data-tone="error"] { color: var(--dsw-alias-state-error-primary, #d93036); }
.vl-progress { width: 100%; height: 4px; overflow: hidden; border-radius: 999px; background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,.08)); }
.vl-progress i { display: block; height: 100%; border-radius: inherit; background: var(--dsw-alias-brand-primary, #4d6bfe); transition: width .3s ease; }
.vl-progress[data-indeterminate="true"] i { width: 38% !important; animation: vl-slide 1.2s ease-in-out infinite; }
@keyframes vl-slide { 0% { transform: translateX(-110%); } 100% { transform: translateX(280%); } }
.vl-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.vl-source { flex: none; width: auto; max-width: 108px; height: 26px; padding: 0 18px 0 6px; font-size: 11.5px; }
.vl-target { flex: none; width: auto; max-width: 118px; height: 26px; padding: 0 18px 0 6px; font-size: 11.5px; }
.vl-select { height: 27px; max-width: 240px; padding: 0 6px; border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.12)); border-radius: 7px; background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-primary, #111); font: inherit; font-size: 11.5px; }
.vl-translation-text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13.5px; line-height: 1.55; color: var(--dsw-alias-label-secondary, #555); user-select: text; }
.vl-sep { flex: 1; }
@media (prefers-reduced-motion: reduce) { .vl-pulse, .vl-spin, .vl-progress[data-indeterminate="true"] i, .vl-panel { animation: none; } }
.vls-page { height: 100%; overflow-y: auto; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 14px; }
.vls-inner { max-width: 880px; margin: 0 auto; padding: 28px 30px 48px; }
.vls-head { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 16px; }
.vls-title { margin: 0; font-size: 21px; font-weight: 600; letter-spacing: -0.02em; line-height: 1.25; }
.vls-sub { margin: 5px 0 0; font-size: 12.5px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
.vls-head-actions { display: flex; align-items: center; gap: 6px; margin-left: auto; }
.vls-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 16px; background: var(--dsw-alias-bg-layer-1); padding: 16px 16px 14px; }
.vls-rec { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.vls-mic { display: inline-flex; flex: none; align-items: center; justify-content: center; width: 54px; height: 54px; padding: 0; border: 0; border-radius: 50%; background: var(--dsw-alias-button-info-fill); color: #fff; cursor: pointer; box-shadow: 0 6px 18px -8px rgba(0,0,0,.35); transition: background .15s ease, transform .12s ease; }
.vls-mic:hover:not(:disabled) { background: var(--dsw-alias-button-info-hover); transform: translateY(-1px); }
.vls-mic:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 3px; }
.vls-mic:disabled { opacity: .5; cursor: default; }
.vls-mic[data-recording="true"] { background: var(--dsw-alias-state-error-primary); }
.vls-mic[data-recording="true"]:hover { background: var(--dsw-alias-state-error-primary); }
.vls-rec-main { min-width: 0; }
.vls-time { font-size: 24px; font-weight: 600; font-variant-numeric: tabular-nums; letter-spacing: .01em; line-height: 1.1; }
.vls-rec-state { display: flex; align-items: center; gap: 6px; margin-top: 4px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.vls-lang { display: inline-flex; align-items: center; gap: 5px; min-width: 0; }
.vls-lang .vl-label { margin: 0; }
.vl-translate-control { display: inline-flex; align-items: center; gap: 4px; }
.vl-check { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); cursor: pointer; white-space: nowrap; }
.vl-check input { margin: 0; accent-color: var(--dsw-alias-brand-primary); }
.vls-rec-side { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; margin-left: auto; }
.vls-live { margin-top: 14px; padding-top: 13px; border-top: 1px solid var(--dsw-alias-border-l1); }
.vls-live-text { margin: 0; max-height: 240px; overflow-y: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 15px; line-height: 1.6; user-select: text; }
.vls-live-text[data-empty="true"] { color: var(--dsw-alias-label-caption); }
.vls-live-translation { margin-top: 10px; padding-top: 9px; border-top: 1px dashed var(--dsw-alias-border-l1); }
.vls-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 12px; }
.vls-actions .vl-grow { flex: 1; }
.vls-save { display: flex; align-items: center; gap: 6px; margin-top: 10px; font-size: 11.5px; color: var(--dsw-alias-state-success-primary); }
.vls-save[data-error="true"] { color: var(--dsw-alias-state-error-primary); }
.vls-setup { margin-top: 14px; padding-top: 13px; border-top: 1px solid var(--dsw-alias-border-l1); }
.vls-history { margin-top: 26px; }
.vls-history-head { display: flex; align-items: baseline; gap: 8px; }
.vls-title2 { margin: 0; font-size: 15px; font-weight: 600; }
.vls-count { font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.vls-history-actions { display: flex; align-items: center; gap: 6px; min-width: 0; margin-left: auto; }
.vls-history-actions .vls-search { min-width: 0; }
.vls-history-actions .vls-mini { flex: none; white-space: nowrap; }
.vls-update { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; margin-top: 5px; }
.vls-update [role="alert"] { color: var(--dsw-alias-state-error-primary); }
.vls-path { display: flex; align-items: center; gap: 6px; min-width: 0; margin: 8px 0 12px; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.vls-path code { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10.5px; }
.vls-list { display: flex; flex-direction: column; gap: 10px; margin: 0; padding: 0; list-style: none; }
.vls-item { border: 1px solid var(--dsw-alias-border-l1); border-radius: 13px; background: var(--dsw-alias-bg-layer-1); padding: 12px 14px 11px; }
.vls-item-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.vls-item-title { flex: 1 1 140px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.vls-item-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.vls-history-actions-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 8px; }
.vls-history-actions-row [data-primary="true"] { color: var(--dsw-alias-brand-primary, #3267d6); }
.vls-item-tools { width: 100%; }
.vls-item-tools summary { width: fit-content; cursor: pointer; }
.vls-transcript-open { max-height: min(400px, 62vh); overflow: auto; overscroll-behavior: contain; margin-block: 8px; padding-inline: 6px; }
.vls-transcript-open:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #3267d6); }
.vls-share-selection { position: fixed; z-index: 999; transform: translateX(-50%); padding: 3px; border-radius: 8px; background: var(--dsw-alias-bg-layer-1, #fff); border: 1px solid var(--dsw-alias-border-l1, #ccc); box-shadow: 0 4px 16px #0002; white-space: nowrap; }
.vls-share-selection .vls-mini { color: var(--dsw-alias-label-primary, #111); }
[data-vls-transcript] { user-select: text; }
.vls-mini { display: inline-flex; align-items: center; justify-content: center; height: 24px; padding: 0 7px; border: 1px solid transparent; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 11px; text-decoration: none; cursor: pointer; }
.vls-mini:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.vls-mini[data-danger="true"]:hover { color: var(--dsw-alias-state-error-primary); }
.vls-item-text { display: -webkit-box; margin: 8px 0 0; overflow: hidden; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13.5px; line-height: 1.55; user-select: text; -webkit-box-orient: vertical; -webkit-line-clamp: 3; }
.vls-item-text[data-open="true"] { display: block; -webkit-line-clamp: unset; }
.vls-item-text[data-empty="true"] { color: var(--dsw-alias-label-caption); }
.vls-report-summary { cursor: pointer; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.vls-report-block { margin-top: 10px; padding-top: 9px; border-top: 1px dashed var(--dsw-alias-border-l1); }
.vls-report-text { margin: 8px 0; max-height: 300px; overflow: auto; padding: 9px 10px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2); white-space: pre-wrap; overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; line-height: 1.55; color: var(--dsw-alias-label-primary); user-select: text; }
.vls-trans-text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13.5px; line-height: 1.55; color: var(--dsw-alias-label-secondary); user-select: text; }
.vls-item-trans { margin: 7px 0 0; padding-top: 7px; border-top: 1px dashed var(--dsw-alias-border-l1); font-size: 12.5px; line-height: 1.55; color: var(--dsw-alias-label-secondary); white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
.vls-more { padding: 2px 0 0; border: 0; background: none; color: var(--dsw-alias-brand-primary); font: inherit; font-size: 11px; cursor: pointer; }
.vls-audio { width: 100%; height: 32px; margin-top: 10px; }
.vls-empty { padding: 30px 20px; border: 1px dashed var(--dsw-alias-border-l1); border-radius: 12px; text-align: center; font-size: 12.5px; color: var(--dsw-alias-label-secondary); }
.vls-error { margin: 8px 0; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); font-size: 12px; line-height: 1.5; color: var(--dsw-alias-state-error-primary); word-break: break-word; }
.vls-loading { display: flex; align-items: center; gap: 8px; padding: 16px; font-size: 12.5px; color: var(--dsw-alias-label-secondary); }
.vls-input { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1, #aaa); border-radius: 6px; color: inherit; font: inherit; padding: 5px 8px; }
.vls-search { width: min(100%, 260px); }
.vls-check { display: grid; gap: 10px; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--dsw-alias-border-l1); }
.vls-check h3 { margin: 0; font-size: 14px; }
.vls-check-overview { display: grid; grid-template-columns: minmax(180px, 240px) minmax(120px, 1fr); gap: 16px; align-items: center; }
.vls-check-gauge { max-width: 240px; color: var(--dsw-alias-label-primary); }
.vls-check-gauge svg { width: 100%; display: block; }
.vls-check-unit { border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 10px; }
.vls-check-unit blockquote { white-space: pre-wrap; overflow-wrap: anywhere; margin: 8px 0; }
.vls-check-evidence { max-height: 420px; overflow: auto; }
.vls-interpretation dl { margin: 12px 0 0; overflow-wrap: anywhere; }
.vls-interpretation dt { margin-top: 10px; font-weight: 600; font-size: 12px; }
.vls-interpretation dd { margin: 4px 0 0; white-space: pre-wrap; }
.vls-interpretation dd ul { margin: 4px 0; padding-left: 20px; }
.vls-interpretation .vls-check-unit { min-width: 0; }
.vls-interpretation > .vl-note { margin: 0; }
.vls-check .vls-mini[aria-pressed="true"] { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); text-decoration: underline; }
@media (max-width: 600px) { .vls-check-overview { grid-template-columns: 1fr; } }
.vls-meeting { display: grid; gap: 8px; margin: 8px 0; }
.vls-segments { display: grid; gap: 6px; padding: 0; margin: 8px 0; list-style: none; }
.vls-segment { display: flex; flex-wrap: wrap; align-items: baseline; gap: 7px; padding: 5px 0; border-bottom: 1px solid var(--dsw-alias-border-l1, #ddd); }
.vls-segment-text { flex: 1 1 14rem; white-space: pre-wrap; }
.vls-segment time, .vls-seek { font-variant-numeric: tabular-nums; }
.vls-morepage { margin-top: 12px; }
.vl-global { -webkit-app-region: no-drag; position: fixed; inset: 10px auto auto 50%; translate: -50% 0; z-index: 40; display: flex; align-items: center; gap: 8px; max-width: calc(100vw - 24px); padding: 5px 7px 5px 10px; border: 1px solid var(--dsw-alias-border-l1, #bbb); border-radius: 9px; background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-primary, #111); box-shadow: 0 3px 12px #0002; font: 600 12px/1.4 system-ui, sans-serif; }
.vl-global[hidden], .vl-global [hidden] { display: none; }
.vl-global-time { font-variant-numeric: tabular-nums; white-space: nowrap; }
.vl-global .vl-btn { padding: 3px 7px; white-space: nowrap; }
.vls-options { margin-top: 9px; }
.vls-options summary { color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: 12px; }
.vls-options-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin-top: 9px; }
.vls-segment[aria-current="true"] { background: var(--dsw-alias-brand-primary-soft, color-mix(in srgb, var(--dsw-alias-brand-primary, #456df2) 13%, transparent)); border-radius: 6px; }
.vls-segment, .vls-item-text { scroll-margin-block: 4rem; }
.vls-segment mark, .vls-item-text mark { background: #fae199; color: #251900; }
.vls-correct { flex-basis: 100%; display: grid; gap: 6px; }
.vls-correct textarea { resize: vertical; width: 100%; box-sizing: border-box; }
.vls-foot { margin-top: 18px; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
@media (max-width: 640px) { .vls-inner { padding: 18px 16px 36px; } .vls-rec-side { margin-left: 0; } }
`;

    /** Tiny external store: the activity bar and the floating panel share it. */
    function createStore(initial) {
      let state = initial;
      const listeners = new Set();
      return {
        get: () => state,
        set(patch) {
          const next = typeof patch === 'function' ? patch(state) : { ...state, ...patch };
          if (next === state) return;
          state = next;
          for (const listener of [...listeners]) listener();
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
    }

    function readPrefs() {
      try {
        const value = JSON.parse(window.localStorage.getItem('voice-live:prefs') ?? '{}');
        return value && typeof value === 'object' ? value : {};
      } catch {
        return {};
      }
    }

    function savePrefs(patch) {
      try {
        const current = readPrefs();
        window.localStorage.setItem('voice-live:prefs', JSON.stringify({ ...current, ...patch }));
      } catch {
        /* storage unavailable */
      }
    }

    const prefs = readPrefs();
    const savedModelPermission = typeof prefs.modelPermission === 'string' ? prefs.modelPermission : '';
    const savedTarget = savedModelPermission && TARGETS.some(([id]) => id === prefs.targetLanguage)
      ? prefs.targetLanguage
      : 'off';
    const savedSource = SOURCE_LANGUAGES.some(([id]) => id === prefs.sourceLanguage)
      ? prefs.sourceLanguage
      : 'auto';
    const initialState = {
      phase: 'idle',
      surface: 'composer',
      archiveError: '',
      lastRecording: null,
      historyVersion: 0,
      report: '',
      reporting: false,
      reportError: '',
      reportMode: Boolean(savedModelPermission) && prefs.reportMode === true,
      modelPermission: savedModelPermission,
      dictationHistory: prefs.dictationHistory === true,
      shortcut: SHORTCUTS.some(([code]) => code === prefs.shortcut) ? prefs.shortcut : 'off',
      archiveStage: '',
      transcribingSegments: 0,
      savedNotice: '',
      importing: false,
      meetingMode: false,
      meetingSpeakers: 0,
      meetingJob: null,
      updating: false,
      importNotice: '',
      importError: '',
      reportKind: ['meeting', 'learning'].includes(prefs.reportKind) ? prefs.reportKind : 'auto',
      reportLanguage: REPORT_LANGUAGES.some(([code]) => code === prefs.reportLanguage) ? prefs.reportLanguage : 'auto',
      targetLanguage: savedTarget,
      sourceLanguage: savedSource,
      captureSource: 'microphone',
      translate: savedTarget !== 'off',
      editMode: Boolean(savedModelPermission) && prefs.editMode === true,
      editedText: '',
      editError: '',
      editing: false,
      pendingSegments: 0,
      captureWarning: '',
      retrySaving: false,
      status: null,
      statusError: '',
      providerId: '',
      preparing: false,
      prepareError: '',
      downloadSource: '',
      setupOpen: false,
      elapsed: 0,
      level: 0,
      finalText: '',
      partialText: '',
      translationText: '',
      translationLabel: '译',
      translating: false,
      translateError: '',
      result: null,
      error: '',
      notice: '',
      copied: false,
    };

    const store = createStore(initialState);

    const engine = {
      sessionId: undefined,
      generation: 0,
      beginSeq: 0,
      inputActions: null,
      activeComposer: null,
      capture: null,
      segment: null,
      segmentSeq: 0,
      timers: [],
      prepareTimer: undefined,
      partialBusy: false,
      finalChain: Promise.resolve(),
      insertSpan: null,
      startedAt: 0,
      lastVoiceAt: 0,
      hasSpeech: false,
      lastPartialAt: 0,
      level: 0,
      lastLevelUi: 0,
      abort: undefined,
      audio: null,
      run: null,
      pcmSamples: 0,
      noticeTimer: undefined,
      meetingAbort: null,
    };

    let localeBound;
    let transcriptSharing;
    const messageOf = (error) =>
      error instanceof Error ? error.message : String(error ?? '未知错误');

    /** Locale fallback for slots that do not inject `t` (the main panel). */
    function translate(key, vars) {
      let value = localeBound ? localeBound(key) : undefined;
      if (!value || value === key) value = ZH[key] || EN[key] || key;
      if (vars) {
        for (const [name, replacement] of Object.entries(vars)) {
          value = value.replaceAll(`{${name}}`, () => String(replacement));
        }
      }
      return value;
    }

    function resetSessionState() {
      if (engine.run && !engine.run.id) {
        engine.run.segmentFailures.clear();
        engine.run.localTexts.clear();
      }
      store.set({
        elapsed: 0,
        level: 0,
        finalText: '',
        editedText: '',
        editing: false,
        editError: '',
        pendingSegments: 0,
        captureWarning: '',
        retrySaving: false,
        archiveStage: '',
        transcribingSegments: 0,
        savedNotice: '',
        partialText: '',
        translationText: '',
        translationLabel: '译',
        translating: false,
        translateError: '',
        result: null,
        error: '',
        notice: '',
        copied: false,
        surface: 'composer',
        archiveError: '',
        lastRecording: null,
        report: '',
        reporting: false,
        reportError: '',
      });
    }

    function newSegment() {
      return { id: engine.segmentSeq++, start: engine.pcmSamples, samples: [], count: 0 };
    }

    function clearTimers() {
      for (const timer of engine.timers) clearInterval(timer);
      engine.timers = [];
    }

    function clearPrepareTimer() {
      if (engine.prepareTimer !== undefined) {
        clearInterval(engine.prepareTimer);
        engine.prepareTimer = undefined;
      }
    }

    function providerOf(status) {
      if (!status) return undefined;
      const id = status.selection?.providerId;
      return (status.providers ?? []).find((provider) => provider.id === id) ?? status.providers?.[0];
    }

    function isUsable(provider) {
      const phase = provider?.preparation?.phase;
      return phase === 'ready' || phase === 'standby';
    }

    async function readJsonResponse(response) {
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (!response.ok || !body || body.ok === false) {
        const message = body?.error?.message || `HTTP ${response.status}`;
        const error = new Error(message);
        error.code = body?.error?.code;
        throw error;
      }
      return body;
    }

    async function fetchStatus() {
      const response = await fetch(`${API}/status`, { cache: 'no-store' });
      const body = await readJsonResponse(response);
      const state = store.get();
      if (state.modelPermission && state.modelPermission !== modelKey(body.model) &&
          !['recording', 'finishing'].includes(state.phase)) {
        const choices = { modelPermission: '', editMode: false, reportMode: false, targetLanguage: 'off' };
        savePrefs(choices);
        store.set({ ...choices, translate: false });
      }
      store.set({ status: body, statusError: '' });
      return body;
    }

    /** Encode float samples as the canonical 16 kHz mono PCM16 WAV. */
    function encodeWave(chunks, sampleRate) {
      let total = 0;
      for (const chunk of chunks) total += chunk.length;
      const source = new Float32Array(total);
      let at = 0;
      for (const chunk of chunks) {
        source.set(chunk, at);
        at += chunk.length;
      }
      let samples;
      if (sampleRate === SAMPLE_RATE) {
        samples = source;
      } else {
        const ratio = SAMPLE_RATE / sampleRate;
        const length = Math.max(1, Math.floor(total * ratio));
        samples = new Float32Array(length);
        for (let index = 0; index < length; index += 1) {
          const position = index / ratio;
          const base = Math.floor(position);
          const fraction = position - base;
          const a = source[base] ?? 0;
          const b = base + 1 < total ? source[base + 1] : a;
          samples[index] = a + (b - a) * fraction;
        }
      }
      const bytes = new Uint8Array(44 + samples.length * 2);
      const view = new DataView(bytes.buffer);
      const ascii = (text, offset) => {
        for (let index = 0; index < text.length; index += 1) {
          bytes[offset + index] = text.charCodeAt(index);
        }
      };
      ascii('RIFF', 0);
      view.setUint32(4, bytes.length - 8, true);
      ascii('WAVE', 8);
      ascii('fmt ', 12);
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, SAMPLE_RATE, true);
      view.setUint32(28, SAMPLE_RATE * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      ascii('data', 36);
      view.setUint32(40, samples.length * 2, true);
      for (let index = 0; index < samples.length; index += 1) {
        const value = Math.max(-1, Math.min(1, samples[index]));
        view.setInt16(44 + index * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
      }
      return bytes;
    }

    function base64Of(bytes) {
      let text = '';
      for (let index = 0; index < bytes.length; index += 8192) {
        text += String.fromCharCode(...bytes.subarray(index, index + 8192));
      }
      return btoa(text);
    }

    async function request(path, { method = 'POST', json, bytes, timeout = bytes ? 8000 : 100_000 } = {}) {
      const response = await fetch(`${API}${path}`, {
        method,
        ...(json !== undefined ? {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(json),
        } : bytes !== undefined ? {
          headers: { 'content-type': 'application/octet-stream' },
          body: bytes,
        } : {}),
        signal: AbortSignal.timeout(timeout),
      });
      return readJsonResponse(response);
    }

    function archivePath(run) {
      return `/recordings/${run.id}`;
    }

    /** Retry idempotent writes when the host is temporarily unavailable. */
    async function writeArchive(path, options) {
      try {
        return await request(path, options);
      } catch {
        return request(path, options);
      }
    }

    function noteArchiveError(run, error) {
      if (engine.run === run) {
        store.set({ archiveError: `录音保存失败：${messageOf(error)}` });
      }
    }

    function pumpAudio(run) {
      if (run.audioPump) return run.audioPump;
      if (!run.audioQueue.length) return Promise.resolve();
      run.audioPump = (async () => {
        while (run.audioQueue.length) {
          const { sequence, bytes, duration } = run.audioQueue[0];
          await writeArchive(`${archivePath(run)}/chunks/${sequence}?duration=${duration}`, {
            method: 'PUT',
            bytes,
          });
          run.audioQueue.shift();
        }
      })().finally(() => { run.audioPump = null; });
      return run.audioPump;
    }

    function flushRecorder(capture) {
      return new Promise((resolve) => {
        const recorder = capture?.recorder;
        if (!recorder || recorder.state === 'inactive') {
          resolve();
          return;
        }
        const finish = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(finish, 2500);
        recorder.addEventListener('stop', finish, { once: true });
        try {
          recorder.stop();
        } catch {
          finish();
        }
      });
    }

    async function putSegment(run, segment, checkpoint = false) {
      const { id, wave, start, end } = segment;
      const query = new URLSearchParams({ start, end, checkpoint: checkpoint ? '1' : '0' });
      await writeArchive(`${archivePath(run)}/segments/${id}?${query}`, { method: 'PUT', bytes: wave });
    }

    function importedMime(file) {
      const extension = file.name?.split('.').at(-1)?.toLowerCase();
      return Object.hasOwn(AUDIO_FORMATS, extension) ? AUDIO_FORMATS[extension] : null;
    }

    async function analyzeMeeting(recording, speakers, decoded) {
      if (engine.meetingAbort) return;
      const controller = new AbortController();
      engine.meetingAbort = controller;
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(62 * 60_000)]);
      const update = (phase, error = false, active = true) => {
        store.set({ meetingJob: { id: recording.id, phase, error, active } });
      };
      const fail = (code) => {
        const error = new Error(translate(`meeting.${code}`));
        error.code = code;
        throw error;
      };
      const send = (path, options) => fetch(`${API}${path}`, { cache: 'no-store', signal, ...options })
        .then(readJsonResponse);
      try {
        if (!recording.audioUrl) fail('unavailable');
        if (recording.duration > MAX_MEETING_SECONDS + 1 || recording.size > MAX_IMPORT_BYTES) fail('tooLong');
        update('decoding');
        const models = await send('/meeting-models');
        if (!models.supported) fail('unsupported');
        if (!models.ready) {
          if (!window.confirm(translate('meeting.download', { size: formatBytes(models.bytes) }))) {
            update('cancelled', false, false);
            return;
          }
          update('downloading');
          await send('/meeting-models', { method: 'POST' });
        }
        update('decoding');
        if (!decoded) {
          const response = await fetch(recording.audioUrl, { cache: 'no-store', signal });
          if (!response.ok) fail('unavailable');
          const context = new OfflineAudioContext(1, 1, SAMPLE_RATE);
          try {
            decoded = await context.decodeAudioData(await response.arrayBuffer());
          } catch (error) {
            if (signal.aborted) throw error;
            throw new Error(translate('import.decodeFailed'));
          }
        }
        if (decoded.duration > MAX_MEETING_SECONDS) fail('tooLong');
        if (decoded.duration < 0.5) fail('noSpeech');
        const channels = Array.from({ length: decoded.numberOfChannels }, (_, i) => decoded.getChannelData(i));
        const size = SAMPLE_RATE * 10;
        const chunks = [];
        for (let start = 0; start < decoded.length; start += size) {
          const end = Math.min(start + size, decoded.length);
          const bytes = new Uint8Array((end - start) * 2);
          const view = new DataView(bytes.buffer);
          for (let offset = start; offset < end; offset++) {
            let value = 0;
            for (const channel of channels) value += channel[offset] / channels.length;
            value = Math.max(-1, Math.min(1, value));
            view.setInt16((offset - start) * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
          }
          chunks.push(bytes);
          if (chunks.length % 8 === 0) {
            await new Promise((resolve) => setTimeout(resolve, 0));
            signal.throwIfAborted();
          }
        }
        const params = new URLSearchParams({
          frames: String(decoded.length), speakers: String(speakers), revision: String(recording.meeting?.revision ?? 0),
        });
        update('processing');
        const result = await send(`${archivePath(recording)}/meeting?${params}`, {
          method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: new Blob(chunks),
        });
        update('ready', false, false);
        store.set((state) => ({ ...state, historyVersion: state.historyVersion + 1 }));
        return result.recording;
      } catch (error) {
        if (controller.signal.aborted) update('cancelled', false, false);
        else if (signal.aborted) update('timeout', true, false);
        else update(Object.hasOwn(EN, `meeting.${error.code}`) ? error.code : 'analysisFailed', true, false);
      } finally {
        engine.meetingAbort = null;
      }
    }

    async function importMeetingModel(file) {
      const job = store.get().meetingJob;
      if (!file || !job || engine.meetingAbort) return;
      const controller = new AbortController();
      engine.meetingAbort = controller;
      const setStatus = (phase, error, active = false) =>
        store.set({ meetingJob: { ...job, phase, error, active } });
      setStatus('installingModel', false, true);
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]);
        const status = await fetch(`${API}/meeting-models`, { signal, cache: 'no-store' }).then(readJsonResponse);
        if (file.size !== status.bytes) {
          setStatus('integrity', true);
          return;
        }
        await fetch(`${API}/meeting-models`, {
          method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: file, signal,
        }).then(readJsonResponse);
        setStatus('modelReady', false);
      } catch (error) {
        if (controller.signal.aborted) setStatus('cancelled', false);
        else setStatus(Object.hasOwn(EN, `meeting.${error.code}`) ? error.code : 'downloadFailed', true);
      } finally {
        engine.meetingAbort = null;
      }
    }

    function SpeakerCount({ value, change, disabled, t }) {
      return h('label', { className: 'vls-lang' }, t('meeting.count'),
        h('select', { className: 'vl-select', value, disabled, onChange: (event) => change(Number(event.target.value)) },
          h('option', { value: 0 }, t('meeting.auto')),
          Array.from({ length: 12 }, (_, i) => h('option', { key: i + 1, value: i + 1 }, i + 1)),
        ));
    }

    function meetingLabel(meeting, turn, t) {
      if (!turn.speakerId) return t(turn.overlap ? 'meeting.overlap' : 'meeting.unknown');
      return meeting.speakers.find(({ id }) => id === turn.speakerId)?.name || t('meeting.speaker', { n: turn.speakerId });
    }

    function meetingPrefix(meeting, turn, t) {
      return `[${formatTime(turn.start)}] ${meetingLabel(meeting, turn, t)}: `;
    }

    function recordingText(recording, t) {
      if (recording.meeting) return recording.meeting.turns
        .map((turn) => meetingPrefix(recording.meeting, turn, t) + (turn.correction ?? turn.text)).join('\n');
      return recording.correctedText ?? recording.text ?? '';
    }

    async function importAudio(load, { title, mimeType, language, source, meetingSpeakers, reportKind }) {
      const current = store.get();
      if (current.importing || current.updating || ['requesting', 'recording', 'finishing'].includes(current.phase)) return;
      store.set({ importing: true, importNotice: translate('import.reading'), importError: '' });
      let run;
      let audioSaved = false;
      try {
        if (!mimeType) throw new Error(translate('import.invalid'));
        const status = await fetchStatus();
        const provider = providerOf(status);
        if (!isUsable(provider)) {
          if (provider && !['requesting', 'recording', 'finishing'].includes(store.get().phase)) {
            store.set({ phase: 'setup', surface: 'studio', setupOpen: true, status, providerId: provider.id });
          }
          throw new Error(translate('import.prepare'));
        }
        const audio = await load();
        if (!audio?.size) throw new Error(translate('import.invalid'));
        if (audio.size > MAX_IMPORT_BYTES) throw new Error(translate('import.tooLarge'));
        let decoded;
        try {
          const decoder = new OfflineAudioContext(1, 1, SAMPLE_RATE);
          decoded = await decoder.decodeAudioData(await audio.arrayBuffer());
        } catch {
          throw new Error(translate('import.decodeFailed'));
        }
        if (!Number.isFinite(decoded.duration) || decoded.duration > MAX_IMPORT_SECONDS) {
          throw new Error(translate('import.tooLarge'));
        }
        if (decoded.duration < 0.05) throw new Error(translate('import.invalid'));
        store.set({ importNotice: translate('import.saving') });
        const { recording } = await request('/recordings/live', {
          json: { title, mimeType, language, source, reportKind, providerId: provider.id },
        });
        run = { id: recording.id };
        const path = archivePath(run);
        const partSize = 1024 * 1024;
        for (let at = 0; at < audio.size; at += partSize) {
          const duration = decoded.duration * Math.min(at + partSize, audio.size) / audio.size;
          await writeArchive(`${path}/chunks/${at / partSize}?duration=${duration}`, {
            method: 'PUT', bytes: audio.slice(at, at + partSize),
          });
        }
        audioSaved = true;
        const rate = decoded.sampleRate;
        const frames = Math.round(SEGMENT_SECONDS * rate);
        const total = Math.ceil(decoded.length / frames);
        const channels = Array.from({ length: decoded.numberOfChannels }, (_, channel) => decoded.getChannelData(channel));
        let pending = 0;
        for (let start = 0, id = 0; start < decoded.length; start += frames, id += 1) {
          const end = Math.min(start + frames, decoded.length);
          if ((end - start) / rate < 0.05) break;
          store.set({ importNotice: translate('import.progress', { done: id + 1, total }) });
          const samples = new Float32Array(end - start);
          for (const channel of channels) {
            for (let at = start; at < end; at += 1) samples[at - start] += channel[at] / channels.length;
          }
          await putSegment(run, { id, start: start / rate, end: end / rate, wave: encodeWave([samples], rate) });
          try {
            const result = await request(`${path}/segments/${id}/retry?live=1`);
            if (result.segment.state !== 'ready') pending += 1;
          } catch {
            pending += 1;
          }
        }
        const { recording: saved } = await writeArchive(path, {
          method: 'PATCH', json: { status: 'complete', duration: decoded.duration },
        });
        if (meetingSpeakers !== undefined) void analyzeMeeting(saved, meetingSpeakers, decoded);
        store.set({ importNotice: translate(pending ? 'import.partial' : 'import.ready', { n: pending }) });
        return run.id;
      } catch (error) {
        if (run && audioSaved) {
          await writeArchive(archivePath(run), { method: 'PATCH', json: { status: 'interrupted' } }).catch(() => {});
        }
        store.set({ importNotice: '', importError: messageOf(error) });
      } finally {
        store.set((state) => ({
          ...state, importing: false, historyVersion: state.historyVersion + (run ? 1 : 0),
        }));
      }
    }

    async function sealArchive(run) {
      try {
        await pumpAudio(run);
        await Promise.all([...run.segmentWrites]);
        if (run.segmentFailures.size) throw new Error(translate('archive.segmentWrites'));
        const { recording } = await writeArchive(archivePath(run), {
          method: 'PATCH',
          json: { status: run.interrupted ? 'interrupted' : 'complete', duration: run.duration },
        });
        run.sealed = true;
        store.set((state) => ({
          ...state,
          ...(engine.run === run ? { lastRecording: recording, archiveError: '', archiveStage: 'saved' } : {}),
          historyVersion: state.historyVersion + 1,
        }));
        return recording;
      } catch (error) {
        noteArchiveError(run, error);
        store.set((state) => ({
          ...state,
          ...(engine.run === run ? { archiveStage: 'failed' } : {}),
          historyVersion: state.historyVersion + 1,
        }));
        return null;
      }
    }

    async function retryArchive() {
      const run = engine.run;
      if (!run || run.sealed || store.get().retrySaving) return;
      store.set({ retrySaving: true, archiveStage: 'saving' });
      try {
        for (const segment of run.segmentFailures.values()) {
          await putSegment(run, segment);
          run.segmentFailures.delete(segment.id);
          void request(`${archivePath(run)}/segments/${segment.id}/retry?live=1`)
            .then(() => store.set((state) => ({ ...state, historyVersion: state.historyVersion + 1 })))
            .catch(() => {});
        }
        await sealArchive(run);
      } catch (error) {
        noteArchiveError(run, error);
      } finally {
        if (engine.run === run) store.set({ retrySaving: false });
      }
    }

    /** Late model results stay attached to the recording that requested them. */
    async function patchArchive(run, patch) {
      if (!run?.id) return;
      try {
        const { recording } = await request(archivePath(run), { method: 'PATCH', json: patch });
        store.set((state) => ({
          ...state,
          ...(engine.run === run ? { lastRecording: recording } : {}),
          historyVersion: state.historyVersion + 1,
        }));
      } catch (error) {
        noteArchiveError(run, error);
      }
    }

    async function transcribeWave(wave, signal, language = engine.run?.language || 'auto') {
      const response = await fetch(`${API}/transcribe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          audioBase64: base64Of(wave),
          language,
        }),
        signal,
      });
      const body = await readJsonResponse(response);
      return String(body.text ?? '').trim();
    }

    function joinText(left, right) {
      const a = String(left ?? '').trimEnd();
      const b = String(right ?? '').trim();
      if (!a) return b;
      if (!b) return a;
      const last = a[a.length - 1];
      const first = b[0];
      if (/[\u3400-\u9fff。，、；：！？…—）》”’】]/.test(last)) return a + b;
      if (/[。，、；：！？…—）》”’】]/.test(first)) return a + b;
      return `${a} ${b}`;
    }

    function targetLabel(code) {
      const found = TARGETS.find(([id]) => id === code);
      return found && found[0] !== 'off' ? found[1] : '译';
    }

    function shouldTranslate(text, target) {
      const source = engine.run?.language ?? store.get().sourceLanguage;
      return Boolean(text && target && target !== 'off' && target !== source);
    }

    function micError(error) {
      const name = error?.name ?? '';
      if (name === 'NotAllowedError' || name === 'SecurityError') return 'blocked';
      if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'nodevice';
      if (name === 'NotSupportedError') return 'unavailable';
      return messageOf(error) || 'unavailable';
    }

    /** Create/resume the one shared AudioContext while a user gesture is live. */
    function ensureAudio() {
      if (engine.audio && engine.audio.state !== 'closed') {
        if (engine.audio.state === 'suspended') void engine.audio.resume().catch(() => {});
        return engine.audio;
      }
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return undefined;
      try {
        engine.audio = new AudioContextClass({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
      } catch {
        engine.audio = new AudioContextClass();
      }
      if (engine.audio.state === 'suspended') void engine.audio.resume().catch(() => {});
      return engine.audio;
    }

    /** Pick a container the current Chromium can actually record and play. */
    function pickRecorderMime() {
      if (typeof MediaRecorder === 'undefined') return undefined;
      const candidates = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/ogg;codecs=opus',
        'audio/mp4',
      ];
      for (const type of candidates) {
        try {
          if (MediaRecorder.isTypeSupported(type)) return type;
        } catch {
          /* try the next container */
        }
      }
      return undefined;
    }

    async function openMicrophone(archive) {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw Object.assign(new Error('unavailable'), { name: 'NotSupportedError' });
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      let source, mute, worklet, processor;
      try {
        const audio = engine.audio ?? ensureAudio();
        if (!audio) {
          throw Object.assign(new Error('unavailable'), { name: 'NotSupportedError' });
        }
        if (audio.state === 'suspended') await audio.resume();
        source = audio.createMediaStreamSource(stream);
        mute = audio.createGain();
        // A tiny non-zero gain keeps the graph audible to the renderer without
        // producing feedback; zero-gain branches are skipped by some engines.
        mute.gain.value = 0.00001;
        mute.connect(audio.destination);
        if (audio.audioWorklet) {
          try {
            if (!audio.__voiceLiveWorklet) {
              const url = URL.createObjectURL(
                new Blob([WORKLET_SOURCE], { type: 'application/javascript' }),
              );
              try { await audio.audioWorklet.addModule(url); }
              finally { URL.revokeObjectURL(url); }
              audio.__voiceLiveWorklet = true;
            }
            worklet = new AudioWorkletNode(audio, 'voice-live-capture', {
              numberOfInputs: 1,
              numberOfOutputs: 1,
              channelCount: 1,
              channelCountMode: 'explicit',
            });
            source.connect(worklet);
            worklet.connect(mute);
          } catch {
            try { worklet?.disconnect(); } catch {}
            worklet = undefined;
          }
        }
        if (!worklet) {
          if (typeof audio.createScriptProcessor !== 'function') {
            throw Object.assign(new Error('unavailable'), { name: 'NotSupportedError' });
          }
          processor = audio.createScriptProcessor(4096, 1, 1);
          source.connect(processor);
          processor.connect(mute);
        }
        let recorder;
        if (archive && typeof MediaRecorder !== 'undefined') {
          try {
            const mime = pickRecorderMime();
            recorder = new MediaRecorder(stream, {
              ...(mime ? { mimeType: mime } : {}),
              audioBitsPerSecond: 16_000,
            });
          } catch {
            recorder = undefined;
          }
        }
        return {
          stream,
          audio,
          source,
          processor,
          worklet,
          mute,
          recorder,
          mimeType: recorder?.mimeType || 'audio/webm',
          closed: false,
        };
      } catch (error) {
        for (const track of stream.getTracks()) track.stop();
        for (const node of [source, mute, worklet, processor]) {
          try { node?.disconnect(); } catch {}
        }
        throw error;
      }
    }

    function computerAudioMessage(code, seconds = 0) {
      if (code === 'noSamples') return translate('system.noSamples', { seconds: Math.round(seconds * 100) / 100 });
      return translate(`system.${['missing', 'unsupported', 'unverified', 'deviceChanged', 'limit'].includes(code) ? code : 'failed'}`);
    }

    async function openSystemAudio(language, reportKind) {
      const availability = await request('/system-audio', { method: 'GET' });
      if (!availability.ready) throw new Error(computerAudioMessage(availability.code));
      const response = await fetch(`${API}/system-audio`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmed: true, language, reportKind }), signal: engine.abort.signal,
      });
      let session;
      try { session = await readJsonResponse(response); }
      catch (error) { throw new Error(computerAudioMessage(error.code)); }
      const controller = new AbortController();
      const capture = {
        system: true, recording: session.recording, closed: false,
        audio: { sampleRate: SAMPLE_RATE }, stream: { getTracks: () => [] }, mimeType: 'audio/wav',
        async stopNative() {
          if (!capture.stopping) capture.stopping = request(`/system-audio/${session.id}`, { method: 'DELETE' });
          const result = await capture.stopping;
          if (result.code) { engine.run && (engine.run.interrupted = true); store.set({ captureWarning: computerAudioMessage(result.code, result.seconds) }); }
          await capture.reading;
        },
        async close() {
          controller.abort();
          await capture.stopNative().catch(() => {});
        },
        start(generation) {
          capture.reading = (async () => {
            let failed = false;
            try {
              const response = await fetch(`${API}/system-audio/${session.id}/stream`, { signal: controller.signal });
              if (!response.ok || !response.body) throw new Error('Audio stream unavailable');
              const reader = response.body.getReader();
              let remainder = new Uint8Array(0);
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const bytes = new Uint8Array(remainder.length + value.length);
                bytes.set(remainder); bytes.set(value, remainder.length);
                const count = Math.floor(bytes.length / 2), view = new DataView(bytes.buffer);
                const samples = new Float32Array(count);
                for (let i = 0; i < count; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
                remainder = bytes.slice(count * 2);
                ingestSamples(samples, generation);
              }
              if (remainder.length) throw new Error('Incomplete audio sample');
            } catch { failed = !controller.signal.aborted; }
            finally {
              if (generation === engine.generation && store.get().phase === 'recording') {
                const status = await request(`/system-audio/${session.id}`, { method: 'GET' }).catch(() => ({ code: 'captureFailed' }));
                if (failed || status.code) store.set({ captureWarning: computerAudioMessage(status.code, status.seconds) });
                // Schedule after this reader settles; finish waits for it when flushing.
                queueMicrotask(() => void finish(failed || status.code ? 'interrupted' : 'stop'));
              }
            }
          })();
        },
      };
      return capture;
    }

    async function closeCapture() {
      const capture = engine.capture;
      engine.capture = null;
      if (!capture || capture.closed) return;
      capture.closed = true;
      await capture.close?.();
      if (capture.recorder && capture.recorder.state !== 'inactive') {
        try {
          capture.recorder.onstop = null;
          capture.recorder.stop();
        } catch {
          /* recorder already stopped */
        }
      }
      try {
        if (capture.worklet) {
          capture.worklet.port.onmessage = null;
          capture.worklet.disconnect();
        }
        if (capture.processor) {
          capture.processor.onaudioprocess = null;
          capture.processor.disconnect();
        }
        capture.source.disconnect();
        capture.mute.disconnect();
      } catch {
        /* already disconnected */
      }
      for (const track of capture.stream.getTracks()) track.stop();
    }

    function ingestSamples(input, generation) {
      if (generation !== engine.generation) return;
      const phase = store.get().phase;
      if (phase !== 'recording' && phase !== 'finishing') return;
      const segment = engine.segment;
      if (!segment) return;
      const copy = new Float32Array(input.length);
      copy.set(input);
      segment.samples.push(copy);
      segment.count += input.length;
      engine.pcmSamples += input.length;
      const now = Date.now();
      if (phase !== 'recording') return;
      const rate = engine.capture.audio.sampleRate;
      if (segment.count >= rate * SEGMENT_SECONDS) {
        finalizeSegment(generation, engine.run);
        return;
      }
      if (
        !engine.partialBusy &&
        segment.count >= rate * 0.8 &&
        now - engine.lastPartialAt >= PARTIAL_MS
      ) {
        void sendPartial(generation);
      }
      let sum = 0;
      for (let index = 0; index < input.length; index += 1) sum += input[index] * input[index];
      const rms = Math.sqrt(sum / input.length);
      engine.level = engine.level * 0.72 + rms * 0.28;
      if (rms >= VOICE_RMS) {
        engine.hasSpeech = true;
        engine.lastVoiceAt = now;
      }
      if (now - engine.lastLevelUi >= 90) {
        engine.lastLevelUi = now;
        store.set({ level: Math.min(1, Math.sqrt(engine.level) * 3.2) });
      }
    }

    function installProcessor(capture, generation) {
      if (capture.worklet) {
        capture.worklet.port.onmessage = ({ data }) => {
          if (data?.flushed) capture.flushDone?.();
          else ingestSamples(data, generation);
        };
      } else if (capture.processor) {
        capture.processor.onaudioprocess = (event) =>
          ingestSamples(event.inputBuffer.getChannelData(0), generation);
      }
    }

    function flushPcm(capture) {
      if (capture?.system) return capture.stopNative().catch((error) => {
        if (engine.run) engine.run.interrupted = true;
        store.set({ captureWarning: messageOf(error) });
      });
      return new Promise((resolve) => {
        if (!capture?.worklet) {
          resolve();
          return;
        }
        capture.flushDone = () => {
          clearTimeout(timer);
          capture.flushDone = null;
          resolve();
        };
        const timer = setTimeout(capture.flushDone, 350);
        capture.worklet.port.postMessage('flush');
      });
    }

    function snapshotSegment(segment, rate) {
      return {
        id: segment.id,
        start: segment.start / rate,
        end: (segment.start + segment.count) / rate,
        wave: encodeWave(segment.samples, rate),
      };
    }

    function startTicker(generation, run) {
      const timer = setInterval(() => {
        if (generation !== engine.generation || store.get().phase !== 'recording') return;
        const now = Date.now();
        store.set({ elapsed: Math.max(0, (now - engine.startedAt) / 1000) });
        const segment = engine.segment;
        const rate = engine.capture.audio.sampleRate;
        const openSeconds = segment.count / rate;
        if (openSeconds >= SEGMENT_SECONDS ||
          (engine.hasSpeech && now - engine.lastVoiceAt >= SILENCE_MS && openSeconds >= MIN_SECONDS)) {
          finalizeSegment(generation, run);
        } else if (run.id && !run.checkpointBusy && openSeconds >= MIN_SECONDS && now - run.lastCheckpoint >= CHECKPOINT_MS) {
          run.checkpointBusy = true;
          run.lastCheckpoint = now;
          putSegment(run, snapshotSegment(segment, rate), true)
            .catch((error) => noteArchiveError(run, error))
            .finally(() => { run.checkpointBusy = false; });
        }
      }, 180);
      engine.timers.push(timer);
    }

    async function sendPartial(generation) {
      if (engine.partialBusy || generation !== engine.generation) return;
      const segment = engine.segment;
      const capture = engine.capture;
      if (!segment || !capture || segment.count < capture.audio.sampleRate * MIN_SECONDS) return;
      const segId = segment.id;
      engine.partialBusy = true;
      engine.lastPartialAt = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('partial timeout')), 9000);
      const signal =
        engine.abort && typeof AbortSignal.any === 'function'
          ? AbortSignal.any([engine.abort.signal, controller.signal])
          : (engine.abort?.signal ?? controller.signal);
      try {
        const wave = encodeWave(segment.samples, capture.audio.sampleRate);
        const text = await transcribeWave(wave, signal);
        if (
          generation === engine.generation &&
          engine.segment?.id === segId &&
          store.get().phase === 'recording'
        ) {
          store.set({ partialText: text });
        }
      } catch (error) {
      } finally {
        clearTimeout(timer);
        engine.partialBusy = false;
      }
    }

    function finalizeSegment(generation, run) {
      const segment = engine.segment;
      if (generation !== engine.generation || !segment?.count) return;
      if (segment.count / run.sampleRate < 0.05) return;
      const rate = engine.capture?.audio.sampleRate ?? run.sampleRate;
      engine.segment = newSegment();
      engine.hasSpeech = false;
      engine.lastVoiceAt = 0;
      engine.lastPartialAt = 0;
      run.lastCheckpoint = Date.now();
      store.set((state) => ({ ...state, partialText: '', transcribingSegments: state.transcribingSegments + 1 }));
      const snapshot = snapshotSegment(segment, rate);
      const stored = run.id ? putSegment(run, snapshot).then(() => true, (error) => {
        run.segmentFailures.set(snapshot.id, snapshot);
        noteArchiveError(run, error);
        return false;
      }) : Promise.resolve(false);
      run.segmentWrites.add(stored);
      void stored.then(() => run.segmentWrites.delete(stored));

      engine.finalChain = engine.finalChain.then(async () => {
        if (generation !== engine.generation) return;
        try {
          let text;
          if (await stored) {
            const { segment: part } = await request(`${archivePath(run)}/segments/${snapshot.id}/retry?live=1`);
            if (part.state !== 'ready') throw new Error(part.error || translate('archive.segmentFailed'));
            text = part.text;
          } else {
            text = await transcribeWave(snapshot.wave, engine.abort?.signal, run.language);
          }
          if (generation !== engine.generation || !text) return;
          if (!run.id) run.localTexts.set(snapshot.id, text);
          store.set({ finalText: joinText(store.get().finalText, text) });
          if (store.get().translate) queueTranslation(text, generation, run);
        } catch (error) {
          if (generation !== engine.generation) return;
          if (!run.id) run.segmentFailures.set(snapshot.id, snapshot);
          store.set((state) => ({ ...state, pendingSegments: state.pendingSegments + 1 }));
        } finally {
          if (generation === engine.generation) {
            store.set((state) => ({ ...state, transcribingSegments: state.transcribingSegments - 1 }));
          }
        }
      });
    }

    async function retryDraftSegments() {
      const run = engine.run;
      const state = store.get();
      if (!run || run.id || state.phase !== 'result' || state.retrySaving) return;
      const generation = engine.generation;
      store.set({ retrySaving: true });
      for (const snapshot of run.segmentFailures.values()) {
        try {
          const text = await transcribeWave(snapshot.wave, engine.abort?.signal, run.language);
          if (generation !== engine.generation || engine.run !== run) return;
          run.localTexts.set(snapshot.id, text);
          run.segmentFailures.delete(snapshot.id);
        } catch {
          if (generation !== engine.generation || engine.run !== run) return;
        }
      }
      const text = [...run.localTexts].sort(([left], [right]) => left - right)
        .reduce((whole, [, segment]) => joinText(whole, segment), '');
      if (generation !== engine.generation || engine.run !== run) return;
      const changed = text !== state.result?.text;
      store.set({
        result: { text }, finalText: text, pendingSegments: run.segmentFailures.size, retrySaving: false,
        ...(changed ? { editedText: '', translationText: '' } : {}),
      });
      if (changed && state.translate) void queueTranslation(text, generation, run, true);
      if (changed && state.editMode) void generateEditedText(text, generation, run);
    }

    function queueTranslation(text, generation, run, replace = false) {
      const target = store.get().targetLanguage;
      const revision = run.translationRevision;
      if (!shouldTranslate(text, target)) return Promise.resolve();
      const currentTarget = () => revision === run.translationRevision;
      const visible = () => generation === engine.generation && currentTarget();
      run.translateChain = run.translateChain.then(async () => {
        if (!currentTarget()) return;
        if (visible()) store.set({ translating: true, translateError: '' });
        if (replace) run.translated = '';
        try {
          for (const chunk of splitText(text)) {
            if (!currentTarget()) return;
            const body = await request('/translate', {
              json: { text: chunk, target, model: run.model },
            });
            if (!currentTarget()) return;
            run.translated = joinText(run.translated, body.text);
            if (visible()) store.set({ translationText: run.translated, translationLabel: targetLabel(target) });
          }
          await patchArchive(run, { translation: run.translated });
        } catch (error) {
          if (visible()) store.set({ translateError: messageOf(error) });
        } finally {
          if (visible()) store.set({ translating: false });
        }
      });
      return run.translateChain;
    }

    function splitText(text, limit = 3500) {
      const clean = String(text ?? '').trim();
      if (!clean) return [];
      const chunks = [];
      let rest = clean;
      while (rest.length > limit) {
        const windowText = rest.slice(0, limit);
        let cut = Math.max(
          windowText.lastIndexOf('\n'),
          windowText.lastIndexOf('。'),
          windowText.lastIndexOf('！'),
          windowText.lastIndexOf('？'),
          windowText.lastIndexOf('. '),
          windowText.lastIndexOf('; '),
        );
        if (cut < limit * 0.55) cut = limit;
        chunks.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
      }
      if (rest) chunks.push(rest);
      return chunks;
    }

    async function generateEditedText(text, generation, run) {
      store.set({ editing: true, editError: '' });
      try {
        let edited = '';
        for (const chunk of splitText(text)) {
          const body = await request('/normalize', {
            json: { text: chunk, language: run.language, model: run.model },
          });
          edited = joinText(edited, body.text);
        }
        await patchArchive(run, { editedText: edited });
        if (generation === engine.generation) store.set({ editedText: edited, editing: false });
      } catch (error) {
        if (generation === engine.generation) {
          store.set({ editing: false, editError: messageOf(error) });
        }
      }
    }

    function resolveReportLanguage(preference, source) {
      if (preference !== 'auto') return preference;
      if (/[\u3040-\u30ff]/.test(source)) return 'ja';
      if (/[\uac00-\ud7af]/.test(source)) return 'ko';
      const han = (source.match(/[\u3400-\u9fff\uf900-\ufaff]/g) ?? []).length;
      const latin = (source.match(/[A-Za-z]/g) ?? []).length;
      return han > 0 && han >= latin * 0.4 ? 'zh' : 'en';
    }

    async function createMeetingReport(source, model, preference, kind = 'meeting') {
      const language = resolveReportLanguage(preference, source);
      const send = async (text, mode, compact) => {
        const body = await request('/report', { json: { text, mode, compact, language, model, kind } });
        return String(body.report ?? '').trim();
      };
      if (source.length <= 12_000) return send(source);
      let parts = [];
      for (const chunk of splitText(source, 12_000)) parts.push(await send(chunk, 'part'));
      while (parts.length > 1) {
        const merged = [];
        for (let index = 0; index < parts.length; index += 4) {
          merged.push(await send(parts.slice(index, index + 4).join('\n\n'), 'merge', parts.length > 4));
        }
        parts = merged;
      }
      return parts[0];
    }

    async function generateMeetingReport(generation, run) {
      store.set({ reporting: true, reportError: '' });
      try {
        const { recording } = await request(archivePath(run), { method: 'GET' });
        if (generation !== engine.generation) return;
        if (recording.reportPending) throw new Error(translate('report.pending'));
        const source = recordingText(recording, translate).trim();
        if (!source) { store.set({ reporting: false }); return; }
        const preference = recording.reportKind ?? store.get().reportKind;
        const reportKind = preference === 'auto' ? (run.source === 'system' ? 'learning' : 'meeting') : preference;
        const report = await createMeetingReport(source, run.model, store.get().reportLanguage, reportKind);
        const { recording: updated } = await request(archivePath(run), {
          method: 'PATCH', json: { report, reportKind, reportSource: recording.reportSource },
        });
        store.set((state) => ({
          ...state,
          ...(engine.run === run ? { lastRecording: updated } : {}),
          historyVersion: state.historyVersion + 1,
        }));
        if (generation === engine.generation) store.set({ report, reporting: false });
      } catch (error) {
        if (generation === engine.generation) {
          store.set({ reporting: false, reportError: messageOf(error) });
        }
      }
    }

    async function begin(inputActions, sessionId, locked, surface = 'composer') {
      if (locked || store.get().updating) return;
      if (store.get().phase !== 'idle' && store.get().phase !== 'result' && store.get().phase !== 'error') {
        return;
      }
      engine.inputActions = inputActions;
      engine.sessionId = sessionId;
      engine.run = null;
      const run = ++engine.beginSeq;
      resetSessionState();
      store.set({ phase: 'requesting', setupOpen: false, surface });
      let status;
      try {
        status = await fetchStatus();
      } catch (error) {
        if (run !== engine.beginSeq) return;
        store.set({ phase: 'error', error: `语音服务不可用：${messageOf(error)}` });
        return;
      }
      if (run !== engine.beginSeq) return;
      const provider = providerOf(status);
      if (!provider) {
        store.set({ phase: 'error', error: '没有可用的语音模型。' });
        return;
      }
      if (!isUsable(provider)) {
        store.set({
          phase: 'setup',
          setupOpen: true,
          surface,
          providerId: provider.id,
          status,
          prepareError: provider.preparation?.phase === 'failed' ? provider.preparation.message ?? '' : '',
        });
        return;
      }
      await startCapture(inputActions, sessionId, provider);
    }

    async function startCapture(inputActions, sessionId, provider) {
      const generation = ++engine.generation;
      engine.sessionId = sessionId;
      engine.inputActions = inputActions;
      try {
        engine.insertSpan = inputActions?.captureInsertion?.() ?? null;
      } catch {
        engine.insertSpan = null;
      }
      engine.abort = new AbortController();
      engine.level = 0;
      engine.hasSpeech = false;
      engine.lastVoiceAt = 0;
      engine.lastPartialAt = 0;
      engine.lastLevelUi = 0;
      engine.partialBusy = false;
      engine.pcmSamples = 0;
      engine.segmentSeq = 0;
      engine.finalChain = Promise.resolve();
      engine.run = null;
      const language = store.get().sourceLanguage;
      const captureOptions = store.get();
      const meetingSpeakers = captureOptions.surface === 'studio' && captureOptions.meetingMode
        ? captureOptions.meetingSpeakers : undefined;
      const computerAudio = captureOptions.surface === 'studio' && captureOptions.captureSource === 'system';
      const reportKind = captureOptions.surface === 'studio' ? captureOptions.reportKind : undefined;
      if (computerAudio && !window.confirm(translate('system.confirm') +
        (captureOptions.translate || captureOptions.editMode || captureOptions.reportMode
          ? '\n\n' + modelDisclosure(captureOptions, translate) : ''))) {
        store.set({ phase: 'idle' }); return;
      }
      const archive = captureOptions.surface === 'studio' || captureOptions.dictationHistory;
      const model = store.get().status?.model ?? null;
      store.set({ phase: 'requesting', providerId: provider.id, error: '' });
      let capture;
      try {
        capture = computerAudio ? await openSystemAudio(language, reportKind) : await openMicrophone(archive);
      } catch (error) {
        if (generation !== engine.generation) return;
        store.set({ phase: 'error', error: computerAudio ? messageOf(error) : micError(error) });
        return;
      }
      if (generation !== engine.generation) {
        await capture.close?.();
        for (const node of [capture.worklet, capture.processor, capture.source, capture.mute]) node?.disconnect();
        for (const track of capture.stream.getTracks()) track.stop();
        return;
      }
      engine.capture = capture;
      try {
        const recording = capture.recording ?? (archive
          ? (await request('/recordings/live', {
              json: { mimeType: capture.mimeType, language, reportKind, providerId: provider.id },
            })).recording : null);
        if (generation !== engine.generation) return;
        const run = {
          id: recording?.id ?? null,
          source: computerAudio ? 'system' : 'microphone',
          meetingSpeakers,
          localTexts: new Map(),
          language,
          model,
          sampleRate: capture.audio.sampleRate,
          audioQueue: [],
          audioSequence: 0,
          segmentWrites: new Set(),
          segmentFailures: new Map(),
          translated: '',
          translationRevision: 0,
          translateChain: Promise.resolve(),
          lastCheckpoint: Date.now(),
          duration: 0,
          sealed: false,
        };
        engine.run = run;
        engine.segment = newSegment();
        installProcessor(capture, generation);
        engine.startedAt = Date.now();
        if (capture.recorder) {
          capture.recorder.ondataavailable = ({ data }) => {
            if (!data?.size) return;
            const duration = Math.max(0, Math.round((Date.now() - engine.startedAt) / 100) / 10);
            const partSize = 1024 * 1024;
            for (let offset = 0; offset < data.size; offset += partSize) {
              const bytes = data.size > partSize ? data.slice(offset, offset + partSize) : data;
              run.audioQueue.push({ sequence: run.audioSequence++, bytes, duration });
            }
            void pumpAudio(run).catch((error) => noteArchiveError(run, error));
          };
          capture.recorder.onerror = () => {
            store.set({ captureWarning: translate('archive.captureInterrupted') });
            void finish('interrupted');
          };
          try {
            capture.recorder.start(1000);
          } catch {
            capture.recorder = undefined;
          }
        }
        for (const track of capture.stream.getTracks()) {
          track.addEventListener('ended', () => {
            if (generation !== engine.generation || store.get().phase !== 'recording') return;
            store.set({ captureWarning: translate('archive.captureInterrupted') });
            void finish('interrupted');
          }, { once: true });
        }
        store.set((current) => ({
          ...current,
          phase: 'recording', elapsed: 0, level: 0,
          archiveStage: archive ? '' : 'draft',
          captureWarning: archive && !capture.recorder && !capture.system ? translate('archive.noRecorder') : '',
          historyVersion: current.historyVersion + Number(archive),
        }));
        capture.start?.(generation);
        startTicker(generation, run);
      } catch (error) {
        await closeCapture();
        if (generation === engine.generation) {
          store.set({ phase: 'error', error: `无法开始归档：${messageOf(error)}` });
        }
      }
    }

    async function finish(reason) {
      const state = store.get();
      const run = engine.run;
      if (state.phase !== 'recording' || !run) return;
      const generation = engine.generation;
      run.interrupted = reason === 'interrupted';
      run.duration = Math.max(0, (Date.now() - engine.startedAt) / 1000);
      store.set({ phase: 'finishing', elapsed: run.duration, archiveStage: 'stopping' });
      clearTimers();
      const capture = engine.capture;
      await Promise.all([flushPcm(capture), flushRecorder(capture)]);
      await closeCapture();
      if (generation !== engine.generation) return;
      store.set({ archiveStage: run.id ? 'saving' : 'draft' });
      finalizeSegment(generation, run);
      const archive = run.id ? sealArchive(run) : Promise.resolve(null);
      await engine.finalChain;
      const saved = await archive;
      if (generation !== engine.generation) return;

      const current = store.get();
      const text = current.finalText.trim();
      const pending = current.pendingSegments;
      if (run.id) store.set((previous) => ({ ...previous, historyVersion: previous.historyVersion + 1 }));
      if (text && current.editMode) void generateEditedText(text, generation, run);
      if (saved && run.meetingSpeakers !== undefined && !run.interrupted) {
        void analyzeMeeting(saved, run.meetingSpeakers).then((meeting) => {
          if (meeting && current.reportMode && generation === engine.generation) {
            void generateMeetingReport(generation, run);
          }
        });
      } else if (saved && state.surface === 'studio' && current.reportMode) {
        if (pending) store.set({ reportError: translate('report.pending') });
        else if (text) void generateMeetingReport(generation, run);
      }
      if (state.surface === 'composer' && text && (!run.id || saved) && !pending && !current.captureWarning &&
          !current.translate && !current.editMode && insertAt(text, engine.insertSpan)) {
        resetSessionState();
        const message = translate(run.id ? 'recording.insertedSaved' : 'recording.inserted');
        store.set({ phase: 'idle', savedNotice: message });
        flashNotice();
        return;
      }
      store.set({
        phase: 'result', result: { text },
        savedNotice: saved ? translate('recording.saved') : '',
      });
      if (saved) flashNotice();
    }

    async function cancel(dispose = false) {
      if (!dispose && store.get().phase === 'recording') {
        await finish('stop');
        return;
      }
      if (!dispose && store.get().phase === 'finishing') return;
      engine.beginSeq += 1;
      engine.generation += 1;
      clearTimers();
      clearPrepareTimer();
      engine.abort?.abort();
      await closeCapture();
      engine.segment = null;
      engine.partialBusy = false;
      resetSessionState();
      store.set({ phase: 'idle', setupOpen: false });
    }

    function dismissSetup() {
      clearPrepareTimer();
      store.set({ setupOpen: false, phase: 'idle' });
    }

    async function prepare(providerId, downloadSource) {
      if (!providerId) return;
      store.set({ preparing: true, prepareError: '' });
      try {
        const response = await fetch(`${API}/prepare`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            providerId,
            ...(downloadSource ? { downloadSource } : {}),
          }),
        });
        await readJsonResponse(response);
      } catch (error) {
        store.set({ preparing: false, prepareError: messageOf(error) });
        return;
      }
      clearPrepareTimer();
      engine.prepareTimer = setInterval(() => {
        void pollPreparation(providerId);
      }, 900);
      void pollPreparation(providerId);
    }

    async function pollPreparation(providerId) {
      let status;
      try {
        status = await fetchStatus();
      } catch (error) {
        store.set({ prepareError: messageOf(error) });
        return;
      }
      const provider = (status.providers ?? []).find((item) => item.id === providerId);
      const phase = provider?.preparation?.phase;
      store.set({ status, setupOpen: true, providerId });
      if (phase === 'ready' || phase === 'standby') {
        clearPrepareTimer();
        store.set({
          preparing: false,
          phase: 'idle',
          notice: '',
          setupOpen: true,
        });
      } else if (phase === 'failed') {
        clearPrepareTimer();
        store.set({
          preparing: false,
          prepareError: provider?.preparation?.message ?? '准备失败',
        });
      } else if (phase === 'cancelled') {
        clearPrepareTimer();
        store.set({ preparing: false, prepareError: '' });
      }
    }

    async function cancelPreparation(providerId) {
      clearPrepareTimer();
      store.set({ preparing: false });
      try {
        const response = await fetch(`${API}/cancel`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ providerId }),
        });
        await readJsonResponse(response);
      } catch (error) {
        store.set({ prepareError: messageOf(error) });
      }
    }

    function modelKey(model) {
      return model && typeof model.provider === 'string' && typeof model.model === 'string'
        ? JSON.stringify([model.provider, model.model]) : '';
    }

    function activeModel(state) {
      return engine.run && ['recording', 'finishing', 'result'].includes(state.phase)
        ? engine.run.model : state.status?.model;
    }

    function saveModelPreference(patch, enabling) {
      const state = store.get();
      const modelPermission = enabling ? modelKey(activeModel(state)) : state.modelPermission;
      if (enabling && !modelPermission) return false;
      savePrefs({ ...patch, modelPermission });
      store.set({ ...patch, modelPermission });
      return true;
    }

    function setReportMode(enabled) {
      saveModelPreference({ reportMode: Boolean(enabled) }, enabled);
    }

    function setSourceLanguage(code) {
      const source = SOURCE_LANGUAGES.some(([id]) => id === code) ? code : 'auto';
      store.set({ sourceLanguage: source });
      savePrefs({ sourceLanguage: source });
    }

    function setTargetLanguage(code) {
      const target = TARGETS.some(([id]) => id === code) ? code : 'off';
      if (!saveModelPreference({ targetLanguage: target }, target !== 'off')) return;
      store.set({
        targetLanguage: target,
        translate: target !== 'off',
        translationLabel: targetLabel(target),
        translationText: '',
        translateError: '',
      });
      const state = store.get();
      const text = (state.result?.text || state.finalText || '').trim();
      const run = engine.run;
      if (run && ['recording', 'finishing', 'result'].includes(state.phase)) {
        run.translationRevision += 1;
        run.translated = '';
        if (shouldTranslate(text, target)) void queueTranslation(text, engine.generation, run, true);
      }
    }

    function insertAt(text, span) {
      const composer = engine.activeComposer;
      if (!text || !composer?.inputActions?.insertText || composer.sessionId !== engine.sessionId || composer.locked) return false;
      if (!composer.sessionId && composer.inputActions !== engine.inputActions) return false;
      const actions = composer.inputActions;
      try {
        if (span && actions.insertText(text, span)) return true;
      } catch {
        /* fall through to the current caret */
      }
      try {
        if (actions.captureInsertion) {
          return actions.insertText(text, actions.captureInsertion());
        }
      } catch {
        return false;
      }
      return false;
    }

    function insert(kind) {
      const state = store.get();
      const result = state.result;
      if (!result?.text) return;
      let text = result.text;
      if (kind === 'translation') text = state.translationText.trim();
      if (kind === 'edited') text = state.editedText.trim();
      if (kind === 'both') {
        text = state.translationText.trim()
          ? `${result.text}\n\n${state.translationText.trim()}`
          : result.text;
      }
      if (!text) return;
      if (insertAt(text, engine.insertSpan)) {
        resetSessionState();
        store.set({ phase: 'idle', notice: '已插入草稿' });
        flashNotice();
        return;
      }
      store.set({ notice: translate('recording.originalDraft') });
    }

    function flashNotice() {
      if (engine.noticeTimer) clearTimeout(engine.noticeTimer);
      engine.noticeTimer = setTimeout(() => {
        store.set((state) => ({ ...state, savedNotice: '', ...(state.phase === 'idle' ? { notice: '' } : {}) }));
      }, 4200);
    }

    async function copyText(text) {
      try {
        await navigator.clipboard.writeText(text);
        store.set({ copied: true });
        setTimeout(() => store.set({ copied: false }), 1600);
        return true;
      } catch {
        store.set({ notice: '复制失败，请手动选择文字' });
        return false;
      }
    }

    function useStore() {
      return React.useSyncExternalStore(store.subscribe, store.get, store.get);
    }

    function formatTime(seconds) {
      const total = Math.max(0, Math.floor(seconds));
      const hours = Math.floor(total / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      const rest = total % 60;
      if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
      }
      return `${minutes}:${String(rest).padStart(2, '0')}`;
    }

    function formatBytes(value) {
      if (!Number.isFinite(value) || value <= 0) return '—';
      if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
      if (value >= 1024 ** 2) return `${Math.round(value / 1024 ** 2)} MB`;
      return `${Math.round(value / 1024)} KB`;
    }

    function Icon(props) {
      const size = props.size ?? 18;
      const paths = {
        mic: 'M12 15a3.5 3.5 0 0 0 3.5-3.5V6a3.5 3.5 0 1 0-7 0v5.5A3.5 3.5 0 0 0 12 15Zm-6-5a6 6 0 0 0 12 0M12 18v3m-3 0h6',
        stop: 'M7 7h10v10H7z',
        close: 'M7 7l10 10M17 7L7 17',
        translate: 'M4 6h9M8.5 6c0 4-2 7-4.5 9m2-5c1.5 2.5 3.5 4 6 5m.5-9 4 10m1.5-4h-7',
        copy: 'M9 9h8v8H9zM7 15H5V5h10v2',
        file: 'M7 3h7l4 4v14H7zM14 3v4h4M10 12h6M10 16h6',
        refresh: 'M4 11a8 8 0 0 1 13.5-4.5L20 9m0 0V4m0 5h-5M20 13a8 8 0 0 1-13.5 4.5L4 15m0 0v5m0-5h5',
      };
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: paths[props.name] ?? paths.mic }),
      );
    }

    function Waveform(props) {
      const bars = 12;
      return h(
        'span',
        { className: 'vl-wave', 'aria-hidden': 'true' },
        Array.from({ length: bars }, (_, index) => {
          const center = 1 - Math.abs(index - (bars - 1) / 2) / ((bars - 1) / 2);
          const wobble = 0.35 + 0.65 * Math.abs(Math.sin((props.phase ?? 0) + index * 1.7));
          const height = 3 + props.level * 17 * (0.35 + center * 0.65) * wobble;
          return h('i', { key: index, style: { height: `${Math.min(20, height)}px` } });
        }),
      );
    }

    function SourceSelect(props) {
      const t = props.t;
      const state = useStore();
      return h(
        'select',
        {
          className: 'vl-select vl-source',
          title: t('language.hint'),
          'aria-label': t('language.title'),
          value: state.sourceLanguage || 'auto',
          disabled: ['requesting', 'recording', 'finishing'].includes(state.phase),
          onChange: (event) => setSourceLanguage(event.target.value),
        },
        SOURCE_LANGUAGES.map(([id, label]) =>
          h('option', { key: id, value: id }, id === 'auto' ? t('translate.auto') : label),
        ),
      );
    }

    function modelDisclosure(state, t) {
      const model = activeModel(state);
      return model
        ? t('model.disclose', { provider: [model.provider, model.model].filter(Boolean).join(' / ') })
        : t('model.unavailable');
    }

    function EditControl({ t }) {
      const state = useStore();
      return h('label', { className: 'vl-check', title: modelDisclosure(state, t) },
        h('input', {
          type: 'checkbox',
          checked: state.editMode,
          disabled: state.phase === 'finishing' || state.phase === 'result' || (!state.editMode && !activeModel(state)),
          onChange: (event) => {
            const editMode = event.target.checked;
            saveModelPreference({ editMode }, editMode);
          },
        }),
        t('model.edit'),
      );
    }

    function stopFeedback(state, t) {
      const n = state.transcribingSegments;
      if (state.archiveStage === 'stopping') return t('recording.stopping');
      if (state.archiveStage === 'failed') return t('recording.saveFailed');
      if (state.archiveStage === 'saved') {
        return n ? t('recording.savedProcessing', { n }) : t('recording.saved');
      }
      if (state.archiveStage === 'draft') {
        if (n) return t('recording.processing', { n });
        return t(state.phase === 'finishing' ? 'recording.finishingDraft' : 'recording.ready');
      }
      return t('recording.saving');
    }

    function ArchiveStatus({ state, t }) {
      if (!state.captureWarning && !state.pendingSegments && !state.archiveError) return null;
      const archive = Boolean(engine.run?.id);
      return h('div', { role: 'status' },
        state.captureWarning ? h('div', { className: 'vl-note' }, state.captureWarning) : null,
        state.pendingSegments ? h('div', { className: 'vl-note' },
          t(archive ? 'archive.pending' : 'archive.localPending', { n: state.pendingSegments })) : null,
        state.archiveError ? h('div', { className: 'vls-error' }, state.archiveError) : null,
        state.phase === 'result' && archive && state.archiveError && !engine.run.sealed
          ? h('button', { type: 'button', className: 'vl-btn', disabled: state.retrySaving, onClick: () => void retryArchive() },
              t(state.retrySaving ? 'archive.saving' : 'archive.retrySave'))
          : null,
        state.phase === 'result' && !archive && state.pendingSegments
          ? h('button', { type: 'button', className: 'vl-btn', disabled: state.retrySaving, onClick: () => void retryDraftSegments() },
              state.retrySaving ? t('recording.processing', { n: state.pendingSegments }) : t('archive.retryLocal'))
          : null,
      );
    }

    function DictationPreferences({ state, t }) {
      return h('details', { className: 'vls-options' },
        h('summary', null, t('recording.dictationSettings')),
        h('div', { className: 'vls-options-row' },
          h('label', { className: 'vl-check', title: t('recording.dictationHint') },
            h('input', {
              type: 'checkbox', checked: state.dictationHistory,
              onChange: (event) => {
                const dictationHistory = event.target.checked;
                store.set({ dictationHistory });
                savePrefs({ dictationHistory });
              },
            }),
            t('recording.dictationHistory'),
          ),
          h('label', { className: 'vls-lang', title: t('shortcut.hint') },
            t('shortcut.label'),
            h('select', {
              className: 'vl-select', value: state.shortcut,
              onChange: (event) => {
                const shortcut = event.target.value;
                store.set({ shortcut });
                savePrefs({ shortcut });
              },
            }, SHORTCUTS.map(([code, label]) => h('option', { key: code, value: code }, code === 'off' ? t(label) : label))),
          ),
        ),
        h('p', { className: 'vl-note' }, t('recording.dictationHint'), ' ', t('shortcut.hint')),
      );
    }

    function EditedText({ state, t }) {
      if (!state.editing && !state.editedText && !state.editError) return null;
      return h('div', { className: 'vls-live-translation' },
        h('div', { className: 'vl-label' }, t('model.edited')),
        state.editing ? h('p', { className: 'vl-note' }, t('model.editing')) : null,
        state.editedText ? h('p', { className: 'vls-trans-text' }, state.editedText) : null,
        state.editError ? h('p', { className: 'vls-error' }, t('model.editError', { message: state.editError })) : null,
      );
    }

    function TranslateControl(props) {
      const t = props.t;
      const state = useStore();
      const enabled = state.targetLanguage !== 'off';
      return h(
        'span',
        { className: 'vl-translate-control' },
        h(
          'label',
          { className: 'vl-check', title: modelDisclosure(state, t) },
          h('input', {
            type: 'checkbox',
            checked: enabled,
            disabled: !enabled && !activeModel(state),
            onChange: (event) => {
              if (!event.target.checked) {
                setTargetLanguage('off');
                return;
              }
              const source = state.sourceLanguage;
              const target = source === 'zh' || source === 'yue' ? 'en' : source === 'en' ? 'zh' : 'en';
              setTargetLanguage(target);
            },
          }),
          t('translate.enable'),
        ),
        enabled ? h(TargetSelect, { t }) : null,
      );
    }

    function TargetSelect(props) {
      const t = props.t;
      const state = useStore();
      return h(
        'select',
        {
          className: 'vl-select vl-target',
          title: t('translate.title'),
          'aria-label': t('translate.title'),
          value: state.targetLanguage || 'off',
          onChange: (event) => setTargetLanguage(event.target.value),
        },
        TARGETS.map(([id, label]) =>
          h('option', { key: id, value: id }, id === 'off' ? t('translate.off') : label),
        ),
      );
    }

    function VoiceBar(props) {
      const state = useStore();
      const t = props.t;
      const active =
        state.surface === 'composer' &&
        (state.phase === 'requesting' ||
          state.phase === 'recording' ||
          state.phase === 'finishing');
      React.useLayoutEffect(() => {
        const composer = { sessionId: props.sessionId, inputActions: props.inputActions, locked: props.locked };
        engine.activeComposer = composer;
        return () => {
          if (engine.activeComposer === composer) engine.activeComposer = null;
        };
      }, [props.sessionId, props.inputActions, props.locked]);

      React.useLayoutEffect(() => {
        props.onActiveChange(active);
        return () => props.onActiveChange(false);
      }, [active, props.onActiveChange]);

      React.useEffect(
        () => () => {
          const current = store.get();
          if (current.surface === 'composer' && current.phase === 'requesting') {
            void cancel();
          }
        },
        [],
      );

      React.useEffect(() => {
        const onKey = (event) => {
          if (event.key !== 'Escape') return;
          if (
            store.get().surface === 'composer' &&
            (store.get().phase === 'recording' || store.get().phase === 'requesting')
          ) {
            event.preventDefault();
            void cancel();
          } else if (store.get().phase === 'setup' && store.get().setupOpen) {
            event.preventDefault();
            dismissSetup();
          }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
      }, []);

      const phase = state.phase;
      if (state.surface === 'studio' && phase !== 'idle') return null;

      if (phase === 'idle') {
        return h(
          'div',
          { className: 'vl-root' },
          h(
            'button',
            {
              type: 'button',
              className: 'vl-trigger',
              title: [t('dictate'), !state.dictationHistory ? t('recording.draft') : null,
                SHORTCUTS.find(([code]) => code === state.shortcut && code !== 'off')?.[1]].filter(Boolean).join(' · '),
              'aria-label': t('dictate'),
              disabled: props.locked,
              onMouseDown: (event) => event.preventDefault(),
              onClick: () => {
                ensureAudio();
                void begin(props.inputActions, props.sessionId, props.locked);
              },
            },
            h(Icon, { name: 'mic', size: 17 }),
          ),
          state.notice
            ? h('span', { className: 'vl-status', style: { marginLeft: '6px' } }, state.notice)
            : null,
        );
      }

      if (phase === 'requesting') {
        return h(
          'div',
          { className: 'vl-root' },
          h(
            'div',
            { className: 'vl-bar' },
            h('span', { className: 'vl-spin' }),
            h('span', { className: 'vl-status' }, h('span', null, t('phase.requesting'))),
            h(
              'button',
              {
                type: 'button',
                className: 'vl-round',
                title: t('bar.cancel'),
                'aria-label': t('bar.cancel'),
                onClick: () => void cancel(),
              },
              h(Icon, { name: 'close', size: 14 }),
            ),
          ),
        );
      }

      if (phase === 'recording') {
        return h(
          'div',
          { className: 'vl-root' },
          h(
            'div',
            { className: 'vl-bar' },
            h('span', { className: 'vl-pulse' }),
            h(Waveform, { level: state.level, phase: state.elapsed }),
            h('span', { className: 'vl-timer' }, formatTime(state.elapsed)),
            h(SourceSelect, { t }),
            h(TranslateControl, { t }),
            h('span', { className: 'vl-sep' }),
            h(
              'button',
              {
                type: 'button',
                className: 'vl-round',
                'data-danger': 'true',
                title: t('bar.stop'),
                'aria-label': t('bar.stop'),
                onClick: () => void finish('stop'),
              },
              h(Icon, { name: 'stop', size: 13 }),
            ),
          ),
        );
      }

      if (phase === 'finishing') {
        return h(
          'div',
          { className: 'vl-root' },
          h(
            'div',
            { className: 'vl-bar' },
            h('span', { className: 'vl-spin' }),
            h('span', { className: 'vl-status' }, h('span', null, stopFeedback(state, t))),
          ),
        );
      }

      // setup / result / error: a compact retry trigger with a close affordance.
      return h(
        'div',
        { className: 'vl-root' },
        h(
          'div',
          { className: 'vl-bar' },
          h(
            'button',
            {
              type: 'button',
              className: 'vl-trigger',
              title: t('bar.retry'),
              'aria-label': t('bar.retry'),
              onMouseDown: (event) => event.preventDefault(),
              onClick: () => {
                if (state.phase === 'result' || state.phase === 'error') {
                  resetSessionState();
                  store.set({ phase: 'idle' });
                } else {
                  void begin(props.inputActions, props.sessionId, props.locked);
                }
              },
            },
            h(Icon, { name: 'mic', size: 17 }),
          ),
          h('span', { className: 'vl-status' }, h('span', null, state.notice || '')),
          h(
            'button',
            {
              type: 'button',
              className: 'vl-round',
              title: t('bar.close'),
              'aria-label': t('bar.close'),
              onClick: () => {
                if (state.phase === 'setup') dismissSetup();
                else {
                  resetSessionState();
                  store.set({ phase: 'idle' });
                }
              },
            },
            h(Icon, { name: 'close', size: 14 }),
          ),
        ),
      );
    }

    function LivePanel(props) {
      const state = useStore();
      const t = props.t;
      if (state.phase !== 'recording' && state.phase !== 'finishing') return null;
      const original = state.finalText;
      const partial = state.partialText;
      const empty = !original && !partial;
      return h(
        'div',
        { className: 'vl-overlay' },
        h(
          'div',
          { className: 'vl-panel', role: 'status', 'aria-live': 'polite' },
          h(
            'div',
            { className: 'vl-head' },
            state.phase === 'recording' ? h('span', { className: 'vl-pulse' }) : h('span', { className: 'vl-spin' }),
            h('span', { className: 'vl-title' }, state.phase === 'recording' ? t('phase.recording') : stopFeedback(state, t)),
            h('span', { className: 'vl-sub' }, formatTime(state.elapsed)),
            h('span', { className: 'vl-sep' }),
            h(TranslateControl, { t }),
            h(EditControl, { t }),
          ),
          h(
            'div',
            { className: 'vl-body' },
            h(
              'p',
              { className: 'vl-text', 'data-empty': empty },
              original,
              partial
                ? h('span', { className: 'vl-partial' }, original ? ` ${partial}` : partial)
                : null,
              empty ? t('live.empty') : null,
            ),
            state.translate
              ? h(
                  'div',
                  { className: 'vl-translation' },
                  h(
                    'div',
                    { className: 'vl-label' },
                    t('live.translation'),
                    h('b', null, state.translationLabel || '译'),
                  ),
                  state.translationText
                    ? h(
                        'p',
                        { className: 'vl-translation-text' },
                        state.translationText,
                      )
                    : h(
                        'p',
                        { className: 'vl-note' },
                        state.translating ? t('live.translating') : t('bar.translateOn'),
                      ),
                  state.translateError ? h('p', { className: 'vl-note', 'data-tone': 'error' }, state.translateError) : null,
                )
              : null,
          ),
          h(ArchiveStatus, { state, t }),
          h('div', { className: 'vl-note' }, state.translate || state.editMode ? modelDisclosure(state, t) : t('live.hint')),
        ),
      );
    }

    function ResultPanel(props) {
      const state = useStore();
      const t = props.t;
      if (state.phase !== 'result') return null;
      const result = state.result ?? { text: '' };
      const hasText = Boolean(result.text);
      const translation = state.translationText.trim();
      return h(
        'div',
        { className: 'vl-overlay' },
        h(
          'div',
          { className: 'vl-panel', role: 'dialog', 'aria-label': t('result.title') },
          h(
            'div',
            { className: 'vl-head' },
            h('span', { className: 'vl-title' }, t('result.title')),
            h('span', { className: 'vl-sub' }, formatTime(state.elapsed)),
            h('span', { className: 'vl-sep' }),
            h(TranslateControl, { t }),
          ),
          h(
            'div',
            { className: 'vl-body' },
            hasText
              ? h('p', { className: 'vl-text' }, result.text)
              : h('p', { className: 'vl-text', 'data-empty': 'true' }, t('result.empty')),
            h(EditedText, { state, t }),
            h(ArchiveStatus, { state, t }),
            state.notice ? h('p', { className: 'vl-note', role: 'status' }, state.notice) : null,
            state.translate ? h('div', { className: 'vl-note' }, modelDisclosure(state, t)) : null,
            state.translate
              ? h(
                  'div',
                  { className: 'vl-translation' },
                  h(
                    'div',
                    { className: 'vl-label' },
                    t('live.translation'),
                    h('b', null, state.translationLabel || '译'),
                  ),
                  translation
                    ? h('p', { className: 'vl-translation-text' }, translation)
                    : h(
                        'p',
                        { className: 'vl-note' },
                        state.translating ? t('live.translating') : t('bar.translateOn'),
                      ),
                  state.translateError ? h('p', { className: 'vl-note', 'data-tone': 'error' }, state.translateError) : null,
                )
              : null,
          ),
          h(
            'div',
            { className: 'vl-actions' },
            hasText
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'vl-btn',
                    'data-primary': 'true',
                    onClick: () => insert('original'),
                  },
                  t('result.insert'),
                )
              : null,
            state.editedText
              ? h('button', { type: 'button', className: 'vl-btn', onClick: () => insert('edited') }, t('result.insertEdited'))
              : null,
            hasText && translation
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'vl-btn',
                    onClick: () => insert('translation'),
                  },
                  t('result.insertTranslation'),
                )
              : null,
            hasText && translation
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'vl-btn',
                    onClick: () => insert('both'),
                  },
                  t('result.insertBoth'),
                )
              : null,
            hasText
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'vl-btn',
                    'data-quiet': 'true',
                    onClick: () => void copyText(result.text),
                  },
                  state.copied ? t('result.copied') : t('result.copy'),
                )
              : null,
            h('span', { className: 'vl-grow' }),
            h(
              'button',
              {
                type: 'button',
                className: 'vl-btn',
                'data-quiet': 'true',
                onClick: () => {
                  resetSessionState();
                  store.set({ phase: 'idle' });
                },
              },
              t('result.discard'),
            ),
          ),
        ),
      );
    }

    function SetupPanel(props) {
      const state = useStore();
      const t = props.t;
      if (state.phase !== 'setup' || !state.setupOpen) return null;
      const provider = (state.status?.providers ?? []).find((item) => item.id === state.providerId);
      const preparation = provider?.preparation ?? {};
      const phase = preparation.phase ?? 'unprepared';
      const sources = Array.isArray(provider?.downloadSources) ? provider.downloadSources : [];
      const estimate = provider?.setupEstimate?.recommendedDiskBytes;
      const total = Number(preparation.totalBytes ?? 0);
      const done = Number(preparation.completedBytes ?? 0);
      const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
      const step = preparation.step ?? 'check';
      const ready = phase === 'ready' || phase === 'standby';
      const failed = phase === 'failed';
      const running =
        state.preparing ||
        phase === 'checking' ||
        phase === 'downloading' ||
        phase === 'loading' ||
        phase === 'cancelling';
      return h(
        'div',
        { className: 'vl-overlay' },
        h(
          'div',
          { className: 'vl-panel', role: 'dialog', 'aria-label': t('setup.title') },
          h(
            'div',
            { className: 'vl-head' },
            h('span', { className: 'vl-title' }, t('setup.title')),
            h('span', { className: 'vl-sep' }),
            state.notice ? h('span', { className: 'vl-sub' }, state.notice) : null,
          ),
          h(
            'p',
            { className: 'vl-note' },
            ready ? t('setup.ready') : t('setup.body', { size: formatBytes(estimate || 260 * 1024 * 1024) }),
          ),
          running
            ? h(
                'div',
                null,
                h(
                  'div',
                  { className: 'vl-row', style: { justifyContent: 'space-between' } },
                  h('span', { className: 'vl-note' }, t(`setup.step.${step}`)),
                  h(
                    'span',
                    { className: 'vl-sub' },
                    total > 0 ? `${formatBytes(done)} / ${formatBytes(total)} · ${percent}%` : t('setup.preparing'),
                  ),
                ),
                h(
                  'div',
                  {
                    className: 'vl-progress',
                    'data-indeterminate': total > 0 ? 'false' : 'true',
                    style: { marginTop: '6px' },
                  },
                  h('i', { style: { width: `${percent}%` } }),
                ),
              )
            : null,
          failed
            ? h('p', { className: 'vl-note', 'data-tone': 'error' }, t('setup.failed', { message: preparation.message ?? state.prepareError ?? '' }))
            : null,
          state.prepareError && !failed
            ? h('p', { className: 'vl-note', 'data-tone': 'error' }, state.prepareError)
            : null,
          !running && !ready && sources.length > 0
            ? h(
                'div',
                { className: 'vl-row' },
                h('span', { className: 'vl-note' }, t('setup.source')),
                h(
                  'select',
                  {
                    className: 'vl-select',
                    value: state.downloadSource,
                    onChange: (event) => store.set({ downloadSource: event.target.value }),
                  },
                  h('option', { value: '' }, t('setup.sourceAuto')),
                  sources.map((source) =>
                    h('option', { key: source, value: source }, source.replace(/^https?:\/\//, '')),
                  ),
                ),
              )
            : null,
          h(
            'div',
            { className: 'vl-actions' },
            ready
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'vl-btn',
                    'data-primary': 'true',
                    onClick: () => {
                      ensureAudio();
                      store.set({ phase: 'idle', setupOpen: false, notice: '' });
                      void begin(engine.inputActions, engine.sessionId, false);
                    },
                  },
                  t('setup.start'),
                )
              : running
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'vl-btn',
                      onClick: () => void cancelPreparation(state.providerId),
                    },
                    t('setup.cancel'),
                  )
                : h(
                    'button',
                    {
                      type: 'button',
                      className: 'vl-btn',
                      'data-primary': 'true',
                      onClick: () => void prepare(state.providerId, state.downloadSource),
                    },
                    failed ? t('setup.retry') : t('setup.download'),
                  ),
            h('span', { className: 'vl-grow' }),
            h(
              'button',
              {
                type: 'button',
                className: 'vl-btn',
                'data-quiet': 'true',
                onClick: dismissSetup,
              },
              t('setup.later'),
            ),
          ),
          h('div', { className: 'vl-note' }, t('setup.disk', { size: formatBytes(estimate || 260 * 1024 * 1024) })),
        ),
      );
    }

    function ErrorPanel(props) {
      const state = useStore();
      const t = props.t;
      if (state.phase !== 'error') return null;
      const key = `error.${state.error}`;
      const translated = t(key);
      const text = translated && translated !== key ? translated : state.error;
      return h(
        'div',
        { className: 'vl-overlay' },
        h(
          'div',
          { className: 'vl-panel', role: 'alertdialog', 'aria-label': t('error.title') },
          h('div', { className: 'vl-head' }, h('span', { className: 'vl-title' }, t('error.title'))),
          h('p', { className: 'vl-note', 'data-tone': 'error' }, text),
          h(
            'div',
            { className: 'vl-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'vl-btn',
                'data-primary': 'true',
                onClick: () => {
                  ensureAudio();
                  store.set({ phase: 'idle', error: '' });
                  void begin(engine.inputActions, engine.sessionId, false);
                },
              },
              t('error.retry'),
            ),
            h('span', { className: 'vl-grow' }),
            h(
              'button',
              {
                type: 'button',
                className: 'vl-btn',
                'data-quiet': 'true',
                onClick: () => {
                  resetSessionState();
                  store.set({ phase: 'idle' });
                },
              },
              t('error.close'),
            ),
          ),
        ),
      );
    }

    function formatDate(ms) {
      const value = Number(ms);
      if (!Number.isFinite(value) || value <= 0) return '';
      try {
        return new Intl.DateTimeFormat(undefined, {
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        }).format(new Date(value));
      } catch {
        return new Date(value).toLocaleString();
      }
    }

    function PanelIcon(props) {
      const size = props?.size || 18;
      const active = Boolean(props?.active);
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          style: { display: 'block', color: active ? 'var(--dsw-alias-brand-primary)' : 'currentColor' },
        },
        h('rect', { x: 9, y: 2.5, width: 6, height: 11, rx: 3 }),
        h('path', { d: 'M6 11a6 6 0 0 0 12 0M12 17v3.5M9 20.5h6' }),
        h('path', { d: 'M3.5 7v3M20.5 7v3' }),
      );
    }

    function StudioTranslation(props) {
      const t = props.t;
      const state = props.state;
      const live = state.translationText;
      return h(
        'div',
        { className: 'vls-live-translation' },
        h(
          'div',
          { className: 'vl-label' },
          t('live.translation'),
          h('b', null, state.translationLabel || '译'),
        ),
        live
          ? h('p', { className: 'vls-trans-text' }, live)
          : h(
              'p',
              { className: 'vl-note' },
              state.translating ? t('live.translating') : t('bar.translateOn'),
            ),
        state.translateError ? h('p', { className: 'vls-error' }, state.translateError) : null,
      );
    }

    function highlighted(text, term) {
      const clean = term.trim();
      if (!text || !clean) return text;
      const lower = text.toLowerCase();
      const needle = clean.toLowerCase();
      const content = [];
      let from = 0;
      let at = lower.indexOf(needle);
      while (at !== -1) {
        content.push(text.slice(from, at), h('mark', { key: at }, text.slice(at, at + needle.length)));
        from = at + needle.length;
        at = lower.indexOf(needle, from);
      }
      content.push(text.slice(from));
      return content;
    }

    function segmentAtTime(segments, seconds) {
      return segments?.find((part) => seconds >= part.start && seconds < part.end)?.sequence ?? null;
    }

    function ReportTemplateSelect({ value, setValue, t, disabled, allowAuto }) {
      const choices = allowAuto ? ['auto', 'meeting', 'learning'] : ['meeting', 'learning'];
      return h('label', { className: 'vls-lang' }, t('report.kind'),
        h('select', { className: 'vl-select', value, disabled, onChange: (event) => setValue(event.target.value) },
          choices.map((kind) => h('option', { key: kind, value: kind }, t(`report.kind.${kind}`)))));
    }

    function ReportLanguageSelect({ value, setValue, t, disabled }) {
      return h('label', { className: 'vls-lang' },
        t('report.language'),
        h('select', {
          className: 'vl-select', value, disabled,
          onChange: (event) => setValue(event.target.value),
        }, REPORT_LANGUAGES.map(([code, label]) => h('option', { key: code, value: code }, code === 'auto' ? t(label) : label))),
      );
    }

    async function openTranscriptDraft({ sessions, conversation, workspace, workspaces }, { title, text, excerpt }, t) {
      const source = text.trim();
      if (!source || !sessions?.create || !sessions?.using ||
          !conversation?.input?.requestDraftInitialization || !workspace?.openSession || !workspaces?.list) {
        throw new Error(t('share.unavailable'));
      }
      const catalog = workspaces.list.getSnapshot();
      if (catalog.phase !== 'ready') throw new Error(t('share.unavailable'));
      const byId = sessions.list.getSnapshot().byId;
      let target;
      let latest = -Infinity;
      for (const item of catalog.items) {
        const lastSession = item.sessionIds.reduce((time, id) => Math.max(time, byId[id]?.updatedAt ?? -Infinity), -Infinity);
        const activity = lastSession === -Infinity ? Date.parse(item.createdAt) : lastSession;
        if (!target || activity > latest) {
          target = item;
          latest = activity;
        }
      }
      if (!target) throw new Error(t('share.workspaceRequired'));
      const sessionId = await sessions.create({ workspaceId: target.workspaceId });
      const instruction = t(excerpt ? 'share.selectedIntro' : 'share.intro', { title });
      const prompt = [instruction, source, t('share.question')].join('\n\n');
      await sessions.using(sessionId, { source: 'controllerOperation' }, (reference) => {
        const result = conversation.input.requestDraftInitialization(reference.binding, {
          prompt,
          whenDraftExists: 'keep',
        });
        if (result !== 'applied') throw new Error(t('share.unavailable'));
        workspace.openSession(sessionId);
      });
    }

    function readTranscriptSelection(root, selection) {
      if (!root || !selection || selection.isCollapsed || !selection.rangeCount) return null;
      const region = (node) => (node?.nodeType === 1 ? node : node?.parentElement)
        ?.closest('[data-vls-transcript]');
      if (!root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return null;
      const anchor = region(selection.anchorNode);
      const focus = region(selection.focusNode);
      const range = selection.getRangeAt(0);
      const visible = (block) => {
        if (block.closest?.('[hidden]')) return false;
        for (let details = block.closest?.('details:not([open])'); details; details = details.parentElement?.closest('details:not([open])')) {
          const summary = Array.from(details.children).find((child) => child.tagName === 'SUMMARY');
          if (!summary?.contains(block)) return false;
        }
        return typeof block.getClientRects !== 'function' || block.getClientRects().length > 0;
      };
      const prefix = (block) => block?.dataset?.meetingPrefix || '';
      let text = '';
      if (anchor && anchor === focus && root.contains(anchor) && visible(anchor)) {
        const selected = selection.toString().trim();
        if (selected) text = prefix(anchor) + selected;
      } else {
        const pieces = [];
        for (const block of root.querySelectorAll('[data-vls-transcript]')) {
          if (!visible(block) || !range.intersectsNode(block)) continue;
          const clip = range.cloneRange();
          clip.selectNodeContents(block);
          if (clip.compareBoundaryPoints(Range.START_TO_START, range) < 0) {
            clip.setStart(range.startContainer, range.startOffset);
          }
          if (clip.compareBoundaryPoints(Range.END_TO_END, range) > 0) {
            clip.setEnd(range.endContainer, range.endOffset);
          }
          const piece = clip.toString().trim();
          if (piece) pieces.push(prefix(block) + piece);
        }
        text = pieces.join('\n');
      }
      if (!text) return null;
      const rect = range.getBoundingClientRect();
      const bounds = root.getBoundingClientRect();
      if (rect.bottom <= bounds.top || rect.top >= bounds.bottom) return null;
      return { text, x: (rect.left + rect.right) / 2, top: rect.top, bottom: rect.bottom };
    }

    function CheckGauge({ percent, t, state }) {
      const ready = typeof percent === 'number';
      const angle = Math.PI * (1 - (percent ?? 0) / 100);
      const x = 120 + 79 * Math.cos(angle), y = 110 - 79 * Math.sin(angle);
      return h('div', { className: 'vls-check-gauge', role: 'img',
        'aria-label': ready ? t('check.score', { n: percent }) : t(`check.${state}`) },
        h('svg', { viewBox: '0 0 240 158', 'aria-hidden': true },
          h('path', { d: 'M 22 110 A 98 98 0 0 1 71 25.13', fill: 'none', stroke: '#41947b', strokeWidth: 12 }),
          h('path', { d: 'M 71 25.13 A 98 98 0 0 1 169 25.13', fill: 'none', stroke: '#d2a246', strokeWidth: 12 }),
          h('path', { d: 'M 169 25.13 A 98 98 0 0 1 218 110', fill: 'none', stroke: '#c8736a', strokeWidth: 12 }),
          ready ? h('g', null,
            h('line', { x1: 120, y1: 110, x2: x, y2: y, stroke: 'currentColor', strokeWidth: 3, strokeLinecap: 'round' }),
            h('circle', { cx: 120, cy: 110, r: 5, fill: 'currentColor' }),
          ) : null,
          h('text', { x: 22, y: 135, textAnchor: 'middle', fill: 'currentColor', fontSize: 12 }, '0'),
          h('text', { x: 120, y: 37, textAnchor: 'middle', fill: 'currentColor', fontSize: 11 }, '50'),
          h('text', { x: 218, y: 135, textAnchor: 'middle', fill: 'currentColor', fontSize: 12 }, '100'),
          h('text', { x: 120, y: 151, textAnchor: 'middle', fill: 'currentColor', fontSize: ready ? 27 : 15, fontWeight: 600 },
            ready ? t('check.approx', { n: percent }) : t(`check.${state}`)),
        ),
      );
    }

    function MeetingCheck({ id, t, seek, audioAvailable, onChanged, sourceVersion }) {
      const [data, setData] = React.useState(null);
      const [topic, setTopic] = React.useState('');
      const [filter, setFilter] = React.useState('all');
      const [error, setError] = React.useState('');
      const [stage, setStage] = React.useState('loading');
      const [compact, setCompact] = React.useState(false);
      const [language, setLanguage] = React.useState(t('check.locale'));
      const activeRequest = React.useRef(null);
      const endpoint = `/recordings/${id}/check`;
      const source = data?.source, analysis = data?.check;
      const pending = ['loading', 'analyzing', 'saving'].includes(stage);

      const failureText = (failure) => Object.hasOwn(EN, `check.${failure.code}`)
        ? t(`check.${failure.code}`) : messageOf(failure);

      React.useEffect(() => {
        setStage('loading');
        setData(null);
        const controller = new AbortController();
        fetch(`${API}${endpoint}`, { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) })
          .then(readJsonResponse)
          .then((body) => { if (!controller.signal.aborted) { setData(body); setTopic(body.check?.topic ?? ''); setLanguage(body.check?.language ?? t('check.locale')); setStage('idle'); } })
          .catch((failure) => { if (!controller.signal.aborted) { setError(failureText(failure)); setStage('idle'); } });
        return () => { controller.abort(); activeRequest.current?.abort(); };
      }, [endpoint, sourceVersion]);

      async function analyze() {
        if (pending || source?.state !== 'ready') return;
        setError('');
        const controller = new AbortController();
        activeRequest.current = controller;
        setStage('analyzing');
        store.set((state) => ({ ...state, checkJobs: (state.checkJobs ?? 0) + 1 }));
        try {
          const model = (await fetchStatus()).model;
          if (!modelKey(model)) throw new Error(t('model.unavailable'));
          controller.signal.throwIfAborted();
          if (!window.confirm(t('check.consent', {
            model: `${model.provider} / ${model.model}`, n: source.chars,
          }))) return;
          const response = await fetch(`${API}${endpoint}`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sourceHash: source.hash, analysisId: analysis?.id ?? null, revision: analysis?.revision ?? 0, topic, model, language }),
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(310_000)]),
          });
          const body = await readJsonResponse(response);
          setData((previous) => ({ ...previous, check: body.check }));
          setCompact(false);
          setFilter('all');
          onChanged();
        } catch (failure) {
          setError(controller.signal.aborted ? t('check.cancelled') : failureText(failure));
        } finally {
          activeRequest.current = null;
          setStage('idle');
          store.set((state) => ({ ...state, checkJobs: Math.max(0, (state.checkJobs ?? 0) - 1) }));
        }
      }

      async function retain(unit) {
        if (pending) return;
        setStage('saving'); setError('');
        try {
          const body = await request(endpoint, { method: 'PATCH', json: {
            analysisId: analysis.id, unitId: unit.id, retained: !unit.retained,
          } });
          setData((previous) => ({ ...previous, check: body.check }));
          onChanged();
        } catch (failure) { setError(failureText(failure)); }
        finally { setStage('idle'); }
      }

      const gaugeState = stage === 'analyzing' ? 'analyzing' : stage === 'loading' ? 'loading'
        : analysis?.stale ? 'stale' : analysis ? 'unassessable' : source?.state === 'ready' ? 'waiting' : 'unassessable';
      const percent = stage === 'analyzing' || stage === 'loading' ? null : analysis?.percent ?? null;
      const cats = ['repeat', 'filler', 'offtopic', 'uncertain', 'keep'];
      const rows = analysis?.units.filter((unit) => filter === 'all'
        ? unit.category !== 'keep' || unit.retained
        : filter === 'keep' ? unit.category === 'keep' || unit.retained : unit.category === filter && !unit.retained);

      return h('section', { className: 'vls-check', 'aria-label': t('check.title') },
        h('h3', null, t('check.title')),
        h('div', { className: 'vls-check-overview' },
          h('div', null, h('div', { className: 'vl-label' }, t('check.headline')),
            h(CheckGauge, { percent, t, state: gaugeState }),
            h('p', { className: 'vl-note' }, t('check.metric'))),
          h('div', null,
            h('p', { className: 'vl-note' }, t('check.explanation')),
            analysis ? h('p', { className: 'vl-note' },
              t('check.counts', { removed: analysis.removed, total: analysis.total, uncertain: analysis.uncertain })) : null,
            source && source.state !== 'ready' ? h('p', { className: 'vl-note' }, t(`check.${source.state}`)) : null,
            analysis?.stale ? h('p', { className: 'vls-error' }, t('check.changed')) : null,
          )),
        h('label', { className: 'vls-lang' }, t('check.topic'),
          h('input', { className: 'vls-input', value: topic, maxLength: 300, disabled: pending,
            placeholder: t('check.topicHint'), onChange: (event) => setTopic(event.target.value) })),
        h('details', null, h('summary', { className: 'vl-note' }, t('check.preview', { n: source?.chars ?? 0 })),
          h('p', { className: 'vls-report-text' }, source?.text || '—')),
        h('label', { className: 'vls-lang' }, t('check.language'),
          h('select', { className: 'vl-select', value: language, disabled: pending,
            onChange: (event) => setLanguage(event.target.value) },
            h('option', { value: 'zh' }, '简体中文'), h('option', { value: 'en' }, 'English'))),
        h('div', { className: 'vls-options-row' },
          h('button', { type: 'button', className: 'vl-btn', disabled: pending || source?.state !== 'ready',
            onClick: analyze }, t(analysis ? 'check.regenerate' : 'check.analyze')),
          stage === 'analyzing' ? h('button', { type: 'button', className: 'vls-mini',
            onClick: () => activeRequest.current?.abort() }, t('studio.cancel')) : null,
          analysis && !analysis.stale ? h('button', { type: 'button', className: 'vls-mini', 'aria-expanded': compact,
            onClick: () => setCompact(!compact) }, t('check.compact')) : null,
        ),
        error ? h('p', { className: 'vls-error', role: 'alert' }, error) : null,
        analysis ? h(React.Fragment, null,
          h('p', { className: 'vl-note' }, t('check.modelUsed', {
            model: `${analysis.model.provider} / ${analysis.model.model}`, topic: analysis.topic || t('check.noTopic'),
          })),
          h('div', { className: 'vls-options-row', role: 'group', 'aria-label': t('check.categories') },
            h('button', { type: 'button', className: 'vls-mini', 'aria-pressed': filter === 'all',
              onClick: () => setFilter('all') }, t('check.all')),
            cats.map((category) => h('button', { key: category, type: 'button', className: 'vls-mini',
              'aria-pressed': filter === category, onClick: () => setFilter(category) },
              t(`check.${category}`), ' ', analysis.total ? Math.round(analysis.counts[category] / analysis.total * 100) : 0, '%')),
          ),
          compact && !analysis.stale ? h('div', null,
            h('p', { className: 'vl-note' }, t('check.compactHint')),
            h('p', { className: 'vls-report-text' }, analysis.compact || t('check.emptyCompact'))) : null,
          h('ol', { className: 'vls-segments vls-check-evidence' }, rows.map((unit) =>
            h('li', { className: 'vls-check-unit', key: unit.id },
              h('div', { className: 'vls-options-row' },
                h('b', null, t(`check.${unit.retained ? 'keep' : unit.category}`)),
                unit.start !== null && audioAvailable ? h('button', { type: 'button', className: 'vls-mini',
                  title: t('check.parentTime'), onClick: () => seek(unit.start) }, formatTime(unit.start)) : null,
                unit.category !== 'keep' ? h('button', { type: 'button', className: 'vls-mini', disabled: pending || analysis.stale,
                  'aria-pressed': unit.retained, onClick: () => void retain(unit) },
                  t(unit.retained ? 'check.undoRetain' : 'check.retain')) : null,
              ),
              h('blockquote', null, unit.text),
              h('p', { className: 'vl-note' }, unit.reason),
            ),
          )),
          !rows.length ? h('p', { className: 'vl-note' }, t('check.noMatches')) : null,
        ) : null,
      );
    }

    function MeetingInterpretation({ id, t, seek, audioAvailable, onChanged, sourceVersion }) {
      const [data, setData] = React.useState(null);
      const [topic, setTopic] = React.useState('');
      const [language, setLanguage] = React.useState(t('check.locale'));
      const [stage, setStage] = React.useState('loading');
      const [error, setError] = React.useState('');
      const activeRequest = React.useRef(null);
      const endpoint = `/recordings/${id}/interpretation`;
      const source = data?.source, report = data?.report;
      const pending = stage !== 'idle';
      const failureText = (failure) => Object.hasOwn(EN, `interpret.${failure.code}`)
        ? t(`interpret.${failure.code}`) : Object.hasOwn(EN, `check.${failure.code}`)
          ? t(`check.${failure.code}`) : messageOf(failure);

      React.useEffect(() => {
        setData(null); setStage('loading'); setError('');
        const controller = new AbortController();
        fetch(`${API}${endpoint}`, { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) })
          .then(readJsonResponse)
          .then((body) => {
            if (controller.signal.aborted) return;
            setData(body); setTopic(body.report?.topic ?? '');
            setLanguage(body.report?.language ?? t('check.locale')); setStage('idle');
          })
          .catch((failure) => { if (!controller.signal.aborted) { setError(failureText(failure)); setStage('idle'); } });
        return () => { controller.abort(); activeRequest.current?.abort(); };
      }, [endpoint, sourceVersion]);

      async function analyze() {
        if (pending || source?.state !== 'ready') return;
        const controller = new AbortController();
        activeRequest.current = controller;
        setError(''); setStage('analyzing');
        store.set((state) => ({ ...state, checkJobs: (state.checkJobs ?? 0) + 1 }));
        try {
          const model = (await fetchStatus()).model;
          if (!modelKey(model)) throw new Error(t('model.unavailable'));
          controller.signal.throwIfAborted();
          if (!window.confirm(t('interpret.consent', { model: `${model.provider} / ${model.model}`, n: source.chars }))) return;
          const response = await fetch(`${API}${endpoint}`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sourceHash: source.hash, analysisId: report?.id ?? null, topic, language, model }),
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(310_000)]),
          });
          const body = await readJsonResponse(response);
          controller.signal.throwIfAborted();
          setData((previous) => ({ ...previous, report: body.report }));
          onChanged();
        } catch (failure) { setError(controller.signal.aborted ? t('check.cancelled') : failureText(failure)); }
        finally {
          activeRequest.current = null; setStage('idle');
          store.set((state) => ({ ...state, checkJobs: Math.max(0, (state.checkJobs ?? 0) - 1) }));
        }
      }

      return h('section', { className: 'vls-check vls-interpretation', 'aria-label': t('interpret.title') },
        h('h3', null, t('interpret.title')),
        h('p', { className: 'vl-note' }, t('interpret.notice')),
        h('label', { className: 'vls-lang' }, t('check.topic'),
          h('input', { className: 'vls-input', value: topic, maxLength: 300, disabled: pending,
            placeholder: t('interpret.topicHint'), onChange: (event) => setTopic(event.target.value) })),
        h('label', { className: 'vls-lang' }, t('check.language'),
          h('select', { className: 'vl-select', value: language, disabled: pending,
            onChange: (event) => setLanguage(event.target.value) },
            h('option', { value: 'zh' }, '简体中文'), h('option', { value: 'en' }, 'English'))),
        h('details', null, h('summary', { className: 'vl-note' }, t('check.preview', { n: source?.chars ?? 0 })),
          h('p', { className: 'vls-report-text' }, source?.text || '—')),
        source && source.state !== 'ready' ? h('p', { className: 'vl-note' }, t(`check.${source.state}`)) : null,
        report?.stale ? h('p', { className: 'vls-error', role: 'status' }, t('interpret.changed')) : null,
        h('div', { className: 'vls-options-row' },
          h('button', { type: 'button', className: 'vl-btn', disabled: pending || source?.state !== 'ready', onClick: analyze },
            t(report ? 'check.regenerate' : 'check.analyze')),
          stage === 'analyzing' ? h('button', { type: 'button', className: 'vls-mini', onClick: () => activeRequest.current?.abort() }, t('studio.cancel')) : null,
          report && !report.stale && !pending ? h('a', { className: 'vls-mini', download: true,
            href: `${API}${endpoint}?format=txt&locale=${report.language}` }, t('interpret.export')) : null,
        ),
        pending ? h('p', { className: 'vl-note', role: 'status' }, t(`check.${stage}`)) : null,
        error ? h('p', { className: 'vls-error', role: 'alert' }, error) : null,
        !report && !pending ? h('p', { className: 'vl-note' }, t('interpret.waiting')) : null,
        report ? h(React.Fragment, null,
          h('p', { className: 'vl-note' }, t('check.modelUsed', {
            model: `${report.model.provider} / ${report.model.model}`, topic: report.topic || t('check.noTopic'),
          }), ' · ', formatDate(Date.parse(report.createdAt))),
          !report.items.length && !report.stale ? h('p', { className: 'vl-note' }, t('interpret.empty')) : null,
          h('ol', { className: 'vls-segments' }, report.items.map((item) => h('li', { className: 'vls-check-unit', key: item.unitIds.join('-') },
            h('div', { className: 'vls-options-row' }, h('b', null, t('interpret.quote')),
              item.start !== null && audioAvailable ? h('button', { type: 'button', className: 'vls-mini',
                title: t('check.parentTime'), onClick: () => seek(item.start) }, formatTime(item.start)) : null),
            h('blockquote', null, item.quote),
            item.before || item.after ? h('details', null,
              h('summary', { className: 'vl-note' }, t('interpret.context')),
              item.before ? h('p', { className: 'vls-report-text' }, t('interpret.before'), '：', item.before) : null,
              item.after ? h('p', { className: 'vls-report-text' }, t('interpret.after'), '：', item.after) : null) : null,
            h('dl', null,
              h('dt', null, t('interpret.literal')), h('dd', null, item.literal),
              h('dt', null, t('interpret.possible')), h('dd', null, item.status === 'uncertain' ? t('interpret.unknown') : item.possible),
              h('dt', null, t('interpret.alternatives')), h('dd', null, h('ul', null, item.alternatives.map((value, i) => h('li', { key: i }, value)))),
              h('dt', null, t('interpret.uncertainty')), h('dd', null,
                item.attributionUncertain ? t('interpret.attribution') + ' ' : '', item.uncertainty),
              h('dt', null, t('interpret.question')), h('dd', null, item.question),
            ),
          ))),
        ) : null,
      );
    }

    function HistoryItem({ item, t, query, onChanged, copy, copiedId, removeItem, importing, refreshVersion, meetingJob }) {
      const [details, setDetails] = React.useState(null);
      const [expanded, setExpanded] = React.useState(false);
      const [tool, setTool] = React.useState('');
      const [speakerCount, setSpeakerCount] = React.useState(0);
      const [meetingEditing, setMeetingEditing] = React.useState(null);
      const [meetingSearch, setMeetingSearch] = React.useState(null);
      const [moreOpen, setMoreOpen] = React.useState(false);
      const [busy, setBusy] = React.useState('');
      const [error, setError] = React.useState('');
      const [rename, setRename] = React.useState(false);
      const [title, setTitle] = React.useState(item.title);
      const [playingPart, setPlayingPart] = React.useState(null);
      const [jump, setJump] = React.useState(null);
      const [editing, setEditing] = React.useState(null);
      const [correction, setCorrection] = React.useState('');
      const [recordingQuery, setRecordingQuery] = React.useState('');
      const [selection, setSelection] = React.useState(null);
      const [recognitionLanguage, setRecognitionLanguage] = React.useState(item.language || 'auto');
      const selectedReportKind = details?.reportKind ?? item.reportKind ?? (item.source === 'system' ? 'learning' : 'meeting');
      const [reportLanguage, setReportLanguage] = React.useState(store.get().reportLanguage);
      const audioRef = React.useRef(null);
      const transcriptRoot = React.useRef(null);
      const segmentList = React.useRef(null);
      const cardTop = React.useRef(null);
      const meetingRoot = React.useRef(null);
      const path = `/recordings/${item.id}`;
      const itemMeetingJob = meetingJob?.id === item.id ? meetingJob : null;
      const original = details?.text ?? item.text;
      const text = details?.correctedText ?? original;
      const shownQuery = recordingQuery.trim() || query;
      const term = shownQuery.trim().toLowerCase();
      const segmentMatches = (part) => Boolean(term &&
        [part.text, part.correction].some((value) => value?.toLowerCase().includes(term)));

      async function fetchDetails(signal) {
        const result = await fetch(`${API}${path}`, { cache: 'no-store', signal });
        return (await readJsonResponse(result)).recording;
      }

      React.useEffect(() => {
        if (!expanded && !moreOpen && !['report', 'meeting'].includes(tool)) return;
        const controller = new AbortController();
        fetchDetails(controller.signal)
          .then((recording) => { if (!controller.signal.aborted) setDetails(recording); })
          .catch((failure) => { if (!controller.signal.aborted) setError(messageOf(failure)); });
        return () => controller.abort();
      }, [expanded, tool, moreOpen, path, refreshVersion, item.status, item.segmentCount, item.pendingCount, item.hasCorrections, item.hasMeeting, itemMeetingJob?.phase]);

      React.useEffect(() => {
        if (!expanded && tool !== 'meeting') {
          setSelection(null);
          return;
        }
        const update = () => {
          const selected = window.getSelection();
          setSelection(readTranscriptSelection(meetingRoot.current, selected) ??
            readTranscriptSelection(transcriptRoot.current, selected));
        };
        document.addEventListener('selectionchange', update);
        window.addEventListener('scroll', update, true);
        return () => {
          document.removeEventListener('selectionchange', update);
          window.removeEventListener('scroll', update, true);
        };
      }, [expanded, tool]);

      React.useEffect(() => {
        if (!jump || jump.term !== term || !expanded || !details?.segments || !segmentList.current) return;
        const matches = details.segments.filter(segmentMatches);
        const part = matches.length ? matches[jump.index % matches.length] : undefined;
        const row = part && segmentList.current.querySelector(`[data-sequence="${part.sequence}"]`);
        row?.scrollIntoView({ block: 'nearest' });
        row?.focus({ preventScroll: true });
      }, [jump, term, expanded, details]);

      function syncPlayback(audio = audioRef.current) {
        if (!audio) return;
        setPlayingPart(segmentAtTime(details?.segments, audio.currentTime));
      }

      React.useEffect(() => { syncPlayback(); }, [details]);

      function locateMatch() {
        setError('');
        setExpanded(true);
        setJump((previous) => ({ term, index: previous?.term === term ? previous.index + 1 : 0 }));
      }

      async function run(key, work) {
        setBusy(key);
        setError('');
        try {
          await work();
        } catch (failure) {
          setError(messageOf(failure));
        } finally {
          setBusy('');
        }
      }

      function foldTranscript(restoreFocus) {
        setExpanded(false);
        setJump(null);
        setSelection(null);
        if (restoreFocus) {
          cardTop.current?.scrollIntoView({ block: 'nearest' });
          cardTop.current?.focus({ preventScroll: true });
        }
      }

      async function copyOriginal() {
        const recording = details ?? await fetchDetails();
        await copy(recording.text, item.id);
      }

      function share(excerpt) {
        if (busy) return;
        void run('share', async () => {
          const recording = excerpt ? item : (details ?? await fetchDetails());
          await openTranscriptDraft(transcriptSharing, {
            title: recording.title,
            text: excerpt ?? recordingText(recording, t),
            excerpt: Boolean(excerpt),
          }, t);
        });
      }

      function chooseReportKind(reportKind) {
        if (busy || reportKind === selectedReportKind) return;
        void run('report-template', async () => {
          const { recording } = await request(path, { method: 'PATCH', json: { reportKind } });
          setDetails(recording);
          onChanged();
        });
      }

      function generateReport() {
        if (busy) return;
        void run('report', async () => {
          const recording = await fetchDetails();
          if (recording.reportPending) throw new Error(t('report.pending'));
          const transcript = recordingText(recording, t).trim();
          if (!transcript) return;
          const model = (await fetchStatus()).model;
          if (!modelKey(model)) throw new Error(t('model.unavailable'));
          if (!window.confirm(t('report.send', { model: `${model.provider} / ${model.model}` }))) return;
          const report = await createMeetingReport(transcript, model, reportLanguage, selectedReportKind);
          const { recording: updated } = await request(path, {
            method: 'PATCH', json: { report, reportKind: selectedReportKind, reportSource: recording.reportSource },
          });
          setDetails(updated);
          onChanged();
        });
      }

      async function retry(part) {
        const result = await request(`${path}/segments/${part.sequence}/retry`);
        setDetails(result.recording);
        onChanged();
        if (result.segment.state !== 'ready') throw new Error(result.segment.error || t('archive.segmentFailed'));
      }

      async function renameRecording(event) {
        event.preventDefault();
        if (!title.trim()) return;
        await run('rename', async () => {
          const { recording } = await request(path, { method: 'PATCH', json: { title } });
          setDetails(recording);
          setRename(false);
          onChanged();
        });
      }

      function startCorrection(key, value) {
        setEditing(key);
        setCorrection(value);
      }

      async function saveCorrection(key, value) {
        await run('correction', async () => {
          const target = key === 'whole' ? path : `${path}/segments/${key}`;
          const { recording } = await request(target, { method: 'PATCH', json: { correction: value } });
          setDetails(recording);
          setEditing(null);
          onChanged();
        });
      }

      function correctionControls(key, raw, corrected) {
        if (editing !== key) {
          return h('button', { type: 'button', className: 'vls-mini', disabled: editing !== null || !!busy,
            onClick: () => startCorrection(key, corrected ?? raw) }, t('history.correct'));
        }
        return h('form', { className: 'vls-correct', onSubmit: (event) => {
          event.preventDefault();
          void saveCorrection(key, correction);
        } },
          h('textarea', { className: 'vls-input', value: correction, 'aria-label': t('history.correction'),
            maxLength: key === 'whole' ? 200_000 : 20_000, rows: 3,
            onChange: (event) => setCorrection(event.target.value) }),
          h('div', { className: 'vls-item-actions' },
            h('button', { type: 'submit', className: 'vls-mini', disabled: !!busy }, t('history.save')),
            corrected !== undefined ? h('button', { type: 'button', className: 'vls-mini', disabled: !!busy,
              onClick: () => void saveCorrection(key, null) }, t('history.restore')) : null,
            h('button', { type: 'button', className: 'vls-mini', disabled: !!busy,
              onClick: () => setEditing(null) }, t('studio.cancel')),
          ),
        );
      }

      function seek(seconds) {
        const audio = audioRef.current;
        if (!audio) return;
        setError('');
        try {
          audio.currentTime = seconds;
          syncPlayback(audio);
          void audio.play().catch((failure) => setError(messageOf(failure)));
        } catch (failure) {
          setError(messageOf(failure));
        }
      }

      function updateMeeting(patch) {
        void run('meetingEdit', async () => {
          const { recording } = await request(`${path}/meeting`, {
            method: 'PATCH', json: { ...patch, revision: details.meeting.revision },
          });
          setDetails(recording);
          setMeetingEditing(null);
          onChanged();
        });
      }

      function analyze() {
        void run('meeting', async () => {
          const recording = await fetchDetails();
          if (recording.meeting && !window.confirm(t('meeting.replace'))) return;
          const result = await analyzeMeeting(recording, speakerCount);
          if (result) {
            setDetails(result);
            setMeetingEditing(null);
            onChanged();
          }
        });
      }

      function speakerPanel() {
        const meeting = details?.meeting;
        const activeJob = meetingJob?.active;
        const search = (meetingSearch ?? query).trim();
        const format = (turn) => meetingLabel(meeting, turn, t);
        const rows = meeting?.turns.filter((turn) => !search ||
          [format(turn), turn.correction ?? turn.text].some((value) => value.toLowerCase().includes(search.toLowerCase())));
        return h('section', { 'aria-label': t('meeting.view'), className: 'vls-meeting' },
          h('div', { className: 'vls-options-row' },
            h(SpeakerCount, { value: speakerCount, change: setSpeakerCount, disabled: activeJob || Boolean(busy), t }),
            h('button', { type: 'button', className: 'vls-mini', disabled: importing || activeJob || Boolean(busy), onClick: analyze },
              t(meeting ? 'meeting.again' : 'meeting.action')),
            meeting ? h('a', { className: 'vls-mini', download: true,
              href: `${API}${path}/transcript?variant=meeting&locale=${t('meeting.locale') === 'en' ? 'en' : 'zh'}` },
              t('meeting.export')) : null,
          ),
          meeting ? h(React.Fragment, null,
            h('p', { className: 'vl-note' }, t('meeting.hint')),
            h('details', null,
              h('summary', { className: 'vl-note' }, t('meeting.rename')),
              meeting.speakers.map((speaker) => h('form', { key: speaker.id, className: 'vls-options-row',
                onSubmit: (event) => {
                  event.preventDefault();
                  const name = String(new FormData(event.currentTarget).get('name') ?? '');
                  updateMeeting({ kind: 'speaker', speakerId: speaker.id, name });
                },
              },
                h('label', { className: 'vls-lang' }, t('meeting.speaker', { n: speaker.id }),
                  h('input', { key: speaker.name ?? '', name: 'name', className: 'vls-input',
                    maxLength: 80, defaultValue: speaker.name ?? '' })),
                h('button', { type: 'submit', className: 'vls-mini', disabled: Boolean(busy) }, t('history.save')),
              )),
            ),
            h('input', { type: 'search', className: 'vls-input vls-search', value: meetingSearch ?? query, maxLength: 200,
              'aria-label': t('history.searchThis'), placeholder: t('history.searchThis'),
              onChange: (event) => setMeetingSearch(event.target.value) }),
            h('div', { className: 'vls-transcript-open', ref: meetingRoot, tabIndex: 0, 'aria-label': t('meeting.view') },
              h('ol', { className: 'vls-segments' }, rows.map((turn) =>
                h('li', { className: 'vls-segment', key: turn.id },
                  h('button', { type: 'button', className: 'vls-mini vls-seek', onClick: () => seek(turn.start) },
                    `${formatTime(turn.start)}–${formatTime(turn.end)}`),
                  h('div', { className: 'vls-segment-text' },
                    h('strong', null, format(turn)), ' ',
                    h('span', { 'data-vls-transcript': true, 'data-meeting-prefix': meetingPrefix(meeting, turn, t) },
                      highlighted(turn.correction ?? turn.text, search) || t('meeting.emptyTurn')),
                  ),
                  meetingEditing === turn.id ? h('form', { className: 'vls-correct', onSubmit: (event) => {
                    event.preventDefault();
                    const form = new FormData(event.currentTarget);
                    const assigned = Number(form.get('speaker'));
                    const correction = String(form.get('correction') ?? '');
                    updateMeeting({ kind: 'turn', turnId: turn.id, speakerId: assigned || null,
                      correction: correction === turn.text ? null : correction });
                  } },
                    h('label', { className: 'vls-lang' }, t('meeting.assign'),
                      h('select', { name: 'speaker', className: 'vl-select', defaultValue: turn.speakerId ?? 0 },
                        h('option', { value: 0 }, t('meeting.unknown')),
                        meeting.speakers.map((speaker) => h('option', { key: speaker.id, value: speaker.id },
                          speaker.name || t('meeting.speaker', { n: speaker.id }))),
                      )),
                    h('textarea', { rows: 3, className: 'vls-input', name: 'correction',
                      'aria-label': t('history.correction'), maxLength: 20_000, defaultValue: turn.correction ?? turn.text }),
                    h('div', { className: 'vls-item-actions' },
                      h('button', { type: 'submit', className: 'vls-mini', disabled: Boolean(busy) }, t('history.save')),
                      h('button', { type: 'button', className: 'vls-mini', onClick: () => setMeetingEditing(null) }, t('studio.cancel')),
                    ),
                  ) : h('button', { type: 'button', className: 'vls-mini', disabled: Boolean(busy),
                    onClick: () => setMeetingEditing(turn.id) }, t('history.correct')),
                ),
              )),
            ),
          ) : null,
        );
      }

      const active = item.status === 'recording';
      const hasDetails = Boolean(original || text || item.segmentCount > 0 || item.hasCorrections);
      const hasTranscript = details?.meeting || item.hasMeeting || (details ? Boolean(text.trim()) : (item.hasTranscript ?? Boolean(text)));
      const matches = details?.segments?.filter(segmentMatches).length ?? 0;

      function retranscribe() {
        if (!item.audioUrl || importing) return;
        void importAudio(async () => {
          if (item.size > MAX_IMPORT_BYTES) throw new Error(t('import.tooLarge'));
          const response = await fetch(item.audioUrl, { cache: 'no-store' });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.blob();
        }, {
          title: t('import.copyTitle', { title: item.title.slice(0, 92) }),
          mimeType: item.mimeType || 'audio/webm',
          language: recognitionLanguage,
          source: 'retranscription',
          reportKind: selectedReportKind,
        });
      }
      const derived = (value, label) => value
        ? h('details', { className: 'vls-report-block' },
            h('summary', { className: 'vls-report-summary' }, label),
            h('div', { className: 'vls-report-text' }, value),
            h('button', { type: 'button', className: 'vl-btn', onClick: () => void copy(value, `${item.id}:${label}`) },
              copiedId === `${item.id}:${label}` ? t('studio.copied') : t('result.copy')),
          )
        : null;
      return h('li', { className: 'vls-item' },
        h('div', { className: 'vls-item-head' },
          h('span', { className: 'vls-item-title', title: item.title }, highlighted(item.title, query) || t('studio.noText')),
          h('span', null, formatDate(item.createdAt)),
          h('span', null, formatTime(item.duration)),
          h('span', null, item.size ? formatBytes(item.size) : t('studio.noAudio')),
        ),
        h('div', { className: 'vls-history-actions-row' },
          hasDetails ? h('button', {
            type: 'button', className: 'vls-mini', ref: cardTop, 'aria-expanded': expanded,
            onClick: () => expanded ? foldTranscript(false) : setExpanded(true),
          }, t(expanded ? 'history.foldTranscript' : item.segmentCount ? 'history.details' : 'history.fullText')) : null,
          hasTranscript && !active ? h('button', {
            type: 'button', className: 'vls-mini', 'data-primary': 'true', disabled: Boolean(busy),
            onClick: () => share(),
          }, t(busy === 'share' ? 'share.preparing' : 'share.transcript')) : null,
          !active && item.audioUrl ? h('button', {
            type: 'button', className: 'vls-mini', 'aria-expanded': tool === 'meeting',
            onClick: () => setTool(tool === 'meeting' ? '' : 'meeting'),
          }, t(item.hasMeeting || details?.meeting ? 'meeting.view' : 'meeting.action')) : null,
          !active && item.audioUrl ? h('button', {
            type: 'button', className: 'vls-mini', 'aria-expanded': tool === 'transcribe',
            disabled: importing || Boolean(busy), onClick: () => setTool(tool === 'transcribe' ? '' : 'transcribe'),
          }, t('import.retranscribe')) : null,
          !active && (hasTranscript || item.hasCheck) ? h('button', {
            type: 'button', className: 'vls-mini', 'aria-expanded': tool === 'check',
            onClick: () => setTool(tool === 'check' ? '' : 'check'),
          }, t('check.title')) : null,
          !active && (hasTranscript || item.hasInterpretation) ? h('button', {
            type: 'button', className: 'vls-mini', 'aria-expanded': tool === 'interpretation',
            onClick: () => setTool(tool === 'interpretation' ? '' : 'interpretation'),
          }, t('interpret.title')) : null,
          !active && (hasTranscript || item.hasReport) ? h('button', {
            type: 'button', className: 'vls-mini', 'aria-expanded': tool === 'report',
            onClick: () => setTool(tool === 'report' ? '' : 'report'),
          }, t('history.report')) : null,
          item.matchingSegments > 0 && term
            ? h('button', { type: 'button', className: 'vls-mini', onClick: locateMatch }, t('history.jump')) : null,
        ),
        h('details', { className: 'vls-item-tools', onToggle: (event) => setMoreOpen(event.currentTarget.open) },
          h('summary', { className: 'vl-note' }, t('history.tools')),
          h('div', { className: 'vls-item-actions' },
            original ? h('button', { type: 'button', className: 'vls-mini', disabled: !!busy,
              onClick: () => void run('copy', copyOriginal) }, copiedId === item.id ? t('studio.copied') : t('studio.copy')) : null,
            !active && item.downloadUrl
              ? h('a', { className: 'vls-mini', href: item.downloadUrl, download: true }, t('studio.download')) : null,
            !active && original ? h('a', { className: 'vls-mini', download: true,
              href: `${API}${path}/transcript?variant=original` }, t('history.exportOriginal')) : null,
            !active && item.hasCorrections ? h('a', { className: 'vls-mini', download: true,
              href: `${API}${path}/transcript?variant=corrected` }, t('history.exportCorrected')) : null,
            h('button', { type: 'button', className: 'vls-mini', disabled: active || !!busy,
              onClick: () => { setTitle(item.title); setRename(true); } }, t('history.rename')),
            h('button', { type: 'button', className: 'vls-mini', 'data-danger': 'true', disabled: active || !!busy,
              onClick: () => void removeItem(item) }, t('studio.delete')),
          ),
          derived(details?.editedText, t('model.edited')),
          derived(details?.translation, t('live.translation')),
        ),
        rename ? h('form', { className: 'vls-item-head', onSubmit: renameRecording },
          h('input', { className: 'vls-input', 'aria-label': t('history.title'), value: title, required: true,
            maxLength: 120, onChange: (event) => setTitle(event.target.value) }),
          h('button', { type: 'submit', className: 'vls-mini', disabled: !!busy || !title.trim() }, t('history.save')),
          h('button', { type: 'button', className: 'vls-mini', disabled: !!busy, onClick: () => setRename(false) }, t('studio.cancel')),
        ) : null,
        active ? h('p', { className: 'vl-note' }, t('history.active')) : null,
        item.status === 'interrupted' ? h('p', { className: 'vl-note' }, t('history.interrupted')) : null,
        item.pendingCount ? h('p', { className: 'vl-note' }, t('history.pending', { n: item.pendingCount })) : null,
        error ? h('p', { className: 'vls-error', role: 'status' }, error) : null,
        item.audioUrl && !active ? h('audio', { className: 'vls-audio', controls: true, preload: 'none',
          src: item.audioUrl, ref: audioRef,
          onTimeUpdate: (event) => syncPlayback(event.currentTarget),
          onSeeking: (event) => syncPlayback(event.currentTarget),
          onPlay: (event) => syncPlayback(event.currentTarget),
        }) : null,
        itemMeetingJob ? h('div', { className: 'vls-options-row', role: 'status' },
          h('span', { className: itemMeetingJob.error ? 'vls-error' : 'vl-note' }, t(`meeting.${itemMeetingJob.phase}`)),
          itemMeetingJob.active ? h('button', { type: 'button', className: 'vls-mini',
            onClick: () => engine.meetingAbort?.abort() }, t('studio.cancel')) : null,
        ) : null,
        tool === 'check' ? h(MeetingCheck, { id: item.id, t, seek,
          audioAvailable: Boolean(item.audioUrl), onChanged,
          sourceVersion: JSON.stringify([refreshVersion, details?.text, details?.correctedText, details?.meeting?.revision, details?.pendingCount]) }) : null,
        tool === 'interpretation' ? h(MeetingInterpretation, { id: item.id, t, seek,
          audioAvailable: Boolean(item.audioUrl), onChanged,
          sourceVersion: JSON.stringify([refreshVersion, details?.text, details?.correctedText, details?.meeting?.revision, details?.pendingCount]) }) : null,
        tool === 'meeting' ? speakerPanel() : null,
        tool === 'transcribe' ? h('div', { className: 'vls-options-row' },
          h('label', { className: 'vls-lang' }, t('language.title'),
            h('select', { className: 'vl-select', value: recognitionLanguage, disabled: importing,
              onChange: (event) => setRecognitionLanguage(event.target.value) },
              SOURCE_LANGUAGES.map(([code, label]) => h('option', { key: code, value: code }, code === 'auto' ? t(label) : label))),
          ),
          h('button', { type: 'button', className: 'vls-mini', disabled: importing,
            title: t('import.retranscribeHint'), onClick: retranscribe }, t('import.retranscribe')),
          h('p', { className: 'vl-note' }, t('import.retranscribeHint')),
        ) : null,
        tool === 'report' ? h('section', { className: 'vls-report-block' },
          hasTranscript ? h('div', { className: 'vls-options-row' },
            h(ReportTemplateSelect, { t, value: selectedReportKind, setValue: chooseReportKind, disabled: Boolean(busy) }),
            h(ReportLanguageSelect, { t, value: reportLanguage, setValue: setReportLanguage, disabled: Boolean(busy) }),
            h('button', { type: 'button', className: 'vls-mini', disabled: Boolean(busy) || details?.reportPending, onClick: generateReport },
              t(busy === 'report' ? 'studio.generating' : 'report.generate')),
          ) : null,
          !details && !error ? h('p', { className: 'vl-note' }, t('studio.loading')) : null,
          details?.reportPending ? h('p', { className: 'vl-note' }, t('report.pending')) : null,
          details?.report ? h('div', null,
            h('div', { className: 'vls-report-text' }, details.report),
            h('button', { type: 'button', className: 'vls-mini', disabled: details.reportStale || details.meetingReportStale, onClick: () => void copy(details.report, `${item.id}:report`) },
              t(copiedId === `${item.id}:report` ? 'studio.copied' : 'studio.copyReport')),
          ) : null,
        ) : null,
        !expanded ? h('p', { className: 'vls-item-text' }, highlighted(text.slice(0, 500), shownQuery) || t('studio.noText')) : null,
        expanded && !details && !error ? h('p', { className: 'vl-note' }, t('studio.loading')) : null,
        expanded && details ? h('div', null,
          h('div', { className: 'vls-options-row' },
            h('input', {
              type: 'search', className: 'vls-input vls-search', value: recordingQuery, maxLength: 200,
              'aria-label': t('history.searchThis'), placeholder: t('history.searchThis'),
              onChange: (event) => { setRecordingQuery(event.target.value); setJump(null); },
            }),
            recordingQuery.trim() && details.segments?.length
              ? h('span', { className: 'vl-note' }, t('history.searchCount', { n: matches })) : null,
            recordingQuery.trim() && matches
              ? h('button', { type: 'button', className: 'vls-mini', onClick: locateMatch },
                  t(jump?.term === term && matches > 1 ? 'history.nextMatch' : 'history.jump')) : null,
          ),
          h('div', { className: 'vls-transcript-open', ref: transcriptRoot, tabIndex: 0,
            'aria-label': t('history.details') },
            details.segments?.length ? h('ol', { className: 'vls-segments', ref: segmentList }, details.segments.map((part) =>
              h('li', {
                key: part.sequence, className: 'vls-segment', tabIndex: -1,
                'data-sequence': part.sequence, 'aria-current': playingPart === part.sequence ? 'true' : undefined,
              },
                item.audioUrl && !active
                  ? h('button', { type: 'button', className: 'vls-mini vls-seek', onClick: () => seek(part.start) },
                      `${formatTime(part.start)}–${formatTime(part.end)}`)
                  : h('time', null, `${formatTime(part.start)}–${formatTime(part.end)}`),
                part.state !== 'ready' && !active
                  ? h('button', { type: 'button', className: 'vls-mini', title: part.error, disabled: !!busy,
                      onClick: () => void run(String(part.sequence), () => retry(part)) },
                      busy === String(part.sequence) ? t('history.retrying') : t('history.retrySegment'))
                  : null,
                h('div', { className: 'vls-segment-text' },
                  part.state === 'ready'
                    ? h('span', { 'data-vls-transcript': true }, highlighted(part.correction ?? part.text, shownQuery) || t('history.emptySegment'))
                    : part.error || '',
                  part.correction !== undefined ? h('details', null,
                    h('summary', null, t('history.original')),
                    h('span', { 'data-vls-transcript': true }, highlighted(part.text, shownQuery)),
                  ) : null,
                ),
                part.state === 'ready' && !active ? correctionControls(part.sequence, part.text || '', part.correction) : null,
              ),
            )) : h('div', null,
              h('p', { className: 'vls-item-text', 'data-open': 'true', 'data-vls-transcript': true },
                highlighted(text, shownQuery) || t('studio.noText')),
              details.hasCorrections ? h('details', null, h('summary', null, t('history.original')),
                h('p', { className: 'vls-item-text', 'data-open': 'true', 'data-vls-transcript': true },
                  highlighted(details.text, shownQuery))) : null,
              original && !active ? correctionControls('whole', details.text, details.correctedText) : null,
            ),
          ),
          h('button', { type: 'button', className: 'vls-mini', onClick: () => foldTranscript(true) }, t('history.foldTranscript')),
        ) : null,
          selection ? h('div', { className: 'vls-share-selection', style: {
            left: Math.max(138, Math.min(window.innerWidth - 138, selection.x)),
            top: selection.top >= 52 ? selection.top - 40 : Math.max(8, Math.min(window.innerHeight - 44, selection.bottom + 4)),
          } },
            h('button', { type: 'button', className: 'vls-mini', disabled: Boolean(busy),
              onMouseDown: (event) => event.preventDefault(), onClick: () => share(selection.text) },
              t(busy === 'share' ? 'share.preparing' : 'share.selection')),
          ) : null,
        (details?.reportStale || details?.meetingReportStale) && tool === 'report' ? h('p', { className: 'vl-note' }, t('meeting.reportStale')) : null,
        details?.derivedStale && tool === 'report' ? h('p', { className: 'vl-note' }, t('history.derivedStale')) : null,
      );
    }

    function UpdateControl({ state, t }) {
      const [view, setView] = React.useState({ state: 'checking' });
      const busy = state.importing || state.retrySaving || state.preparing || state.reporting || state.meetingJob?.active || state.checkJobs > 0 ||
        state.editing || state.translating || ['requesting', 'recording', 'finishing'].includes(state.phase);

      async function check(refresh = false) {
        if (refresh) setView({ state: 'checking' });
        try {
          setView(await request(refresh ? '/update?refresh=1' : '/update', { method: 'GET' }));
        } catch (error) {
          setView({ state: 'error', code: error.code || 'checkFailed' });
        }
      }

      React.useEffect(() => { void check(); }, []);
      React.useEffect(() => {
        if (view.state !== 'installing' || state.updating) return;
        const timer = setTimeout(() => void check(), 3_000);
        return () => clearTimeout(timer);
      }, [view, state.updating]);

      async function install() {
        if (busy || store.get().updating || view.state !== 'available' || !view.canInstall) return;
        store.set({ updating: true });
        setView({ state: 'installing' });
        try {
          setView(await request('/update', { json: { version: view.version }, timeout: 240_000 }));
        } catch (error) {
          setView({ state: 'error', code: error.code || 'installFailed' });
        } finally {
          store.set({ updating: false });
        }
      }

      const phase = state.updating ? 'installing' : view.state;
      const key = `update.${view.code}`;
      const message = phase === 'error'
        ? t(Object.hasOwn(EN, key) ? key : 'update.installFailed')
        : t(`update.${phase}`, { version: view.version });
      return h('div', { className: 'vls-update' },
        h('span', { className: 'vls-sub', role: phase === 'error' ? 'alert' : 'status' }, message),
        phase === 'available' && view.canInstall ? h('button', {
          type: 'button', className: 'vl-btn', disabled: busy, onClick: install,
        }, t('update.install')) : null,
        phase === 'available' && busy && view.canInstall ? h('span', { className: 'vls-sub' }, t('update.busy')) : null,
        phase === 'available' && !view.canInstall ? h(React.Fragment, null,
          h('span', { className: 'vls-sub' }, t('update.unsupported')),
          h('a', { className: 'vls-mini', href: 'https://github.com/WinterOne-hub/dsh-voice-notes/releases',
            target: '_blank', rel: 'noopener noreferrer' }, t('update.releases')),
        ) : null,
        ['current', 'error', 'available'].includes(phase) ? h('button', {
          type: 'button', className: 'vls-mini', onClick: () => void check(true),
        }, t('update.check')) : null,
      );
    }

    function Studio(props) {
      const t = translate;
      const state = useStore();
      const studioSource = state.surface === 'composer' && ['requesting', 'recording', 'finishing'].includes(state.phase)
        ? 'microphone' : state.captureSource;
      const [history, setHistory] = React.useState({
        loading: true,
        items: [],
        error: '',
        root: '', total: 0, nextOffset: null,
      });
      const [reload, setReload] = React.useState(0);
      const [refreshState, setRefreshState] = React.useState({ running: false, message: '', failed: false });
      const [refreshVersion, setRefreshVersion] = React.useState(0);
      const refreshPending = React.useRef(false);
      const [query, setQuery] = React.useState('');
      const [offset, setOffset] = React.useState(0);
      const [copiedId, setCopiedId] = React.useState('');
      const [actionError, setActionError] = React.useState('');
      const importPicker = React.useRef(null);
      const meetingModelPicker = React.useRef(null);

      function chooseAudio(event) {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        setQuery('');
        setOffset(0);
        void importAudio(() => file, {
          title: file.name.replace(/\.[^./]+$/, ''),
          language: state.sourceLanguage,
          mimeType: importedMime(file),
          source: 'import',
          reportKind: state.reportKind,
          meetingSpeakers: state.meetingMode ? state.meetingSpeakers : undefined,
        });
      }


      React.useEffect(() => {
        void fetchStatus().catch(() => {});
      }, []);

      React.useEffect(
        () => () => {
          const current = store.get();
          if (current.surface !== 'studio') return;
          if (current.phase === 'recording' || current.phase === 'finishing') {
            return;
          } else if (current.phase === 'requesting') {
            void cancel();
          } else if (current.phase === 'setup') {
            dismissSetup();
          } else if (current.phase === 'result' || current.phase === 'error') {
            resetSessionState();
            store.set({ phase: 'idle' });
          }
        },
        [],
      );

      function refreshHistory() {
        if (refreshPending.current) return;
        refreshPending.current = true;
        setRefreshState({ running: true, message: '', failed: false });
        setReload((value) => value + 1);
      }

      React.useEffect(() => {
        const controller = new AbortController();
        const manual = refreshPending.current;
        const parameters = new URLSearchParams({ q: query.trim(), limit: '25', offset: String(offset) });
        const load = () => {
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
          fetch(`${API}/recordings?${parameters}`, { cache: 'no-store', signal })
            .then(readJsonResponse)
            .then((body) => {
              if (controller.signal.aborted) return;
              setHistory({
                loading: false,
                items: Array.isArray(body.recordings) ? body.recordings : [],
                error: '',
                root: body.root || '',
                total: body.total || 0,
                nextOffset: body.nextOffset,
                query: query.trim(),
              });
              if (manual) {
                refreshPending.current = false;
                setRefreshVersion((value) => value + 1);
                setRefreshState({ running: false, message: t('history.refreshed', { n: body.total || 0 }), failed: false });
              }
            })
            .catch((error) => {
              if (controller.signal.aborted) return;
              setHistory((previous) => ({ ...previous, loading: false, error: messageOf(error) }));
              if (manual) {
                refreshPending.current = false;
                setRefreshState({ running: false, message: t('history.refreshError', { message: messageOf(error) }), failed: true });
              }
            });
        };
        let timer;
        if (manual) load();
        else timer = setTimeout(load, 160);
        return () => {
          clearTimeout(timer);
          controller.abort();
        };
      }, [state.historyVersion, reload, query, offset]);

      const hasActive = history.items.some((item) => item.status === 'recording');
      React.useEffect(() => {
        if (!hasActive) return;
        const timer = setInterval(() => setReload((value) => value + 1), 5000);
        return () => clearInterval(timer);
      }, [hasActive]);

      const phase = state.phase;
      const recording = phase === 'recording';
      const requesting = phase === 'requesting';
      const finishing = phase === 'finishing';
      const provider = providerOf(state.status);
      const preparation = provider?.preparation ?? {};
      const preparationPhase = preparation.phase ?? 'unprepared';
      const ready = preparationPhase === 'ready' || preparationPhase === 'standby';
      const running =
        state.preparing ||
        preparationPhase === 'checking' ||
        preparationPhase === 'downloading' ||
        preparationPhase === 'loading' ||
        preparationPhase === 'cancelling';
      const failed = preparationPhase === 'failed';
      const sources = Array.isArray(provider?.downloadSources) ? provider.downloadSources : [];
      const estimate = provider?.setupEstimate?.recommendedDiskBytes;
      const total = Number(preparation.totalBytes ?? 0);
      const done = Number(preparation.completedBytes ?? 0);
      const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
      const step = preparation.step ?? 'check';
      const modelText = state.status
        ? `${t('studio.model')} · ${
            ready
              ? t('studio.ready')
              : running
                ? t('studio.preparing')
                : t('studio.unprepared')
          }`
        : '';

      const start = () => {
        ensureAudio();
        if (store.get().phase === 'setup') {
          store.set({ phase: 'idle', setupOpen: false });
        }
        void begin(null, undefined, false, 'studio');
      };
      const closeStudio = () => {
        resetSessionState();
        store.set({ phase: 'idle' });
      };
      const onMic = () => {
        if (recording) {
          void finish('stop');
          return;
        }
        if (requesting || finishing) {
          void cancel();
          return;
        }
        if (phase === 'setup') return;
        start();
      };
      const copy = async (text, id) => {
        if (!text) return;
        try {
          await navigator.clipboard.writeText(text);
          setCopiedId(id);
          setTimeout(() => setCopiedId(''), 1500);
        } catch (error) {
          setActionError(messageOf(error));
        }
      };
      const removeItem = async (item) => {
        if (typeof window.confirm === 'function' && !window.confirm(t('studio.confirmDelete'))) {
          return;
        }
        setActionError('');
        try {
          const response = await fetch(`${API}/recordings/${encodeURIComponent(item.id)}`, {
            method: 'DELETE',
          });
          await readJsonResponse(response);
          store.set({ historyVersion: (store.get().historyVersion || 0) + 1 });
        } catch (error) {
          setActionError(messageOf(error));
        }
      };

      const errorKey = `error.${state.error}`;
      const translatedError = t(errorKey);
      const errorText =
        translatedError && translatedError !== errorKey ? translatedError : state.error;

      const statusText = recording
        ? t('phase.recording')
        : requesting
          ? t(studioSource === 'system' ? 'system.requesting' : 'phase.requesting')
          : finishing
            ? stopFeedback(state, t)
            : phase === 'setup'
              ? t('setup.title')
              : phase === 'result'
                ? t('result.title')
                : phase === 'error'
                  ? t('error.title')
                  : modelText || t('studio.subtitle');

      const original = state.finalText;
      const partial = state.partialText;
      const liveEmpty = !original && !partial;
      const resultText = state.result?.text || '';
      const translation = state.translationText;

      let body = null;
      if (phase === 'setup') {
        body = h(
          'div',
          { className: 'vls-setup' },
          h(
            'p',
            { className: 'vl-note' },
            ready
              ? t('setup.ready')
              : t('setup.body', {
                  size: formatBytes(estimate || 260 * 1024 * 1024),
                }),
          ),
          running
            ? h(
                'div',
                null,
                h(
                  'div',
                  { className: 'vl-row', style: { justifyContent: 'space-between' } },
                  h('span', { className: 'vl-note' }, t(`setup.step.${step}`)),
                  h(
                    'span',
                    { className: 'vl-sub' },
                    total > 0
                      ? `${formatBytes(done)} / ${formatBytes(total)} · ${percent}%`
                      : t('setup.preparing'),
                  ),
                ),
                h(
                  'div',
                  {
                    className: 'vl-progress',
                    'data-indeterminate': total > 0 ? 'false' : 'true',
                    style: { marginTop: '6px' },
                  },
                  h('i', { style: { width: `${percent}%` } }),
                ),
              )
            : null,
          failed
            ? h(
                'p',
                { className: 'vls-error' },
                t('setup.failed', {
                  message: preparation.message ?? state.prepareError ?? '',
                }),
              )
            : null,
          state.prepareError && !failed
            ? h('p', { className: 'vls-error' }, state.prepareError)
            : null,
          !running && !ready && sources.length > 0
            ? h(
                'div',
                { className: 'vl-row', style: { marginTop: '10px' } },
                h('span', { className: 'vl-note' }, t('setup.source')),
                h(
                  'select',
                  {
                    className: 'vl-select',
                    value: state.downloadSource,
                    onChange: (event) => store.set({ downloadSource: event.target.value }),
                  },
                  h('option', { value: '' }, t('setup.sourceAuto')),
                  sources.map((source) =>
                    h(
                      'option',
                      { key: source, value: source },
                      source.replace(/^https?:\/\//, ''),
                    ),
                  ),
                ),
              )
            : null,
          h(
            'div',
            { className: 'vls-actions' },
            ready
              ? h(
                  'button',
                  { className: 'vl-btn', 'data-primary': 'true', onClick: start },
                  t('setup.start'),
                )
              : running
                ? h(
                    'button',
                    {
                      className: 'vl-btn',
                      onClick: () =>
                        void cancelPreparation(state.providerId || provider?.id),
                    },
                    t('setup.cancel'),
                  )
                : h(
                    'button',
                    {
                      className: 'vl-btn',
                      'data-primary': 'true',
                      onClick: () =>
                        void prepare(state.providerId || provider?.id, state.downloadSource),
                    },
                    failed ? t('setup.retry') : t('setup.download'),
                  ),
            h('span', { className: 'vl-grow' }),
            h(
              'button',
              { className: 'vl-btn', 'data-quiet': 'true', onClick: dismissSetup },
              t('setup.later'),
            ),
          ),
          h(
            'div',
            { className: 'vl-note', style: { marginTop: '8px' } },
            t('setup.disk', { size: formatBytes(estimate || 260 * 1024 * 1024) }),
          ),
        );
      } else if (phase === 'error') {
        body = h(
          'div',
          { className: 'vls-setup' },
          h('p', { className: 'vls-error' }, errorText),
          h(
            'div',
            { className: 'vls-actions' },
            h(
              'button',
              { className: 'vl-btn', 'data-primary': 'true', onClick: start },
              t('error.retry'),
            ),
            h(
              'button',
              { className: 'vl-btn', 'data-quiet': 'true', onClick: closeStudio },
              t('error.close'),
            ),
          ),
        );
      } else if (phase === 'result') {
        body = h(
          'div',
          { className: 'vls-live' },
          h(
            'p',
            { className: 'vls-live-text', 'data-empty': resultText ? 'false' : 'true' },
            resultText || t('result.empty'),
          ),
          state.translate || translation
            ? h(StudioTranslation, { t, state })
            : null,
          state.report || state.reporting || state.reportError
            ? h(
                'div',
                { className: 'vls-report-block' },
                h(
                  'div',
                  { className: 'vl-label' },
                  t('studio.report'),
                  state.reportMode ? h('b', null, 'AUTO') : null,
                ),
                state.reporting
                  ? h('p', { className: 'vl-note' }, t('studio.generating'))
                  : state.report
                    ? h(
                        React.Fragment,
                        null,
                        h('pre', { className: 'vls-report-text' }, state.report),
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'vl-btn',
                            'data-quiet': 'true',
                            onClick: () => void copy(state.report, 'report'),
                          },
                          copiedId === 'report' ? t('studio.copied') : t('studio.copyReport'),
                        ),
                      )
                    : h(
                        'p',
                        { className: 'vls-error' },
                        t('studio.reportFailed', { message: state.reportError }),
                      ),
              )
            : null,
          h(
            'div',
            { className: 'vls-actions' },
            resultText
              ? h(
                  'button',
                  {
                    className: 'vl-btn',
                    'data-primary': 'true',
                    onClick: () => void copy(resultText, 'result'),
                  },
                  copiedId === 'result' ? t('studio.copied') : t('studio.copy'),
                )
              : null,
            translation
              ? h(
                  'button',
                  {
                    className: 'vl-btn',
                    onClick: () => void copy(translation, 'translation'),
                  },
                  copiedId === 'translation' ? t('studio.copied') : t('live.translation'),
                )
              : null,
            resultText && !state.report && !state.reporting
              ? h(
                  'button',
                  {
                    className: 'vl-btn',
                    disabled: !activeModel(state),
                    onClick: () => {
                      if (window.confirm(modelDisclosure(state, t))) {
                        void generateMeetingReport(resultText, engine.generation);
                      }
                    },
                    title: modelDisclosure(state, t),
                  },
                  t('studio.generate'),
                )
              : null,
            h('button', { className: 'vl-btn', onClick: start }, t('studio.again')),
            h(
              'button',
              { className: 'vl-btn', 'data-quiet': 'true', onClick: closeStudio },
              t('studio.close'),
            ),
          ),
          h(EditedText, { state, t }),
          state.lastRecording && engine.run?.sealed
            ? h('p', { className: 'vls-save' }, t('studio.saved'))
            : null,
          h(ArchiveStatus, { state, t }),
        );
      } else if (recording || requesting || finishing) {
        body = h(
          'div',
          { className: 'vls-live' },
          h(
            'p',
            { className: 'vls-live-text', 'data-empty': liveEmpty ? 'true' : 'false' },
            original,
            partial
              ? h('span', { className: 'vl-partial' }, original ? ` ${partial}` : partial)
              : null,
            liveEmpty ? t('live.empty') : null,
          ),
          state.translate ? h(StudioTranslation, { t, state }) : null,
          h(ArchiveStatus, { state, t }),
          h(
            'div',
            { className: 'vls-actions' },
            requesting
              ? h(
                  'button',
                  {
                    className: 'vl-btn',
                    'data-quiet': 'true',
                    onClick: () => void cancel(),
                  },
                  t('studio.cancel'),
                )
              : null,

          ),
        );
      } else {
        body = h(
          'p',
          { className: 'vl-note', style: { marginTop: '10px' } },
          t('studio.hint'),
        );
      }

      return h(
        'div',
        { className: 'vls-page' },
        h(
          'div',
          { className: 'vls-inner' },
          h(
            'div',
            { className: 'vls-head' },
            h(
              'div',
              null,
              h('h1', { className: 'vls-title' }, t('studio.title')),
              h('p', { className: 'vls-sub' }, t('studio.subtitle'), ` · v${BUILD}`),
              h(UpdateControl, { state, t }),
            ),
            h(
              'div',
              { className: 'vls-head-actions' },
              modelText ? h('span', { className: 'vls-sub' }, modelText) : null,
              h('input', {
                ref: importPicker, type: 'file', hidden: true, accept: '.mp3,.wav,.m4a,.flac,.ogg,.opus,.webm',
                onChange: chooseAudio,
              }),
              h('button', {
                type: 'button', className: 'vl-btn', disabled: state.importing || state.updating || recording || requesting || finishing || (state.meetingMode && state.meetingJob?.active),
                title: t('import.formats'), onClick: () => importPicker.current?.click(),
              }, t('import.open')),
            ),
          ),
          h(
            'section',
            { className: 'vls-card' },
            h(
              'div',
              { className: 'vls-rec' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'vls-mic',
                  'data-recording': recording ? 'true' : 'false',
                  disabled: phase === 'setup' || finishing || (state.meetingMode && state.meetingJob?.active && !recording),
                  title: recording
                    ? t('studio.stop')
                    : requesting || finishing
                      ? t('studio.cancel')
                      : t('studio.record'),
                  'aria-label': recording ? t('studio.stop') : t('studio.record'),
                  onClick: onMic,
                },
                h(Icon, { name: recording ? 'stop' : 'mic', size: 22 }),
              ),
              h(
                'div',
                { className: 'vls-rec-main' },
                h('div', { className: 'vls-time' }, formatTime(state.elapsed)),
                h(
                  'div',
                  { className: 'vls-rec-state' },
                  recording
                    ? h('span', { className: 'vl-pulse' })
                    : requesting || finishing
                      ? h('span', { className: 'vl-spin' })
                      : null,
                  h('span', null, statusText),
                ),
              ),
              h(
                'div',
                { className: 'vls-rec-side' },
                h(Waveform, { level: state.level, phase: state.elapsed }),
                h(
                  'span',
                  { className: 'vls-lang' },
                  h('span', { className: 'vl-label' }, t('language.title')),
                  h(SourceSelect, { t }),
                ),
              ),
            ),
            h('div', { className: 'vls-options-row' },
              h('label', { className: 'vls-lang' },
                t('system.source'),
                h('select', { className: 'vl-select', value: studioSource,
                  disabled: recording || requesting || finishing || state.importing,
                  onChange: (event) => store.set({ captureSource: event.target.value }) },
                  h('option', { value: 'microphone' }, t('system.microphone')),
                  h('option', { value: 'system' }, t('system.computer')))),
              studioSource === 'system' ? h('span', { className: 'vl-note' },
                t('system.hint')) : null,
              h('label', { className: 'vls-lang' },
                h('input', { type: 'checkbox', checked: state.meetingMode, disabled: recording || requesting || finishing || state.importing,
                  onChange: (event) => store.set({ meetingMode: event.target.checked }) }),
                t('meeting.mode'),
              ),
              state.meetingMode ? h(SpeakerCount, { t, value: state.meetingSpeakers,
                disabled: recording || requesting || finishing || state.importing,
                change: (meetingSpeakers) => store.set({ meetingSpeakers }),
              }) : null,
              state.meetingMode ? h('span', { className: 'vl-note' }, t('meeting.modeHint')) : null,
            ),
            state.meetingJob ? h('div', { className: 'vls-options-row', role: 'status' },
              h('span', { className: state.meetingJob.error ? 'vls-error' : 'vl-note' }, t(`meeting.${state.meetingJob.phase}`)),
              state.meetingJob.active ? h('button', { type: 'button', className: 'vls-mini',
                onClick: () => engine.meetingAbort?.abort() }, t('studio.cancel')) : null,
              ['downloadFailed', 'integrity'].includes(state.meetingJob.phase) ? h(React.Fragment, null,
                h('a', { className: 'vls-mini', href: SPEAKER_MODEL_URL,
                  target: '_blank', rel: 'noopener noreferrer' }, t('meeting.getModel')),
                h('input', { type: 'file', accept: '.onnx', hidden: true, ref: meetingModelPicker,
                  onChange: (event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    void importMeetingModel(file);
                  } }),
                h('button', { type: 'button', className: 'vls-mini',
                  onClick: () => meetingModelPicker.current?.click() }, t('meeting.installModel')),
              ) : null,
            ) : null,
            h('details', { className: 'vls-options' },
              h('summary', null, t('recording.options')),
              h('div', { className: 'vls-options-row' },
                h(TranslateControl, { t }),
                h(EditControl, { t }),
                h('button', {
                  type: 'button', className: 'vl-toggle', 'aria-pressed': state.reportMode,
                  disabled: !state.reportMode && !activeModel(state),
                  title: t('studio.reportHint'), onClick: () => setReportMode(!state.reportMode),
                }, h(Icon, { name: 'file', size: 14 }), t('studio.report')),
                h(ReportTemplateSelect, {
                  t, value: state.reportKind, disabled: state.reporting, allowAuto: true,
                  setValue: (reportKind) => { store.set({ reportKind }); savePrefs({ reportKind }); },
                }),
                h(ReportLanguageSelect, {
                  t, value: state.reportLanguage, disabled: state.reporting,
                  setValue: (reportLanguage) => {
                    store.set({ reportLanguage });
                    savePrefs({ reportLanguage });
                  },
                }),
              ),
              h('p', { className: 'vl-note' }, modelDisclosure(state, t)),
            ),
            h(DictationPreferences, { state, t }),
            state.importNotice ? h('p', { className: 'vl-note', role: 'status' }, state.importNotice) : null,
            state.importError ? h('p', { className: 'vls-error', role: 'alert' }, state.importError) : null,
            body,
          ),
          h(
            'section',
            { className: 'vls-history' },
            h(
              'div',
              { className: 'vls-history-head' },
              h('h2', { className: 'vls-title2' }, t('studio.history')),
              h(
                'span',
                { className: 'vls-count' },
                t('studio.count', { n: history.total }),
              ),
              h(
                'div',
                { className: 'vls-history-actions' },
                h('input', { className: 'vls-input vls-search', type: 'search', value: query,
                  'aria-label': t('history.search'), placeholder: t('history.search'), maxLength: 200,
                  onChange: (event) => { setQuery(event.target.value); setOffset(0); } }),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'vls-mini',
                    onClick: refreshHistory,
                    disabled: refreshState.running,
                  },
                  t(refreshState.running ? 'history.refreshing' : 'studio.refresh'),
                ),
              ),
            ),
            refreshState.message ? h('p', {
              className: refreshState.failed ? 'vls-error' : 'vl-note',
              role: refreshState.failed ? 'alert' : 'status',
            }, refreshState.message) : null,
            history.root
              ? h(
                  'div',
                  { className: 'vls-path' },
                  h('span', null, t('studio.path')),
                  h('code', { title: history.root }, history.root),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'vls-mini',
                      onClick: () => void copy(history.root, 'root'),
                    },
                    copiedId === 'root' ? t('studio.copied') : t('studio.copyPath'),
                  ),
                )
              : null,
            actionError ? h('div', { className: 'vls-error' }, actionError) : null,
            history.loading
              ? h(
                  'div',
                  { className: 'vls-loading' },
                  h('span', { className: 'vl-spin' }),
                  t('studio.loading'),
                )
              : history.error && history.items.length === 0
                ? h(
                    'div',
                    { className: 'vls-error' },
                    history.error,
                    ' ',
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'vls-mini',
                        onClick: refreshHistory,
                      },
                      t('studio.retry'),
                    ),
                  )
                : history.items.length === 0
                  ? h('div', { className: 'vls-empty' }, t(query.trim() ? 'history.noMatch' : 'studio.empty'))
                  : h(
                      'ul',
                      { className: 'vls-list' },
                      history.items.map((item) => h(HistoryItem, {
                        key: item.id, item, t, query: history.query ?? '', copy, copiedId, removeItem, importing: state.importing || recording || requesting || finishing,
                        refreshVersion, meetingJob: state.meetingJob,
                        onChanged: () => setReload((value) => value + 1),
                      })),
                    ),
            offset ? h('button', { type: 'button', className: 'vls-mini vls-morepage',
              onClick: () => setOffset((value) => Math.max(0, value - 25)) }, t('history.previous')) : null,
            history.nextOffset !== null && !history.error
              ? h('button', { type: 'button', className: 'vls-mini vls-morepage',
                  onClick: () => setOffset(history.nextOffset) }, t('history.more'))
              : null,
          ),
        ),
      );
    }

    function mountRecordingIndicator(openStudio) {
      const banner = document.createElement('div');
      banner.className = 'vl-global';
      banner.hidden = true;
      const dot = document.createElement('span');
      dot.className = 'vl-pulse';
      dot.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.setAttribute('role', 'status');
      const elapsed = document.createElement('span');
      elapsed.className = 'vl-global-time';

      const stop = document.createElement('button');
      stop.type = 'button';
      stop.className = 'vl-btn';
      stop.addEventListener('click', () => void finish('stop'));
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'vl-btn';
      open.addEventListener('click', openStudio);
      banner.append(dot, label, elapsed, stop, open);
      document.body.append(banner);

      const update = () => {
        const state = store.get();
        const recording = state.phase === 'recording';
        const finishing = state.phase === 'finishing';
        const result = state.phase === 'result' && (state.surface === 'composer' || state.archiveStage === 'failed' || state.savedNotice);
        const text = recording ? (engine.run?.source === 'system' ? translate('system.computer') + ' · ' : '') + translate('recording.live')
          : finishing || result ? stopFeedback(state, translate) : state.savedNotice;
        banner.hidden = !(recording || finishing || result || state.savedNotice);
        dot.hidden = elapsed.hidden = stop.hidden = !recording;
        open.hidden = !(finishing || result);
        if (label.textContent !== text) label.textContent = text;
        if (recording) {
          const time = formatTime(state.elapsed);
          if (elapsed.textContent !== time) elapsed.textContent = time;
        }
        const stopLabel = translate('recording.stop');
        const openLabel = translate('recording.open');
        if (stop.textContent !== stopLabel) stop.textContent = stopLabel;
        if (open.textContent !== openLabel) open.textContent = openLabel;
      };
      const unsubscribe = store.subscribe(update);
      update();
      return () => { unsubscribe(); banner.remove(); };
    }

    function handleDictationShortcut(event) {
      const state = store.get();
      if (state.updating || state.shortcut === 'off' || !event.ctrlKey || !event.shiftKey || event.altKey ||
          event.metaKey || event.code !== state.shortcut || event.isComposing) return;
      if (state.phase === 'recording') {
        event.preventDefault();
        if (!event.repeat) void finish('stop');
        return;
      }
      const composer = engine.activeComposer;
      if (!composer || composer.locked || !['idle', 'error', 'result'].includes(state.phase)) return;
      event.preventDefault();
      if (event.repeat) return;
      ensureAudio();
      void begin(composer.inputActions, composer.sessionId, composer.locked);
    }

    function LiveOverlay(props) {
      const state = useStore();
      if (state.surface === 'studio') return null;
      return h(
        React.Fragment,
        null,
        h(LivePanel, props),
        h(ResultPanel, props),
        h(SetupPanel, props),
        h(ErrorPanel, props),
      );
    }

    return {
      inject: ['slots', 'locale', 'layout', 'sessions', 'conversation', 'uiWorkspace', 'workspaces'],
      apply(ctx) {
        if (window.location.protocol !== 'dsh-app:' || window.location.host !== 'app') return;
        localeBound = ctx.locale.bind(NS);
        transcriptSharing = {
          sessions: ctx.get('sessions'),
          conversation: ctx.get('conversation'),
          workspace: ctx.get('uiWorkspace'),
          workspaces: ctx.get('workspaces'),
        };
        const style = document.createElement('style');
        style.setAttribute('data-voice-live', '');
        style.textContent = CSS;
        document.head.append(style);
        ctx.effect(() => () => style.remove(), 'voice-live: styles');
        ctx.effect(
          () => () => {
            void cancel(true);
            if (engine.audio && engine.audio.state !== 'closed') {
              engine.audio.close().catch(() => {});
              engine.audio = null;
            }
          },
          'voice-live: audio',
        );

        ctx.effect(
          () => ctx.locale.register(NS, { zh: ZH, en: EN }),
          'voice-live: dictionaries',
        );

        ctx.slots.inject('conversation.input.activity', () =>
          ctx.slots.register(
            { name: 'conversation.input.activity', locale: NS },
            VoiceBar,
          ),
        );
        ctx.slots.inject('conversation.input.overlay', () =>
          ctx.slots.register(
            { name: 'conversation.input.overlay', id: 'voice-live', locale: NS },
            LiveOverlay,
          ),
        );
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: 'voice-live',
              order: 26,
              label: () => ctx.locale.bind(NS)('studio.title'),
            },
            PanelIcon,
          ),
        );
        ctx.slots.inject('main', () =>
          ctx.slots.register(
            { name: 'main', key: 'voice-live', locale: NS },
            Studio,
          ),
        );

        const layout = ctx.get('layout');
        ctx.effect(() => mountRecordingIndicator(() => layout?.selectPanel?.('voice-live')), 'voice-live: recording indicator');
        ctx.effect(() => {
          document.addEventListener('keydown', handleDictationShortcut, true);
          return () => document.removeEventListener('keydown', handleDictationShortcut, true);
        }, 'voice-live: dictation shortcut');
        if (layout) {
        const OPEN_KEY = 'voice-live:open-nonce';
        ctx.effect(() => {
          let disposed = false;
          let busy = false;
          const readHandled = () => {
            try {
              return Number(window.localStorage.getItem(OPEN_KEY) ?? 0) || 0;
            } catch {
              return 0;
            }
          };
          let handled = readHandled();
          const tick = async () => {
            if (disposed || busy) return;
            busy = true;
            try {
              const response = await fetch(`${API}/open-state?since=${handled}`, {
                cache: 'no-store',
              });
              const body = await response.json();
              if (disposed || !body?.ok) return;
              const nonce = Number(body.nonce) || 0;
              if (nonce < handled) {
                handled = nonce;
                return;
              }
              if (nonce <= handled) return;
              try {
                layout?.selectPanel?.('voice-live');
              } catch {
                return;
              }
              handled = nonce;
              try {
                window.localStorage.setItem(OPEN_KEY, String(handled));
              } catch {
                /* storage unavailable */
              }
            } catch {
              /* host not ready */
            } finally {
              busy = false;
            }
          };
          void tick();
          const timer = setInterval(tick, 1800);
          return () => {
            disposed = true;
            clearInterval(timer);
          };
        }, 'voice-live: open signal');
        }
      },
    };
  },
});
