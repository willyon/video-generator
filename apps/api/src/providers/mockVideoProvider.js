import { spawn } from 'node:child_process'
import { dimensionsFor } from './providerUtils.js'

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
      else reject(new Error(`FFmpeg mock generation failed: ${stderr.slice(-1200)}`))
    })
  })
}

export async function generateMockClip({ shot, aspectRatio, outputPath, signal }) {
  const { width, height } = dimensionsFor(aspectRatio)
  const colors = ['0x174C3C', '0x693C35', '0x3C486A', '0x5A4930']
  const color = colors[(shot.shot_number - 1) % colors.length]
  const source = `color=c=${color}:s=${width}x${height}:r=24:d=${shot.duration_sec}`
  const vf = `drawgrid=width=iw/8:height=ih/8:color=white@0.06:t=1,noise=alls=7:allf=t+u,format=yuv420p`
  await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', source, '-vf', vf, '-t', String(shot.duration_sec), '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-movflags', '+faststart', outputPath], signal)
  return { path: outputPath, providerJobId: `mock-${shot.id}` }
}
