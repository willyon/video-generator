<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import {
  ArrowDown, ArrowLeftRight, ArrowUp, Check, ChevronRight, Clapperboard, Download, Film, Lock,
  LoaderCircle, Plus, RefreshCw, Save, Settings, Sparkles, Square, Trash2,
  Unlock, Upload, Video, X, CircleCheck, CircleX, Volume2, Music2,
} from 'lucide-vue-next'
import { api } from './api.js'
import {
  audioCloudModelOptions,
  audioLocalModelOptions,
  audioProviderOptions,
  textModelOptions,
  textProviderOptions,
  videoCloudModelOptions,
  videoProviderOptions,
  withCurrentOption,
} from './constants/modelOptions.js'

const videos = ref([])
const current = ref(null)
const settings = reactive({})
const capabilities = ref([])
const showCreate = ref(false)
const showSettings = ref(false)
const busy = ref('')
const error = ref('')
const pollTimer = ref(null)

const createForm = reactive({
  theme: '', durationSec: 10, aspectRatio: '16:9', language: 'zh-CN',
  provider: 'mock', subtitlesEnabled: true,
  visualDirection: {
    medium: '', mood: '', colorLighting: '', character: '', world: '',
    camera: '', motion: '', vfx: '', audio: '', negative: '',
  },
})

const statusLabel = {
  draft: '待编辑', ready: '已冻结', generating: '生成中', partial: '部分完成',
  review: '待审核', approved: '已通过', audio: '声音制作', complete: '已完成', error: '失败',
}

const totalDuration = computed(() => current.value?.shots?.reduce((sum, shot) => sum + Number(shot.duration_sec), 0) || 0)
const runningJob = computed(() => ['queued', 'running', 'cancelling'].includes(current.value?.latestJob?.status))
const progress = computed(() => {
  const job = current.value?.latestJob
  if (!job?.total_shots) return 0
  return Math.round((job.completed_shots / job.total_shots) * 100)
})
const currentCapability = computed(() => capabilities.value.find((item) => item.provider === current.value?.provider))
const projectAssets = computed(() => current.value?.assets?.filter((asset) => !asset.shot_id) || [])
const allShotsApproved = computed(() => current.value?.shots?.length && current.value.shots.every((shot) => shot.review_status === 'approved'))
const audioReady = computed(() => current.value?.audioSegments?.length && current.value.audioSegments.every((segment) => segment.selected_version_id))

const audioTypeLabel = { narration: '旁白', dialogue: '对白', music: '背景音乐', sfx: '音效' }

const textModelChoices = computed(() => withCurrentOption(textModelOptions, settings.openRouterModel))
const videoCloudModelChoices = computed(() => withCurrentOption(videoCloudModelOptions, settings.cloudModel))
const audioCloudModelChoices = computed(() => withCurrentOption(audioCloudModelOptions, settings.audioCloudModel))
const audioLocalModelChoices = computed(() => withCurrentOption(audioLocalModelOptions, settings.audioLocalModel))

function shotAssets(shotId) {
  return current.value?.assets?.filter((asset) => asset.shot_id === shotId) || []
}

function assetLabel(role) {
  return { 'first-frame': '首帧', 'last-frame': '尾帧', reference: '参考图', style: '风格', character: '角色', scene: '场景', 'motion-reference': '运动参考' }[role] || role
}

function fail(err) {
  error.value = err.message || String(err)
  window.setTimeout(() => { error.value = '' }, 7000)
}

async function loadVideos() {
  videos.value = await api.listVideos()
}

async function openVideo(id) {
  busy.value = 'open'
  try {
    current.value = await api.getVideo(id)
    if (runningJob.value) startPolling(current.value.latestJob.id)
  } catch (err) { fail(err) } finally { busy.value = '' }
}

async function createVideo() {
  busy.value = 'create'
  try {
    const video = await api.createVideo(createForm)
    showCreate.value = false
    createForm.theme = ''
    await loadVideos()
    await openVideo(video.id)
  } catch (err) { fail(err) } finally { busy.value = '' }
}

async function saveShots() {
  busy.value = 'save'
  try {
    await api.updateVisualDirection(current.value.id, current.value.visualDirection)
    for (const shot of current.value.shots) {
      await api.updateShot(shot.id, {
        durationSec: shot.duration_sec, narration: shot.narration, dialogue: shot.dialogue,
        visualPrompt: shot.visual_prompt, negativePrompt: shot.negative_prompt,
        cameraMove: shot.camera_move, location: shot.location, action: shot.action,
        continuity: shot.continuity, generationMode: shot.generation_mode,
      })
    }
    await refreshCurrent()
  } catch (err) { fail(err) } finally { busy.value = '' }
}

