export const VISUAL_DIRECTION_FIELDS = [
  'medium', 'mood', 'colorLighting', 'character', 'world',
  'camera', 'motion', 'vfx', 'audio', 'negative',
]

export function normalizeVisualDirection(input = {}) {
  return Object.fromEntries(VISUAL_DIRECTION_FIELDS.map((field) => [field, String(input?.[field] || '').trim()]))
}

export function compileShotPrompt({ direction, shot, aspectRatio, provider }) {
  const visualDirection = normalizeVisualDirection(direction)
  const sections = [
    ['content', 'Shot content', shot.visual_prompt],
    ['medium', 'Visual medium and texture', visualDirection.medium],
    ['mood', 'Mood', visualDirection.mood],
    ['character', 'Character consistency', visualDirection.character],
    ['world', 'World and environment', visualDirection.world],
    ['colorLighting', 'Color and lighting', visualDirection.colorLighting],
    ['camera', 'Camera language', [visualDirection.camera, shot.camera_move, `${aspectRatio} framing`].filter(Boolean).join(', ')],
    ['motion', 'Motion and rhythm', visualDirection.motion],
    ['vfx', 'Visual effects', visualDirection.vfx],
    ['continuity', 'Continuity', shot.continuity?.keepSubjectIdentity || shot.continuity?.keepStyle
      ? 'Maintain subject identity, world details, and visual style across adjacent shots.'
      : ''],
  ].filter(([, , content]) => content)
    .map(([key, label, content]) => ({ key, label, content }))
  const negativeSections = [shot.negative_prompt, visualDirection.negative, 'text, subtitles, watermark, logo']
    .filter(Boolean)

  return {
    compilerVersion: 1,
    provider,
    prompt: sections.map((section) => `[${section.label}]\n${section.content}`).join('\n\n'),
    negativePrompt: [...new Set(negativeSections.flatMap((value) => value.split(',').map((item) => item.trim()).filter(Boolean)))].join(', '),
    sections,
    visualDirection,
  }
}
