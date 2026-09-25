import { downloadFile, wait } from './providerUtils.js'
import fs from 'node:fs'
import path from 'node:path'
import { outputDir } from '../config.js'

function replaceWorkflowPlaceholders(source, values) {
  let result = source
  for (const [key, value] of Object.entries(values)) {
    result = result.replaceAll(`{{${key}}}`, typeof value === 'string' ? JSON.stringify(value).slice(1, -1) : String(value))
  }
  return result
}

function findVideoOutput(history) {
  for (const output of Object.values(history?.outputs || {})) {
    for (const key of ['videos', 'gifs', 'images']) {
      const items = output?.[key]
      if (!Array.isArray(items)) continue
      const video = items.find((item) => /\.(mp4|webm|mov)$/i.test(item.filename || ''))
      if (video) return video
    }
  }
  return null
}

async function uploadAsset(baseUrl, asset, signal) {
  const bytes = fs.readFileSync(path.join(outputDir, asset.filePath))
  const form = new FormData()
  form.append('image', new Blob([bytes], { type: asset.mimeType }), path.basename(asset.filePath))
  form.append('overwrite', 'true')
  const response = await fetch(new URL('/upload/image', baseUrl), { method: 'POST', body: form, signal })
  if (!response.ok) throw new Error(`ComfyUI 素材上传失败 (${response.status}): ${await response.text()}`)
  const payload = await response.json()
  return payload.name || payload.filename
}

export async function generateComfyClip({ shot, settings, outputPath, signal, dimensions }) {
  if (!settings.comfyBaseUrl) throw new Error('ComfyUI base URL is not configured')
  if (!settings.comfyWorkflowJson) throw new Error('ComfyUI workflow JSON is not configured')
  const spec = shot.generationSpec || {}
  const uploaded = {}
  for (const asset of spec.assets || []) {
    if (asset.mimeType?.startsWith('image/')) uploaded[asset.role] = await uploadAsset(settings.comfyBaseUrl, asset, signal)
  }
  const workflowText = replaceWorkflowPlaceholders(settings.comfyWorkflowJson, {
    PROMPT: spec.prompt,
    NEGATIVE_PROMPT: spec.negativePrompt,
    WIDTH: dimensions.width,
    HEIGHT: dimensions.height,
    DURATION: shot.duration_sec,
    FPS: 24,
    SEED: spec.seed ?? Math.floor(Math.random() * 2_147_483_647),
    GENERATION_MODE: spec.mode || shot.generation_mode,
    FIRST_FRAME: uploaded['first-frame'] || '',
    LAST_FRAME: uploaded['last-frame'] || '',
    REFERENCE_IMAGE: uploaded.reference || '',
  })
  let workflow
  try { workflow = JSON.parse(workflowText) } catch (error) { throw new Error(`Invalid ComfyUI workflow JSON: ${error.message}`) }

  const submit = await fetch(new URL('/prompt', settings.comfyBaseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow }),
    signal,
  })
  if (!submit.ok) throw new Error(`ComfyUI submission failed (${submit.status}): ${await submit.text()}`)
  const promptId = (await submit.json()).prompt_id
  if (!promptId) throw new Error('ComfyUI did not return prompt_id')

  while (true) {
    await wait(Number(settings.pollIntervalMs) || 3000, signal)
    const response = await fetch(new URL(`/history/${encodeURIComponent(promptId)}`, settings.comfyBaseUrl), { signal })
    if (!response.ok) throw new Error(`ComfyUI history failed (${response.status})`)
    const payload = await response.json()
    const history = payload[promptId]
    if (!history) continue
    if (history.status?.status_str === 'error') throw new Error('ComfyUI workflow failed')
    const video = findVideoOutput(history)
    if (!video) {
      if (history.status?.completed) throw new Error('ComfyUI workflow completed without a video output')
      continue
    }
    const viewUrl = new URL('/view', settings.comfyBaseUrl)
    viewUrl.searchParams.set('filename', video.filename)
    viewUrl.searchParams.set('subfolder', video.subfolder || '')
    viewUrl.searchParams.set('type', video.type || 'output')
    await downloadFile(viewUrl, outputPath, { signal })
    return { path: outputPath, providerJobId: promptId }
  }
}
