# Product Workflow

Video Generator is a single-user, local-first creation studio. It is not designed
as a hosted multi-user platform.

## Product intent

The product will support **two creation modes** that share one production pipeline:

| Mode | User goal | Narrative layer |
| --- | --- | --- |
| **Single short** | One self-contained clip (typically 5–30s) | Shot-level narration / dialogue is enough; no separate screenplay stage required |
| **Series** | Multiple related episodes / clips with shared identity | Series bible + editable screenplay, then each episode becomes a Video project |

Architecture rule: **reuse the existing Video → freeze → generate → review → audio → mix
pipeline for every finished clip.** Series and screenplay sit *above* that pipeline.
Do not fork a second generation stack for series.

```text
Series (optional)
  └─ shared world / characters / style locks
       └─ screenplay (beats, scenes, dialogue)     ← series path; short path skips
            └─ Video project (one episode / one short)  ← current implemented core
                 └─ freeze → generate → review → silent master → audio → final MP4
```

### Single short path (implemented)

Theme → plan shots (text embedded on shots) → edit → freeze → generate → … → final MP4.

An optional whole-script *preview* (concatenate shot narration/dialogue) may be added
for UX later. It must not become a blocking screenplay subsystem for shorts.

### Series path (planned; not implemented)

1. Create a Series with shared visual direction and asset library (characters, style, scenes).
2. Write or generate a screenplay (outline → episode script → timed beats).
3. Materialize one episode as a Video project (shots derived from the script).
4. Run the existing Video production pipeline for that episode.
5. Keep cross-episode continuity via shared assets and locked style rules.

Script edits that should update shots must use an **explicit sync** action (never silent
overwrite of frozen generation specs).

## Development constraints

- Complete each user workflow before adding the next media layer.
- Every operation has explicit inputs, outputs, states, validation, and recovery.
- Model availability is assumed. The application owns contracts, orchestration,
  persistence, validation, and manual review.
- Do not expose controls for capabilities that do not work yet.
- Do not add multi-user, billing, distributed queue, cloud storage, or deployment
  infrastructure unless the product scope changes.
- Do not retain unused compatibility paths. Use explicit schema migrations when
  existing local data needs to change.
- Add abstractions only for real provider differences or repeated business logic.
- Do not build Series / screenplay UI until a single short can reliably export with
  at least one real video provider and one real audio provider (see gates below).

## Workflow — single short (current)

1. Configure theme, total duration, aspect ratio, language, style, and provider.
2. Define project-level visual, camera, motion, effects, and audio direction.
3. Generate and edit the timed shot plan (narration and dialogue live on each shot).
4. Choose a generation mode for each shot and attach required references.
5. Compile project direction and shot content into provider-ready prompts, then
   freeze a traceable generation specification for every shot.
6. Generate clips as immutable versions; preserve previous results.
7. Run technical validation and select one valid version per shot.
8. Approve or reject each selected shot; regenerate only rejected shots.
9. Assemble approved selections into a silent master and optional SRT.
10. Build timed narration/dialogue tracks from approved shots; add music and
    sound effects where needed.
11. Generate immutable audio versions, preview them, and select one per segment.
12. Mix selected audio tracks with the silent master and export the final MP4.

## Workflow — series (future)

1. Create Series; define shared bible fields and upload shared reference assets.
2. Draft screenplay (manual and/or LLM); edit until narrative is accepted.
3. Split or map script beats into one Video project per episode (or per short unit).
4. Inherit Series visual direction and assets into the Video; allow per-episode overrides.
5. Continue from step 4 of the single-short workflow (modes, freeze, generate, …).

## Gates

### Current status

The **single-short theme-to-final-video core** is complete. Automated checks cover
planning, shot structure changes, capability constraints, missing references, frozen
specifications, video and audio generation, technical validation, version preservation
and selection, review, resume, silent assembly, final mixing, and verification that
the exported MP4 contains an audio stream.

### Gate A — Real provider usability (next)

Validate the existing short pipeline with real configured providers. Adapters stay
contract-based; vendor-specific payload mapping belongs in the adapter when a model
is chosen. Record a reproducible sample path in docs (no secrets).

### Gate B — Local day-to-day use

One-command or packaged start, FFmpeg health check, optional disk cleanup on delete,
clearer staged UI for the short workflow.

### Gate C — Short quality

Adjacent-shot continuity aids, simple mix ducking / transitions, export presets.

### Gate D — Series + screenplay

Only after Gate A is green for at least one video + one audio provider:

1. `Series` entity and shared asset library.
2. Screenplay document with explicit “apply to episode / refresh shots” sync.
3. Create Video from episode without duplicating the generation stack.
