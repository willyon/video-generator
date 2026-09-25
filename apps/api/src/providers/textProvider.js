import { getSettings } from '../db.js'

function extractJson(text) {
  const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/```$/, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end < start) throw new Error('Text model did not return a JSON object')
  return JSON.parse(cleaned.slice(start, end + 1))
}

export async function generatePlanWithTextModel(input) {
  const settings = getSettings({ includeSecrets: true })
  if (settings.textProvider !== 'openrouter' || !settings.openRouterApiKey) return null

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${settings.openRouterApiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://localhost:5174',
      'X-Title': 'Video Generator',
    },
    body: JSON.stringify({
      model: settings.openRouterModel,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `You are a short-video director. Return strict JSON with title, logline and shots. Each shot must contain durationSec, narration, dialogue, visualPrompt, negativePrompt, cameraMove, location, action and continuity. Shot durations must total exactly the requested duration. Write narration/dialogue in the requested language; write visual prompts in production-quality English.`,
        },
        {
          role: 'user',
          content: JSON.stringify(input),
        },
      ],
    }),
  })
  if (!response.ok) throw new Error(`OpenRouter request failed (${response.status}): ${await response.text()}`)
  const payload = await response.json()
  return extractJson(payload.choices?.[0]?.message?.content || '')
}
