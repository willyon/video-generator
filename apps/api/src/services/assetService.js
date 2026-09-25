import fs from 'node:fs'
import path from 'node:path'
import { nanoid } from 'nanoid'
import { db } from '../db.js'
import { outputDir } from '../config.js'

export const ASSET_ROLES = new Set([
  'reference', 'first-frame', 'last-frame', 'style', 'character', 'scene', 'motion-reference',
])

function hydrate(row) {
  return row ? { ...row, url: `/files/${row.file_path}` } : null
}

export function listVideoAssets(videoId) {
  return db.prepare('SELECT * FROM video_assets WHERE video_id = ? ORDER BY created_at').all(videoId).map(hydrate)
}

export function getAsset(id) {
  return hydrate(db.prepare('SELECT * FROM video_assets WHERE id = ?').get(id))
}

export function createAsset({ videoId, shotId, role, file }) {
  const video = db.prepare('SELECT id, plan_frozen FROM videos WHERE id = ?').get(videoId)
  if (!video) throw new Error('视频项目不存在')
  if (video.plan_frozen) throw new Error('计划已冻结，请先解冻再修改参考素材')
  if (!ASSET_ROLES.has(role)) throw new Error('不支持的素材用途')
  if (shotId) {
    const shot = db.prepare('SELECT id FROM video_shots WHERE id = ? AND video_id = ?').get(shotId, videoId)
    if (!shot) throw new Error('镜头不存在或不属于该项目')
  }
  if (!file) throw new Error('请选择素材文件')
  if (!/^(image|video)\//.test(file.mimetype)) throw new Error('只支持图片或视频素材')

  const id = nanoid(12)
  const safeExtension = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 8)
  const relativePath = `videos/${videoId}/assets/${id}${safeExtension}`
  const destination = path.join(outputDir, relativePath)
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.renameSync(file.path, destination)
  db.prepare(`
    INSERT INTO video_assets (id, video_id, shot_id, role, original_name, mime_type, file_path, file_size)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, videoId, shotId || null, role, file.originalname, file.mimetype, relativePath, file.size)
  return getAsset(id)
}

export function deleteAsset(id) {
  const asset = getAsset(id)
  if (!asset) throw new Error('素材不存在')
  const video = db.prepare('SELECT plan_frozen FROM videos WHERE id = ?').get(asset.video_id)
  if (video?.plan_frozen) throw new Error('计划已冻结，请先解冻再删除参考素材')
  db.prepare('DELETE FROM video_assets WHERE id = ?').run(id)
  const file = path.join(outputDir, asset.file_path)
  if (fs.existsSync(file)) fs.unlinkSync(file)
}
