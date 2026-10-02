# Resource loading feedback

Base: `main` at `97a83887f6e4192990bca7210d5118fb32116337` (the author's latest UI). Branch: `loading-feedback-v1`. This change does not include or merge `ui-polish-v1`.

## Behaviour

- A text status and small spinner cover a loading Spine stage. The existing renderer downloads and builds the scene normally; its metadata callback plus two animation frames dismiss the notice. It is not hidden after a fixed number of seconds and does not invent download percentages. A 12-second timer changes the explanatory text only.
- Static portraits have independent loading, success, error and retry states; switching their URL resets the state.
- Directory images show a skeleton labelled “加载中…”. Their actual load/error events, including already cached images, determine the result. An error is labelled “加载失败”; selecting that entry (pointer or keyboard) retries the same-origin thumbnail without cancelling character selection.
- Rendering errors continue into the owning view's existing error/retry UI. Initial WebGL exceptions are also caught instead of leaving a permanent spinner.
- Existing layout, black stage background, controls, game data and interaction logic stay intact. Notices are absolutely positioned and do not resize the canvas. Motion is disabled for reduced-motion preferences.

## Implementation

`SpineStageRenderer.tsx` was originally extracted from the renderer. It now also supports entrance preferences and concurrent resource loading; the loading wrapper remains independent. `SpineStage.tsx` preserves the old import/export interface and adds only lifecycle feedback. It keeps callback identities stable so status renders do not restart downloads or reset the scene.

`ThumbnailLoadingFeedback.tsx` is a scoped DOM enhancement for existing images in `.entry-monogram`. It owns data attributes and temporary failure descriptions only; React retains ownership of children and entry selection. The observer is limited to inserted/removed nodes and `src` changes and removes listeners for detached images. This is intentionally isolated from the gallery's large interaction component.

No production deployment is performed by this branch's validation workflow. Preview with `cd web && npm ci && npm run build:pages`, then serve `dist-pages` from the repository root. Browser checks simulate delayed requests and failed assets as well as successful loading. This is not a claim of full gameplay or all-browser regression coverage.

The current validation compares the deployed bundles and ready-state UI with a build of the current commit, rather than pinning the renderer to its original loading-only revision.
