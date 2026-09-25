import fs from 'node:fs'
import path from 'node:path'
import { nanoid } from 'nanoid'
import { db, getSettings } from '../db.js'
import { outputDir } from '../config.js'
import { generateAudioAsset } from '../providers/audioProvider.js'
import { inspectAudio, mixAudioTracks } from './mediaService.js'
import { getVideo } from './videoService.js'
import { normalizeVisualDirection } from './visualDirection.js'

const TYPES = new Set(['narration', 'dialogue', 'music', 'sfx'])
const PROVIDERS = new Set(['mock', 'cloud-http', 'local-http'])

function validateTiming(videoId, startSec, durationSec) {
  const video = db.prepare('SELECT duration_sec FROM videos WHERE id = ?').get(videoId)
  if (!video) throw new Error('视频项目不存在')
  const start = Number(startSec)
  const duration = Number(durationSec)
  if (!Number.isFinite(start) || !Number.isFinite(duration) || start < 0 || duration <= 0) throw new Error('音频时间参数无效')
  if (start + duration > Number(video.duration_sec) + 0.05) throw new Error('音频片段超出视频总时长')
  return { start, duration }
}

function insertAudioSegment(videoId, input, fallbackProvider) {
  if (!TYPES.has(input.type)) throw new Error('不支持的音频类型')
  const { start, duration } = validateTiming(videoId, input.startSec, input.durationSec)
  const provider = PROVIDERS.has(input.provider) ? input.provider : fallbackProvider
  const id = nanoid(12)
  const defaultVolume = input.type === 'music' ? 0.25 : input.type === 'sfx' ? 0.7 : 1
  const requestedVolume = Number(input.volume)
  const volume = Number.isFinite(requestedVolume) ? requestedVolume : defaultVolume
  db.prepare(`
    INSERT INTO audio_segments (id, video_id, shot_id, type, start_sec, duration_sec, text, prompt, voice, volume, provider)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, videoId, input.shotId || null, input.type, start, duration,
    String(input.text || ''), String(input.prompt || ''), String(input.voice || ''),
    Math.max(0, Math.min(2, volume)), provider,
  )
  return id
}

export function createAudioSegment(videoId, input) {
  const settings = getSettings({ includeSecrets: true })
  insertAudioSegment(videoId, input, settings.audioProvider)
  db.prepare(`UPDATE videos SET status = 'audio', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(videoId)
  return getVideo(videoId)
}

export function initializeAudioPlan(videoId) {
  const video = getVideo(videoId)
  if (!video) throw new Error('视频项目不存在')
  if (!video.shots.every((shot) => shot.review_status === 'approved')) throw new Error('请先通过全部视频镜头')
  if (video.audioSegments.length) return video
  const settings = getSettings({ includeSecrets: true })
  let cursor = 0
  const transaction = db.transaction(() => {
    for (const shot of video.shots) {
      const hasNarration = Boolean(shot.narration.trim())
      const hasDialogue = Boolean(shot.dialogue.trim())
      if (hasNarration) {
        insertAudioSegment(videoId, {
          shotId: shot.id, type: 'narration', startSec: cursor,
          durationSec: hasDialogue ? shot.duration_sec * 0.48 : shot.duration_sec,
          text: shot.narration, provider: settings.audioProvider,
        }, settings.audioProvider)
      }
      if (hasDialogue) {
        insertAudioSegment(videoId, {
          shotId: shot.id, type: 'dialogue', startSec: cursor + (hasNarration ? shot.duration_sec * 0.5 : 0),
          durationSec: hasNarration ? shot.duration_sec * 0.48 : shot.duration_sec,
          text: shot.dialogue, provider: settings.audioProvider,
        }, settings.audioProvider)
      }
      cursor += Number(shot.duration_sec)
    }
    db.prepare(`UPDATE videos SET status = 'audio', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(videoId)
  })
  transaction()
  return getVideo(videoId)
}

export function updateAudioSegment(id, input) {
  const segment = db.prepare('SELECT * FROM audio_segments WHERE id = ?').get(id)
  if (!segment) throw new Error('音频片段不存在')
  const { start, duration } = validateTiming(segment.video_id, input.startSec ?? segment.start_sec, input.durationSec ?? segment.duration_sec)
  const provider = PROVIDERS.has(input.provider) ? input.provider : segment.provider
  db.prepare(`
    UPDATE audio_segments SET start_sec = ?, duration_sec = ?, text = ?, prompt = ?, voice = ?, volume = ?,
      provider = ?, selected_version_id = NULL, status = 'planned', error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(
    start, duration, String(input.text ?? segment.text), String(input.prompt ?? segment.prompt), String(input.voice ?? segment.voice),
    Math.max(0, Math.min(2, Number(input.volume ?? segment.volume))), provider, id,
  )
  return getVideo(segment.video_id)
}

export function deleteAudioSegment(id) {
  const segment = db.prepare('SELECT video_id FROM audio_segments WHERE id = ?').get(id)
  if (!segment) throw new Error('音频片段不存在')
  db.prepare('DELETE FROM audio_segments WHERE id = ?').run(id)
  return getVideo(segment.video_id)
}

export async function generateAudioSegment(id, { signal } = {}) {
  const segment = db.prepare('SELECT * FROM audio_segments WHERE id = ?').get(id)
  if (!segment) throw new Error('音频片段不存在')
  if ((segment.type === 'narration' || segment.type === 'dialogue') && !segment.text.trim()) throw new Error('语音文本不能为空')
  if ((segment.type === 'music' || segment.type === 'sfx') && !segment.prompt.trim()) throw new Error('音乐或音效提示词不能为空')
  const versionNumber = db.prepare('SELECT COALESCE(MAX(version_number), 0) + 1 AS value FROM audio_versions WHERE segment_id = ?').get(id).value
  const versionId = nanoid(12)
  const relativePath = `videos/${segment.video_id}/audio/${segment.id}/v${String(versionNumber).padStart(3, '0')}.wav`
  const absolutePath = path.join(outputDir, relativePath)
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
  db.prepare(`INSERT INTO audio_versions (id, segment_id, version_number, provider) VALUES (?, ?, ?, ?)`).run(versionId, id, versionNumber, segment.provider)
  db.prepare(`UPDATE audio_segments SET status = 'generating', error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id)
  try {
    const video = db.prepare('SELECT visual_direction_json FROM videos WHERE id = ?').get(segment.video_id)
    let direction = {}
    try { direction = JSON.parse(video?.visual_direction_json || '{}') } catch {}
    const generated = await generateAudioAsset({
      segment: { ...segment, audioDirection: normalizeVisualDirection(direction).audio },
      outputPath: absolutePath,
      signal,
    })
    const validation = await inspectAudio(absolutePath, segment.duration_sec)
    if (!validation.valid) throw new Error(validation.errors.join('；'))
    db.prepare(`
      UPDATE audio_versions SET provider_job_id = ?, file_path = ?, duration_sec = ?, status = 'valid' WHERE id = ?
    `).run(generated.providerJobId || null, relativePath, validation.durationSec, versionId)
    db.prepare(`
      UPDATE audio_segments SET selected_version_id = ?, status = 'generated', error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(versionId, id)
  } catch (error) {
    db.prepare(`UPDATE audio_versions SET status = 'failed', error = ? WHERE id = ?`).run(error.message, versionId)
    db.prepare(`UPDATE audio_segments SET status = 'error', error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(error.message, id)
    throw error
  }
  return getVideo(segment.video_id)
}

export function selectAudioVersion(segmentId, versionId) {
  const version = db.prepare('SELECT * FROM audio_versions WHERE id = ? AND segment_id = ?').get(versionId, segmentId)
  if (!version || version.status !== 'valid') throw new Error('只能选择有效的音频版本')
  const segment = db.prepare('SELECT video_id FROM audio_segments WHERE id = ?').get(segmentId)
  db.prepare(`UPDATE audio_segments SET selected_version_id = ?, status = 'generated', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(versionId, segmentId)
  return getVideo(segment.video_id)
}

export async function mixProjectAudio(videoId, signal) {
  const video = getVideo(videoId)
  if (!video?.video_base_path) throw new Error('无声母版不存在，请先重新合成视频镜头')
  if (!video.audioSegments.length) throw new Error('还没有音频片段')
  const missing = video.audioSegments.filter((segment) => !segment.selected_version_id)
  if (missing.length) throw new Error(`还有 ${missing.length} 个音频片段尚未生成或选择版本`)
  const clips = video.audioSegments.map((segment) => {
    const version = segment.versions.find((item) => item.id === segment.selected_version_id)
    return { ...segment, filePath: path.join(outputDir, version.file_path) }
  })
  const relativePath = `videos/${videoId}/final.mp4`
  await mixAudioTracks(path.join(outputDir, video.video_base_path), clips, path.join(outputDir, relativePath), video.duration_sec, signal)
  db.prepare(`UPDATE videos SET video_path = ?, status = 'complete', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(relativePath, videoId)
  return getVideo(videoId)
}
