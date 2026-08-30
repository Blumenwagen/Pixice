# Sample result

The `example/typescript-web-app` folder shows a finished setup for a small Vite and React repository.

The useful part is not its wording. It is the chain of evidence:

1. Commands come from the repository's package scripts.
2. Generated output is named so the agent does not edit it.
3. External actions remain behind approval.
4. Each change type has a concrete check.
5. The handoff separates checks that passed from checks that did not run.

When adapting the kit, remove rules that do not change decisions. Keep repository facts, risky boundaries, and executable checks.
