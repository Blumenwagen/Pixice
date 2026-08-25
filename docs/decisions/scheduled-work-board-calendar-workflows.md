# Scheduled work across Board, Timeline, and Workflows

- Status: accepted
- Date: 2026-08-25
- Decision: make scheduled work a shared project record with Board, Timeline, Preview, agent planning, and Workflow integrations
- Default autonomy: proposal-first planning with optional maintenance of unlocked target dates
- Scope: product and architecture direction with a four-phase implementation plan

## Decision

Pixice will treat Board tasks, scheduled events, and timeline items as views of one durable project work item. Board status, schedule, dependencies, linked thread, agent activity, and workflow bindings remain attached to the same identity.

The Board workspace offers two views:

1. Board for status and ordering.
2. Timeline for dates, spans, milestones, dependencies, and plan changes.

A work item appears on Timeline when it has a schedule. Moving or editing it in either view updates the same record. Board is the default view, and saved Calendar selections migrate to Board.

Selecting or editing a work item opens a dedicated task surface in the active thread's Preview workspace. Agent-led Board and schedule editing from the active conversation opens the same Preview surface so the user can watch the plan change. This follows the existing Workflow preview pattern: the task editor temporarily owns the Preview content area, covered browser controls are inert, and the user can open the full Board workspace without losing context.

Planning dates do not grant execution authority. A planned start does not launch an agent or Workflow by itself. Automatic execution requires a separate, explicit Workflow binding that names its trigger and permission mode.

## Why this fits Pixice

Pixice already has durable project Board tasks, thread attachment, Board activity, Workflow schedule triggers, Workflow Board actions, proactive task stewardship, and interactive temporal rendering. The missing part is a shared scheduled-work model.

The unified model gives users one answer to these questions:

- What work exists?
- What is ready, active, blocked, or done?
- When should it happen?
- What must finish first?
- Which thread is carrying it out?
- Which Workflow may react to it?
- Who changed the plan and why?

It also makes agent planning inspectable. A decomposition made in conversation becomes a proposed Board and time plan, not disposable prose.

## Product model

### Work item

The existing `board_tasks` record remains the durable base during the first implementation. It gains fields for work kind, priority, estimate, and optimistic concurrency.

Supported kinds:

- `task`: work with a status and optional duration;
- `milestone`: a zero-duration checkpoint;
- `event`: a scheduled commitment that may be hidden from the Board by default.

Board column remains the status source of truth. Timeline placement never creates a second status field.

### Schedule

An optional one-to-one schedule record contains:

- planned start;
- planned end;
- hard deadline;
- all-day state;
- project timezone;
- scheduling constraint;
- locked fields;
- whether Pixice may move unlocked target dates;
- schedule revision;
- author kind and author ID;
- last scheduling explanation.

Planned start and end describe the current plan. A hard deadline is a protected constraint. Agents may propose moving a hard deadline, but they cannot apply that change without user confirmation.

### Dependencies

Dependencies are stored as separate edges between work items. The first release supports finish-to-start relationships with optional lag. Pixice rejects cycles before saving.

### Workflow bindings

A work item may have zero or more Workflow bindings. A binding contains:

- Workflow ID;
- trigger condition;
- enabled state;
- expected task and schedule revision;
- missed-trigger policy;
- creation and update provenance.

The schedule and the binding are independent. Removing a Workflow binding does not remove dates. Moving a date does not silently enable automation.

### Activity and provenance

Board activity records schedule proposals, applied changes, manual edits, dependency changes, automatic replans, Workflow triggers, missed triggers, and conflicts. Activity metadata identifies whether a user, agent thread, or Workflow made the change.

## Preview editing

### Entry points

The task Preview opens when:

- the user selects a Board card or Timeline item;
- the user chooses Edit from a work item;
- an agent in the active conversation begins a Board or schedule editing session;
- an agent produces a multi-item scheduling proposal;
- the user follows a task link from a Workflow run or notification.

Passive background Workflow changes do not steal the user's current Preview tab. They refresh an already-open task Preview and add activity. Foreground or user-requested editing opens the Preview immediately.

### Preview states

Single-item Preview shows:

