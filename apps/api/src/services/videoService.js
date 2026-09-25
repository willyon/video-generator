import { nanoid } from 'nanoid'
import { db } from '../db.js'
import { generateVideoPlan } from './planningService.js'
import { listVideoAssets } from './assetService.js'
import { getProviderCapabilities, isDurationSupported } from '../providers/capabilities.js'
import { getSettings } from '../db.js'
import { compileShotPrompt, normalizeVisualDirection } from './visualDirection.js'

function parseJson(value, fallback) {
  try { return value ? JSON.parse(value) : fallback } catch { return fallback }
}

function hydrateShot(row) {
  if (!row) return null
  const {
    continuity_json: _continuityJson,
    generation_spec_json: _generationSpecJson,
    audio_json: _legacyAudioJson,
    validation_json: _legacyValidationJson,
    ...publicRow
  } = row
  const versions = db.prepare('SELECT * FROM shot_versions WHERE shot_id = ? ORDER BY version_number DESC').all(row.id).map((version) => ({
    ...version,
    generationSpec: parseJson(version.generation_spec_json, {}),
    validation: parseJson(version.validation_json, null),
    clipUrl: version.clip_path ? `/files/${version.clip_path}` : null,
  }))
  return {
    ...publicRow,
    continuity: parseJson(row.continuity_json, {}),
    generationSpec: parseJson(row.generation_spec_json, null),
    versions,
    clipUrl: row.clip_path ? `/files/${row.clip_path}` : null,
  }
}

function listAudioSegments(videoId) {
  return db.prepare('SELECT * FROM audio_segments WHERE video_id = ? ORDER BY start_sec, created_at').all(videoId).map((row) => {
    const versions = db.prepare('SELECT * FROM audio_versions WHERE segment_id = ? ORDER BY version_number DESC').all(row.id).map((version) => ({
      ...version,
      url: version.file_path ? `/files/${version.file_path}` : null,
    }))
    return {
      ...row,
      versions,
      selectedUrl: versions.find((version) => version.id === row.selected_version_id)?.url || null,
    }
  })
}

export function hydrateVideo(row, { withShots = true } = {}) {
  if (!row) return null
  const {
    script_json: _scriptJson,
    motion_plan_json: _motionPlanJson,
    visual_direction_json: _visualDirectionJson,
    ...publicRow
  } = row
  const result = {
    ...publicRow,
    planFrozen: Boolean(row.plan_frozen),
    subtitlesEnabled: Boolean(row.subtitles_enabled),
    script: parseJson(row.script_json, {}),
    motionPlan: parseJson(row.motion_plan_json, null),
    visualDirection: normalizeVisualDirection(parseJson(row.visual_direction_json, {})),
    videoUrl: row.video_path ? `/files/${row.video_path}` : null,
    subtitleUrl: row.subtitle_path ? `/files/${row.subtitle_path}` : null,
  }
  if (withShots) {
    result.shots = db.prepare('SELECT * FROM video_shots WHERE video_id = ? ORDER BY shot_number').all(row.id).map(hydrateShot)
    result.assets = listVideoAssets(row.id)
    result.audioSegments = listAudioSegments(row.id)
  }
  return result
}

export function listVideos() {
  return db.prepare('SELECT * FROM videos ORDER BY created_at DESC').all().map((row) => hydrateVideo(row, { withShots: false }))
}

export function getVideo(id) {
  return hydrateVideo(db.prepare('SELECT * FROM videos WHERE id = ?').get(id))
}

