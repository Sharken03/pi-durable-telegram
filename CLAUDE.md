# orkestrator

Fork of smixs/pi-durable-telegram on branch `mvp`: a durable agent you talk to in Telegram.
It runs from source (`node src/cli/main.ts`, no build step) with Node 24 on a small aarch64
host with 1 GB RAM, as a systemd user service. The agent has read, write and edit tools, and no bash tool.

## Rules
- Never run a TypeScript typecheck locally: not `tsc`, `npx tsc`, `npm run typecheck`, `npm run build`
  or `npm pack` (prepack runs tsc). The phone kills Termux. To typecheck, commit, then
  `git push origin HEAD:refs/heads/typecheck/<name>` and `gh run watch <id>` (find the id with `gh run list`).
- Never read env files: `~/.config/orkestrator/env`, `.env*`. Never write a token or key value anywhere.
  `ops/env.example` holds names only.
- Never push to `upstream` (smixs). Push only `mvp` and `typecheck/*` to `origin`, and only when the user says so.
- Node on the host must be the same version as in Termux (v24.18.0 on 2026-11-26).

## Tests
Local test command (skips the packed-asset test, because it runs `npm pack` and so tsc):

    node --test --test-concurrency=1 --test-skip-pattern="packed asset" "test/**/*.test.ts"

CI (`.github/workflows/typecheck.yml`) runs `npm ci`, `npm run typecheck` and the full `npm test`.

## Ops
- `ops/deploy-pi.sh [host]` copies the app to the host (`pi-ork` by default) and restarts the service.
- `ops/orkestrator.service` is the unit; `ops/env.example` is the env file template.

## Commits and comments
Follow `docs/comments-and-commits.md`. Short version:
- English, "Area: imperative summary" (at most 72 chars), blank line, 1-4 lines on why.
- Never write "8T" or "Raspberry Pi" in a commit message.
- End each commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Comments in English; they describe the code as it is now.