- title, notes, status, priority, owner, and linked thread;
- planned dates, hard deadline, timezone, and estimate;
- dependencies and dependents;
- Workflow bindings and their enabled state;
- current conflicts and overdue state;
- recent activity and change provenance.

Multi-item plan Preview shows:

- the proposed Timeline;
- created, changed, moved, and unscheduled items;
- dependency changes;
- deadline and capacity conflicts;
- assumptions and estimate confidence;
- Apply plan and Discard proposal actions.

### Host contract

Add a `TaskPreviewOpenRequested` application event with:

- project ID;
- task ID or proposal ID;
- thread or Preview workspace ID;
- reason such as `open`, `edit`, `plan`, or `run`;
- originating actor and revision.

The renderer mounts a task Preview overlay into the same Preview host used by Workflow Preview. It hides the native browser viewport while active and restores the prior Preview state on close. The task editor provides an `Open full workspace` action that enters Board takeover with the same item selected and the current view preserved.

Preview state belongs to the thread. Task selection, schedule draft, active subview, scroll position, and unsaved fields must not bleed into another thread.

### Concurrent changes

Every save supplies an expected item and schedule revision. If an agent or Workflow changes the item while the user has unsaved fields, Pixice keeps the draft and shows the newer saved revision. The user may compare, reload, or apply a deliberate merge. Pixice never replaces unsaved user input silently.

## Agent planning

Agents supply judgment:

- decompose an outcome into work items and milestones;
- estimate effort and state confidence;
- propose priorities and dependencies;
- identify fixed dates and assumptions;
- explain plan changes.

A deterministic scheduling service supplies date math:

1. Validate task references and dependency cycles.
2. Respect locked starts and hard deadlines.
3. Order work by dependencies and constraints.
4. Calculate planned dates in the project timezone.
5. Move only unlocked target dates.
6. Produce a conflict report when the plan cannot fit.
7. Return an atomic proposal with an expected base revision.

Agents do not manually cascade dates through the Board. They submit planning intent and estimates, then inspect the scheduler result.

### Autonomy levels

`Suggest only` is the default. Agents may create a plan proposal but cannot apply it.

`Maintain unlocked dates` lets Board stewardship apply changes to unlocked target dates after an initial user-approved plan. It cannot move hard deadlines, change locked fields, enable Workflow bindings, or delete tasks.

`Enabled` belongs to an individual Workflow binding. The user must turn it on explicitly, regardless of the selected event. The binding retains the Workflow's configured permission mode and cannot increase task authority.

## Workflow integration

Add a `Task Event Trigger` node. It listens to durable work-item events instead of creating one cron schedule per task.

Initial trigger conditions:

- planned start reached;
- hard deadline approaching;
- task entered Ready;
- all dependencies completed;
- task became blocked;
- task became overdue;
- schedule changed.

Workflow context includes the task, schedule, dependencies, revision, source actor, and triggering event. Board action nodes gain scheduling and dependency operations with the same revision checks as agent tools.

Every trigger receives a durable idempotency key derived from task ID, schedule revision, event type, and effective time. If Pixice was closed when a time trigger became due, the binding's missed-trigger policy decides whether to skip, ask, notify, or run on next startup. The default is ask.

`Plan Work` is a deterministic action node. It accepts the same plan shape as the agent scheduling tool, performs dependency and deadline checks, and may save a reviewable proposal. It never applies the proposal. A completed run can open that proposal directly in Preview.

## Data shape

The first implementation adds:

```text
board_tasks
  kind
  priority
  estimate_minutes
  revision

board_task_schedules
  task_id
  planned_start
  planned_end
  hard_deadline
  all_day
  timezone
  constraint_type
  locked_fields
  auto_schedule
  revision
  updated_by_kind
  updated_by_id
  explanation
  created_at
  updated_at

board_task_dependencies
  task_id
  depends_on_task_id
  dependency_type
  lag_minutes
  created_at

board_task_workflow_bindings
  id
  task_id
  workflow_id
  trigger_type
  enabled
  missed_trigger_policy
  created_by_thread_id
  created_at
  updated_at
```

Deletion of a task removes its schedule, dependency edges, and bindings in one transaction. It does not delete a linked thread or Workflow.

