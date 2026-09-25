import fs from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

export async function wait(ms, signal) {
  if (signal?.aborted) throw new DOMException('Generation cancelled', 'AbortError')
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new DOMException('Generation cancelled', 'AbortError'))
    }, { once: true })
  })
}

export async function downloadFile(url, destination, { headers = {}, signal } = {}) {
  const response = await fetch(url, { headers, signal })
  if (!response.ok || !response.body) throw new Error(`Failed to download generated video (${response.status})`)
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destination))
  return destination
}

export function dimensionsFor(aspectRatio) {
  return aspectRatio === '9:16' ? { width: 720, height: 1280 } : { width: 1280, height: 720 }
}
