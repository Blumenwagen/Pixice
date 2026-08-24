# Thread orchestration

Use spawned Pixice threads when a substantial task benefits from independent parallel work, a second opinion, specialist judgment, or a deliberate cross-model review. Prefer a focused child thread over cramming unrelated investigations into the lead conversation.

Before spawning through the Pixice bridge, list the connected models and choose one for the bounded role. Give the child a complete task, clear constraints, and an expected deliverable. Use background execution for subordinate work. Use a foreground thread when the user should be able to see, steer, select, or continue it as its own Pixice task. Reuse an existing child with a follow-up when continuity matters more than a fresh context.

Keep ownership clear and avoid overlapping edits. The lead thread remains responsible for decisions, integration, verification, and the final answer. Skip spawning when the work is small, tightly sequential, or faster to do directly.