## Full-workspace behavior

Board remains a full-shell takeover with one navigation column and one content frame. Board is the default. A compact segmented control switches between Board and Timeline. Timeline fits the scheduled span automatically and has no manual day or date navigator.

Filters and the selected item are stored per project. Board opens by default whenever the workspace is entered. Timeline derives its range from the scheduled items. Returning to task restores the previous conversation and Preview workspace.

Dragging a scheduled item previews the change before saving when it affects dependents, locked constraints, or Workflow triggers. Simple moves without downstream effects may save directly and still record activity.

## Implementation phases

### Phase 1: unified work model

Add migrations, domain operations, schedule and dependency persistence, revisions, audit metadata, IPC types, agent tools, and Workflow Board action support. Existing Board tasks migrate without schedules and continue to work.

Acceptance:

- existing Board tasks load unchanged;
- schedule and dependency changes are transactional;
- cycles and stale revisions fail without partial writes;
- user, agent, and Workflow provenance appears in activity;
- deleting a task removes its schedule links but keeps linked threads and Workflows.

### Phase 2: Board, Timeline, and Preview

Add the two Board views, shared selection, date and dependency editing, task Preview, multi-item plan Preview, drag previews, conflict presentation, and per-thread draft isolation.

Acceptance:

- one work item stays consistent across all views;
- selecting or editing from any view opens Preview;
- active agent editing opens Preview with live saved changes;
- background Workflow changes refresh without stealing focus;
- unsaved user edits survive concurrent updates;
- `Open full workspace` preserves item and view context.

### Phase 3: agent planning service

Add planning proposals, deterministic scheduling, assumptions, confidence, atomic application, project timezone, working-time rules, and optional maintenance of unlocked dates.

Acceptance:

- an agent can turn an outcome and deadline into a reviewable multi-item proposal;
- date calculations are deterministic for the same input;
- impossible plans return conflicts instead of invalid dates;
- applying a proposal is atomic and revision-checked;
- automatic maintenance never changes locked fields or hard deadlines.

### Phase 4: Task Event Workflows

Add Task Event Trigger, Plan Work, schedule-aware Board actions, Workflow bindings, explicit Enabled controls, missed-trigger handling, idempotency, notifications, and task-linked run history.

Acceptance:

- enabled bindings fire once for each qualifying task event;
- planning dates alone never start work;
- missed time triggers follow the stored policy;
- task Preview shows binding state and recent runs;
- Workflow results can update the source task without stale writes;
- disabling a binding stops future automation without removing the schedule.

## Out of scope for the first release

- recurring work items;
- multiple assignees and resource leveling;
- external calendar synchronization;
- week and day time-grid views;
- public or team-shared schedules;
- automatic changes to hard deadlines;
- automatic Workflow enablement;
- remote editing through Connect Lite.

These can follow after the shared identity, Preview editing, and proposal workflow prove useful.

## Rejected approaches

### Separate Calendar events synchronized to Board tasks

Rejected because identity, status, dates, activity, and Workflow bindings would drift. Conflict resolution would become a product feature by itself.

### One cron Workflow per scheduled task

Rejected because rescheduling would require Workflow graph edits, missed runs would be ambiguous, and thousands of tasks would create unnecessary timers. Task Event Trigger is event-driven and task-aware.

### Let agents calculate and apply the whole schedule directly

Rejected because date math, dependency cascades, timezones, and concurrency need deterministic behavior. Agents provide planning judgment. Pixice calculates and validates the schedule.

### Edit only in Board dialogs

Rejected because a dialog cannot show the surrounding plan, live agent edits, dependencies, Workflow bindings, and conflicts clearly. Preview provides room without adding a permanent pane.

## Success measures

- users open scheduled work in Preview and complete edits without switching to a separate settings-style surface;
- agent planning proposals are applied rather than copied into manual Board tasks;
- scheduled items remain consistent across Board, Timeline, and Workflow runs;
- stale or conflicting changes fail visibly without losing user drafts;
- automatic task runs happen only through explicit enabled bindings;
- overdue and blocked work produces useful replanning suggestions instead of silent date drift.
