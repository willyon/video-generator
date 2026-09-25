import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { dataDir, dbPath, outputDir } from './config.js'

fs.mkdirSync(dataDir, { recursive: true })
fs.mkdirSync(outputDir, { recursive: true })

export const db = new Database(dbPath)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS videos (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    theme TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    duration_sec REAL NOT NULL DEFAULT 10,
    aspect_ratio TEXT NOT NULL DEFAULT '16:9',
    language TEXT NOT NULL DEFAULT 'zh-CN',
    visual_direction_json TEXT NOT NULL DEFAULT '{}',
    script_json TEXT NOT NULL,
    motion_plan_json TEXT,
    plan_frozen INTEGER NOT NULL DEFAULT 0,
    provider TEXT NOT NULL DEFAULT 'mock',
    subtitles_enabled INTEGER NOT NULL DEFAULT 1,
    video_base_path TEXT,
    video_path TEXT,
    subtitle_path TEXT,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS video_shots (
    id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    shot_number INTEGER NOT NULL,
    duration_sec REAL NOT NULL,
    narration TEXT NOT NULL DEFAULT '',
    dialogue TEXT NOT NULL DEFAULT '',
    visual_prompt TEXT NOT NULL,
    negative_prompt TEXT NOT NULL DEFAULT '',
    camera_move TEXT NOT NULL DEFAULT 'static',
    location TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL DEFAULT '',
    continuity_json TEXT NOT NULL DEFAULT '{}',
    generation_mode TEXT NOT NULL DEFAULT 'text-to-video',
    generation_spec_json TEXT,
    selected_version_id TEXT,
    review_status TEXT NOT NULL DEFAULT 'pending',
    clip_path TEXT,
    provider_job_id TEXT,
    status TEXT NOT NULL DEFAULT 'planned',
    error TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(video_id, shot_number)
  );

  CREATE TABLE IF NOT EXISTS generation_jobs (
    id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    current_step TEXT NOT NULL DEFAULT '',
    completed_shots INTEGER NOT NULL DEFAULT 0,
    total_shots INTEGER NOT NULL DEFAULT 0,
    payload_json TEXT NOT NULL DEFAULT '{}',
    error TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_video_shots_video ON video_shots(video_id, shot_number);
  CREATE INDEX IF NOT EXISTS idx_jobs_video ON generation_jobs(video_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS video_assets (
    id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    shot_id TEXT REFERENCES video_shots(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    file_path TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS shot_versions (
    id TEXT PRIMARY KEY,
    shot_id TEXT NOT NULL REFERENCES video_shots(id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL,
    provider TEXT NOT NULL,
    provider_job_id TEXT,
    generation_spec_json TEXT NOT NULL,
    clip_path TEXT,
    validation_json TEXT,
    status TEXT NOT NULL DEFAULT 'generating',
    error TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(shot_id, version_number)
  );

  CREATE INDEX IF NOT EXISTS idx_video_assets_video ON video_assets(video_id, shot_id);
  CREATE INDEX IF NOT EXISTS idx_shot_versions_shot ON shot_versions(shot_id, version_number DESC);

  CREATE TABLE IF NOT EXISTS audio_segments (
    id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    shot_id TEXT REFERENCES video_shots(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    start_sec REAL NOT NULL,
    duration_sec REAL NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    prompt TEXT NOT NULL DEFAULT '',
    voice TEXT NOT NULL DEFAULT '',
    volume REAL NOT NULL DEFAULT 1,
    provider TEXT NOT NULL DEFAULT 'mock',
    selected_version_id TEXT,
    status TEXT NOT NULL DEFAULT 'planned',
    error TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS audio_versions (
    id TEXT PRIMARY KEY,
    segment_id TEXT NOT NULL REFERENCES audio_segments(id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL,
    provider TEXT NOT NULL,
    provider_job_id TEXT,
    file_path TEXT,
    duration_sec REAL,
    status TEXT NOT NULL DEFAULT 'generating',
    error TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(segment_id, version_number)
  );

  CREATE INDEX IF NOT EXISTS idx_audio_segments_video ON audio_segments(video_id, start_sec);
  CREATE INDEX IF NOT EXISTS idx_audio_versions_segment ON audio_versions(segment_id, version_number DESC);
`)

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all()
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
}

// These migrations upgrade only databases created by earlier video-generator prototypes.
ensureColumn('video_shots', 'generation_mode', "TEXT NOT NULL DEFAULT 'text-to-video'")
ensureColumn('video_shots', 'generation_spec_json', 'TEXT')
ensureColumn('video_shots', 'selected_version_id', 'TEXT')
ensureColumn('video_shots', 'review_status', "TEXT NOT NULL DEFAULT 'pending'")
ensureColumn('generation_jobs', 'payload_json', "TEXT NOT NULL DEFAULT '{}'")
ensureColumn('videos', 'video_base_path', 'TEXT')
ensureColumn('videos', 'visual_direction_json', "TEXT NOT NULL DEFAULT '{}'")
ensureColumn('generation_jobs', 'kind', "TEXT NOT NULL DEFAULT 'video'")
ensureColumn('generation_jobs', 'target_id', 'TEXT')

const videoColumns = db.prepare('PRAGMA table_info(videos)').all()
if (videoColumns.some((column) => column.name === 'style_prompt')) {
  for (const video of db.prepare('SELECT id, style_prompt, visual_direction_json FROM videos').all()) {
    if (video.style_prompt && (!video.visual_direction_json || video.visual_direction_json === '{}')) {
      db.prepare('UPDATE videos SET visual_direction_json = ? WHERE id = ?').run(
        JSON.stringify({ medium: video.style_prompt }), video.id,
      )
    }
  }
}

for (const obsoleteColumn of ['style_prompt', 'narration_enabled', 'dialogue_enabled', 'music_enabled', 'sfx_enabled', 'poster_path']) {
  if (videoColumns.some((column) => column.name === obsoleteColumn)) {
    db.exec(`ALTER TABLE videos DROP COLUMN ${obsoleteColumn}`)
  }
}

for (const video of db.prepare(`
  SELECT id, video_path FROM videos
  WHERE video_path IS NOT NULL AND (video_base_path IS NULL OR video_base_path = video_path)
`).all()) {
  const source = path.join(outputDir, video.video_path)
  const relativeBase = `videos/${video.id}/video-base.mp4`
  const destination = path.join(outputDir, relativeBase)
  if (fs.existsSync(source)) {
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    if (source !== destination) fs.copyFileSync(source, destination)
    db.prepare('UPDATE videos SET video_base_path = ? WHERE id = ?').run(relativeBase, video.id)
  }
}

db.prepare(`
  UPDATE videos SET plan_frozen = 0, motion_plan_json = NULL, status = 'draft', video_path = NULL,
    subtitle_path = NULL, updated_at = CURRENT_TIMESTAMP
  WHERE EXISTS (
    SELECT 1 FROM video_shots WHERE video_shots.video_id = videos.id AND video_shots.generation_spec_json IS NULL
  )
`).run()
db.prepare(`
  UPDATE video_shots SET clip_path = NULL, provider_job_id = NULL, status = 'planned', error = NULL
  WHERE generation_spec_json IS NULL AND video_id IN (SELECT id FROM videos WHERE plan_frozen = 0)
`).run()

db.prepare(`
  UPDATE generation_jobs
  SET status = 'interrupted', error = 'API restarted while the job was running', updated_at = CURRENT_TIMESTAMP
  WHERE status IN ('queued', 'running', 'cancelling')
`).run()

const defaultSettings = {
  // Text planning: OpenRouter. Falls back to offline rules until a key is saved.
  textProvider: 'openrouter',
  openRouterApiKey: '',
  openRouterModel: 'deepseek/deepseek-v4.1-flash',
  // Video / audio stay on mock until a real gateway is configured.
  // Model IDs below are the recommended defaults once cloud-http is selected.
  // OpenRouter has no text-to-video models as of this writing.
  videoProvider: 'mock',
  cloudBaseUrl: '',
  cloudApiKey: '',
  cloudModel: 'wanx2.1-t2v-turbo',
  cloudSubmitPath: '/v1/video/generations',
  cloudStatusPath: '/v1/video/generations/{id}',
  cloudDurationOptions: [5, 10],
  comfyBaseUrl: 'http://127.0.0.1:8188',
  comfyWorkflowJson: '',
  comfyDurationOptions: [5, 10],
  audioProvider: 'mock',
  audioCloudBaseUrl: '',
  audioCloudApiKey: '',
  audioCloudModel: 'cosyvoice-v2',
  audioLocalBaseUrl: 'http://127.0.0.1:8189',
  audioLocalModel: 'cosyvoice-v2',
  audioSubmitPath: '/v1/audio/generations',
  audioStatusPath: '/v1/audio/generations/{id}',
  pollIntervalMs: 3000,
}

const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
for (const [key, value] of Object.entries(defaultSettings)) {
  insertSetting.run(key, JSON.stringify(value))
}

// Upgrade stock defaults from earlier prototypes without overwriting intentional custom values.
{
  const read = (key) => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
    if (!row) return undefined
    try { return JSON.parse(row.value) } catch { return undefined }
  }
  const write = (key, value) => {
    db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `).run(key, JSON.stringify(value))
  }
  const textProvider = read('textProvider')
  const openRouterModel = read('openRouterModel')
  if (textProvider === 'offline') write('textProvider', defaultSettings.textProvider)
  if (!openRouterModel || openRouterModel === 'openai/gpt-4.1-mini') {
    write('openRouterModel', defaultSettings.openRouterModel)
  }
  if (!read('cloudModel')) write('cloudModel', defaultSettings.cloudModel)
  if (!read('audioCloudModel')) write('audioCloudModel', defaultSettings.audioCloudModel)
  if (!read('audioLocalModel')) write('audioLocalModel', defaultSettings.audioLocalModel)
}

export function getSettings({ includeSecrets = false } = {}) {
  const result = Object.fromEntries(
    db.prepare('SELECT key, value FROM settings').all().map((row) => [row.key, JSON.parse(row.value)]),
  )
  if (!includeSecrets) {
    result.openRouterApiKey = result.openRouterApiKey ? '********' : ''
    result.cloudApiKey = result.cloudApiKey ? '********' : ''
    result.audioCloudApiKey = result.audioCloudApiKey ? '********' : ''
  }
  return result
}

export function updateSettings(input) {
  const allowed = new Set(Object.keys(defaultSettings))
  const upsert = db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `)
  const transaction = db.transaction(() => {
    for (const [key, value] of Object.entries(input)) {
      if (!allowed.has(key)) continue
      if ((key === 'openRouterApiKey' || key === 'cloudApiKey' || key === 'audioCloudApiKey') && value === '********') continue
      upsert.run(key, JSON.stringify(value))
    }
  })
  transaction()
  return getSettings()
}
