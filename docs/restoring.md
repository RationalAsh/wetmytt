# Restoring a saved version

Use **Restore last save** beside the branch indicator at the bottom of the presentation. “Last save” means the latest commit on the current branch (or the currently viewed commit when no branch is selected). Saving a text field writes a file; it does not create a commit. The Files tab can stage and commit a saved version, and agents also create commits.

The action applies to all uncommitted project changes, regardless of whether they came from manual editing, built-in chat, or an external editor. It preserves staged edits, working files, deletions, renames, and new files in a local backup before returning to the latest saved version. It keeps the current branch and commit history in place. Changes already committed by an agent require choosing an older version through Git; this button does not undo a completed, committed AI request or add automatic checkpoints around requests.

The button's tooltip is available on hover and keyboard focus and shows the operation:

```sh
git stash push --include-untracked --message "Backup before restoring last save"
```

Ignored files are left in place, including `.wetmytt/` chat history and `node_modules/` in app-created decks. Nested repositories and submodule contents are not restored. Backups remain in the deck's Git repository across app restarts. There is no automatic backup deletion.

After restoring, hover or focus the confirmation message to see a recovery command containing the backup's full ID:

```sh
git stash apply --index <backup-id>
```

Run it from the presentation folder to bring back the files and their staging state. The backup remains available after applying it. Later restores retain previous backups; `git stash list` lists them, including after reopening the app. Applying a backup over subsequent edits may produce conflicts, so save subsequent work before recovering it.

The button is disabled while built-in chat, slide management, or export is running, when there is no saved version, or when there are no changes. Stop or wait for built-in chat before restoring; completed edits from failed or stopped requests can be restored if they remain uncommitted. Pause external agents and editors first: the app serializes restoration with its connected tools and content writes, but cannot lock out another process writing directly to the folder. Unsaved text drafts in the Edit tab have not reached disk and are not part of a backup.

Missing repositories, merge conflicts, locked indexes, and write failures report an error. They never trigger a fallback hard reset or clean. If Git has saved a backup but cannot finish restoring (or the operation is interrupted), inspect `git stash list` before retrying. The app refreshes the preview, thumbnails, file list, and change indicator after a successful restore.
