import { db } from '../db.js'
import { assembleSelectedVideo } from './generationService.js'
import { getVideo } from './videoService.js'

export async function selectShotVersion(shotId, versionId) {
  const version = db.prepare(`
    SELECT sv.*, vs.video_id FROM shot_versions sv
    JOIN video_shots vs ON vs.id = sv.shot_id
    WHERE sv.id = ? AND sv.shot_id = ?
  `).get(versionId, shotId)
  if (!version) throw new Error('镜头版本不存在')
  if (version.status !== 'valid' || !version.clip_path) throw new Error('只能选择通过技术校验的镜头版本')
  db.prepare(`
    UPDATE video_shots SET selected_version_id = ?, clip_path = ?, status = 'generated', review_status = 'pending',
      error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(version.id, version.clip_path, shotId)
  await assembleSelectedVideo(version.video_id)
  return getVideo(version.video_id)
}

export function reviewShot(shotId, decision) {
  if (!['approved', 'rejected'].includes(decision)) throw new Error('审核结果必须是 approved 或 rejected')
  const shot = db.prepare('SELECT * FROM video_shots WHERE id = ?').get(shotId)
  if (!shot) throw new Error('镜头不存在')
  if (!shot.selected_version_id) throw new Error('请先选择一个有效的镜头版本')
  db.prepare(`
    UPDATE video_shots SET review_status = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(decision, decision === 'approved' ? 'approved' : 'generated', shotId)
  const remaining = db.prepare(`
    SELECT COUNT(*) AS count FROM video_shots WHERE video_id = ? AND review_status != 'approved'
  `).get(shot.video_id).count
  db.prepare(`UPDATE videos SET status = ?, video_path = COALESCE(video_base_path, video_path), updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(
    remaining === 0 ? 'approved' : 'review', shot.video_id,
  )
  return getVideo(shot.video_id)
}
