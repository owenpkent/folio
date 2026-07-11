import {
  AiNotConfiguredError,
  type AIProvider,
  type AiRequestOptions,
  type DocumentText,
} from '../types';

/**
 * Claude (Anthropic) provider.
 *
 * EXPERIMENTAL and off by default. It performs no network activity until the
 * user supplies an API key via {@link configure}. When enabled it calls the
 * Anthropic Messages API directly and streams the response.
 *
 * The API key is held in memory only in this scaffold. Persisting it belongs in
 * the OS keychain via a Tauri command; see docs/ai.md (Provider configuration).
 */
export class ClaudeProvider implements AIProvider {
  readonly id = 'claude';
  readonly name = 'Claude';

  private apiKey: string | null = null;
  private model = 'claude-opus-4-8';
  private readonly baseUrl = 'https://api.anthropic.com';
  private readonly maxContextChars = 120_000;

  configure(options: { apiKey: string; model?: string }): void {
    this.apiKey = options.apiKey;
    if (options.model) this.model = options.model;
  }

  isConfigured(): boolean {
    return this.apiKey !== null;
  }

  async *summarize(doc: DocumentText, opts?: AiRequestOptions): AsyncIterable<string> {
    const prompt =
      `Document: ${doc.name}\n\n${this.truncate(doc.fullText)}\n\n` +
      'Write a clear, well-structured summary of this document.';
    yield* this.stream(
      'You are a precise assistant that summarizes documents faithfully, without inventing facts.',
      prompt,
      opts?.signal,
    );
  }

  async *ask(
    question: string,
    context: DocumentText,
    opts?: AiRequestOptions,
  ): AsyncIterable<string> {
    const prompt =
      `Here is the document "${context.name}":\n\n${this.truncate(context.fullText)}\n\n` +
      `Question: ${question}\n\nAnswer using only the document. If the answer is not present, say so.`;
    yield* this.stream(
      'You answer questions strictly grounded in the provided document.',
      prompt,
      opts?.signal,
    );
  }

  async extract(schema: object, context: DocumentText, opts?: AiRequestOptions): Promise<unknown> {
    let raw = '';
    const prompt =
      `${this.truncate(context.fullText)}\n\n` +
      `Extract data from the document above that matches this JSON schema and reply with ONLY the JSON:\n` +
      JSON.stringify(schema);
    for await (const chunk of this.stream(
      'You extract structured data and output only valid JSON.',
      prompt,
      opts?.signal,
    )) {
      raw += chunk;
    }
    return JSON.parse(stripJsonFence(raw));
  }

  /** Stream text deltas from the Anthropic Messages API (SSE). */
  private async *stream(
    system: string,
    userText: string,
    signal?: AbortSignal,
  ): AsyncIterable<string> {
    if (!this.apiKey) throw new AiNotConfiguredError(this.name);

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        // Required for direct browser/webview calls to the Anthropic API.
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 2048,
        stream: true,
        system,
        messages: [{ role: 'user', content: userText }],
      }),
      signal,
    });

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Claude request failed (${response.status}). ${detail.slice(0, 300)}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const event = JSON.parse(data);
          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            yield event.delta.text as string;
          }
        } catch {
          /* ignore keep-alives and partial frames */
        }
      }
    }
  }

  private truncate(text: string): string {
    return text.length > this.maxContextChars
      ? `${text.slice(0, this.maxContextChars)}\n\n[document truncated]`
      : text;
  }
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : trimmed).trim();
}
