async function request(path, options = {}) {
  const isForm = options.body instanceof FormData
  const response = await fetch(path, {
    headers: { ...(isForm ? {} : { 'Content-Type': 'application/json' }), ...(options.headers || {}) },
    ...options,
  })
  if (response.status === 204) return null
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error || `请求失败 (${response.status})`)
  return payload
}

export const api = {
  listVideos: () => request('/api/videos'),
  getVideo: (id) => request(`/api/videos/${id}`),
  createVideo: (body) => request('/api/videos', { method: 'POST', body: JSON.stringify(body) }),
  deleteVideo: (id) => request(`/api/videos/${id}`, { method: 'DELETE' }),
  updateShot: (id, body) => request(`/api/shots/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  updateVisualDirection: (videoId, body) => request(`/api/videos/${videoId}/visual-direction`, { method: 'PUT', body: JSON.stringify(body) }),
  addShot: (videoId, afterShotId) => request(`/api/videos/${videoId}/shots`, { method: 'POST', body: JSON.stringify({ afterShotId }) }),
  deleteShot: (id) => request(`/api/shots/${id}`, { method: 'DELETE' }),
  reorderShots: (videoId, shotIds) => request(`/api/videos/${videoId}/shots/order`, { method: 'PUT', body: JSON.stringify({ shotIds }) }),
  freeze: (id) => request(`/api/videos/${id}/freeze`, { method: 'POST' }),
  unfreeze: (id) => request(`/api/videos/${id}/unfreeze`, { method: 'POST' }),
  generate: (id, shotId) => request(`/api/videos/${id}/generate`, { method: 'POST', body: JSON.stringify({ shotId }) }),
  getJob: (id) => request(`/api/jobs/${id}`),
  cancelJob: (id) => request(`/api/jobs/${id}/cancel`, { method: 'POST' }),
  getSettings: () => request('/api/settings'),
  saveSettings: (body) => request('/api/settings', { method: 'PUT', body: JSON.stringify(body) }),
  getCapabilities: () => request('/api/providers/capabilities'),
  uploadAsset: (videoId, { file, shotId, role }) => {
    const body = new FormData()
    body.append('file', file)
    body.append('shotId', shotId || '')
    body.append('role', role)
    return request(`/api/videos/${videoId}/assets`, { method: 'POST', body })
  },
  deleteAsset: (id) => request(`/api/assets/${id}`, { method: 'DELETE' }),
  selectVersion: (shotId, versionId) => request(`/api/shots/${shotId}/versions/${versionId}/select`, { method: 'POST' }),
  reviewShot: (shotId, decision) => request(`/api/shots/${shotId}/review`, { method: 'POST', body: JSON.stringify({ decision }) }),
  resumeJob: (id) => request(`/api/jobs/${id}/resume`, { method: 'POST' }),
  initializeAudio: (videoId) => request(`/api/videos/${videoId}/audio/initialize`, { method: 'POST' }),
  createAudioSegment: (videoId, body) => request(`/api/videos/${videoId}/audio-segments`, { method: 'POST', body: JSON.stringify(body) }),
  updateAudioSegment: (id, body) => request(`/api/audio-segments/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteAudioSegment: (id) => request(`/api/audio-segments/${id}`, { method: 'DELETE' }),
  generateAudio: (id) => request(`/api/audio-segments/${id}/generate`, { method: 'POST' }),
  selectAudioVersion: (id, versionId) => request(`/api/audio-segments/${id}/versions/${versionId}/select`, { method: 'POST' }),
  mixAudio: (videoId) => request(`/api/videos/${videoId}/audio/mix`, { method: 'POST' }),
}
