import { getSettings } from '../db.js'

const BASE_MODES = [
  { id: 'text-to-video', label: '文生视频', requiredAssets: [] },
  { id: 'image-to-video', label: '图生视频', requiredAssets: ['first-frame'] },
  { id: 'keyframes', label: '首尾帧生成', requiredAssets: ['first-frame', 'last-frame'] },
]

function normalizeDurations(value, fallback) {
  const source = Array.isArray(value) ? value : String(value || '').split(',')
  const values = [...new Set(source.map(Number).filter((item) => Number.isFinite(item) && item >= 1))]
  return values.length ? values.sort((a, b) => a - b) : fallback
}

export function getProviderCapabilities(provider, suppliedSettings) {
  const settings = suppliedSettings || getSettings({ includeSecrets: true })
  if (provider === 'mock') {
    return {
      provider: 'mock',
      label: 'Mock FFmpeg',
      aspectRatios: ['16:9', '9:16'],
      duration: { type: 'range', min: 1, max: 30, step: 0.5 },
      modes: BASE_MODES,
      supportsSeed: true,
    }
  }
  if (provider === 'cloud-http') {
    return {
      provider: 'cloud-http',
      label: '云端 HTTP API',
      aspectRatios: ['16:9', '9:16'],
      duration: { type: 'options', values: normalizeDurations(settings.cloudDurationOptions, [5, 10]) },
      modes: BASE_MODES,
      supportsSeed: true,
    }
  }
  if (provider === 'comfyui') {
    return {
      provider: 'comfyui',
      label: '本地 ComfyUI',
      aspectRatios: ['16:9', '9:16'],
      duration: { type: 'options', values: normalizeDurations(settings.comfyDurationOptions, [5, 10]) },
      modes: BASE_MODES,
      supportsSeed: true,
    }
  }
  throw new Error(`Unsupported video provider: ${provider}`)
}

export function listProviderCapabilities() {
  const settings = getSettings({ includeSecrets: true })
  return ['mock', 'cloud-http', 'comfyui'].map((provider) => getProviderCapabilities(provider, settings))
}

export function isDurationSupported(duration, capability) {
  const value = Number(duration)
  if (capability.duration.type === 'options') return capability.duration.values.includes(value)
  const { min, max, step } = capability.duration
  if (value < min || value > max) return false
  return Math.abs((value - min) / step - Math.round((value - min) / step)) < 0.0001
}

function findOptionCombination(total, values, targetCount) {
  const sorted = [...values].sort((a, b) => b - a)
  function visit(remaining, items) {
    if (items.length === targetCount) return Math.abs(remaining) < 0.001 ? items : null
    for (const value of sorted) {
      if (value <= remaining + 0.001) {
        const found = visit(Number((remaining - value).toFixed(3)), [...items, value])
        if (found) return found
      }
    }
    return null
  }
  return visit(total, [])
}

export function planShotDurations(totalDuration, capability) {
  const total = Number(totalDuration)
  if (capability.duration.type === 'options') {
    const preferredCount = Math.max(1, Math.min(6, Math.round(total / 5)))
    for (let count = preferredCount; count <= 6; count += 1) {
      const result = findOptionCombination(total, capability.duration.values, count)
      if (result) return result
    }
    for (let count = preferredCount - 1; count >= 1; count -= 1) {
      const result = findOptionCombination(total, capability.duration.values, count)
      if (result) return result
    }
    throw new Error(`总时长 ${total} 秒无法由 ${capability.duration.values.join('/')} 秒镜头组成`)
  }
  const count = total <= 6 ? 1 : Math.min(3, Math.max(2, Math.round(total / 5)))
  const raw = total / count
  const stepped = Math.round(raw / capability.duration.step) * capability.duration.step
  const durations = Array.from({ length: count }, () => stepped)
  durations[durations.length - 1] = Number((total - stepped * (count - 1)).toFixed(3))
  if (!durations.every((duration) => isDurationSupported(duration, capability))) {
    throw new Error(`总时长 ${total} 秒不符合 ${capability.label} 的镜头时长约束`)
  }
  return durations
}