export async function createVideo(input) {
  const theme = String(input.theme || '').trim()
  if (!theme) throw new Error('请输入视频主题')
  const durationSec = Math.min(60, Math.max(3, Number(input.durationSec) || 10))
  const aspectRatio = input.aspectRatio === '9:16' ? '9:16' : '16:9'
  const language = String(input.language || 'zh-CN')
  const visualDirection = normalizeVisualDirection(input.visualDirection)
  const provider = ['mock', 'cloud-http', 'comfyui'].includes(input.provider) ? input.provider : 'mock'
  const plan = await generateVideoPlan({ theme, durationSec, aspectRatio, language, provider })
  const id = nanoid(12)
  const insert = db.transaction(() => {
    db.prepare(`
      INSERT INTO videos (
        id, title, theme, duration_sec, aspect_ratio, language, visual_direction_json, script_json,
        provider, subtitles_enabled
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, plan.title, theme, durationSec, aspectRatio, language, JSON.stringify(visualDirection), JSON.stringify(plan), provider,
      input.subtitlesEnabled === false ? 0 : 1,
    )
    const addShot = db.prepare(`
      INSERT INTO video_shots (
        id, video_id, shot_number, duration_sec, narration, dialogue, visual_prompt,
        negative_prompt, camera_move, location, action, continuity_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    plan.shots.forEach((shot, index) => addShot.run(
      nanoid(12), id, index + 1, shot.durationSec, shot.narration, shot.dialogue,
      shot.visualPrompt, shot.negativePrompt, shot.cameraMove, shot.location, shot.action,
      JSON.stringify(shot.continuity),
    ))
  })
  insert()
  return getVideo(id)
}

export function updateShot(id, input) {
  const shot = db.prepare('SELECT * FROM video_shots WHERE id = ?').get(id)
  if (!shot) throw new Error('镜头不存在')
  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(shot.video_id)
  if (video.plan_frozen) throw new Error('计划已冻结，请先解冻再编辑')
  db.prepare(`
    UPDATE video_shots SET
      duration_sec = ?, narration = ?, dialogue = ?, visual_prompt = ?, negative_prompt = ?,
      camera_move = ?, location = ?, action = ?, continuity_json = ?, generation_mode = ?,
      status = 'planned', clip_path = NULL, error = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    Math.max(1, Number(input.durationSec) || shot.duration_sec),
    String(input.narration ?? shot.narration), String(input.dialogue ?? shot.dialogue),
    String(input.visualPrompt ?? shot.visual_prompt), String(input.negativePrompt ?? shot.negative_prompt),
    String(input.cameraMove ?? shot.camera_move), String(input.location ?? shot.location),
    String(input.action ?? shot.action), JSON.stringify(input.continuity ?? parseJson(shot.continuity_json, {})),
    String(input.generationMode ?? shot.generation_mode),
    id,
  )
  invalidateDownstream(shot.video_id)
  return getVideo(shot.video_id)
}

function invalidateDownstream(videoId) {
  db.prepare(`
    UPDATE audio_segments SET selected_version_id = NULL, status = 'planned', updated_at = CURRENT_TIMESTAMP
    WHERE video_id = ?
  `).run(videoId)
  db.prepare(`
    UPDATE videos SET status = 'draft', video_base_path = NULL, video_path = NULL,
      subtitle_path = NULL, error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(videoId)
}

function assertEditableVideo(videoId) {
  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId)
  if (!video) throw new Error('视频项目不存在')
  if (video.plan_frozen) throw new Error('计划已冻结，请先解冻再调整镜头')
  return video
}

function renumberShots(videoId) {
  const rows = db.prepare('SELECT id FROM video_shots WHERE video_id = ? ORDER BY shot_number, created_at').all(videoId)
  const update = db.prepare('UPDATE video_shots SET shot_number = ? WHERE id = ?')
  rows.forEach((row, index) => update.run(index + 1, row.id))
}

export function addShot(videoId, { afterShotId } = {}) {
  const video = assertEditableVideo(videoId)
  const capabilities = getProviderCapabilities(video.provider)
  const defaultDuration = capabilities.duration.type === 'options' ? capabilities.duration.values[0] : Math.max(1, capabilities.duration.min)
  const existing = db.prepare('SELECT * FROM video_shots WHERE video_id = ? ORDER BY shot_number').all(videoId)
  const after = afterShotId ? existing.find((shot) => shot.id === afterShotId) : existing.at(-1)
  const position = after ? existing.findIndex((shot) => shot.id === after.id) + 1 : existing.length
  const newId = nanoid(12)
  const orderedIds = existing.map((shot) => shot.id)
  orderedIds.splice(position, 0, newId)
  const transaction = db.transaction(() => {
    const updateOrder = db.prepare('UPDATE video_shots SET shot_number = ? WHERE id = ?')
    existing.forEach((shot, index) => updateOrder.run(-(index + 1), shot.id))
    db.prepare(`
      INSERT INTO video_shots (
        id, video_id, shot_number, duration_sec, narration, dialogue, visual_prompt,
        negative_prompt, camera_move, location, action, continuity_json
      ) VALUES (?, ?, ?, ?, '', '', ?, ?, 'static', '', '', '{}')
    `).run(
      newId, videoId, 0, defaultDuration,
      `${video.theme}, new shot, cinematic composition, coherent visual continuity, no text, no watermark`,
      'text, watermark, logo, flicker, identity drift',
    )
    orderedIds.forEach((id, index) => updateOrder.run(index + 1, id))
    invalidateDownstream(videoId)
  })
  transaction()
  return getVideo(videoId)
}

export function deleteShot(id) {
  const shot = db.prepare('SELECT * FROM video_shots WHERE id = ?').get(id)
  if (!shot) throw new Error('镜头不存在')
  assertEditableVideo(shot.video_id)
  const count = db.prepare('SELECT COUNT(*) AS count FROM video_shots WHERE video_id = ?').get(shot.video_id).count
  if (count <= 1) throw new Error('项目至少需要保留一个镜头')
  const transaction = db.transaction(() => {
    db.prepare('DELETE FROM video_shots WHERE id = ?').run(id)
    renumberShots(shot.video_id)
    invalidateDownstream(shot.video_id)
  })
  transaction()
  return getVideo(shot.video_id)
}

export function reorderShots(videoId, orderedIds) {
  assertEditableVideo(videoId)
  const existingIds = db.prepare('SELECT id FROM video_shots WHERE video_id = ?').all(videoId).map((row) => row.id)
  if (!Array.isArray(orderedIds) || orderedIds.length !== existingIds.length || existingIds.some((id) => !orderedIds.includes(id))) {
    throw new Error('镜头顺序必须包含项目中的全部镜头')
  }
  const transaction = db.transaction(() => {
    const temporary = db.prepare('UPDATE video_shots SET shot_number = ? WHERE id = ?')
    orderedIds.forEach((id, index) => temporary.run(-(index + 1), id))
    orderedIds.forEach((id, index) => temporary.run(index + 1, id))
    invalidateDownstream(videoId)
  })
  transaction()
  return getVideo(videoId)
}

export function setPlanFrozen(id, frozen) {
  const video = getVideo(id)
  if (!video) throw new Error('视频项目不存在')
  const total = video.shots.reduce((sum, shot) => sum + Number(shot.duration_sec), 0)
  if (frozen && Math.abs(total - Number(video.duration_sec)) > 0.05) {
    throw new Error(`镜头总时长为 ${total.toFixed(2)} 秒，应为 ${video.duration_sec} 秒`)
  }
  const capabilities = getProviderCapabilities(video.provider)
  const settings = getSettings({ includeSecrets: true })
  if (frozen && !capabilities.aspectRatios.includes(video.aspect_ratio)) {
    throw new Error(`${capabilities.label} 不支持 ${video.aspect_ratio} 画幅`)
  }
  const specs = []
  if (frozen) {
    for (const shot of video.shots) {
      if (!isDurationSupported(shot.duration_sec, capabilities)) {
        throw new Error(`镜头 ${shot.shot_number} 的 ${shot.duration_sec} 秒时长不受 ${capabilities.label} 支持`)
      }
      const mode = capabilities.modes.find((item) => item.id === shot.generation_mode)
      if (!mode) throw new Error(`镜头 ${shot.shot_number} 使用了不受支持的生成模式`)
      const assets = video.assets.filter((asset) => !asset.shot_id || asset.shot_id === shot.id)
      const missing = mode.requiredAssets.filter((role) => !assets.some((asset) => asset.role === role && asset.shot_id === shot.id))
      if (missing.length) throw new Error(`镜头 ${shot.shot_number} 缺少素材：${missing.join('、')}`)
      const compiled = compileShotPrompt({
        direction: video.visualDirection,
        shot,
        aspectRatio: video.aspect_ratio,
        provider: video.provider,
      })
      specs.push({
        version: 1,
        shotId: shot.id,
        provider: video.provider,
        model: video.provider === 'cloud-http' ? settings.cloudModel : '',
        mode: mode.id,
        durationSec: shot.duration_sec,
        aspectRatio: video.aspect_ratio,
        prompt: compiled.prompt,
        negativePrompt: compiled.negativePrompt,
        promptSections: compiled.sections,
        visualDirection: compiled.visualDirection,
        cameraMove: shot.camera_move,
        seed: Math.floor(Math.random() * 2_147_483_647),
        assets: assets.map((asset) => ({ id: asset.id, role: asset.role, filePath: asset.file_path, mimeType: asset.mime_type })),
      })
    }
  }
  const motionPlan = frozen ? {
    version: 1,
    frozenAt: new Date().toISOString(),
    aspectRatio: video.aspect_ratio,
    durationSec: video.duration_sec,
    visualDirection: video.visualDirection,
    shots: specs,
  } : null
  const save = db.transaction(() => {
    db.prepare(`
      UPDATE videos SET plan_frozen = ?, motion_plan_json = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(frozen ? 1 : 0, motionPlan ? JSON.stringify(motionPlan) : null, frozen ? 'ready' : 'draft', id)
    const updateSpec = db.prepare('UPDATE video_shots SET generation_spec_json = ? WHERE id = ?')
    video.shots.forEach((shot, index) => updateSpec.run(frozen ? JSON.stringify(specs[index]) : null, shot.id))
  })
  save()
  return getVideo(id)
}

export function deleteVideo(id) {
  db.prepare('DELETE FROM videos WHERE id = ?').run(id)
}