async function toggleFreeze() {
  busy.value = 'freeze'
  try {
    current.value = current.value.planFrozen ? await api.unfreeze(current.value.id) : await api.freeze(current.value.id)
    await loadVideos()
  } catch (err) { fail(err) } finally { busy.value = '' }
}

async function generate(shotId = null) {
  busy.value = shotId ? `shot-${shotId}` : 'generate'
  try {
    const job = await api.generate(current.value.id, shotId)
    current.value.latestJob = job
    startPolling(job.id)
  } catch (err) { fail(err) } finally { busy.value = '' }
}

function startPolling(jobId) {
  stopPolling()
  pollTimer.value = window.setInterval(async () => {
    try {
      const job = await api.getJob(jobId)
      if (current.value) current.value.latestJob = job
      if (['done', 'error', 'cancelled', 'interrupted'].includes(job.status)) {
        stopPolling()
        await refreshCurrent()
        await loadVideos()
      }
    } catch (err) {
      stopPolling()
      fail(err)
    }
  }, 1200)
}

function stopPolling() {
  if (pollTimer.value) window.clearInterval(pollTimer.value)
  pollTimer.value = null
}

async function refreshCurrent() {
  if (current.value) current.value = await api.getVideo(current.value.id)
}

async function cancelJob() {
  try { await api.cancelJob(current.value.latestJob.id) } catch (err) { fail(err) }
}

async function resumeJob() {
  try {
    const job = await api.resumeJob(current.value.latestJob.id)
    current.value.latestJob = job
    startPolling(job.id)
  } catch (err) { fail(err) }
}

async function uploadAsset(event, shot, role) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  busy.value = `asset-${shot?.id || 'project'}-${role}`
  try {
    await api.uploadAsset(current.value.id, { file, shotId: shot?.id || null, role })
    await refreshCurrent()
  } catch (err) { fail(err) } finally { busy.value = '' }
}

async function addShotAfter(shot) {
  busy.value = 'shot-structure'
  try { current.value = await api.addShot(current.value.id, shot?.id) } catch (err) { fail(err) } finally { busy.value = '' }
}

async function removeShot(shot) {
  if (!window.confirm(`从项目删除镜头 ${shot.shot_number}？本地生成文件不会被删除。`)) return
  busy.value = 'shot-structure'
  try { current.value = await api.deleteShot(shot.id) } catch (err) { fail(err) } finally { busy.value = '' }
}

async function moveShot(index, direction) {
  const next = index + direction
  if (next < 0 || next >= current.value.shots.length) return
  const ids = current.value.shots.map((shot) => shot.id)
  ;[ids[index], ids[next]] = [ids[next], ids[index]]
  busy.value = 'shot-structure'
  try { current.value = await api.reorderShots(current.value.id, ids) } catch (err) { fail(err) } finally { busy.value = '' }
}

async function removeAsset(asset) {
  if (!window.confirm(`删除素材“${asset.original_name}”？`)) return
  try {
    await api.deleteAsset(asset.id)
    await refreshCurrent()
  } catch (err) { fail(err) }
}

async function selectVersion(shot, versionId) {
  if (!versionId || versionId === shot.selected_version_id) return
  busy.value = `version-${shot.id}`
  try { current.value = await api.selectVersion(shot.id, versionId) } catch (err) { fail(err) } finally { busy.value = '' }
}

async function reviewShot(shot, decision) {
  busy.value = `review-${shot.id}`
  try {
    current.value = await api.reviewShot(shot.id, decision)
    await loadVideos()
  } catch (err) { fail(err) } finally { busy.value = '' }
}

async function initializeAudio() {
  busy.value = 'audio-init'
  try { current.value = await api.initializeAudio(current.value.id) } catch (err) { fail(err) } finally { busy.value = '' }
}

async function addAudio(type) {
  busy.value = 'audio-add'
  try {
    current.value = await api.createAudioSegment(current.value.id, {
      type, startSec: 0, durationSec: type === 'sfx' ? Math.min(2, current.value.duration_sec) : current.value.duration_sec,
      prompt: type === 'music' ? '符合视频情绪、不过度抢占人声的背景音乐' : '与画面动作同步的环境音效',
      provider: settings.audioProvider || 'mock',
    })
  } catch (err) { fail(err) } finally { busy.value = '' }
}

async function saveAudio(segment) {
  busy.value = `audio-save-${segment.id}`
  try {
    current.value = await api.updateAudioSegment(segment.id, {
      startSec: segment.start_sec, durationSec: segment.duration_sec, text: segment.text,
      prompt: segment.prompt, voice: segment.voice, volume: segment.volume, provider: segment.provider,
    })
  } catch (err) { fail(err) } finally { busy.value = '' }
}

