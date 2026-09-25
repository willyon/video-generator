import { generatePlanWithTextModel } from '../providers/textProvider.js'
import { getProviderCapabilities, isDurationSupported, planShotDurations } from '../providers/capabilities.js'

const cameraMoves = ['slow push in', 'gentle tracking shot', 'slow pull back']

function offlinePlan({ theme, durationSec, aspectRatio, language, capabilities }) {
  const durations = planShotDurations(durationSec, capabilities)
  const shotCount = durations.length
  const beats = [
    ['建立情境', `以清晰的环境镜头引入“${theme}”`],
    ['发生变化', `围绕“${theme}”出现一个明确、可视化的动作`],
    ['留下结果', `用有余韵的画面完成“${theme}”的情绪收束`],
  ]
  return {
    title: theme.slice(0, 40),
    logline: `一个关于“${theme}”的${durationSec}秒短视频。`,
    shots: durations.map((shotDuration, index) => {
      const beat = beats[index] || [`推进 ${index + 1}`, `继续推进“${theme}”并保持清晰的视觉动作`]
      return {
      durationSec: shotDuration,
      narration: language.startsWith('zh') ? beat[1] : `${beat[0]}: ${theme}`,
      dialogue: '',
      visualPrompt: `${beat[1]}, clear subject and action, coherent story world`,
      negativePrompt: 'text, subtitles, watermark, logo, malformed anatomy, identity drift, flicker',
      cameraMove: cameraMoves[index],
      location: index === 0 ? 'establishing environment' : 'same story world',
      action: beat[0],
      continuity: { keepSubjectIdentity: true, keepStyle: true, previousShot: index || null },
      }
    }),
  }
}

function normalizePlan(plan, input, capabilities) {
  if (!Array.isArray(plan?.shots) || plan.shots.length === 0) throw new Error('The generated plan has no shots')
  const shots = plan.shots.map((shot, index) => ({
    durationSec: Math.max(1, Number(shot.durationSec) || input.durationSec / plan.shots.length),
    narration: String(shot.narration || ''),
    dialogue: String(shot.dialogue || ''),
    visualPrompt: String(shot.visualPrompt || shot.prompt || `${input.theme}, shot ${index + 1}`),
    negativePrompt: String(shot.negativePrompt || 'text, watermark, flicker, identity drift'),
    cameraMove: String(shot.cameraMove || 'static'),
    location: String(shot.location || ''),
    action: String(shot.action || ''),
    continuity: shot.continuity && typeof shot.continuity === 'object' ? shot.continuity : {},
  }))
  const total = shots.reduce((sum, shot) => sum + shot.durationSec, 0)
  shots[shots.length - 1].durationSec = Number(Math.max(1, shots.at(-1).durationSec + input.durationSec - total).toFixed(2))
  if (!shots.every((shot) => isDurationSupported(shot.durationSec, capabilities))) {
    throw new Error(`模型返回了 ${capabilities.label} 不支持的镜头时长`)
  }
  return {
    title: String(plan.title || input.theme).slice(0, 100),
    logline: String(plan.logline || ''),
    shots,
  }
}

export async function generateVideoPlan(input) {
  const capabilities = getProviderCapabilities(input.provider)
  const allowedDurations = planShotDurations(input.durationSec, capabilities)
  const modelPlan = await generatePlanWithTextModel({ ...input, allowedShotDurations: allowedDurations })
  return normalizePlan(modelPlan || offlinePlan({ ...input, capabilities }), input, capabilities)
}
