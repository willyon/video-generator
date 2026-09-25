import { getSettings } from '../db.js'
import { dimensionsFor } from './providerUtils.js'
import { generateMockClip } from './mockVideoProvider.js'
import { generateCloudHttpClip } from './cloudHttpVideoProvider.js'
import { generateComfyClip } from './comfyVideoProvider.js'

export async function generateVideoClip({ provider, shot, aspectRatio, outputPath, signal }) {
  const settings = getSettings({ includeSecrets: true })
  const selected = provider || settings.videoProvider || 'mock'
  const common = { shot, settings, aspectRatio, outputPath, signal, dimensions: dimensionsFor(aspectRatio) }
  if (selected === 'mock') return generateMockClip(common)
  if (selected === 'cloud-http') return generateCloudHttpClip(common)
  if (selected === 'comfyui') return generateComfyClip(common)
  throw new Error(`Unsupported video provider: ${selected}`)
}
