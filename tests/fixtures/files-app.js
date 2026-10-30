import { app, BrowserWindow, dialog } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveGitBinary } from 'dugite';
import { gitChanges, gitFilesAction, gitInit } from '../../electron/git.js';

const [directory] = process.argv.slice(2);
app.setPath('userData', path.join(directory, 'profile'));
app.setPath('sessionData', path.join(directory, 'profile'));
app.whenReady().then(async () => {
  const root = path.join(directory, 'deck');
  await fs.cp(path.resolve('templates/starter'), root, { recursive: true });
  await gitInit(root, undefined, true);
  await fs.writeFile(path.join(root, 'notes.txt'), 'New notes\nKeep these notes for the next presentation.\n');
  await fs.appendFile(path.join(root, 'deck.json'), '\n');
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
  const waitFor = async predicate => {
    const deadline = Date.now() + 15000;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error('Files UI did not reach the expected state.');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  try {
    await import('../../electron/main.js');
    let window;
    await waitFor(() => { window = BrowserWindow.getAllWindows().find(item => item.isVisible()); return window; });
    const js = source => window.webContents.executeJavaScript(source);
    await waitFor(() => js(`Boolean(document.querySelector('.file-actions .menu-trigger'))`));
    await js(`document.querySelector('.file-actions .menu-trigger').click()`);
    await js(`[...document.querySelectorAll('[role=menuitem]')].find(b => b.textContent === 'Open folder…').click()`);
    await waitFor(() => js(`Boolean(document.querySelector('#files-tab'))`));
    await waitFor(() => js(`document.querySelector('.last-commit')?.textContent === 'Create presentation' && document.querySelector('.git-working-status')?.dataset.dirty === 'true'`));
    assert.equal(await js(`document.querySelectorAll('.sidebar-tabs [role=tab]').length`), 4);
    await js(`document.querySelector('#history-tab').click()`);
    await waitFor(() => js(`document.querySelector('.commit-timeline h3')?.textContent === 'Create presentation'`));
    assert.equal(await js(`document.querySelector('#files-panel').hidden`), true);
    await js(`document.querySelector('#files-tab').click()`);
    await waitFor(() => js(`document.querySelector('.project-tree')?.textContent.includes('notes.txt')`));
    assert.equal(await js(`document.querySelector('#chat-panel').hidden`), true);
    assert.equal(await js(`document.querySelector('#edit-panel').hidden`), true);
    assert.equal(await js(`document.querySelector('.project-tree li[title="notes.txt"] .file-status').textContent`), 'U');
    assert.equal(await js(`document.querySelector('.project-tree li[title="deck.json"] .file-status').textContent`), 'M');
    await js(`document.querySelector('[aria-label="Stage notes.txt"]').click()`);
    await waitFor(() => js(`Boolean(document.querySelector('[aria-label="Unstage notes.txt"]:not(:disabled)'))`));
    await js(`document.querySelector('[aria-label="Unstage notes.txt"]').click()`);
    await waitFor(() => js(`Boolean(document.querySelector('[aria-label="Stage notes.txt"]:not(:disabled)'))`));
    await js(`document.querySelector('[aria-label="Stage notes.txt"]').click()`);
    await waitFor(() => js(`Boolean(document.querySelector('[aria-label="Unstage notes.txt"]:not(:disabled)'))`));
    await js(`(() => { const input = document.querySelector('#commit-message'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'Add presentation notes'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await waitFor(() => js(`!document.querySelector('.files-commit button').disabled`));
    const layout = await js(`(() => { const panel = document.querySelector('#files-panel').getBoundingClientRect(); const toolbar = document.querySelector('#files-panel .files-toolbar').getBoundingClientRect(); const tree = document.querySelector('.project-tree').getBoundingClientRect(); const commit = document.querySelector('.files-commit').getBoundingClientRect(); return { panelTop: panel.top, toolbarTop: toolbar.top, treeHeight: tree.height, commitBottom: commit.bottom, panelBottom: panel.bottom }; })()`);
    assert.equal(await js(`document.querySelectorAll('#files-panel').length`), 1);
    assert.equal(layout.panelTop, layout.toolbarTop);
    assert.ok(layout.treeHeight > 0);
    assert.ok(layout.commitBottom <= layout.panelBottom + 1);
    if (process.env.WETMYTT_FILES_SCREENSHOT) {
      await new Promise(resolve => setTimeout(resolve, 400));
      await fs.writeFile(process.env.WETMYTT_FILES_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
    }
    await js(`document.querySelector('.files-commit button').click()`);
    await waitFor(() => js(`document.querySelector('.files-commit [role=status]')?.textContent === 'Changes committed.'`));
    assert.equal(await js(`document.querySelector('#commit-message').value`), '');
    let changes = await gitChanges(root);
    assert.deepEqual(changes.map(c => c.path), ['deck.json']);
    assert.equal(changes[0].worktree, 'M');
    await waitFor(() => js(`document.querySelector('.last-commit')?.textContent === 'Add presentation notes'`));
    await js(`document.querySelector('#history-tab').click()`);
    await waitFor(() => js(`document.querySelector('.commit-timeline h3')?.textContent === 'Add presentation notes'`));
    assert.equal(await js(`document.querySelectorAll('.commit-timeline > li').length`), 2);
    assert.equal(await js(`document.querySelectorAll('#history-panel').length`), 1);
    await js(`document.querySelector('#files-tab').click()`);
    // Index-only changes from another tool must refresh without a content write.
    await gitFilesAction(root, 'stage', ['deck.json']);
    await waitFor(() => js(`Boolean(document.querySelector('[aria-label="Unstage deck.json"]'))`));
    await fs.writeFile(path.join(root, 'external.txt'), 'external edit');
    await waitFor(() => js(`document.querySelector('.project-tree')?.textContent.includes('external.txt')`));
    const stale = await js(`window.wetmytt.gitAction(${JSON.stringify(root)}, -1, 'stage', ['external.txt']).then(() => false, () => true)`);
    assert.equal(stale, true);
    assert.equal((await gitChanges(root)).find(c => c.path === 'external.txt').index, '?');
    await fs.rename(path.join(root, 'notes.txt'), path.join(root, 'renamed-notes.txt'));
    await gitFilesAction(root, 'stage', ['notes.txt', 'renamed-notes.txt']);
    await fs.appendFile(path.join(root, 'renamed-notes.txt'), '\nupdated');
    await waitFor(() => js(`Boolean(document.querySelector('[aria-label="Stage renamed-notes.txt"]:not(:disabled)'))`));
    await js(`document.querySelector('[aria-label="Stage renamed-notes.txt"]').click()`);
    await waitFor(() => js(`!document.querySelector('[aria-label="Stage renamed-notes.txt"]') && Boolean(document.querySelector('[aria-label="Unstage renamed-notes.txt"]:not(:disabled)'))`));
    await js(`document.querySelector('[aria-label="Unstage renamed-notes.txt"]').click()`);
    await waitFor(() => js(`Boolean(document.querySelector('[aria-label="Stage notes.txt"]'))`));
    assert.ok(!(await gitChanges(root)).some(c => c.path === 'renamed-notes.txt' && c.index === 'R'));
    await js(`document.querySelector('#history-tab').click()`);
    await gitFilesAction(root, 'stage', ['deck.json', 'notes.txt', 'renamed-notes.txt', 'external.txt']);
    await gitFilesAction(root, 'commit', [], 'Refine presentation\n\nTighten the opening and keep the supporting notes.');
    await waitFor(() => js(`document.querySelector('.commit-timeline h3')?.textContent === 'Refine presentation' && document.querySelector('.last-commit')?.textContent === 'Refine presentation' && document.querySelector('.git-working-status')?.dataset.dirty === 'false'`));
    assert.equal(await js(`document.querySelectorAll('.commit-timeline > li').length`), 3);
    await js(`document.querySelector('.commit-timeline details').open = true`);
    assert.equal(await js(`document.querySelector('.commit-body').textContent`), 'Tighten the opening and keep the supporting notes.');
    if (process.env.WETMYTT_HISTORY_SCREENSHOT) {
      await new Promise(resolve => setTimeout(resolve, 400));
      await fs.writeFile(process.env.WETMYTT_HISTORY_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
    }
    // Restore from the footer without an agent; the backup can recover both files.
    await waitFor(() => js(`document.querySelector('.restore-save')?.disabled === true`));
    const saved = await fs.readFile(path.join(root, 'deck.json'), 'utf8');
    await fs.writeFile(path.join(root, 'deck.json'), saved + '\n');
    await fs.writeFile(path.join(root, 'draft.txt'), 'Keep this draft');
    await waitFor(() => js(`document.querySelector('.restore-save')?.disabled === false`));
    assert.match(await js(`document.querySelector('#restore-detail').textContent`), /git stash push --include-untracked/);
    assert.equal(await js(`window.wetmytt.restoreLastSave(${JSON.stringify(root)}, -1).then(() => false, () => true)`), true);
    await js(`document.querySelector('.restore-save').focus()`);
    assert.equal(await js(`getComputedStyle(document.querySelector('#restore-detail')).display`), 'block');
    await js(`document.querySelector('.restore-save').click()`);
    await waitFor(() => js(`document.querySelector('.restore-result')?.textContent.includes('Last save restored.') && document.querySelector('.restore-save').disabled`));
    assert.equal(await fs.readFile(path.join(root, 'deck.json'), 'utf8'), saved);
    await assert.rejects(fs.stat(path.join(root, 'draft.txt')), { code: 'ENOENT' });
    assert.deepEqual(await gitChanges(root), []);
    if (process.env.WETMYTT_RESTORE_SCREENSHOT) {
      await js(`document.querySelector('.restore-save').blur()`);
      await fs.writeFile(process.env.WETMYTT_RESTORE_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
    }
    const command = await js(`document.querySelector('.restore-backup').textContent`);
    const backup = command.split(' ').at(-1);
    assert.match(backup, /^[a-f0-9]{40,64}$/);
    await promisify(execFile)(resolveGitBinary(), ['stash', 'apply', '--index', backup], { cwd: root });
    assert.equal(await fs.readFile(path.join(root, 'deck.json'), 'utf8'), saved + '\n');
    assert.equal(await fs.readFile(path.join(root, 'draft.txt'), 'utf8'), 'Keep this draft');
    console.log('Files and History integration passed, including footer restore, stale project guard and backup recovery.');
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
}).catch(error => { console.error(error); app.exit(1); });
