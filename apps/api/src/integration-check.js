import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'video-generator-check-'))
process.env.VIDEO_GENERATOR_DATA_DIR = path.join(testRoot, 'data')
process.env.VIDEO_GENERATOR_OUTPUT_DIR = path.join(testRoot, 'outputs')

try {
  const { addShot, createVideo, deleteShot, getVideo, reorderShots, setPlanFrozen, updateShot } = await import('./services/videoService.js')
  const { updateVisualDirection } = await import('./services/visualDirectionService.js')
  const { generateVideoAssets } = await import('./services/generationService.js')
  const { reviewShot, selectShotVersion } = await import('./services/reviewService.js')
  const { createAsset } = await import('./services/assetService.js')
  const { db } = await import('./db.js')
  const { getJob, resumeGenerationJob } = await import('./services/jobService.js')
  const { createAudioSegment, generateAudioSegment, initializeAudioPlan, mixProjectAudio, selectAudioVersion } = await import('./services/audioService.js')

  let video = await createVideo({
    theme: '清晨的城市光线',
    durationSec: 10,
    aspectRatio: '16:9',
    provider: 'mock',
    subtitlesEnabled: true,
    visualDirection: {
      medium: 'cinematic realism with subtle film grain',
      mood: 'quiet and hopeful',
      colorLighting: 'cool morning shadows with warm sunlight',
      camera: 'stable deliberate framing',
      negative: 'oversaturated colors, handheld shake',
    },
  })
  assert.equal(video.shots.length, 2)
  assert.deepEqual(video.shots.map((shot) => shot.duration_sec), [5, 5])

  video = addShot(video.id, { afterShotId: video.shots[0].id })
  assert.equal(video.shots.length, 3)
  const addedShot = video.shots[1]
  video = deleteShot(addedShot.id)
  assert.equal(video.shots.length, 2)
  const reversedIds = video.shots.map((shot) => shot.id).reverse()
  video = reorderShots(video.id, reversedIds)
  assert.deepEqual(video.shots.map((shot) => shot.id), reversedIds)
  video = reorderShots(video.id, reversedIds.reverse())

  updateShot(video.shots[0].id, { generationMode: 'keyframes' })
  assert.throws(() => setPlanFrozen(video.id, true), /缺少素材/)
  for (const role of ['first-frame', 'last-frame']) {
    const source = path.join(testRoot, `${role}.png`)
    fs.writeFileSync(source, Buffer.from('test-reference'))
    createAsset({
      videoId: video.id,
      shotId: video.shots[0].id,
      role,
      file: { path: source, originalname: `${role}.png`, mimetype: 'image/png', size: 14 },
    })
  }

  video = updateVisualDirection(video.id, { ...video.visualDirection, motion: 'slow natural movement' })
  video = setPlanFrozen(video.id, true)
  assert.ok(video.shots.every((shot) => shot.generationSpec?.seed !== undefined))
  assert.equal(video.shots[0].generationSpec.assets.length, 2)
  assert.equal(video.shots[0].generationSpec.visualDirection.motion, 'slow natural movement')
  assert.ok(video.shots[0].generationSpec.prompt.includes('[Visual medium and texture]'))
  assert.ok(video.shots[0].generationSpec.prompt.includes('[Motion and rhythm]'))
  assert.ok(video.shots[0].generationSpec.negativePrompt.includes('handheld shake'))
  assert.throws(() => updateVisualDirection(video.id, {}), /已冻结/)
  await generateVideoAssets(video.id)

  video = getVideo(video.id)
  assert.equal(video.status, 'review')
  assert.ok(video.video_path)
  assert.ok(video.shots.every((shot) => shot.versions.length === 1))
  assert.ok(video.shots.every((shot) => shot.versions[0].validation.valid))
  assert.ok(video.shots.every((shot) => shot.selected_version_id))

  for (const shot of video.shots) reviewShot(shot.id, 'approved')
  assert.equal(getVideo(video.id).status, 'approved')

  await generateVideoAssets(video.id, { shotIds: [video.shots[0].id] })
  video = getVideo(video.id)
  assert.equal(video.shots[0].versions.length, 2)
  assert.ok(video.shots[0].versions.every((version) => version.clip_path && fs.existsSync(path.join(process.env.VIDEO_GENERATOR_OUTPUT_DIR, version.clip_path))))

  const oldestVersion = video.shots[0].versions.at(-1)
  await selectShotVersion(video.shots[0].id, oldestVersion.id)
  assert.equal(getVideo(video.id).shots[0].selected_version_id, oldestVersion.id)

  const interruptedId = 'integration-interrupted'
  const payload = { initialShotIds: [video.shots[0].id], remainingShotIds: [video.shots[0].id] }
  db.prepare(`
    INSERT INTO generation_jobs (id, video_id, status, current_step, total_shots, payload_json)
    VALUES (?, ?, 'interrupted', '测试中断', 1, ?)
  `).run(interruptedId, video.id, JSON.stringify(payload))
  const resumed = resumeGenerationJob(interruptedId)
  let resumedJob = getJob(resumed.id)
  for (let attempt = 0; attempt < 100 && !['done', 'error'].includes(resumedJob.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    resumedJob = getJob(resumed.id)
  }
  assert.equal(resumedJob.status, 'done')
  assert.equal(getVideo(video.id).shots[0].versions.length, 3)

  const assemblyJobId = 'integration-assembly-interrupted'
  db.prepare(`
    INSERT INTO generation_jobs (id, video_id, status, current_step, total_shots, payload_json)
    VALUES (?, ?, 'interrupted', '合成中断', 0, ?)
  `).run(assemblyJobId, video.id, JSON.stringify({ initialShotIds: [], remainingShotIds: [], needsAssembly: true }))
  const assemblyResume = resumeGenerationJob(assemblyJobId)
  let assemblyJob = getJob(assemblyResume.id)
  for (let attempt = 0; attempt < 100 && !['done', 'error'].includes(assemblyJob.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    assemblyJob = getJob(assemblyResume.id)
  }
  assert.equal(assemblyJob.status, 'done')
  assert.equal(getVideo(video.id).shots[0].versions.length, 3)

  video = getVideo(video.id)
  for (const shot of video.shots) reviewShot(shot.id, 'approved')
  video = initializeAudioPlan(video.id)
  assert.ok(video.audioSegments.length >= 1)
  for (const segment of video.audioSegments) await generateAudioSegment(segment.id)
  video = createAudioSegment(video.id, {
    type: 'music', startSec: 0, durationSec: video.duration_sec,
    prompt: '轻柔而克制的清晨氛围音乐', provider: 'mock',
  })
  const music = video.audioSegments.find((segment) => segment.type === 'music')
  await generateAudioSegment(music.id)
  await generateAudioSegment(music.id)
  video = getVideo(video.id)
  const refreshedMusic = video.audioSegments.find((segment) => segment.id === music.id)
  assert.equal(refreshedMusic.versions.length, 2)
  selectAudioVersion(music.id, refreshedMusic.versions.at(-1).id)
  video = await mixProjectAudio(video.id)
  assert.equal(video.status, 'complete')
  const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name', '-of', 'json', path.join(process.env.VIDEO_GENERATOR_OUTPUT_DIR, video.video_path)], { encoding: 'utf8' })
  assert.equal(probe.status, 0)
  assert.ok(JSON.parse(probe.stdout).streams?.[0]?.codec_name)
  console.log('API integration check passed')
} finally {
  fs.rmSync(testRoot, { recursive: true, force: true })
}
