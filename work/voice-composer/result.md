# Composer result for coordinator review

Work 8d25369f-4cd5-4798-9afd-d9a648b41499. Direction revisions 28 and 33 acknowledged. GPT-6.1 Sol, no delegation. Shared ownership contract followed.

The main task and Focus composer now use one primary action. Supported local Codex empty drafts offer native conversational Voice, typing or attachments switches to Send, and the existing running Stop/steering behavior remains. Motion animates the icon inside the same button and respects both the app preference and system reduced motion. Dictation remains a separate control. Enter and IME handling remain in the existing composer path. There is no toolbar Voice button or conversation modal.

Voice launch calls the native worker's api.voice.companion.open(context) only after a click. The context includes project/thread, model, effort, permissions, selected microphone and accent. New task launches create a thread through the existing threads API first. Project/provider changes invalidate pending launches. No media capture, playback, native window code or companion lifecycle belongs to this implementation. Missing API and unsupported providers/accounts have visible explanations. The native companion API and types are now present in the shared working tree and were consumed without editing native-owned files.

A compact This computer/Cloud control sits immediately above each composer. Cloud environments come from api.cloud.state for the current project, refresh when opening the menu, and are validated again immediately before submission. Empty lists link to existing Cloud Settings. Existing device selection remains available beside This computer. No Remote destination was added.

Cloud submission uses api.cloud.submit({projectId, environmentId, prompt, attempts:1}) before any local attachment preparation, slash commands, widget detection or coordinator/chat submission. Cloud writing/sending remains usable when the local conversation runtime is disconnected. Unsupported attachments and open Preview context block Cloud submission with an explanation and retain the draft. The selector explicitly states that each Cloud task receives only the prompt, without local conversation/model/permission settings. Returned CLI output and warnings appear in the composer. A task ID returned in the actual output enables existing status/diff APIs. Open Codex Cloud uses the existing cloud.open API. No task ID or task was fabricated.

Project/provider/device destination changes reset invalid Cloud selection and discard stale UI results. The existing API cannot cancel an already submitted remote job. This limitation is separate from invalidating the stale response in Pixice.

## Verification

- Nine focused composer integration checks passed. They cover one-button action switching, explicit Voice launch, no launch on render/empty Enter, IME, running Stop/steering, stale Voice launch after provider change, missing API/provider fallback, direct Cloud routing, response inspection/open integration, unsupported files/Preview context, missing/deleted saved environments, project changes and attachment-only Send.
- One existing dictation check passed. It records, transcribes and inserts at the cursor without submitting. The other eight dictation checks were skipped. No broad suites ran.
- After the local-runtime fallback fix, only the affected Cloud routing check reran and passed. It verifies that the Cloud text field is enabled and submission bypasses the disabled local path.
- Scoped git diff whitespace check passed. App.composer.patch records only this worker's changes relative to its starting App.jsx, preserving the existing auth/cloud work. Existing auth, Cloud Settings and Services were not edited. The coordinator explicitly authorized the Voice Settings copy correction in this follow-up.
- Actual Pixice Preview rendered the real App in a development fixture at 1320×860 and 1060×720, the native window's minimum size. Both Task and Focus were inspected in empty, typed and location-menu states. There was one primary action, the composer was centered relative to its canvas, the primary control and menu fit, the location row was above the composer, and the observed rail bounds did not change. Measurements are in preview-evidence.json. Focus's idle fixture hides its task rail, so these measurements do not claim verification of an active task rail.

## Follow-up refinement and visual review

The empty primary now offers Voice only when the provider is Codex, the execution host is local, the companion API is present and the launch adapter reports availability. Claude, remote execution, missing APIs, unavailable accounts and support checks keep ordinary Send with a visible explanation. Typed Claude drafts still submit through the existing local callback. Running Stop and Cloud routing are unchanged.

Voice Settings now describes the main Voice button in an empty Focus or Codex task composer and the companion's detached window. Only this copy was changed in Settings, as explicitly authorized by the coordinator. The coordinator owns the superseded modal assertion in tests/devday-ui.test.jsx; this worker did not edit it.

Only the affected fallback check reran for this refinement. It passed with eight other composer checks skipped. No suite, build or unchanged Preview was rerun. App.refinement.patch and test.refinement.patch record the follow-up separately. Scoped whitespace checks passed.

The screenshot capture blocker is resolved. The coordinator captured task-empty.png, task-typed.png, focus-empty.png, focus-typed.png and focus-cloud-menu.png using isolated Electron and reported the layout good. This worker inspected the existing task-empty and focus-cloud-menu captures, which show the primary action and location menu fitting the Pixice composer without shifting its rails. Earlier desktop and minimum-width DOM evidence remains in preview-evidence.json. These captures use the development fixture and do not prove microphone capture, companion lifetime or Cloud CLI execution. The native worker and combined independent review own that evidence.

## Artifacts

- preview.html is an interactive, local review harness for the real app. Open through the running Vite server at http://127.0.0.1:5183/work/voice-composer/preview.html. It is open in this thread's Preview.
- preview-evidence.json contains inspected states and actual layout measurements.
- App.composer.patch and devday-preview.composer.patch isolate these edits from pre-existing uncommitted changes.
- tests/voice-composer-integration.test.jsx contains the narrow behavioral checks.
- design-qa.md records resolved screenshot capture and the limits of the fixture evidence.
- App.refinement.patch and test.refinement.patch contain the follow-up availability gate and copy correction.
- task-empty.png, task-typed.png, focus-empty.png, focus-typed.png and focus-cloud-menu.png are the coordinator's actual Electron captures.

Submitted for coordinator review. This worker did not mark the durable outcome done, commit, push, reinstall the app, or change other workers' owned files.
