import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

function runFfmpeg(args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const abort = () => child.kill('SIGTERM')
    signal?.addEventListener('abort', abort, { once: true })
    child.on('error', reject)
    child.on('close', (code) => {
      signal?.removeEventListener('abort', abort)
      if (signal?.aborted) return reject(new DOMException('Generation cancelled', 'AbortError'))
      if (code === 0) resolve()
      else reject(new Error(`FFmpeg failed: ${stderr.slice(-1600)}`))
    })
  })
}

function runCapture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr.slice(-1200))))
  })
}

export async function inspectVideo(filePath, expected) {
  const result = {
    valid: false,
    errors: [],
    fileSize: fs.existsSync(filePath) ? fs.statSync(filePath).size : 0,
    durationSec: null,
    width: null,
    height: null,
    codec: null,
    fps: null,
  }
  if (!result.fileSize) {
    result.errors.push('生成文件为空或不存在')
    return result
  }
  try {
    const output = await runCapture('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,width,height,r_frame_rate:format=duration',
      '-of', 'json', filePath,
    ])
    const payload = JSON.parse(output)
    const stream = payload.streams?.[0]
    result.durationSec = Number(payload.format?.duration)
    result.width = Number(stream?.width)
    result.height = Number(stream?.height)
    result.codec = stream?.codec_name || null
    const [numerator, denominator] = String(stream?.r_frame_rate || '0/1').split('/').map(Number)
    result.fps = denominator ? Number((numerator / denominator).toFixed(3)) : 0
    if (!stream) result.errors.push('文件中没有视频轨道')
    if (!Number.isFinite(result.durationSec)) result.errors.push('无法读取视频时长')
    if (Math.abs(result.durationSec - expected.durationSec) > 0.4) {
      result.errors.push(`视频时长 ${result.durationSec.toFixed(2)} 秒与计划 ${expected.durationSec} 秒不符`)
    }
    if (result.width !== expected.width || result.height !== expected.height) {
      result.errors.push(`视频尺寸 ${result.width}x${result.height} 与计划 ${expected.width}x${expected.height} 不符`)
    }
  } catch (error) {
    result.errors.push(`视频无法解码：${error.message}`)
  }
  result.valid = result.errors.length === 0
  return result
}

export async function inspectAudio(filePath, expectedDuration) {
  const result = { valid: false, errors: [], fileSize: fs.existsSync(filePath) ? fs.statSync(filePath).size : 0, durationSec: null }
  if (!result.fileSize) {
    result.errors.push('音频文件为空或不存在')
    return result
  }
  try {
    const output = await runCapture('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name:format=duration', '-of', 'json', filePath])
    const payload = JSON.parse(output)
    result.durationSec = Number(payload.format?.duration)
    if (!payload.streams?.[0]) result.errors.push('文件中没有音频轨道')
    if (!Number.isFinite(result.durationSec)) result.errors.push('无法读取音频时长')
    if (Math.abs(result.durationSec - expectedDuration) > 0.5) result.errors.push(`音频时长 ${result.durationSec.toFixed(2)} 秒与计划 ${expectedDuration} 秒不符`)
  } catch (error) {
    result.errors.push(`音频无法解码：${error.message}`)
  }
  result.valid = result.errors.length === 0
  return result
}

export async function mixAudioTracks(videoPath, clips, destination, durationSec, signal) {
  if (!clips.length) {
    fs.copyFileSync(videoPath, destination)
    return destination
  }
  const args = ['-y', '-i', videoPath]
  clips.forEach((clip) => args.push('-i', clip.filePath))
  const filters = clips.map((clip, index) => {
    const delay = Math.max(0, Math.round(Number(clip.start_sec) * 1000))
    const volume = Number.isFinite(Number(clip.volume)) ? Number(clip.volume) : 1
    return `[${index + 1}:a]adelay=${delay}:all=1,volume=${volume}[a${index + 1}]`
  })
  const labels = clips.map((_clip, index) => `[a${index + 1}]`).join('')
  filters.push(`${labels}amix=inputs=${clips.length}:duration=longest:normalize=0[mix]`)
  args.push('-filter_complex', filters.join(';'), '-map', '0:v:0', '-map', '[mix]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-t', String(durationSec), '-movflags', '+faststart', destination)
  await runFfmpeg(args, signal)
  return destination
}

function srtTimestamp(seconds) {
  const milliseconds = Math.round(seconds * 1000)
  const hours = Math.floor(milliseconds / 3_600_000)
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000)
  const secs = Math.floor((milliseconds % 60_000) / 1000)
  const ms = milliseconds % 1000
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`
}

export function writeSubtitles(shots, destination) {
  let cursor = 0
  const blocks = []
  shots.forEach((shot, index) => {
    const text = [shot.dialogue, shot.narration].filter(Boolean).join('\n')
    const start = cursor
    cursor += Number(shot.duration_sec)
    if (text) blocks.push(`${index + 1}\n${srtTimestamp(start)} --> ${srtTimestamp(cursor)}\n${text}\n`)
  })
  fs.writeFileSync(destination, blocks.join('\n'), 'utf8')
  return blocks.length ? destination : null
}

export async function assembleVideo(shots, destination, signal) {
  const listPath = path.join(path.dirname(destination), 'concat.txt')
  const content = shots.map((shot) => `file '${shot.clip_path.replaceAll("'", "'\\''")}'`).join('\n')
  fs.writeFileSync(listPath, content, 'utf8')
  await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', destination], signal)
  return destination
}
