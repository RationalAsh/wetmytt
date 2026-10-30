'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ActionBarPrimitive, AssistantRuntimeProvider, ComposerPrimitive,
  MessagePrimitive, ThreadPrimitive, groupPartByType, useExternalStoreRuntime, useAuiState,
  type ThreadMessageLike, type ToolCallMessagePartProps,
} from '@assistant-ui/react';
import type { Message } from './bridge';
import { MarkdownMessage } from './markdown-message';

function convertMessage(message: Message, index: number, activeRequest?: string): ThreadMessageLike {
  const tools = (message.tools || []).map(tool => ['pending', 'running'].includes(tool.status) && (!activeRequest || message.requestId !== activeRequest) ? { ...tool, status: 'cancelled' as const } : tool);
  const running = tools.some(tool => tool.status === 'pending' || tool.status === 'running');
  return {
    id: message.id || `legacy-${index}`,
    role: message.role,
    createdAt: message.createdAt ? new Date(message.createdAt) : undefined,
    content: [
      ...(message.content ? [{ type: 'text' as const, text: message.content }] : []),
      ...tools.map(tool => ({
        type: 'tool-call' as const, toolCallId: tool.id, toolName: tool.name,
        argsText: tool.argsText, result: tool.result,
        isError: tool.status === 'failed' || tool.status === 'cancelled',
        artifact: { status: tool.status },
      })),
    ],
    ...(message.role === 'assistant' ? { status: running
      ? { type: 'running' as const }
      : { type: 'complete' as const, reason: 'stop' as const } } : {}),
  };
}

function ToolDetails({ toolName, args, argsText, result, artifact }: ToolCallMessagePartProps) {
  const status = (artifact as { status?: string } | undefined)?.status || 'completed';
  const label = ({ pending: 'Queued', running: 'Running', completed: 'Completed', failed: 'Failed', cancelled: 'Stopped' } as Record<string, string>)[status];
  const detail = args.path || args.query || args.url || args.name;
  let input = argsText;
  try { input = JSON.stringify(JSON.parse(argsText), null, 2); } catch {}
  return <details className={`tool-call tool-${status}`}>
    <summary><span className="tool-name">{toolName.replaceAll('_', ' ')}</span><span className="tool-status">{label}</span></summary>
    {typeof detail === 'string' && <div className="tool-detail">{detail}</div>}
    <div className="tool-content"><strong>Input</strong><pre>{input}</pre>
      <strong>Output</strong><pre>{result === undefined ? (status === 'cancelled' ? 'Stopped before a result was returned.' : status === 'failed' ? 'No result was returned.' : 'Waiting for a result…') : String(result)}</pre>
    </div>
  </details>;
}

const groupTools = groupPartByType({ 'tool-call': ['group-tools'] });

function AssistantMessage() {
  const preview = useAuiState(state => state.message.id === 'response-preview');
  const empty = useAuiState(state => state.message.parts.length === 0);
  if (empty) return null;
  return <MessagePrimitive.Root className={preview ? "message assistant streaming-response" : "message assistant"}>
    <span>{preview ? 'WETMYTT · RECEIVING' : 'WETMYTT'}</span>
    <MessagePrimitive.GroupedParts groupBy={groupTools} indicator="never">
      {({ part, children }) => {
        switch (part.type) {
          case 'group-tools': return <details className="tool-group"><summary>{part.indices.length} tool {part.indices.length === 1 ? 'call' : 'calls'}{part.counts.running > 0 ? ' · Working…' : part.counts.incomplete > 0 ? ' · Needs attention' : ''}</summary><div>{children}</div></details>;
          case 'text': return <MarkdownMessage>{part.text}</MarkdownMessage>;
          case 'tool-call': return <ToolDetails {...part} />;
          default: return null;
        }
      }}
    </MessagePrimitive.GroupedParts>
    {!preview && <ActionBarPrimitive.Root className="message-actions"><ActionBarPrimitive.Copy aria-label="Copy response"><span className="copy-label">Copy</span><span className="copied-label">Copied</span></ActionBarPrimitive.Copy></ActionBarPrimitive.Root>}
  </MessagePrimitive.Root>;
}

