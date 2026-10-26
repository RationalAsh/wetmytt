import { DEFAULT_MAX_TURNS, inferProvider, normalizeMaxTurns, normalizeSettings } from '../shared/ai.js';

export function createAISettings({ safeStorage, write }) {
  let settings = { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: '', apiKey: '', maxTurns: DEFAULT_MAX_TURNS };
  let encryptedKey = null, unlocking, saving = Promise.resolve();
  // Serialize writes so overlapping preference/connection saves cannot lose keys.
  const save = operation => {
    const result = saving.then(operation);
    saving = result.catch(() => {});
    return result;
  };
  async function persist(next, preserveKey) {
    let cipher = preserveKey ? encryptedKey : null;
    let persistedKey = !next.apiKey || Boolean(cipher);
    if (next.apiKey && !preserveKey) {
      persistedKey = await safeStorage.isAsyncEncryptionAvailable();
      if (persistedKey) cipher = (await safeStorage.encryptStringAsync(next.apiKey)).toString('base64');
    }
    await write({ provider: next.provider, baseUrl: next.baseUrl, model: next.model, maxTurns: next.maxTurns, encryptedKey: cipher });
    settings = next;
    encryptedKey = cipher;
    return { persistedKey };
  }
  return {
    load(saved) {
      settings.maxTurns = normalizeMaxTurns(saved.maxTurns);
      const next = normalizeSettings({ provider: saved.provider ?? inferProvider(saved.baseUrl), baseUrl: saved.baseUrl, model: saved.model, apiKey: '', maxTurns: settings.maxTurns }, {}, { requireKey: false });
      settings = next;
      encryptedKey = typeof saved.encryptedKey === 'string' && saved.encryptedKey ? saved.encryptedKey : null;
    },
    state: () => ({ provider: settings.provider, baseUrl: settings.baseUrl, model: settings.model, maxTurns: settings.maxTurns, hasKey: Boolean(settings.apiKey || encryptedKey) }),
    // Metadata lookups can use an already unlocked key, but never open Keychain.
    context: () => ({ ...settings }),
    async connection() {
      const current = settings;
      if (!current.apiKey && encryptedKey) {
        if (!unlocking) {
          const cipher = encryptedKey;
          unlocking = Promise.resolve().then(async () => {
            try {
              if (!await safeStorage.isAsyncEncryptionAvailable()) throw new Error('Keychain unavailable');
              const { result } = await safeStorage.decryptStringAsync(Buffer.from(cipher, 'base64'));
              if (typeof result !== 'string' || !result.trim()) throw new Error('Empty API key');
              return result;
            } catch {
              throw new Error('Could not unlock your saved API key. Allow Keychain access and try again, or enter the key again in Settings.');
            }
          }).finally(() => { unlocking = undefined; });
        }
        const apiKey = await unlocking;
        if (settings !== current) throw new Error('AI settings changed while unlocking the API key. Please try again.');
        current.apiKey = apiKey;
      }
      return normalizeSettings({ ...current });
    },
    savePreferences: value => save(() => persist({ ...settings, maxTurns: normalizeMaxTurns(value.maxTurns) }, true)),
    saveConnection: value => save(() => {
      const next = normalizeSettings(value, settings, { requireKey: false });
      const preserveKey = value.apiKey === undefined && next.provider === settings.provider && next.baseUrl === settings.baseUrl;
      // Validate a retained encrypted credential without decrypting it.
      normalizeSettings({ ...next, apiKey: next.apiKey || (preserveKey && encryptedKey ? 'saved-key' : '') }, {}, { requireKey: value.apiKey !== '' });
      return persist(next, preserveKey);
    }),
  };
}
