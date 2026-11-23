# Third-party components

Voice Notes is a community plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). The plugin code is released under the MIT license in this directory.

- Harness provides the host, user interface and speech services. See the [Harness license](https://github.com/deepseek-ai/deepseek-harness/blob/master/LICENSE).
- Harness's SenseVoice provider prepares model resources from upstream sources. See the [SenseVoiceSmall model card](https://huggingface.co/FunAudioLLM/SenseVoiceSmall) and the [ONNX conversion used by the tested Harness release](https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/tree/2365baeacb507f821a0c8120fcee3d484dba7a07). The upstream terms apply to the model weights.

- Speaker diarization uses [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) from the Harness runtime. The bundled Pyannote segmentation model is distributed under MIT; see `meeting-models/LICENSE` and the [upstream ONNX conversion](https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0). The optional [ERes2Net embedding model](https://modelscope.cn/models/iic/speech_eres2net_base_sv_zh-cn_3dspeaker_16k) is fetched from a pinned Hugging Face mirror of the original Sherpa-ONNX export and verified against the original size and SHA-256.
