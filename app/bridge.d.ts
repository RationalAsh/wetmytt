export type Deck = { root?: string; url?: string; name?: string | null };
export type Provider = 'openrouter' | 'openai' | 'claude' | 'ollama';
export type Settings = { provider: Provider; baseUrl: string; model: string; hasKey: boolean };
export type Message = { role: 'user' | 'assistant'; content: string };
declare global {
  interface Window {
    wetmytt?: {
      connectCodex(): Promise<{ opened: boolean; error?: string }>;
      state(): Promise<Deck>;
      open(): Promise<Deck | null>;
      create(): Promise<Deck | null>;
      close(): Promise<Deck>;
      exportPDF(root: string): Promise<{ path: string; pages: number } | null>;
      reveal(): Promise<void>;
      importAssets(root: string, files: File[]): Promise<{ imported: string[]; errors: string[] }>;
      settings(): Promise<Settings>;
      saveSettings(value: { provider: Provider; baseUrl: string; model: string; apiKey?: string }): Promise<{ persistedKey: boolean }>;
      chat(history: Message[]): Promise<string>;
      cancel(): Promise<void>;
      present(value: boolean): Promise<void>;
      on(name: string, callback: (value: never) => void): () => void;
    };
  }
}
