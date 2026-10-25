'use client';

import { useEffect, useRef, useState } from 'react';

export function AgentConnection({ agent, onClose }: { agent: 'Codex' | 'Claude'; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const started = useRef(false);
  const [busy, setBusy] = useState(true);
  const [opened, setOpened] = useState(false);
  const [error, setError] = useState('');
  const [filename, setFilename] = useState('');
  async function connect() {
    setBusy(true); setError(''); setOpened(false);
    try {
      if (!window.wetmytt) throw new Error(`Open the desktop app to connect to ${agent}.`);
      const result = agent === 'Claude' ? await window.wetmytt.connectClaude() : await window.wetmytt.connectCodex();
      setFilename('filename' in result && typeof result.filename === 'string' ? result.filename : '');
      setOpened(result.opened); setError(result.error || '');
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    dialog.current?.showModal();
    if (!started.current) { started.current = true; void connect(); }
  }, []);
  return <dialog ref={dialog} className="settings-modal agent-modal" onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }} aria-labelledby="agent-title">
    <div className="modal-heading"><h2 id="agent-title">Connect to {agent}</h2><button className="icon-button" aria-label="Close connection settings" onClick={onClose}>×</button></div>
    <p>Use the Welcome to My TED Talk {agent === 'Claude' ? 'extension' : 'plugin'} to edit your open presentation and capture slide screenshots.</p>
    {agent === 'Claude' ? <>
      <p role="status">{busy ? 'Preparing your local extension and opening Claude…' : opened ? 'Opened the extension. Follow the installation prompts in Claude Desktop.' : 'Finish connecting in Claude Desktop.'}</p>
      <ol className="agent-steps"><li>Install the extension in Claude Desktop.</li><li>Open a presentation here and keep this app running.</li><li>Start a new Claude chat and enable the Welcome to My TED Talk tools.</li></ol>
      <p>If the installer doesn’t open, go to Claude Settings → Desktop app → Extensions → Advanced settings → Install Extension and select the file below. After switching presentations, reconnect the extension.</p>
      {filename && <p className="agent-path">{filename}</p>}
    </> : <>
    <p role="status">{busy ? 'Preparing your local plugin and opening Codex…' : opened ? 'Opened the plugin in Codex. Select Install there to finish connecting.' : 'Finish connecting in Codex Desktop.'}</p>
    <ol className="agent-steps"><li>Install the plugin in Codex.</li><li>Open a presentation here and keep this app running.</li><li>Start a new Codex chat and use the plugin.</li></ol>
    <p>If Codex doesn’t show the plugin yet, restart Codex and click “Open in Codex” below. After switching presentations, reconnect MCP or start a new Codex chat.</p>
    </>}
    {error && <div className="settings-error" role="alert">{error}</div>}
    <div className="settings-buttons"><button onClick={onClose}>Close</button><button className="primary" disabled={busy} onClick={() => void connect()}>{busy ? 'Opening…' : `Open in ${agent}`}</button></div>
  </dialog>;
}
