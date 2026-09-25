import { downloadFile, wait } from './providerUtils.js'
import fs from 'node:fs'
import path from 'node:path'
import { outputDir } from '../config.js'

function statusValue(payload) {
  return String(payload.status || payload.state || payload.data?.status || '').toLowerCase()
}

function outputUrl(payload) {
  return payload.output_url || payload.video_url || payload.url || payload.output?.url || payload.data?.output_url || payload.data?.url
}

export async function generateCloudHttpClip({ shot, settings, aspectRatio, outputPath, signal, dimensions }) {
  if (!settings.cloudBaseUrl) throw new Error('Cloud provider base URL is not configured')
  const headers = { 'Content-Type': 'application/json' }
  if (settings.cloudApiKey) headers.Authorization = `Bearer ${settings.cloudApiKey}`
  const submitUrl = new URL(settings.cloudSubmitPath || '/v1/video/generations', settings.cloudBaseUrl).toString()
  const spec = shot.generationSpec || {}
  const references = (spec.assets || []).map((asset) => ({
    role: asset.role,
    mime_type: asset.mimeType,
    data_base64: fs.readFileSync(path.join(outputDir, asset.filePath)).toString('base64'),
  }))
  const response = await fetch(submitUrl, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({
      prompt: spec.prompt,
      negative_prompt: spec.negativePrompt,
      duration: shot.duration_sec,
      aspect_ratio: aspectRatio,
      width: dimensions.width,
      height: dimensions.height,
      fps: 24,
      camera_move: shot.camera_move,
      model: spec.model || settings.cloudModel || undefined,
      mode: spec.mode || shot.generation_mode,
      seed: spec.seed,
      references,
    }),
  })
  if (!response.ok) throw new Error(`Cloud video submission failed (${response.status}): ${await response.text()}`)
  let payload = await response.json()
  const jobId = payload.id || payload.job_id || payload.task_id || payload.data?.id
  let url = outputUrl(payload)
  if (!url && !jobId) throw new Error('Cloud provider returned neither a job id nor an output URL')

  while (!url) {
    await wait(Number(settings.pollIntervalMs) || 3000, signal)
    const path = String(settings.cloudStatusPath || '/v1/video/generations/{id}').replace('{id}', encodeURIComponent(jobId))
    const pollResponse = await fetch(new URL(path, settings.cloudBaseUrl), { headers, signal })
    if (!pollResponse.ok) throw new Error(`Cloud video status failed (${pollResponse.status}): ${await pollResponse.text()}`)
    payload = await pollResponse.json()
    const status = statusValue(payload)
    if (['failed', 'error', 'cancelled', 'canceled'].includes(status)) {
      throw new Error(payload.error?.message || payload.error || payload.message || `Cloud video job ${status}`)
    }
    url = outputUrl(payload)
  }
  await downloadFile(url, outputPath, { signal })
  return { path: outputPath, providerJobId: String(jobId || 'immediate') }
}
