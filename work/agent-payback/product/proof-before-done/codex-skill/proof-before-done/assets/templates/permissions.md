# Agent permissions

These boundaries do not grant access. They record what the repository owner has approved.

## Allowed without another question

- Read files inside the repository.
- Run local, read-only inspection commands.
- Edit files needed for the requested task.
- Run the repository's verified local checks.

## Ask immediately before acting

- Install or upgrade production dependencies.
- Use the network when the task did not already require it.
- Access credentials, secret stores, private customer data, or production data.
- Change CI, release, deployment, billing, or account settings.
- Publish a release, message a person, open a pull request, or post publicly.
- Delete, overwrite, reset, or migrate data that is difficult to recover.
- Write outside the repository.

## Never infer from a task request

- Permission to spend money or enter a contract.
- Permission to impersonate the repository owner.
- Permission to weaken security checks or bypass approvals.
- Permission to expose source code, data, logs, or credentials to another service.

## Recovery rule

Resolve the exact target before a destructive action. Prefer a recoverable operation. Stop when the target or rollback path is unclear.

