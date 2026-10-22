'use client';

import { useEffect, useRef, useState } from 'react';

export function AgentConnection({ onClose }: { onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [connection, setConnection] = useState<{ url?: string; config?: string; error?: string }>({});
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    dialog.current?.showModal();
    window.wetmytt?.mcpConnection().then(setConnection).catch(err => setError(String(err)));
  }, []);
  async function copy() {
    try { await window.wetmytt!.copyMcpConfig(); setCopied(true); }
    catch (err) { setError(String(err)); }
  }
  return <dialog ref={dialog} className="settings-modal agent-modal" onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }} aria-labelledby="agent-title">
    <div className="modal-heading"><h2 id="agent-title">Connect to Codex</h2><button className="icon-button" aria-label="Close connection settings" onClick={onClose}>×</button></div>
    <p>Give Codex access to the open presentation’s files and slide screenshots. Keep this app running while you work.</p>
    {connection.url && <>
      <ol className="agent-steps"><li>Copy the connection settings below.</li><li>Add them to <code>~/.codex/config.toml</code> on this computer.</li><li>Open a presentation, then start a new Codex session.</li></ol>
      <pre className="agent-config" aria-label="Codex MCP configuration">{connection.config}</pre>
      <small>These settings include a private access token for this installation. Keep it out of shared presentation folders and version control.</small>
      <p>If you switch presentations, reconnect MCP or start a new Codex session. Existing connections stay bound to the previous presentation and stop accepting file and screenshot requests.</p>
    </>}
    {(connection.error || error) && <div className="settings-error" role="alert">{connection.error || error}</div>}
    <div className="settings-buttons"><span role="status">{copied ? 'Connection settings copied' : ''}</span><button onClick={onClose}>Close</button><button className="primary" disabled={!connection.config} onClick={() => void copy()}>Copy settings</button></div>
  </dialog>;
}