async function generateAudio(segment) {
  busy.value = `audio-generate-${segment.id}`
  try {
    const job = await api.generateAudio(segment.id)
    current.value.latestJob = job
    startPolling(job.id)
  } catch (err) { fail(err) } finally { busy.value = '' }
}

async function selectAudioVersion(segment, versionId) {
  if (!versionId || versionId === segment.selected_version_id) return
  try { current.value = await api.selectAudioVersion(segment.id, versionId) } catch (err) { fail(err) }
}

async function removeAudio(segment) {
  if (!window.confirm(`删除${audioTypeLabel[segment.type]}片段？`)) return
  try { current.value = await api.deleteAudioSegment(segment.id) } catch (err) { fail(err) }
}

async function mixAudio() {
  busy.value = 'audio-mix'
  try {
    current.value = await api.mixAudio(current.value.id)
    await loadVideos()
  } catch (err) { fail(err) } finally { busy.value = '' }
}

async function removeCurrent() {
  if (!window.confirm(`删除“${current.value.title}”？生成文件会保留在 outputs 目录。`)) return
  try {
    await api.deleteVideo(current.value.id)
    current.value = null
    await loadVideos()
  } catch (err) { fail(err) }
}

async function openSettings() {
  try {
    Object.assign(settings, await api.getSettings())
    capabilities.value = await api.getCapabilities()
    showSettings.value = true
  } catch (err) { fail(err) }
}

async function saveSettings() {
  busy.value = 'settings'
  try {
    Object.assign(settings, await api.saveSettings(settings))
    capabilities.value = await api.getCapabilities()
    showSettings.value = false
  } catch (err) { fail(err) } finally { busy.value = '' }
}

