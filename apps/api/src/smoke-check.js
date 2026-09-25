import assert from 'node:assert/strict'
import { getSettings } from './db.js'
import { generateVideoPlan } from './services/planningService.js'

const settings = getSettings()
assert.equal(settings.videoProvider, 'mock')

const plan = await generateVideoPlan({
  theme: '一束光穿过清晨的城市',
  durationSec: 10,
  aspectRatio: '16:9',
  language: 'zh-CN',
  provider: 'mock',
})
assert.ok(plan.shots.length >= 2)
assert.equal(Number(plan.shots.reduce((sum, shot) => sum + shot.durationSec, 0).toFixed(2)), 10)
assert.ok(plan.shots.every((shot) => shot.visualPrompt))
console.log('API smoke check passed')
