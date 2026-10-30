<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Git workflow

Before each logical change (which may span several files), check `git status` and start with a clean working tree and index. If there are existing changes, inspect both unstaged and staged diffs and read relevant untracked files. Preserve their contents, stage explicit paths, and commit them separately with a descriptive checkpoint message before editing. Do not include secrets or files outside this repository. If a clean baseline cannot be created safely or a Git operation fails, report the blocker before editing.

After each logical change, review the diff and run the relevant checks. Stage explicit changed paths, inspect the staged diff, and commit with a concise, descriptive message explaining what changed and why. Confirm `git status` is clean before starting another change or reporting completion. Do not create empty commits for read-only or unchanged work. Never discard edits or rewrite history unless requested. If validation or a commit fails, report it honestly and preserve the edits.

## Release follow-up: README and GitHub Pages

After publishing a new stable GitHub Release, update both macOS download badges near the top of `README.md` to the published release's DMG asset URLs: Apple Silicon uses `arm64`, and Intel uses `x64`. Verify both assets exist before changing the links, then commit and push the README update. Do not advance the badges for draft releases or prereleases.

Also refresh the GitHub Pages site after every new stable release: run the **Project website** workflow (`.github/workflows/pages.yml`) on `master`, wait for deployment to succeed, and verify the live site's version, release-notes link, and both architecture download buttons match the published release. The site resolves download URLs at build time, so publishing a release alone does not update it. Treat both the README update and the Pages deployment as required release follow-up; if either is blocked, report the outstanding step instead of reporting the release work complete. Do not deploy a draft or prerelease as the site's latest release. See `docs/website.md` for deployment details.

The DMG filenames currently include the version (`wetmytt-X.Y.Z-mac-ARCH.dmg`), so `/releases/latest/download/…` does not remove the need to update their filenames. Keep the separate `/releases/latest` page link version-independent. If releases later provide fixed-name DMG aliases for both architectures, the badges can use those aliases with `/releases/latest/download/` instead. See `docs/releases.md` for the release checklist.
