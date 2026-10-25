export type Deck = { root?: string; generation?: number; url?: string; name?: string | null };
export type Provider = 'openrouter' | 'openai' | 'claude' | 'ollama';
export type Settings = { provider: Provider; baseUrl: string; model: string; hasKey: boolean };
export type Message = { role: 'user' | 'assistant'; content: string };
export type ConversationSummary = { id: string; title: string; updatedAt: string; provider?: Provider; model?: string };
export type Conversation = { id: string; title: string; messages: Message[]; requests: { provider: Provider; model: string; status: string }[] };
declare global {
  interface Window {
    wetmytt?: {
      connectCodex(): Promise<{ opened: boolean; error?: string }>;
      connectClaude(): Promise<{ opened: boolean; filename: string; error?: string }>;
      state(): Promise<Deck>;
      readContent(root: string, generation: number): Promise<string>;
      saveContent(root: string, generation: number, source: string, pointer: string, text: string): Promise<string>;
      open(): Promise<Deck | null>;
      create(): Promise<Deck | null>;
      close(): Promise<Deck>;
      exportPDF(root: string): Promise<{ path: string; pages: number } | null>;
      reveal(): Promise<void>;
      importAssets(root: string, files: File[]): Promise<{ imported: string[]; errors: string[] }>;
      settings(): Promise<Settings>;
      saveSettings(value: { provider: Provider; baseUrl: string; model: string; apiKey?: string }): Promise<{ persistedKey: boolean }>;
      chats(root: string): Promise<ConversationSummary[]>;
      loadChat(root: string, id: string): Promise<Conversation>;
      chat(root: string, id: string | null, text: string): Promise<{ conversation: Conversation; error?: string }>;
      cancel(): Promise<void>;
      present(value: boolean): Promise<void>;
      on(name: string, callback: (value: never) => void): () => void;
    };
  }
}
