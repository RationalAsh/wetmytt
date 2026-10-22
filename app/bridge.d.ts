export type Deck = { root?: string; url?: string; name?: string | null };
export type Settings = { baseUrl: string; model: string; hasKey: boolean };
export type Message = { role: 'user' | 'assistant'; content: string };
declare global {
  interface Window {
    decklet?: {
      state(): Promise<Deck>;
      open(): Promise<Deck | null>;
      create(): Promise<Deck | null>;
      reveal(): Promise<void>;
      settings(): Promise<Settings>;
      saveSettings(value: { baseUrl: string; model: string; apiKey?: string }): Promise<{ persistedKey: boolean }>;
      chat(history: Message[]): Promise<string>;
      cancel(): Promise<void>;
      present(value: boolean): Promise<void>;
      on(name: string, callback: (value: never) => void): () => void;
    };
  }
}
