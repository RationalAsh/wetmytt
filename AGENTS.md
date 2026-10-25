<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Git workflow

Before each logical change (which may span several files), check `git status` and start with a clean working tree and index. If there are existing changes, inspect both unstaged and staged diffs and read relevant untracked files. Preserve their contents, stage explicit paths, and commit them separately with a descriptive checkpoint message before editing. Do not include secrets or files outside this repository. If a clean baseline cannot be created safely or a Git operation fails, report the blocker before editing.

After each logical change, review the diff and run the relevant checks. Stage explicit changed paths, inspect the staged diff, and commit with a concise, descriptive message explaining what changed and why. Confirm `git status` is clean before starting another change or reporting completion. Do not create empty commits for read-only or unchanged work. Never discard edits or rewrite history unless requested. If validation or a commit fails, report it honestly and preserve the edits.
