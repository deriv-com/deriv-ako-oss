// Setup step: the optional AI provider for plain-language requests.

import { DEFAULT_AI_BASE_URL } from "../ai/provider.js";

const LIST_LIMIT = 40;

export async function setupAi(ctx) {
  const p = ctx.prompter;
  p.write("\n== AI (optional) ==\n");
  p.write("With an AI key, people can ask AKO in their own words. It only ever sees the typed request and project names.\n");
  if (!(await p.confirm("Use an AI provider?", Boolean(ctx.env.OPENAI_API_KEY)))) {
    p.write("  Skipped. Plain commands such as `npx ako release create web-app` still work.\n");
    return;
  }

  const current = ctx.env.OPENAI_BASE_URL || DEFAULT_AI_BASE_URL;
  const provider = await p.choose(
    "Which provider?",
    [
      { label: "OpenAI", value: "openai" },
      { label: "Another provider with an OpenAI-compatible API (LiteLLM, OpenRouter, Anthropic...)", value: "compatible" },
    ],
    { default: current === DEFAULT_AI_BASE_URL ? "openai" : "compatible" },
  );
  const baseUrl =
    provider === "openai"
      ? DEFAULT_AI_BASE_URL
      : (
          await p.ask("The provider's OpenAI-compatible base URL, usually ending in /v1", {
            default: current === DEFAULT_AI_BASE_URL ? undefined : current,
            validate: (v) => (/^https?:\/\/\S+$/.test(v) ? null : "That isn't a URL."),
          })
        ).replace(/\/+$/, "");

  let apiKey = ctx.env.OPENAI_API_KEY;
  let models = null;
  for (;;) {
    apiKey = await p.ask("API key", { secret: true, default: apiKey || undefined });
    try {
      models = await ctx.services.listModels({ apiKey, baseUrl }, { fetch: ctx.fetch });
      break;
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        p.write("  ✗ The provider refused that key.\n");
        apiKey = undefined;
        continue;
      }
      p.write(`  ! Couldn't list the provider's models (${error.message}), so type the model name.\n`);
      models = [];
      break;
    }
  }

  const fallback = ctx.env.AKO_AI_MODEL;
  const model =
    models.length && models.length <= LIST_LIMIT
      ? await p.choose("Which model?", models.map((m) => ({ label: m, value: m })), { default: fallback })
      : await p.ask("Model name", {
          default: fallback,
          validate: (v) => (models.length === 0 || models.includes(v) ? null : "The provider doesn't list that model."),
        });

  ctx.saveEnv(
    {
      OPENAI_API_KEY: apiKey,
      OPENAI_BASE_URL: baseUrl === DEFAULT_AI_BASE_URL ? null : baseUrl,
      AKO_AI_MODEL: model,
    },
    "AI provider (optional)",
  );
  p.write(`  Saved. AKO will use ${model}.\n`);
}