onMounted(async () => {
  try {
    await loadVideos()
    Object.assign(settings, await api.getSettings())
    capabilities.value = await api.getCapabilities()
    createForm.provider = settings.videoProvider || 'mock'
    if (videos.value[0]) await openVideo(videos.value[0].id)
  } catch (err) { fail(err) }
})
onBeforeUnmount(stopPolling)
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <a class="brand" href="#"><span class="brand-mark"><Clapperboard :size="20" /></span><span>Video Generator</span></a>
      <div class="topbar-actions">
        <button class="icon-btn" title="设置" @click="openSettings"><Settings :size="19" /></button>
        <button class="primary-btn" @click="showCreate = true"><Plus :size="17" />新建视频</button>
      </div>
    </header>

    <aside class="sidebar">
      <div class="sidebar-title"><span>视频项目</span><span class="count">{{ videos.length }}</span></div>
      <button v-for="video in videos" :key="video.id" class="project-row" :class="{ active: current?.id === video.id }" @click="openVideo(video.id)">
        <span class="project-thumb"><Video :size="18" /></span>
        <span class="project-copy"><strong>{{ video.title }}</strong><small>{{ video.duration_sec }}秒 · {{ video.aspect_ratio }} · {{ statusLabel[video.status] || video.status }}</small></span>
        <ChevronRight :size="16" />
      </button>
      <div v-if="!videos.length" class="sidebar-empty">尚未创建视频</div>
    </aside>

    <main class="workspace">
      <div v-if="error" class="toast error-toast"><span>{{ error }}</span><button title="关闭" @click="error = ''"><X :size="16" /></button></div>

      <section v-if="!current" class="empty-state">
        <Film :size="42" stroke-width="1.4" />
        <h1>创建第一个短视频</h1>
        <p>输入主题，生成可编辑的脚本、分镜和镜头计划。</p>
        <button class="primary-btn" @click="showCreate = true"><Sparkles :size="17" />开始创作</button>
      </section>

      <template v-else>
        <section class="project-header">
          <div>
            <div class="eyebrow"><span class="status-dot" :class="current.status"></span>{{ statusLabel[current.status] || current.status }}</div>
            <h1>{{ current.title }}</h1>
            <p>{{ current.theme }}</p>
          </div>
          <div class="project-actions">
            <button class="secondary-btn danger" title="删除项目" @click="removeCurrent"><Trash2 :size="17" /></button>
            <button v-if="!current.planFrozen" class="secondary-btn" :disabled="!!busy" @click="saveShots"><Save :size="17" />保存</button>
            <button class="secondary-btn" :disabled="!!busy || runningJob" @click="toggleFreeze">
              <Unlock v-if="current.planFrozen" :size="17" /><Lock v-else :size="17" />{{ current.planFrozen ? '解冻计划' : '冻结计划' }}
            </button>
            <button v-if="!runningJob && current.latestJob?.resumable" class="secondary-btn" :disabled="!!busy" @click="resumeJob"><RefreshCw :size="17" />继续任务</button>
            <button v-if="!runningJob" class="primary-btn" :disabled="!current.planFrozen || !!busy" @click="generate()"><Sparkles :size="17" />生成视频</button>
            <button v-else class="secondary-btn danger" @click="cancelJob"><Square :size="15" />取消</button>
          </div>
        </section>

        <section v-if="runningJob" class="job-strip">
          <LoaderCircle class="spin" :size="18" /><span>{{ current.latestJob.current_step }}</span>
          <div class="progress-track"><span :style="{ width: `${progress}%` }"></span></div><strong>{{ progress }}%</strong>
        </section>

        <section class="summary-band">
          <div><small>总时长</small><strong :class="{ mismatch: Math.abs(totalDuration - current.duration_sec) > .05 }">{{ totalDuration.toFixed(1) }} / {{ current.duration_sec }} 秒</strong></div>
          <div><small>画幅</small><strong>{{ current.aspect_ratio }}</strong></div>
          <div><small>生成器</small><strong>{{ current.provider }}</strong></div>
          <div><small>镜头</small><strong>{{ current.shots.length }}</strong></div>
          <div><small>字幕文件</small><strong>{{ current.subtitlesEnabled ? '生成 SRT' : '不生成' }}</strong></div>
        </section>

        <section class="direction-section">
          <div class="section-heading"><div><h2>视觉方向</h2><p>项目级规则会在冻结时按镜头编译，不直接作为一整段提示词发送。</p></div><span class="direction-state">{{ current.planFrozen ? '已随计划冻结' : '可编辑' }}</span></div>
          <div class="field-grid direction-grid">
            <label><span>视觉媒介与质感</span><textarea v-model="current.visualDirection.medium" rows="2" placeholder="例如：cinematic realism, subtle film grain" :disabled="current.planFrozen"></textarea></label>
            <label><span>整体情绪</span><textarea v-model="current.visualDirection.mood" rows="2" placeholder="例如：克制、神秘，但保留温暖感" :disabled="current.planFrozen"></textarea></label>
            <label><span>色彩与光照</span><textarea v-model="current.visualDirection.colorLighting" rows="2" placeholder="例如：低饱和冷色，暖色作为局部强调" :disabled="current.planFrozen"></textarea></label>
            <label><span>角色一致性</span><textarea v-model="current.visualDirection.character" rows="2" placeholder="外观、服装、比例和表演规则" :disabled="current.planFrozen"></textarea></label>
            <label><span>世界与场景</span><textarea v-model="current.visualDirection.world" rows="2" placeholder="空间、材质、时代与环境规则" :disabled="current.planFrozen"></textarea></label>
            <label><span>镜头语言</span><textarea v-model="current.visualDirection.camera" rows="2" placeholder="景别、焦段感、构图与摄影机倾向" :disabled="current.planFrozen"></textarea></label>
            <label><span>运动与节奏</span><textarea v-model="current.visualDirection.motion" rows="2" placeholder="人物动作、环境运动、快慢节奏" :disabled="current.planFrozen"></textarea></label>
            <label><span>视觉特效</span><textarea v-model="current.visualDirection.vfx" rows="2" placeholder="粒子、光效及其与场景的融合方式" :disabled="current.planFrozen"></textarea></label>
            <label><span>声音方向</span><textarea v-model="current.visualDirection.audio" rows="2" placeholder="旁白语气、音乐情绪与声音质感" :disabled="current.planFrozen"></textarea></label>
            <label><span>禁止项</span><textarea v-model="current.visualDirection.negative" rows="2" placeholder="不希望出现的视觉方向或瑕疵" :disabled="current.planFrozen"></textarea></label>
          </div>
        </section>

        <section class="reference-band">
          <div class="section-heading"><div><h2>项目参考</h2><p>角色、风格和场景素材会自动提供给全部镜头。</p></div></div>
          <div v-if="projectAssets.length" class="asset-list">
            <span v-for="asset in projectAssets" :key="asset.id" class="asset-chip"><a :href="asset.url" target="_blank">{{ assetLabel(asset.role) }} · {{ asset.original_name }}</a><button v-if="!current.planFrozen" title="删除素材" @click="removeAsset(asset)"><X :size="13" /></button></span>
          </div>
          <div v-if="!current.planFrozen" class="asset-actions">
            <label class="upload-btn"><Upload :size="14" />角色参考<input type="file" accept="image/*" @change="uploadAsset($event, null, 'character')" /></label>
            <label class="upload-btn"><Upload :size="14" />风格参考<input type="file" accept="image/*" @change="uploadAsset($event, null, 'style')" /></label>
            <label class="upload-btn"><Upload :size="14" />场景参考<input type="file" accept="image/*" @change="uploadAsset($event, null, 'scene')" /></label>
          </div>
        </section>

        <section v-if="current.videoUrl" class="preview-section">
          <div class="section-heading"><div><h2>成片预览</h2><p>镜头已合成，可返回分镜单独重生成。</p></div><a class="secondary-btn" :href="current.videoUrl" download><Download :size="17" />下载 MP4</a></div>
          <video class="video-preview" :class="current.aspect_ratio === '9:16' ? 'portrait' : 'landscape'" :src="current.videoUrl" controls />
          <a v-if="current.subtitleUrl" class="text-link" :href="current.subtitleUrl" download>下载 SRT 字幕</a>
        </section>

        <section v-if="current.video_base_path && allShotsApproved" class="audio-section">
          <div class="section-heading">
            <div><h2>声音时间线</h2><p>先建立旁白与对白，再按需添加音乐和音效；全部生成后混入成片。</p></div>
            <div class="audio-actions">
              <button v-if="!current.audioSegments?.length" class="secondary-btn" :disabled="!!busy" @click="initializeAudio"><Volume2 :size="16" />导入对白旁白</button>
              <button class="secondary-btn" :disabled="!!busy" @click="addAudio('music')"><Music2 :size="16" />音乐</button>
              <button class="secondary-btn" :disabled="!!busy" @click="addAudio('sfx')"><Plus :size="16" />音效</button>
              <button v-if="current.audioSegments?.length" class="primary-btn" :disabled="!audioReady || !!busy || runningJob" @click="mixAudio"><Volume2 :size="16" />混音导出</button>
            </div>
          </div>
          <div v-if="current.audioSegments?.length" class="audio-ruler">
            <span v-for="second in Math.ceil(current.duration_sec)" :key="second" :style="{ left: `${((second - 1) / current.duration_sec) * 100}%` }">{{ second - 1 }}s</span>
          </div>
          <article v-for="segment in current.audioSegments" :key="segment.id" class="audio-row">
            <div class="audio-kind"><strong>{{ audioTypeLabel[segment.type] }}</strong><small>{{ Number(segment.start_sec).toFixed(1) }}s - {{ (Number(segment.start_sec) + Number(segment.duration_sec)).toFixed(1) }}s</small></div>
            <div class="audio-editor">
              <div class="field-grid audio-fields">
                <label><span>开始</span><input v-model.number="segment.start_sec" type="number" min="0" :max="current.duration_sec" step="0.1" /></label>
                <label><span>时长</span><input v-model.number="segment.duration_sec" type="number" min="0.1" :max="current.duration_sec" step="0.1" /></label>
                <label><span>音量</span><input v-model.number="segment.volume" type="number" min="0" max="2" step="0.05" /></label>
                <label><span>Provider</span><select v-model="segment.provider"><option value="mock">Mock</option><option value="cloud-http">云端 HTTP</option><option value="local-http">本地 HTTP</option></select></label>
              </div>
              <label v-if="segment.type === 'narration' || segment.type === 'dialogue'"><span>文本</span><textarea v-model="segment.text" rows="2"></textarea></label>
              <label v-else><span>声音提示词</span><textarea v-model="segment.prompt" rows="2"></textarea></label>
              <label v-if="segment.type === 'narration' || segment.type === 'dialogue'"><span>音色 / Voice ID</span><input v-model="segment.voice" placeholder="留空使用模型默认音色" /></label>
              <div class="audio-footer">
                <audio v-if="segment.selectedUrl" :src="segment.selectedUrl" controls preload="metadata" />
                <select v-if="segment.versions?.length" :value="segment.selected_version_id" @change="selectAudioVersion(segment, $event.target.value)"><option v-for="version in segment.versions" :key="version.id" :value="version.id" :disabled="version.status !== 'valid'">v{{ version.version_number }} · {{ version.status }}</option></select>
                <span v-if="segment.error" class="inline-error">{{ segment.error }}</span>
                <div class="audio-row-actions"><button class="secondary-btn" :disabled="!!busy || runningJob" @click="saveAudio(segment)"><Save :size="15" />保存</button><button class="primary-btn" :disabled="!!busy || runningJob" @click="generateAudio(segment)"><Sparkles :size="15" />{{ segment.versions?.length ? '再生成' : '生成' }}</button><button class="icon-btn danger-icon" title="删除音轨" :disabled="!!busy || runningJob" @click="removeAudio(segment)"><Trash2 :size="16" /></button></div>
              </div>
            </div>
          </article>
          <div v-if="current.audioSegments?.length && !audioReady" class="audio-note">每条声音片段需要先生成或选择一个有效版本，之后才能混音导出。</div>
        </section>

        <section class="timeline-section">
          <div class="section-heading"><div><h2>分镜时间线</h2><p>{{ current.planFrozen ? '计划已冻结，解冻后可继续编辑。' : '先确认每个镜头的画面、动作与时长，再冻结生成。' }}</p></div><button v-if="!current.planFrozen" class="secondary-btn" :disabled="!!busy" @click="addShotAfter(current.shots.at(-1))"><Plus :size="16" />添加镜头</button></div>
          <div class="timeline-ruler"><span v-for="shot in current.shots" :key="shot.id" :style="{ flex: shot.duration_sec }">{{ shot.duration_sec }}s</span></div>

          <article v-for="(shot, shotIndex) in current.shots" :key="shot.id" class="shot-row">
            <div class="shot-index"><span>{{ String(shot.shot_number).padStart(2, '0') }}</span><small>{{ shot.duration_sec }}s</small><div v-if="!current.planFrozen" class="order-actions"><button title="上移" :disabled="shotIndex === 0 || !!busy" @click="moveShot(shotIndex, -1)"><ArrowUp :size="13" /></button><button title="下移" :disabled="shotIndex === current.shots.length - 1 || !!busy" @click="moveShot(shotIndex, 1)"><ArrowDown :size="13" /></button><button title="删除镜头" :disabled="current.shots.length === 1 || !!busy" @click="removeShot(shot)"><Trash2 :size="13" /></button></div></div>
            <div class="shot-media" :class="current.aspect_ratio === '9:16' ? 'portrait' : ''">
              <video v-if="shot.clipUrl" :src="shot.clipUrl" controls preload="metadata" />
              <div v-else class="media-placeholder"><Film :size="25" /><span>{{ shot.status === 'generating' ? '生成中' : '等待生成' }}</span></div>
            </div>
            <div class="shot-editor">
              <div class="field-grid four">
                <label><span>时长（秒）</span><input v-model.number="shot.duration_sec" type="number" min="1" step="0.5" :disabled="current.planFrozen" /></label>
                <label><span>生成模式</span><select v-model="shot.generation_mode" :disabled="current.planFrozen"><option v-for="mode in currentCapability?.modes || []" :key="mode.id" :value="mode.id">{{ mode.label }}</option></select></label>
                <label><span>运镜</span><input v-model="shot.camera_move" :disabled="current.planFrozen" /></label>
                <label><span>场景</span><input v-model="shot.location" :disabled="current.planFrozen" /></label>
              </div>
              <label><span>画面提示词</span><textarea v-model="shot.visual_prompt" rows="3" :disabled="current.planFrozen"></textarea></label>
              <details v-if="shot.generationSpec?.prompt" class="prompt-preview"><summary>查看冻结后的模型指令</summary><div v-for="section in shot.generationSpec.promptSections" :key="section.key"><strong>{{ section.label }}</strong><p>{{ section.content }}</p></div><div><strong>Negative</strong><p>{{ shot.generationSpec.negativePrompt }}</p></div></details>
              <div class="asset-section">
                <span class="label-title">参考素材</span>
                <div v-if="shotAssets(shot.id).length" class="asset-list">
                  <span v-for="asset in shotAssets(shot.id)" :key="asset.id" class="asset-chip">
                    <a :href="asset.url" target="_blank">{{ assetLabel(asset.role) }} · {{ asset.original_name }}</a>
                    <button v-if="!current.planFrozen" title="删除素材" @click="removeAsset(asset)"><X :size="13" /></button>
                  </span>
                </div>
                <div v-if="!current.planFrozen" class="asset-actions">
                  <label class="upload-btn"><Upload :size="14" />首帧<input type="file" accept="image/*" @change="uploadAsset($event, shot, 'first-frame')" /></label>
                  <label v-if="shot.generation_mode === 'keyframes'" class="upload-btn"><Upload :size="14" />尾帧<input type="file" accept="image/*" @change="uploadAsset($event, shot, 'last-frame')" /></label>
                  <label class="upload-btn"><Upload :size="14" />参考图<input type="file" accept="image/*" @change="uploadAsset($event, shot, 'reference')" /></label>
                </div>
              </div>
              <div class="field-grid two">
                <label><span>旁白</span><textarea v-model="shot.narration" rows="2" :disabled="current.planFrozen"></textarea></label>
                <label><span>角色对白</span><textarea v-model="shot.dialogue" rows="2" placeholder="可留空" :disabled="current.planFrozen"></textarea></label>
              </div>
              <div v-if="shot.versions?.length" class="version-bar">
                <label><span>生成版本</span><select :value="shot.selected_version_id" :disabled="!!busy" @change="selectVersion(shot, $event.target.value)"><option v-for="version in shot.versions" :key="version.id" :value="version.id" :disabled="version.status !== 'valid'">v{{ version.version_number }} · {{ version.status }} · {{ version.validation?.durationSec?.toFixed(2) || '-' }}s</option></select></label>
                <span v-if="shot.versions.find(v => v.id === shot.selected_version_id)?.validation" class="validation-ok"><Check :size="14" />技术校验通过</span>
              </div>
              <div class="shot-footer">
                <span v-if="shot.error" class="inline-error">{{ shot.error }}</span>
                <span v-else class="shot-status" :class="shot.review_status"><Check v-if="shot.status === 'generated' || shot.status === 'approved'" :size="14" />{{ shot.review_status === 'approved' ? '已通过' : shot.review_status === 'rejected' ? '已驳回' : shot.status }}</span>
                <div class="shot-actions">
                  <button v-if="shot.selected_version_id" class="text-btn approve" :disabled="!!busy || shot.review_status === 'approved'" @click="reviewShot(shot, 'approved')"><CircleCheck :size="15" />通过</button>
                  <button v-if="shot.selected_version_id" class="text-btn reject" :disabled="!!busy" @click="reviewShot(shot, 'rejected')"><CircleX :size="15" />驳回</button>
                  <button v-if="current.planFrozen" class="text-btn" :disabled="runningJob || busy === `shot-${shot.id}`" @click="generate(shot.id)"><RefreshCw :size="15" />重生成</button>
                </div>
              </div>
            </div>
          </article>
        </section>
      </template>
    </main>

    <div v-if="showCreate" class="modal-backdrop" @click.self="showCreate = false">
      <form class="modal" @submit.prevent="createVideo">
        <div class="modal-header"><div><h2>新建短视频</h2><p>先生成脚本和分镜，确认后再消耗视频模型额度。</p></div><button type="button" class="icon-btn" title="关闭" @click="showCreate = false"><X :size="19" /></button></div>
        <label><span>主题</span><textarea v-model="createForm.theme" rows="3" required placeholder="例如：一位宇航员在雨夜的上海寻找遗失的记忆"></textarea></label>
        <div class="field-grid two">
          <label><span>时长</span><select v-model.number="createForm.durationSec"><option :value="5">5 秒</option><option :value="10">10 秒</option><option :value="15">15 秒</option><option :value="30">30 秒</option></select></label>
          <label><span>生成器</span><select v-model="createForm.provider"><option value="mock">Mock FFmpeg</option><option value="cloud-http">云端 HTTP API</option><option value="comfyui">本地 ComfyUI</option></select></label>
        </div>
        <div><span class="label-title">画幅</span><div class="segment"><button type="button" :class="{ active: createForm.aspectRatio === '16:9' }" @click="createForm.aspectRatio = '16:9'"><ArrowLeftRight :size="16" />横屏 16:9</button><button type="button" :class="{ active: createForm.aspectRatio === '9:16' }" @click="createForm.aspectRatio = '9:16'"><ArrowLeftRight :size="16" class="rotate" />竖屏 9:16</button></div></div>
        <div class="field-grid two">
          <label><span>视觉媒介与质感</span><input v-model="createForm.visualDirection.medium" placeholder="例如：cinematic realism, subtle film grain" /></label>
          <label><span>整体情绪</span><input v-model="createForm.visualDirection.mood" placeholder="例如：神秘、克制、温暖" /></label>
          <label><span>色彩与光照</span><input v-model="createForm.visualDirection.colorLighting" placeholder="例如：雨夜冷色，暖色车窗光" /></label>
          <label><span>镜头与运动倾向</span><input v-model="createForm.visualDirection.camera" placeholder="例如：稳定缓慢推进，电影感构图" /></label>
        </div>
        <label class="checkbox-row"><input v-model="createForm.subtitlesEnabled" type="checkbox" /><span>生成 SRT 字幕文件</span></label>
        <div class="modal-actions"><button type="button" class="secondary-btn" @click="showCreate = false">取消</button><button class="primary-btn" :disabled="busy === 'create'"><LoaderCircle v-if="busy === 'create'" class="spin" :size="17" /><Sparkles v-else :size="17" />生成分镜</button></div>
      </form>
    </div>

    <div v-if="showSettings" class="modal-backdrop" @click.self="showSettings = false">
      <form class="modal settings-modal" @submit.prevent="saveSettings">
        <div class="modal-header"><div><h2>模型与连接</h2><p>密钥只保存在本机 SQLite。OpenRouter 目前覆盖文本规划；视频与声音需独立网关或保持 Mock。</p></div><button type="button" class="icon-btn" title="关闭" @click="showSettings = false"><X :size="19" /></button></div>

        <h3>1. 文本规划（分镜）</h3>
        <div class="field-grid two">
          <label><span>Provider</span><select v-model="settings.textProvider"><option v-for="item in textProviderOptions" :key="item.value" :value="item.value">{{ item.label }}</option></select></label>
          <label><span>模型</span><select v-model="settings.openRouterModel" :disabled="settings.textProvider !== 'openrouter'"><option v-for="item in textModelChoices" :key="item.value" :value="item.value">{{ item.label }}{{ item.hint ? ` · ${item.hint}` : '' }}</option></select></label>
        </div>
        <label><span>OpenRouter API Key</span><input v-model="settings.openRouterApiKey" type="password" autocomplete="off" placeholder="填入后即可用上方模型生成分镜" /></label>

        <h3>2. 默认视频生成</h3>
        <label><span>Provider</span><select v-model="settings.videoProvider"><option v-for="item in videoProviderOptions" :key="item.value" :value="item.value">{{ item.label }}{{ item.hint ? ` · ${item.hint}` : '' }}</option></select></label>
        <div class="settings-group">
          <h4>云端 HTTP（选「云端 HTTP API」时使用）</h4>
          <p class="settings-note">OpenRouter 暂无文生视频模型。请填写可灵 / 万相 / 自建网关等地址；模型 ID 按网关文档选择。</p>
          <div class="field-grid two">
            <label><span>Base URL</span><input v-model="settings.cloudBaseUrl" placeholder="https://your-video-gateway.example" /></label>
            <label><span>模型</span><select v-model="settings.cloudModel"><option v-for="item in videoCloudModelChoices" :key="item.value" :value="item.value">{{ item.label }}{{ item.hint ? ` · ${item.hint}` : '' }}</option></select></label>
          </div>
          <label><span>API Key</span><input v-model="settings.cloudApiKey" type="password" autocomplete="off" /></label>
          <div class="field-grid two"><label><span>提交路径</span><input v-model="settings.cloudSubmitPath" /></label><label><span>状态路径</span><input v-model="settings.cloudStatusPath" /></label></div>
          <label><span>支持的单镜头时长（逗号分隔）</span><input :value="settings.cloudDurationOptions?.join(', ')" @input="settings.cloudDurationOptions = $event.target.value.split(',').map(Number).filter(Boolean)" /></label>
        </div>
        <div class="settings-group">
          <h4>本地 ComfyUI</h4>
          <div class="field-grid two"><label><span>Base URL</span><input v-model="settings.comfyBaseUrl" /></label><label><span>支持的单镜头时长</span><input :value="settings.comfyDurationOptions?.join(', ')" @input="settings.comfyDurationOptions = $event.target.value.split(',').map(Number).filter(Boolean)" /></label></div>
          <label><span>API 工作流 JSON</span><textarea v-model="settings.comfyWorkflowJson" rows="7" placeholder="支持 {{PROMPT}}、{{NEGATIVE_PROMPT}}、{{WIDTH}}、{{HEIGHT}}、{{DURATION}}、{{FPS}}、{{SEED}}、{{FIRST_FRAME}}、{{LAST_FRAME}}"></textarea></label>
        </div>

        <h3>3. 默认声音生成</h3>
        <label><span>Provider</span><select v-model="settings.audioProvider"><option v-for="item in audioProviderOptions" :key="item.value" :value="item.value">{{ item.label }}{{ item.hint ? ` · ${item.hint}` : '' }}</option></select></label>
        <div class="settings-group">
          <h4>云端声音 HTTP</h4>
          <div class="field-grid two">
            <label><span>Base URL</span><input v-model="settings.audioCloudBaseUrl" placeholder="https://your-tts-gateway.example" /></label>
            <label><span>模型</span><select v-model="settings.audioCloudModel"><option v-for="item in audioCloudModelChoices" :key="item.value" :value="item.value">{{ item.label }}{{ item.hint ? ` · ${item.hint}` : '' }}</option></select></label>
          </div>
          <label><span>API Key</span><input v-model="settings.audioCloudApiKey" type="password" autocomplete="off" /></label>
        </div>
        <div class="settings-group">
          <h4>本地声音 HTTP</h4>
          <div class="field-grid two">
            <label><span>Base URL</span><input v-model="settings.audioLocalBaseUrl" /></label>
            <label><span>模型</span><select v-model="settings.audioLocalModel"><option v-for="item in audioLocalModelChoices" :key="item.value" :value="item.value">{{ item.label }}{{ item.hint ? ` · ${item.hint}` : '' }}</option></select></label>
          </div>
        </div>
        <div class="field-grid two"><label><span>提交路径</span><input v-model="settings.audioSubmitPath" /></label><label><span>状态路径</span><input v-model="settings.audioStatusPath" /></label></div>
        <div class="modal-actions"><button type="button" class="secondary-btn" @click="showSettings = false">取消</button><button class="primary-btn" :disabled="busy === 'settings'"><Save :size="17" />保存设置</button></div>
      </form>
    </div>
  </div>
</template>
