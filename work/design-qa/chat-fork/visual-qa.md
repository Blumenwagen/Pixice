# Chat fork visual QA

## Evidence

- Source visual truth: user-provided Codex answer-action screenshot in the lead Pixice thread. The source is a 598 x 572 partial-screen reference and has no local filesystem path.
- Source-state implementation: `work/design-qa/chat-fork/01-source-answer-full.png`
- Focused source answer, generated output, and footer: `work/design-qa/chat-fork/02-source-answer-detail.png`
- Post-click implementation: `work/design-qa/chat-fork/03-fork-selected-main-full.png`
- Focused neutral sidebar lineage state: `work/design-qa/chat-fork/04-fork-sidebar-detail.png`
- Focused post-click answer, generated output, and footer: `work/design-qa/chat-fork/05-fork-answer-detail.png`
- DOM and interaction evidence: `work/design-qa/chat-fork/evidence.json`
- Final settled-tree capture: `2026-08-31T07:22:36.209Z`.
- Viewport: 1480 x 950 CSS px at devicePixelRatio 2.
- Full captures: 2960 x 1900 px. Focused answer captures: 1600 x 1574 px. Focused sidebar capture: 528 x 1844 px.
- State: dark theme, expanded sidebar, completed answer followed by generated image output. The post-click capture shows `preview-task-fork` selected as the main thread. The sidebar detail then shows that fork inactive and unhovered so its resting color can be judged.
- Density normalization: implementation captures use native 2x output. The source is a partial crop, so comparison is scoped to control placement, icon scale, hierarchy, and behavior rather than whole-screen geometry.

## Findings

No actionable P0, P1, or P2 issues.

The completed final text renders first, followed by the real Pixice icon image fixture and then the compact answer footer. The branch action is the first footer control, before the timestamp. After activation, the fork becomes the selected top-level sidebar thread. Its branch icon is visible before the title. No Preview workspace or fork Preview tab appears.

## Fidelity checks

- Fonts and typography: the action does not add a visible text label or disturb answer wrapping. The timestamp remains secondary and follows the action.
- Spacing and layout rhythm: the 26 x 26 px action sits 13 px below the generated image output and matches the compact density of the Codex reference. The 14 px sidebar icon leaves the thread title readable.
- Colors and visual tokens: the answer branch action uses Pixice's quiet token. The inactive, unhovered sidebar lineage icon resolves to `rgb(133, 133, 133)`, exactly the computed `--quiet` color. Active and hover states can still rise to the normal foreground color.
- Image quality and assets: the image-heavy fixture uses the existing real `src/assets/pixice-icon.png` raster asset. The implementation uses the existing Phosphor `GitBranch` icon. No handmade SVG, CSS drawing, or placeholder was introduced.
- Copy and content: the control uses `Fork from this answer` for its accessible label and tooltip. The sidebar title remains the thread name.
- Accessibility and interaction: the control is a semantic button with a label, tooltip, disabled pending state, and keyboard focus support. The tested click submitted the selected thread, turn, and answer IDs.

## Interaction evidence

- Active thread changed from `preview-task` to `preview-task-fork`.
- Fork payload used `fork-source-turn` and `fork-source-answer`, so the branch point is the selected answer.
- Direct-child order is final answer index 2, generated image index 3, detached footer index 4.
- The footer branch action precedes the timestamp and has a 13 px gap after the image output.
- The selected sidebar row contains exactly one `.task-fork-icon`.
- After returning to the source thread, the inactive fork row is not hovered and its lineage icon exactly matches `--quiet`.
- Preview workspace count stayed at 0.
- Preview fork-tab count stayed at 0.
- Browser console errors: none.

## Focused comparison

The focused answer captures were required because the action is too small to judge in the full-screen image. They show the full reference structure: final text, generated output, then the low-emphasis branch action before the timestamp. The focused sidebar capture confirms that lineage is shown on the normal thread row rather than inside Preview, and that its resting color is neutral.

## Comparison history

- Pass 1: the initial text-only fixture found no P0, P1, or P2 differences.
- Pass 2: the refreshed image-heavy fixture verified detached footer order, main-thread selection, closed Preview, and neutral resting lineage color. No production fix was needed after capture.
- Pass 3: the final settled-tree recapture reproduced the same result after the last nonvisual renderer cleanup.

## Follow-up polish

- P3: the visible 26 px desktop target intentionally matches the compact reference. A future touch-specific layout could increase the invisible hit area without enlarging the icon.

final result: passed
