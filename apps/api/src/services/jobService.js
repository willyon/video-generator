import { nanoid } from 'nanoid'
import { db } from '../db.js'
import { assembleSelectedVideo, generateVideoAssets } from './generationService.js'
import { generateAudioSegment } from './audioService.js'

const controllers = new Map()

function hydrate(row) {
  if (!row) return null
  let payload = {}
  try { payload = JSON.parse(row.payload_json || '{}') } catch {}
  return {
    ...row,
    payload,
    cancellable: ['queued', 'running'].includes(row.status),
    resumable: ['error', 'cancelled', 'interrupted'].includes(row.status) && (payload.remainingShotIds?.length > 0 || payload.needsAssembly),
  }
}

export function getJob(id) {
  return hydrate(db.prepare('SELECT * FROM generation_jobs WHERE id = ?').get(id))
}

export function latestJobForVideo(videoId) {
  return hydrate(db.prepare('SELECT * FROM generation_jobs WHERE video_id = ? ORDER BY created_at DESC LIMIT 1').get(videoId))
}

export function startGenerationJob(videoId, { shotId, shotIds, assembleOnly = false } = {}) {
  const running = db.prepare(`SELECT * FROM generation_jobs WHERE video_id = ? AND status IN ('queued', 'running', 'cancelling')`).get(videoId)
  if (running) return hydrate(running)
  const allShotIds = db.prepare('SELECT id FROM video_shots WHERE video_id = ? ORDER BY shot_number').all(videoId).map((row) => row.id)
  const targets = Array.isArray(shotIds) ? allShotIds.filter((id) => shotIds.includes(id)) : shotId ? allShotIds.filter((id) => id === shotId) : allShotIds
  if (!targets.length && !assembleOnly) throw new Error('没有可生成的镜头')
  const total = targets.length
  const id = nanoid(12)
  const payload = { initialShotIds: targets, remainingShotIds: [...targets], needsAssembly: true }
  db.prepare(`
    INSERT INTO generation_jobs (id, video_id, kind, status, current_step, total_shots, payload_json)
    VALUES (?, ?, 'video', 'queued', '等待开始', ?, ?)
  `).run(id, videoId, total, JSON.stringify(payload))
  const controller = new AbortController()
  controllers.set(id, controller)

  queueMicrotask(async () => {
    try {
      db.prepare(`UPDATE generation_jobs SET status = 'running', current_step = '准备生成', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id)
      if (assembleOnly) {
        db.prepare(`UPDATE generation_jobs SET current_step = '正在重新合成', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id)
        await assembleSelectedVideo(videoId, controller.signal)
      } else {
        await generateVideoAssets(videoId, {
          shotIds: targets,
          signal: controller.signal,
          onProgress: ({ step, completed, total: progressTotal }) => db.prepare(`
            UPDATE generation_jobs SET current_step = ?, completed_shots = ?, total_shots = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
          `).run(step, completed, progressTotal, id),
          onShotComplete: (completedShotId) => {
            payload.remainingShotIds = payload.remainingShotIds.filter((targetId) => targetId !== completedShotId)
            db.prepare(`
              UPDATE generation_jobs SET completed_shots = ?, payload_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
            `).run(total - payload.remainingShotIds.length, JSON.stringify(payload), id)
          },
        })
      }
      payload.needsAssembly = false
      db.prepare(`
        UPDATE generation_jobs SET status = 'done', current_step = '完成', completed_shots = total_shots,
          payload_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(JSON.stringify(payload), id)
    } catch (error) {
      const cancelled = error.name === 'AbortError' || controller.signal.aborted
      db.prepare(`UPDATE generation_jobs SET status = ?, current_step = ?, error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(
        cancelled ? 'cancelled' : 'error', cancelled ? '已取消' : '生成失败', error.message, id,
      )
      db.prepare(`UPDATE videos SET status = ?, error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(
        cancelled ? 'ready' : 'error', cancelled ? null : error.message, videoId,
      )
    } finally {
      controllers.delete(id)
    }
  })
  return getJob(id)
}

export function startAudioGenerationJob(segmentId) {
  const segment = db.prepare('SELECT video_id FROM audio_segments WHERE id = ?').get(segmentId)
  if (!segment) throw new Error('音频片段不存在')
  const running = db.prepare(`
    SELECT * FROM generation_jobs
    WHERE kind = 'audio' AND target_id = ? AND status IN ('queued', 'running', 'cancelling')
  `).get(segmentId)
  if (running) return hydrate(running)
  const id = nanoid(12)
  db.prepare(`
    INSERT INTO generation_jobs (id, video_id, kind, target_id, status, current_step, total_shots, payload_json)
    VALUES (?, ?, 'audio', ?, 'queued', '等待生成声音', 1, '{}')
  `).run(id, segment.video_id, segmentId)
  const controller = new AbortController()
  controllers.set(id, controller)
  queueMicrotask(async () => {
    try {
      db.prepare(`UPDATE generation_jobs SET status = 'running', current_step = '正在生成声音', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id)
      await generateAudioSegment(segmentId, { signal: controller.signal })
      db.prepare(`UPDATE generation_jobs SET status = 'done', current_step = '完成', completed_shots = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id)
    } catch (error) {
      const cancelled = error.name === 'AbortError' || controller.signal.aborted
      db.prepare(`UPDATE generation_jobs SET status = ?, current_step = ?, error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(
        cancelled ? 'cancelled' : 'error', cancelled ? '已取消' : '生成失败', error.message, id,
      )
    } finally {
      controllers.delete(id)
    }
  })
  return getJob(id)
}

export function resumeGenerationJob(id) {
  const job = getJob(id)
  if (!job) throw new Error('任务不存在')
  if (!job.resumable) throw new Error('该任务没有可继续的工作')
  const remaining = job.payload.remainingShotIds || []
  return startGenerationJob(job.video_id, { shotIds: remaining, assembleOnly: remaining.length === 0 && job.payload.needsAssembly })
}

export function cancelJob(id) {
  const job = getJob(id)
  if (!job) throw new Error('任务不存在')
  if (!job.cancellable) return job
  db.prepare(`UPDATE generation_jobs SET status = 'cancelling', current_step = '正在取消', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id)
  controllers.get(id)?.abort()
  return getJob(id)
}
