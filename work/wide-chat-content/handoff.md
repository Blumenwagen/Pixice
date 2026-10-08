# Wider chat content, ready for coordinator review

Activity follow-up r38 is complete. `src/App.jsx` now measures `.focus-coordination[data-open="true"]` and observes `data-open` changes. The correction is only two source lines; current Settings edits were preserved. In one actual Focus open/close case, rich width changes 1468px → 1436px → 1468px. Open rich right is 1460px, Activity left is 1472px, giving 12px clearance. Prose stays at x494.5px / width614.875px; composer stays at x490px / width820px. Both table edges pass browser paint hit testing, and page/canvas overflow remains zero. The same toggle passes with panel transitions disabled, verifying mutation-driven updates independently of `transitionend`. `activity-open.png`, `activity-closed.png`, `activity-measurements.json`, `verify-activity.cjs` and `activity.patch` hold the evidence. No renderer tests, suites, builds or existing layout captures were rerun. Direction r38 acknowledged; submitted for coordinator review on the same work and thread.


Implemented in `src/App.jsx` and `src/styles.css`. Focus work `5f02715f-b9e7-40a5-a33e-223bcc7f1194`, direction r28 acknowledged. No delegation, commits, installs, builds or application restarts.

Tables and parsed inline charts, timelines and calendars now inherit measured canvas bounds. The existing prose column remains in place. Width accounts for canvas padding, scrollbar, Preview split, sidebar, inspector, Focus task rail, widget shelf and the prompt rail's expanded tooltip. One shared column observer updates bounds on resize, overlay changes and layout transitions. Chat turns containing rich blocks opt out of the paint containment imposed by `content-visibility: auto`; other task turns retain it. Tables keep natural cell widths and scroll locally instead of squeezing text or using ellipses. Table and visualization scroll regions support keyboard focus. Visualization parsing and widget sizing remain unchanged.

## Measured before and after

All four comparisons use the actual App with the same isolated synthetic assistant message containing prose, a table, a reactive chart, a timeline and a calendar. No real project conversation was edited or submitted. Baseline screenshots were captured before implementation.

| Case | Prose before/after | Rich before | Rich after | Page / canvas horizontal overflow |
| --- | --- | --- | --- | --- |
| Focus desktop | 614.875px | 614.875px | 1468px | 0 / 0 |
| Task desktop | 614.875px | 614.875px | 1453px | 0 / 0 |
| Focus Preview, 480px canvas | 425px | 425px | 425px | 0 / 0 |
| Task Preview, 430px canvas | 385px | 385px | 385px | 0 / 0 |

Before/after assertions confirm unchanged horizontal position and width for prose, headers, user bubbles and composer. Browser hit testing confirms both outer table edges are actually visible, including outside the prose column. Table keyboard scrolling advances 40px in both Preview splits. Keyboard chart input updates the forecast metric to 100.

Additional actual App captures verify 12px clearance from the widget shelf, inspector and expanded prompt tooltip. Widget widths remain 142px and 292px. Timeline selection and calendar agenda/detail selection pass. At a 390px window, Focus rich blocks are 327px wide; task rich blocks are 243px wide with navigation collapsed. Both have zero page and canvas horizontal overflow. Oversized visual content uses local scrolling.

Scope limit: at 390px with the desktop navigation expanded, task chat has only 43px of usable column width. Rich regions stay inside it and page overflow remains zero, but ordinary prose has 13px of internal canvas overflow. This extreme navigation/prose combination was not changed. The normal narrow task capture uses collapsed navigation.

## Verification and artifacts

- `vitest run tests/inline-visualization.test.jsx`: 6 tests passed, run once. Covers validation/safety, reactive controls and temporal interaction.
- Real Electron browser captures and geometry/paint/keyboard checks against the already running Vite server. No broad suites or build run.
- Focused implementation diff inspected; `git diff --check -- src/App.jsx src/styles.css` passed. Existing unrelated workspace changes preserved.
- `implementation.patch` contains this work's changes relative to the pre-edit workspace snapshot.
- `before-measurements.json`, `after-measurements.json` and `constraints.json` contain the measurements and interaction evidence.
- `before-focus-desktop.png`, `after-focus-desktop.png` show the same mixed message before/after. `after-focus-desktop-chart.png` shows the full chart with table and surrounding prose.
- `before-focus-preview.png`, `after-focus-preview.png`, `before-task-preview.png`, `after-task-preview.png` show real Preview splits.
- Additional `after-*.png` captures show temporal views, widget shelf, inspector, expanded prompt tooltip and narrow windows.

Review gallery: http://127.0.0.1:5183/work/wide-chat-content/review.html

Live isolated App fixture: http://127.0.0.1:5183/work/wide-chat-content/preview.html?mode=focus&rails

Preview thread: `01a0f21a-95a7-7711-90cf-6e739a09ac34`.

Submitted for coordinator review. Not marked done by this worker.
