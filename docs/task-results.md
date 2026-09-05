# Task results and replay

Completed tasks show result controls on the same line as the answer’s fork action. Price, tokens used, and elapsed time are visible together. Expand **Result** to inspect recorded checks, unresolved plan items, and the captured workspace diff. The final response stays in the conversation.

The **Attention** tab contains approval requests only. Questions remain in the originating task’s composer. Results, failed checks, unfinished plan items, remain with the task. Completed results and questions do not add to the Attention badge or automatically navigate to Attention.

**Replay** in the result row opens the task’s model comparison. It uses the same model and reasoning pickers as the composer and shows results side by side. Choose a connected model and supported reasoning/speed settings, then run a replay. Pixice creates a separate project and detached Git worktrees from the recorded starting snapshot. It submits the original prompt sequence in order, copies preserved attachment inputs into that replay, and records a separate receipt. Replays consume normal provider usage. Opening a running replay allows inspection or interruption. Interrupting or steering stops automatic submission of remaining prompts; restarting Pixice does not restart spending.


## Evidence and replay limits

- Starting snapshots require Git and an initial commit. They preserve tracked and unignored files, including staged and unstaged changes, without changing the user's index or branch. Ignored dependencies, environment variables, running services, and external resources are not captured. Submodule projects are currently excluded.
- Worktrees have separate working files but share the source repository's Git object store and references. Replay does not merge or apply changes back to the original workspace.
- Prompt attachment files are copied before a recorded turn starts. Replay uses those preserved bytes, including on a replay of a replay. Inline images remain in the recorded input. Arbitrary external paths mentioned in prose are not captured.
- The original submitted prompt sequence is replayed. Models may ask different questions; interactive answers and tool results are not deterministically replayed. Live steering makes that attempt unavailable for exact replay.
- Verification summaries describe only the latest turn. Earlier checks remain accessible with a warning that they may predate current changes. Shell compound commands are unconfirmed because the wrapper exit code cannot prove which check passed. An agent's prose is not treated as test evidence.
- Diffs include all workspace edits made while the task ran, including edits by the user or concurrent tasks. Captured patches are limited to 400,000 characters and file lists to 500 entries; truncation is shown. Failed capture is shown explicitly.
- Earlier tasks can display receipts from available history, but cannot reconstruct an unrecorded starting snapshot or historical workspace diff. Interrupted runs remain labelled as interrupted.

## Local storage

Receipts live in the `task_results` SQLite table. Starting snapshots are retained under `refs/pixice/task-starts/` in each repository. Preserved attachment inputs and replay worktrees live under the application's user-data `task-results` directory. These can contain project and attachment content; they remain local and currently have no automatic retention cleanup.

The development-only `?task-results-preview` route contains explicitly labelled demo fixtures for inspecting the UI without provider calls or real usage.
