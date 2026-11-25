// Stall 5 — paid AI inference backed by a local Ollama instance.
import { config } from "../config.js";

export class InferenceError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly hint?: string,
  ) {
    super(message);
  }
}

const MAX_PROMPT_CHARS = 4_000;

export async function generate(prompt: unknown, system?: unknown) {
  if (typeof prompt !== "string" || !prompt.trim()) throw new InferenceError("Body must include a non-empty \"prompt\".", 400);
  if (prompt.length > MAX_PROMPT_CHARS) throw new InferenceError(`Prompt is longer than ${MAX_PROMPT_CHARS} characters.`, 400);

  const started = Date.now();
  let response: Response;
  try {
    response = await fetch(`${config.ollama.url}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.ollama.model,
        prompt,
        system: typeof system === "string" ? system : undefined,
        stream: false,
        options: { num_predict: 512 },
      }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new InferenceError(
      "AI backend is offline.",
      503,
      `Install Ollama (https://ollama.com), then run: ollama pull ${config.ollama.model}`,
    );
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const missingModel = response.status === 404;
    throw new InferenceError(
      missingModel ? `Model "${config.ollama.model}" is not installed.` : `AI backend error (${response.status}).`,
      503,
      missingModel ? `Run: ollama pull ${config.ollama.model}` : detail.slice(0, 200),
    );
  }

  const data = (await response.json()) as { model: string; response: string };
  return { model: data.model, response: data.response.trim(), durationMs: Date.now() - started };
}
