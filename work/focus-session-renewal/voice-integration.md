# Voice integration contract for the coordinator

The renewal backend exposes two host APIs on `createApplication`'s returned object. The headless voice worker's files were read for compatibility but not edited.

Register `application.setFocusVoiceGuard((projectId, threadId) => voiceBridge.blocksRollover({ projectId, threadId }))` after creating the headless bridge. A preparation reservation, active session, stopping session, or failed stop must keep this guard true. The renewal engine checks the guard both before creating a candidate and before publishing it. A throwing or unknown guard fails closed.

Run voice preparation through `application.withFocusSessionAdmission({ projectId, threadId }, scope => voiceBridge.prepare(scope))`. This uses the same project gate as renewal and user turn admission, validates the authoritative thread and provider, and rejects active text turns. Its callback must not recursively acquire this gate. Voice `resolveScope` should validate ownership and authoritative identity directly inside the existing application initialization wiring.

These are integration hooks. This worker has not wired a live voice bridge into `application.mjs`, activated voice, recorded microphone audio, or changed final voice UI. The coordinator must integrate the hooks with the separate voice outcome before accepting combined voice/renewal behavior.
