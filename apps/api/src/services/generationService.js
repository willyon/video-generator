import fs from 'node:fs'
import path from 'node:path'
import { db, getSettings } from '../db.js'
import { outputDir } from '../config.js'
import { generateVideoClip } from '../providers/videoProvider.js'
import { dimensionsFor } from '../providers/providerUtils.js'
import { assembleVideo, inspectVideo, writeSubtitles } from './mediaService.js'
import { getVideo } from './videoService.js'
import { nanoid } from 'nanoid'

function absolute(relativePath) {
  return path.join(outputDir, relativePath)
}

function nextVersionNumber(shotId) {
  return db.prepare('SELECT COALESCE(MAX(version_number), 0) + 1 AS value FROM shot_versions WHERE shot_id = ?').get(shotId).value
}

export async function assembleSelectedVideo(videoId, signal) {
  const video = getVideo(videoId)
  if (!video || video.shots.some((shot) => !shot.clip_path)) return null
  const projectDir = path.join(outputDir, 'videos', videoId)
  fs.mkdirSync(projectDir, { recursive: true })
  const assemblyShots = video.shots.map((shot) => ({ ...shot, clip_path: absolute(shot.clip_path) }))
  const videoRelativePath = `videos/${videoId}/video-base.mp4`
  await assembleVideo(assemblyShots, absolute(videoRelativePath), signal)
  let subtitleRelativePath = null
  if (video.subtitlesEnabled) {
    subtitleRelativePath = `videos/${videoId}/subtitles.srt`
    if (!writeSubtitles(video.shots, absolute(subtitleRelativePath))) subtitleRelativePath = null
  }
  db.prepare(`UPDATE videos SET status = 'review', video_base_path = ?, video_path = ?, subtitle_path = ?, error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(
    videoRelativePath, videoRelativePath, subtitleRelativePath, videoId,
  )
  return getVideo(videoId)
}

export async function generateVideoAssets(videoId, { signal, onProgress, shotIds, onShotComplete } = {}) {
  const video = getVideo(videoId)
  if (!video) throw new Error('视频项目不存在')
  if (!video.planFrozen) throw new Error('请先冻结分镜计划')
  const settings = getSettings({ includeSecrets: true })
  const projectDir = path.join(outputDir, 'videos', videoId)
  const shotsDir = path.join(projectDir, 'shots')
  fs.mkdirSync(shotsDir, { recursive: true })
  const targets = Array.isArray(shotIds) ? video.shots.filter((shot) => shotIds.includes(shot.id)) : video.shots
  if (targets.length === 0) throw new Error('没有可生成的镜头')
  if (targets.some((shot) => !shot.generationSpec)) throw new Error('生成规格不存在，请解冻并重新冻结计划')

  db.prepare(`UPDATE videos SET status = 'generating', error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(videoId)
  for (let index = 0; index < targets.length; index += 1) {
    if (signal?.aborted) throw new DOMException('Generation cancelled', 'AbortError')
    const shot = targets[index]
    onProgress?.({ step: `正在生成镜头 ${shot.shot_number}`, completed: index, total: targets.length })
    db.prepare(`UPDATE video_shots SET status = 'generating', error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(shot.id)
    const versionNumber = nextVersionNumber(shot.id)
    const versionId = nanoid(12)
    const relativePath = `videos/${videoId}/shots/${shot.id}/v${String(versionNumber).padStart(3, '0')}.mp4`
    fs.mkdirSync(path.dirname(absolute(relativePath)), { recursive: true })
    db.prepare(`
      INSERT INTO shot_versions (id, shot_id, version_number, provider, generation_spec_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(versionId, shot.id, versionNumber, video.provider, JSON.stringify(shot.generationSpec || {}))
    try {
      const generated = await generateVideoClip({
        provider: video.provider || settings.videoProvider,
        shot,
        aspectRatio: video.aspect_ratio,
        outputPath: absolute(relativePath),
        signal,
      })
      const dimensions = dimensionsFor(video.aspect_ratio)
      const validation = await inspectVideo(absolute(relativePath), {
        durationSec: shot.duration_sec,
        width: dimensions.width,
        height: dimensions.height,
      })
      db.prepare(`
        UPDATE shot_versions SET provider_job_id = ?, clip_path = ?, validation_json = ?, status = ?, error = ? WHERE id = ?
      `).run(
        generated.providerJobId || null, relativePath, JSON.stringify(validation), validation.valid ? 'valid' : 'invalid',
        validation.valid ? null : validation.errors.join('；'), versionId,
      )
      if (!validation.valid) throw new Error(`镜头 ${shot.shot_number} 技术校验失败：${validation.errors.join('；')}`)
      db.prepare(`
        UPDATE video_shots SET clip_path = ?, selected_version_id = ?, provider_job_id = ?, status = 'generated',
          review_status = 'pending', error = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(relativePath, versionId, generated.providerJobId || null, shot.id)
      onShotComplete?.(shot.id)
    } catch (error) {
      db.prepare(`UPDATE shot_versions SET status = CASE WHEN status = 'invalid' THEN status ELSE 'failed' END, error = COALESCE(error, ?) WHERE id = ?`).run(error.message, versionId)
      db.prepare(`UPDATE video_shots SET status = 'error', error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(error.message, shot.id)
      throw error
    }
  }

  const refreshed = getVideo(videoId)
  if (refreshed.shots.some((shot) => !shot.clip_path)) {
    db.prepare(`UPDATE videos SET status = 'partial', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(videoId)
    return getVideo(videoId)
  }
  onProgress?.({ step: '正在合成最终视频', completed: targets.length, total: targets.length })
  await assembleSelectedVideo(videoId, signal)
  onProgress?.({ step: '生成完成', completed: targets.length, total: targets.length })
  return getVideo(videoId)
}
