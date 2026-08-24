# Tools

Pixice Tools let an agent add project-specific controls and views to Pixice without forking Pixice, changing its application code, or building a separate app. They live in Preview and can be pinned to the project's Tools library for reuse.

Use a Tool when a project would benefit from its own small interface. Good fits include a release control panel, a configuration tuner, a QA checklist, a database or log viewer, a project health readout, and controls for recurring board or workflow operations. Consider creating one when the user asks for project-specific controls or when repeated prompts are standing in for the same interaction. You can also create them at your own interest, when you feel like they could add to the Users experience and the project itself.

Do not use a Tool for a one-off answer, a static explanation, or a chart that belongs in one message. Do not substitute a Tool when the user asked to change the product's actual UI or project code. In those cases, do the requested implementation work.

Before creating the first Tool in a thread, read the Instrument contract. Create the smallest document that handles the job. Use local controls and `setState` for filtering, selection, tabs, toggles, and calculations. Use `sendAgentEvent` only when the next step needs agent judgment. Use confirmed native capabilities for supported board or workflow actions, and never imply that an action ran before the user clicked and confirmed it.

Use bounded read-only sources for project data. Refresh event-driven sources after relevant Pixice changes, and leave expensive sources such as file contents and Git diffs on manual refresh unless the task needs something else. Inspect the current document and version before updating an existing Tool so user state and newer edits are not overwritten.

Tools start as thread-scoped and ephemeral. Open the Tool after creating it so the user can work with it. Suggest pinning only when the controls are likely to help again in this project. Do not create a replacement for an existing Tool when updating or reopening it will do. A pinned Tool cannot be changed by an agent until the user unpins it.
