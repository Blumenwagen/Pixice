# Done checklist

Run the smallest checks that could expose a real failure in the change. Add broader checks when the risk justifies them.

| Change type | Required proof |
| --- | --- |
| Application logic | Focused tests for the changed behavior, then the relevant typecheck or build |
| UI or styling | Focused tests, production build, and visual inspection at affected sizes |
| API or integration | Contract tests or a representative request, plus error-path coverage |
| Database or schema | Migration validation, compatibility check, and a tested rollback path |
| Dependency | Lockfile review, relevant tests, production build, and license or security review when material |
| Configuration | Parser or loader check, affected test, and diff review for secrets or environment assumptions |
| Documentation | Link or command check where practical, plus final diff review |

## Completion handoff

- Changed: [short factual summary]
- Passed: [checks that ran and passed]
- Not run: [checks not run and why]
- Remaining: [risk, blocker, or human action]

