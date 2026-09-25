# Video Generator

An AI video creation studio migrated from the reusable architecture of
`book-generation`. Product intent: **single shorts** and later **series** (shared
world / screenplay → episode), both feeding the same production pipeline.

The implemented workflow turns a theme into a short video:

1. Plan a script and shot list with OpenRouter or the built-in offline planner.
2. Review and edit the shots before generation.
3. Generate clips with a mock provider, a configurable cloud HTTP provider, or
   a local ComfyUI workstation.
4. Approve selected clip versions and assemble a silent master with optional SRT.
5. Generate versioned narration, dialogue, music, and sound effects, then mix the
   selected audio into the final MP4.

The project is intentionally independent from `book-generation`. It keeps the
same useful ideas (structured plans, frozen generation input, background jobs,
provider adapters, review before approval) without carrying over page/PDF code.

## Run

```bash
npm install
npm run dev
```

Open `http://localhost:5174`. The API listens on `http://localhost:3101`.

The default mock provider creates a real MP4 locally with FFmpeg, so the entire
workflow can be tested before any API key or local model is configured.

## Providers

- **OpenRouter**: script and shot planning. Enter the key in Settings.
- **Cloud HTTP**: configurable submit/status/download endpoints for a cloud video
  gateway. This isolates vendor-specific APIs from the application workflow.
- **ComfyUI**: submits a workflow JSON to a local workstation and waits for the
  generated video output. Use `{{PROMPT}}`, `{{WIDTH}}`, `{{HEIGHT}}`,
  `{{DURATION}}`, `{{FPS}}`, and `{{SEED}}` placeholders in the workflow JSON.
- **Mock FFmpeg**: local development and end-to-end verification.
- **Cloud/local audio HTTP**: one configurable contract for speech, dialogue,
  music, and effects. Each request carries type, text or prompt, voice, the
  project audio direction, duration, model, and WAV output format.

Secrets stay in the local SQLite database under `data/video-generator.sqlite`.
Do not commit that directory.

## Current scope

Implemented: theme-to-video, provider-aware shot durations, 16:9/9:16 selection,
shot add/delete/reorder, text/image/keyframe generation modes, project and
per-shot references, structured project visual direction, per-shot prompt
compilation, traceable frozen generation specifications, background
progress/cancellation/resume, versioned video and audio generation, technical
media validation, manual shot approval, silent-master assembly, timed narration,
dialogue, music and effects, audio preview/version selection, final mixing, SRT
subtitle files, and cloud/local provider settings.

Intentionally excluded for now: series/screenplay UI (planned after real-provider
validation), multi-user collaboration, billing, hosted asset storage, distributed
queues, and a full nonlinear editor. Semantic visual review remains manual because
model-based quality scoring is provider-specific and should not block the local
creation workflow.

The product workflow (short path + planned series path) and development constraints
are in [`docs/WORKFLOW.md`](docs/WORKFLOW.md). Architecture and maturity audit:
[`docs/AUDIT_REPORT.md`](docs/AUDIT_REPORT.md).