function UserMessage() {
  return <MessagePrimitive.Root className="message user"><span>YOU</span><MessagePrimitive.Parts /></MessagePrimitive.Root>;
}

type RequestProgress = { startedAt: number; operation: string; text: string; stopping: boolean };

function RequestStatus({ progress }: { progress: RequestProgress }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [progress.startedAt]);
  const seconds = Math.max(0, Math.floor((now - progress.startedAt) / 1000));
  const elapsed = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return <div className="request-progress">
    <div className="activity"><span aria-hidden="true" /><div role="status">{progress.stopping ? 'Stopping…' : progress.operation}</div><time aria-label="Request elapsed time">{elapsed}</time></div>
    <p>{progress.stopping ? 'Waiting for the current operation to stop. Completed edits stay saved.' : 'You can stop at any time. Completed edits stay saved.'}</p>
  </div>;
}

export function ChatThread({ messages, busy, progress, loading, disabled, connected, onSend, onCancel, onConnect, intro, footer }: {
  messages: Message[]; busy: boolean; progress: RequestProgress; loading: boolean; disabled: boolean; connected: boolean;
  onSend: (text: string) => Promise<void>; onCancel: () => Promise<void>; onConnect: () => void;
  intro: ReactNode; footer: ReactNode;
}) {
  const converted = useMemo(() => {
    const activeRequest = busy ? messages.findLast(message => message.role === 'user')?.requestId : undefined;
    const result = messages.map((message, index) => convertMessage(message, index, activeRequest));
    if (busy && progress.text) result.push({ id: 'response-preview', role: 'assistant', content: [{ type: 'text', text: progress.text }], status: { type: 'running' } });
    return result;
  }, [messages, busy, progress.text]);
  const runtime = useExternalStoreRuntime({
    messages: converted, convertMessage: message => message, isRunning: busy, isLoading: loading, isDisabled: disabled || loading,
    isSendDisabled: !connected,
    onNew: async message => {
      const text = message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
      await onSend(text);
    },
    onCancel,
  });
  return <AssistantRuntimeProvider runtime={runtime}>
    <ThreadPrimitive.Root className="assistant-thread">
      <ThreadPrimitive.Viewport className="chat-messages">
        <ThreadPrimitive.Empty>{intro}</ThreadPrimitive.Empty>
        <ThreadPrimitive.Messages>{({ message }) => message.role === 'user' ? <UserMessage /> : <AssistantMessage />}</ThreadPrimitive.Messages>
      </ThreadPrimitive.Viewport>
      <ThreadPrimitive.ScrollToBottom className="scroll-to-bottom" aria-label="Scroll to latest message">↓ Latest</ThreadPrimitive.ScrollToBottom>
      {busy && <RequestStatus progress={progress} />}
      <ComposerPrimitive.Root className="composer">
        <ComposerPrimitive.Input aria-label="Message your creative partner" placeholder={disabled ? 'Open a deck to start creating…' : 'What’s your big idea?'} disabled={busy} onKeyDown={event => {
          if (!connected && event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); onConnect(); }
        }} />
        <div>{footer}<div className="composer-actions">
          {busy ? <ComposerPrimitive.Cancel className="send-button" aria-label="Stop generation">■</ComposerPrimitive.Cancel>
            : connected ? <ComposerPrimitive.Send className="send-button" aria-label="Send message">↑</ComposerPrimitive.Send>
              : <button type="button" className="send-button" aria-label="Connect AI to send message" disabled={disabled || loading} onClick={onConnect}>↑</button>}
        </div></div>
      </ComposerPrimitive.Root>
    </ThreadPrimitive.Root>
  </AssistantRuntimeProvider>;
}
