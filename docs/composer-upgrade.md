# Composer upgrade

Implementation reference: T3 Code released nightly
`v0.0.46-nightly.20261008.2813`, commit
`30cc788975500a8c00d32a50f348174d1ce578d1`.

The editor, context, memory and queue controls belong to one composer. Pixice
keeps its existing quiet shell, native provider slash commands, thread drafts,
attachment transfer recovery and provider submission format.

## Editor and context

Rich Markdown is enabled by default and can be switched to plain text in
Conversation settings. Headings, quotes, nested lists, tasks, inline marks and
highlighted code fences retain their Markdown source. File, image, thread,
Skill, pull-request, terminal, review, Preview and quoted-answer chips are
editable context records. Their inspector supports comments and source opening
where that source has a workspace route. Copy, cut, paste and undo carry the
records alongside the source. Copied local attachment chips recover their
native bytes only within the same project and host.

Selecting answer, terminal, review or project-file text offers Cite in composer.
Provider submission expands only referenced records. Thread chips contain
metadata and direct the agent to the bounded `pixice_bridge.read_thread` tool,
which requires an explicitly attached thread belonging to the same project.
It returns conversational text with pagination; reasoning, tool arguments and
image bytes stay outside that context lookup. The same tool is available to
Codex, Claude and Focus. Rewind checkpoints retain context records and restore
attachment identities with the original prompt.

## Saved prompts

Command-S on macOS or Control-S elsewhere saves a nonempty composer. Saved
prompts are reusable within their project and host; they are not exposed to
another project or machine. Restoring retains the saved copy. A saved prompt
contains its text, inline context records, attachment metadata and attachment
bytes when they fit the bounded local storage budget.

The storage holds at most 20 prompts and 2,500,000 serialized characters in
total. Each saved prompt may retain up to 1,350,000 characters of encoded file
bytes. Files that exceed that budget or cannot be read remain visible as
metadata with a specific reselect requirement. They must be repaired before
the restored draft can be sent. A failed durable write does not remove the
current draft or evict a previous saved prompt.

The `createDraftMemory` API does not mutate the current composer. Its owning
composer clears the draft only after a durable write succeeds and the draft
still matches the snapshot saved. Restoring into a nonempty composer must
preserve or deliberately save the existing draft first.

## Prompt recall and paste

Up from an empty composer recalls the latest accepted text prompt in that
thread. Further Up/Down steps move through accepted prompts only at the
editor's first/last visual line. Edited text ends recall, and Down after the
latest prompt restores the empty composer. Attachments and context in a
current draft disable recall. Recall strips context chips and provider-expanded
context rather than reviving stale selections or hidden attachment IDs.

Accepted sends are available for recall while the provider's authoritative
history arrives. The temporary cache records the last stable user-message ID
present before submission. An acknowledgement matches only after that anchor,
and each native message is consumed once. Pruned cache records retain the
consumed-history boundary so consecutive identical prompts cannot disappear
on a second reconciliation pass. Unknown or unloaded anchors keep the local
cache conservatively; optimistic message IDs never become native anchors.

A normal text paste of at least 32 KiB of UTF-8 data becomes a text attachment
named `pasted-text.txt`, with sequential names avoiding collisions. Shift-paste
keeps the text editable inline. The attachment keeps the exact pasted text.

## Queued editing

Queued user messages can be opened in the same composer, retaining their
attachments and context. The previous unsent draft is preserved while editing
and restored on cancellation. A queue entry that has started or disappeared
must leave edited work recoverable. Interrupted dispatches stay unavailable
for automatic editing or steering until the user checks the conversation.

The queue panel accepts an `onEdit(entry)` integration and otherwise retains
its earlier text-only fallback. Its `controlRef.current.editLatest()` requests
the latest editable user entry; `promoteFirst()` steers the oldest queued
message into the active turn, or resumes its dispatch when there is no active
turn. These support Option/Alt-Up and Command/Control-Shift-Enter without
installing global keyboard handlers.

## Verification

The focused memory, stash menu and queue UI tests cover durable file recovery,
quota rejection, host/project isolation, text-only accepted history, visual
caret boundaries, large Unicode pastes, queue keyboard actions and fallback
editing. Desktop browser verification belongs to the composed UI integration.
