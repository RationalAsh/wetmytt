export type Deck = { root?: string; generation?: number; url?: string; name?: string | null; branch?: string | null };
export type Provider = 'openrouter' | 'openai' | 'claude' | 'ollama';
export type Settings = { provider: Provider; baseUrl: string; model: string; hasKey: boolean; maxTurns: number };
export type Message = { role: 'user' | 'assistant'; content: string };
export type TokenUsage = { inputTokens: number; outputTokens: number };
export type ConversationSummary = { id: string; title: string; updatedAt: string; provider?: Provider; model?: string };
export type Conversation = { id: string; title: string; messages: Message[]; requests: { provider: Provider; model: string; status: string; usage?: TokenUsage }[] };
declare global {
  interface Window {
    wetmytt?: {
      connectCodex(): Promise<{ opened: boolean; error?: string }>;
      connectClaude(): Promise<{ opened: boolean; filename: string; error?: string }>;
      recentFolders(): Promise<string[]>;
      openRecent(folder: string): Promise<Deck>;
      removeRecent(folder: string): Promise<void>;
      clearRecent(): Promise<void>;
      state(): Promise<Deck>;
      thumbnails(root: string, generation: number, indices: number[]): Promise<{ index: number; url: string }[] | null>;
      readContent(root: string, generation: number): Promise<string>;
      saveContent(root: string, generation: number, source: string, pointer: string, text: string): Promise<string>;
      open(): Promise<Deck | null>;
      create(): Promise<Deck | null>;
      close(): Promise<Deck>;
      exportPDF(root: string): Promise<{ path: string; pages: number } | null>;
      reveal(): Promise<void>;
      importAssets(root: string, files: File[]): Promise<{ imported: string[]; errors: string[] }>;
      chooseAssets(root: string, generation: number): Promise<{ imported: string[]; errors: string[] } | null>;
      settings(): Promise<Settings>;
      savePreferences(value: { maxTurns: number }): Promise<{ persistedKey: boolean }>;
      saveSettings(value: { provider: Provider; baseUrl: string; model: string; apiKey?: string }): Promise<{ persistedKey: boolean }>;
      chats(root: string): Promise<ConversationSummary[]>;
      loadChat(root: string, id: string): Promise<Conversation>;
      chat(root: string, id: string | null, text: string): Promise<{ conversation: Conversation; error?: string }>;
      context(): Promise<number | null>;
      cancel(): Promise<void>;
      present(value: boolean): Promise<void>;
      on(name: string, callback: (value: never) => void): () => void;
    };
  }
}
