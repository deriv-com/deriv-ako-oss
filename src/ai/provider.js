// The optional AI provider. AKO speaks the OpenAI API, so any provider with an
// OpenAI-compatible endpoint works by setting OPENAI_BASE_URL. Without a key,
// AKO still works through plain commands.

export const DEFAULT_AI_BASE_URL = "https://api.openai.com/v1";

export function aiSettings(env = process.env) {
  if (!env.OPENAI_API_KEY) return null;
  return {
    apiKey: env.OPENAI_API_KEY,
    baseUrl: (env.OPENAI_BASE_URL || DEFAULT_AI_BASE_URL).replace(/\/+$/, ""),
    model: env.AKO_AI_MODEL || null,
  };
}

/** Model IDs the provider lists. Throws when the request fails. */
export async function listModels(settings, { fetch = globalThis.fetch } = {}) {
  const response = await fetch(`${settings.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${settings.apiKey}` },
  });
  if (!response.ok) {
    const error = new Error(`the provider answered HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const data = await response.json().catch(() => ({}));
  return (data.data ?? []).map((m) => m.id).sort();
}

/**
 * Confirms the key works and, when the provider lists models, that the
 * model is one of them. Returns `{ ok, modelListed, detail }`.
 */
export async function checkAiProvider(settings, { fetch = globalThis.fetch } = {}) {
  if (!settings.model) return { ok: false, detail: "AKO_AI_MODEL is not set" };
  const response = await fetch(`${settings.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${settings.apiKey}` },
  });
  if (response.status === 401 || response.status === 403) {
    return { ok: false, detail: `the provider refused the key (HTTP ${response.status})` };
  }
  if (!response.ok) {
    // Some OpenAI-compatible providers don't serve /models; that is not fatal.
    return { ok: true, modelListed: null, detail: `couldn't list models (HTTP ${response.status}), so the model wasn't checked` };
  }
  const data = await response.json().catch(() => ({}));
  const ids = (data.data ?? []).map((m) => m.id);
  if (ids.length === 0) return { ok: true, modelListed: null, detail: "the provider lists no models, so the model wasn't checked" };
  const listed = ids.includes(settings.model);
  return {
    ok: true,
    modelListed: listed,
    detail: listed ? `model ${settings.model} is available` : `the provider doesn't list model "${settings.model}"`,
  };
}
