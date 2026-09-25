import express from 'express'
import cors from 'cors'
import fs from 'node:fs'
import multer from 'multer'
import path from 'node:path'
import { apiPort, outputDir } from './config.js'
import { getSettings, updateSettings } from './db.js'
import { cancelJob, getJob, latestJobForVideo, resumeGenerationJob, startAudioGenerationJob, startGenerationJob } from './services/jobService.js'
import { addShot, createVideo, deleteShot, deleteVideo, getVideo, listVideos, reorderShots, setPlanFrozen, updateShot } from './services/videoService.js'
import { listProviderCapabilities } from './providers/capabilities.js'
import { createAsset, deleteAsset, listVideoAssets } from './services/assetService.js'
import { reviewShot, selectShotVersion } from './services/reviewService.js'
import { createAudioSegment, deleteAudioSegment, initializeAudioPlan, mixProjectAudio, selectAudioVersion, updateAudioSegment } from './services/audioService.js'
import { updateVisualDirection } from './services/visualDirectionService.js'

const app = express()
const uploadTempDir = path.join(outputDir, '.upload-temp')
fs.mkdirSync(uploadTempDir, { recursive: true })
const upload = multer({ dest: uploadTempDir, limits: { fileSize: 200 * 1024 * 1024 } })
app.use(cors())
app.use(express.json({ limit: '12mb' }))
app.use('/files', express.static(outputDir, { fallthrough: false }))

function route(handler) {
  return async (request, response) => {
    try {
      const result = await handler(request, response)
      if (!response.headersSent) response.json(result)
    } catch (error) {
      if (request.file?.path && fs.existsSync(request.file.path)) fs.unlinkSync(request.file.path)
      console.error(error)
      response.status(error.status || 400).json({ error: error.message || 'Unexpected error' })
    }
  }
}

app.get('/api/health', (_request, response) => response.json({ ok: true, service: 'video-generator-api' }))
app.get('/api/settings', route(() => getSettings()))
app.get('/api/providers/capabilities', route(() => listProviderCapabilities()))
app.put('/api/settings', route((request) => {
  updateSettings(request.body || {})
  return getSettings()
}))

app.get('/api/videos', route(() => listVideos()))
app.post('/api/videos', route((request) => createVideo(request.body || {})))
app.get('/api/videos/:id', route((request) => {
  const video = getVideo(request.params.id)
  if (!video) throw Object.assign(new Error('视频项目不存在'), { status: 404 })
  return { ...video, latestJob: latestJobForVideo(video.id) }
}))
app.delete('/api/videos/:id', route((request, response) => {
  deleteVideo(request.params.id)
  response.status(204).end()
}))
app.put('/api/shots/:id', route((request) => updateShot(request.params.id, request.body || {})))
app.put('/api/videos/:id/visual-direction', route((request) => updateVisualDirection(request.params.id, request.body || {})))
app.post('/api/videos/:id/shots', route((request) => addShot(request.params.id, request.body || {})))
app.delete('/api/shots/:id', route((request) => deleteShot(request.params.id)))
app.put('/api/videos/:id/shots/order', route((request) => reorderShots(request.params.id, request.body?.shotIds)))
app.get('/api/videos/:id/assets', route((request) => listVideoAssets(request.params.id)))
app.post('/api/videos/:id/assets', upload.single('file'), route((request) => createAsset({
  videoId: request.params.id,
  shotId: request.body.shotId || null,
  role: request.body.role,
  file: request.file,
})))
app.delete('/api/assets/:id', route((request, response) => {
  deleteAsset(request.params.id)
  response.status(204).end()
}))
app.post('/api/videos/:id/freeze', route((request) => setPlanFrozen(request.params.id, true)))
app.post('/api/videos/:id/unfreeze', route((request) => setPlanFrozen(request.params.id, false)))
app.post('/api/videos/:id/generate', route((request) => startGenerationJob(request.params.id, { shotId: request.body?.shotId })))
app.post('/api/shots/:id/versions/:versionId/select', route((request) => selectShotVersion(request.params.id, request.params.versionId)))
app.post('/api/shots/:id/review', route((request) => reviewShot(request.params.id, request.body?.decision)))
app.post('/api/videos/:id/audio/initialize', route((request) => initializeAudioPlan(request.params.id)))
app.post('/api/videos/:id/audio-segments', route((request) => createAudioSegment(request.params.id, request.body || {})))
app.put('/api/audio-segments/:id', route((request) => updateAudioSegment(request.params.id, request.body || {})))
app.delete('/api/audio-segments/:id', route((request) => deleteAudioSegment(request.params.id)))
app.post('/api/audio-segments/:id/generate', route((request) => startAudioGenerationJob(request.params.id)))
app.post('/api/audio-segments/:id/versions/:versionId/select', route((request) => selectAudioVersion(request.params.id, request.params.versionId)))
app.post('/api/videos/:id/audio/mix', route((request) => mixProjectAudio(request.params.id)))

app.get('/api/jobs/:id', route((request) => {
  const job = getJob(request.params.id)
  if (!job) throw Object.assign(new Error('任务不存在'), { status: 404 })
  return job
}))
app.post('/api/jobs/:id/cancel', route((request) => cancelJob(request.params.id)))
app.post('/api/jobs/:id/resume', route((request) => resumeGenerationJob(request.params.id)))

app.use((error, _request, response, _next) => {
  console.error(error)
  response.status(500).json({ error: error.message || 'Server error' })
})

app.listen(apiPort, () => {
  console.log(`Video Generator API listening on http://localhost:${apiPort}`)
})
