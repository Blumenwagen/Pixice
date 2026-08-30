# Proof Before Done

Project rules, permission boundaries, and completion checks for coding agents.

This kit helps you stop four expensive failure patterns:

- the agent guesses commands or architecture;
- broad permissions turn a small task into a risky one;
- an agent edits the right file but skips the real check;
- "done" means the response ended, not that the change works.

## What is included

- `codex-skill/proof-before-done/`: an installable Codex skill that inspects a repository and creates or repairs its agent guidance;
- `templates/`: editable files for project instructions, permissions, task briefs, and proof-of-completion checks;
- `example/`: a filled TypeScript web application example;
- `SAMPLE-OUTPUT.md`: the kind of repository setup the skill should produce;
- `LICENSE.txt`: the purchase license.

## Ten-minute setup

1. Copy `codex-skill/proof-before-done` to your repository at `.agents/skills/proof-before-done`.
2. Start a new Codex session from the repository root.
3. Run: `$proof-before-done configure reliable agent guidance for this repository`.
4. Review the proposed commands, permission boundaries, and verification matrix before accepting edits.
5. Commit the resulting guidance with the rest of your project documentation.

For Claude Code, start with `templates/CLAUDE.md` and replace every bracketed field with facts from your repository. The Codex skill and the Claude companion template share the same operating rules, but installation differs between the products.

## The rule that matters

Never write an agent instruction that cannot be checked. "Keep quality high" is decoration. "Run `pnpm test` after changing application logic" can be verified.

## Privacy

The kit is local files. It has no network code, tracking, credentials, or external service dependency. Your coding agent still follows the permissions and data controls of the product you use.

