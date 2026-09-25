import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

export const projectRoot = path.resolve(here, '../../..')
export const dataDir = process.env.VIDEO_GENERATOR_DATA_DIR ? path.resolve(process.env.VIDEO_GENERATOR_DATA_DIR) : path.join(projectRoot, 'data')
export const outputDir = process.env.VIDEO_GENERATOR_OUTPUT_DIR ? path.resolve(process.env.VIDEO_GENERATOR_OUTPUT_DIR) : path.join(projectRoot, 'outputs')
export const dbPath = process.env.VIDEO_GENERATOR_DB_PATH ? path.resolve(process.env.VIDEO_GENERATOR_DB_PATH) : path.join(dataDir, 'video-generator.sqlite')
export const apiPort = Number(process.env.PORT || 3101)
