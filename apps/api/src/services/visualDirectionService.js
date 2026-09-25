import { db } from '../db.js'
import { getVideo } from './videoService.js'
import { normalizeVisualDirection } from './visualDirection.js'

export function updateVisualDirection(videoId, input) {
  const video = db.prepare('SELECT id, plan_frozen FROM videos WHERE id = ?').get(videoId)
  if (!video) throw new Error('视频项目不存在')
  if (video.plan_frozen) throw new Error('计划已冻结，请先解冻再调整视觉方向')
  const direction = normalizeVisualDirection(input)
  db.prepare(`
    UPDATE videos SET visual_direction_json = ?, status = 'draft', updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(JSON.stringify(direction), videoId)
  return getVideo(videoId)
}
