import { spawn } from 'node:child_process'
import { getSettings } from '../db.js'
import { downloadFile, wait } from './providerUtils.js'

function run(command, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const abort = () => child.kill('SIGTERM')
    signal?.addEventListener('abort', abort, { once: true })
    child.on('error', reject)
    child.on('close', (code) => {
      signal?.removeEventListener('abort', abort)
      if (signal?.aborted) return reject(new DOMException('Generation cancelled', 'AbortError'))
      if (code === 0) resolve()
      else reject(new Error(`Audio generation failed: ${stderr.slice(-1200)}`))
    })
  })
}

async function generateMockAudio({ segment, outputPath, signal }) {
  const duration = String(segment.duration_sec)
  if (segment.type === 'narration' || segment.type === 'dialogue') {
    await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', duration, '-c:a', 'pcm_s16le', outputPath], signal)
  } else {
    const frequency = segment.type === 'music' ? 220 : 660
    const volume = segment.type === 'music' ? '0.025' : '0.08'
    await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=44100:duration=${duration}`, '-af', `volume=${volume}`, '-c:a', 'pcm_s16le', outputPath], signal)
  }
  return { path: outputPath, providerJobId: `mock-audio-${segment.id}` }
}

function outputUrl(payload) {
  return payload.output_url || payload.audio_url || payload.url || payload.output?.url || payload.data?.url
}

async function generateHttpAudio({ segment, outputPath, signal, local }) {
  const settings = getSettings({ includeSecrets: true })
  const baseUrl = local ? settings.audioLocalBaseUrl : settings.audioCloudBaseUrl
  const apiKey = local ? '' : settings.audioCloudApiKey
  const model = local ? settings.audioLocalModel : settings.audioCloudModel
  if (!baseUrl) throw new Error(`${local ? '本地' : '云端'}音频服务地址未配置`)
  const headers = { 'Content-Type': 'application/json' }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  const response = await fetch(new URL(settings.audioSubmitPath, baseUrl), {
    method: 'POST', headers, signal,
    body: JSON.stringify({
      type: segment.type,
      text: segment.text,
      prompt: segment.prompt,
      voice: segment.voice,
      direction: segment.audioDirection,
      duration: segment.duration_sec,
      model,
      format: 'wav',
    }),
  })
  if (!response.ok) throw new Error(`音频任务提交失败 (${response.status}): ${await response.text()}`)
  if (response.headers.get('content-type')?.startsWith('audio/')) {
    const bytes = Buffer.from(await response.arrayBuffer())
    await import('node:fs').then(({ default: fs }) => fs.writeFileSync(outputPath, bytes))
    return { path: outputPath, providerJobId: 'immediate' }
  }
  let payload = await response.json()
  const jobId = payload.id || payload.job_id || payload.task_id || payload.data?.id
  let url = outputUrl(payload)
  while (!url) {
    if (!jobId) throw new Error('音频服务未返回任务 ID 或下载地址')
    await wait(Number(settings.pollIntervalMs) || 3000, signal)
    const statusPath = String(settings.audioStatusPath).replace('{id}', encodeURIComponent(jobId))
    const statusResponse = await fetch(new URL(statusPath, baseUrl), { headers, signal })
    if (!statusResponse.ok) throw new Error(`音频任务查询失败 (${statusResponse.status})`)
    payload = await statusResponse.json()
    const status = String(payload.status || payload.state || payload.data?.status || '').toLowerCase()
    if (['failed', 'error', 'cancelled', 'canceled'].includes(status)) throw new Error(payload.error?.message || payload.error || '音频生成失败')
    url = outputUrl(payload)
  }
  await downloadFile(url, outputPath, { signal })
  return { path: outputPath, providerJobId: String(jobId || 'immediate') }
}

export async function generateAudioAsset({ segment, outputPath, signal }) {
  if (segment.provider === 'mock') return generateMockAudio({ segment, outputPath, signal })
  if (segment.provider === 'cloud-http') return generateHttpAudio({ segment, outputPath, signal, local: false })
  if (segment.provider === 'local-http') return generateHttpAudio({ segment, outputPath, signal, local: true })
  throw new Error(`不支持的音频 Provider：${segment.provider}`)
}
