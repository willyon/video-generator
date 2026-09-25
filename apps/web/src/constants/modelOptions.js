/** Settings presets for each generation node. */

export const textProviderOptions = [
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'offline', label: '离线规则' },
]

/** OpenRouter chat models for script / shot planning. */
export const textModelOptions = [
  { value: 'deepseek/deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash', hint: '推荐 · 中文分镜、便宜快' },
  { value: 'deepseek/deepseek-v3.2', label: 'DeepSeek V3.2', hint: '纯文本性价比' },
  { value: 'deepseek/deepseek-chat-v3.1', label: 'DeepSeek Chat V3.1', hint: '稳定常用' },
  { value: 'deepseek/deepseek-chat', label: 'DeepSeek Chat', hint: '兼容别名' },
  { value: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash', hint: '速度快' },
  { value: 'openai/gpt-4.1-mini', label: 'GPT-4.1 mini', hint: '备选' },
  { value: 'anthropic/claude-sonnet-4', label: 'Claude Sonnet 4', hint: '文笔强 · 部分地区可能受限' },
]

export const videoProviderOptions = [
  { value: 'mock', label: 'Mock FFmpeg', hint: '本地联调，不消耗额度' },
  { value: 'cloud-http', label: '云端 HTTP API', hint: '可灵 / 万相 / 自建网关等' },
  { value: 'comfyui', label: '本地 ComfyUI', hint: '本机工作流' },
]

/**
 * Model IDs sent to a configured cloud video gateway.
 * OpenRouter currently has no text-to-video models; these IDs are for dedicated video APIs.
 */
export const videoCloudModelOptions = [
  { value: 'wanx2.1-t2v-turbo', label: '通义万相 T2V Turbo', hint: '阿里云常见文生视频' },
  { value: 'wanx2.1-t2v-plus', label: '通义万相 T2V Plus', hint: '质量优先' },
  { value: 'wanx2.1-i2v-turbo', label: '通义万相 I2V Turbo', hint: '图生视频' },
  { value: 'kling-v1', label: '可灵 Kling v1', hint: '按你的网关实际 ID 调整' },
  { value: 'kling-v1-5', label: '可灵 Kling v1.5', hint: '按你的网关实际 ID 调整' },
  { value: 'vidu-2.0', label: 'Vidu 2.0', hint: '按你的网关实际 ID 调整' },
]

export const audioProviderOptions = [
  { value: 'mock', label: 'Mock FFmpeg', hint: '本地联调' },
  { value: 'cloud-http', label: '云端 HTTP API', hint: 'TTS / 音乐网关' },
  { value: 'local-http', label: '本地 HTTP API', hint: '本机语音服务' },
]

/** Model IDs for a configured cloud audio gateway (not OpenRouter chat). */
export const audioCloudModelOptions = [
  { value: 'cosyvoice-v2', label: 'CosyVoice V2', hint: '阿里系常见 TTS' },
  { value: 'cosyvoice-v1', label: 'CosyVoice V1', hint: '兼容旧网关' },
  { value: 'speech-02-hd', label: 'MiniMax Speech HD', hint: '按网关实际 ID 调整' },
  { value: 'speech-02-turbo', label: 'MiniMax Speech Turbo', hint: '更快' },
  { value: 'tts-1', label: 'OpenAI TTS-1 风格', hint: '兼容网关常用名' },
]

export const audioLocalModelOptions = [
  { value: 'cosyvoice-v2', label: 'CosyVoice V2', hint: '本地常见' },
  { value: 'local-tts', label: 'local-tts', hint: '占位 · 改成你的本地模型名' },
]

export function withCurrentOption(options, current, labelPrefix = '当前') {
  const value = String(current || '')
  if (!value || options.some((item) => item.value === value)) return options
  return [{ value, label: `${labelPrefix} · ${value}`, hint: '自定义' }, ...options]
}
