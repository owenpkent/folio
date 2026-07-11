# AI & MCP Integration

Folio's AI layer is provider-agnostic and off by default. Nothing about a document leaves your machine until you explicitly enable a provider and supply a key. The default provider targets Claude (Anthropic) with a bring-your-own-key model, and the interface is designed so a local or third-party model can be dropped in without touching the rest of the app.

- AI layer: [`src/ai`](../src/ai)
- Providers: [`src/ai/providers`](../src/ai/providers)
- MCP (planned/experimental): [`src/ai/mcp`](../src/ai/mcp)

Three capabilities are defined on the provider interface: **Summarize** a document, **Ask** questions grounded in the document's extracted text, and **Extract** structured data against a JSON schema. Summarize and Ask stream their output; Extract resolves once with a parsed result.

> **Status.** The provider and these three methods exist and work today (`ClaudeProvider`). The intended way to invoke them is through Folio's command registry (`ai.summarizeDocument`, `ai.askDocument`, `ai.extractData`), so they would behave like any other command (keybinding, command palette, toolbar, or a plugin invoking them). Those `ai.*` commands are **not registered yet**: see [How AI features dispatch through the command registry](#how-ai-features-dispatch-through-the-command-registry). Everything marked **Planned** below is a design target, not a shipping feature.

## The `AIProvider` interface

A provider is any object satisfying `AIProvider`. Summarize and Ask stream (they return `AsyncIterable<string>` so the UI can render tokens as they arrive); Extract resolves once with a parsed result.

```ts
// src/ai/types.ts
interface AIProvider {
  readonly id: string;
  readonly name: string;

  /** True once the provider has the credentials/config it needs to run. */
  isConfigured(): boolean;

  summarize(doc: DocumentText, opts?: AiRequestOptions): AsyncIterable<string>;
  ask(question: string, context: DocumentText, opts?: AiRequestOptions): AsyncIterable<string>;
  extract(schema: object, context: DocumentText, opts?: AiRequestOptions): Promise<unknown>;
}

interface PageText {
  pageNumber: number;
  text: string;
}

interface DocumentText {
  name: string;
  pages: PageText[];   // one entry per extracted page
  fullText: string;    // all pages joined, the concatenated text layer
}

interface AiRequestOptions {
  signal?: AbortSignal;   // cancel a long stream
}
```

The layer also exports an error type used when a provider is invoked without configuration:

```ts
// src/ai/types.ts
class AiNotConfiguredError extends Error {
  constructor(providerName: string); // "<name> is not configured. Add an API key in settings to enable AI features."
}
```

`AiRequestOptions` currently carries only `signal`. Richer per-call options (a summary style, a length cap, multi-turn chat history, or a per-call model override) are **planned** but are not part of the interface today; each provider decides its own prompting.

`DocumentText` is produced by `collectDocumentText()` in [`src/ai/documentText.ts`](../src/ai/documentText.ts), which reads the active document from the document store and pulls each page's text from the same PDF.js text layer that powers search and selection. The AI layer never sends the raw PDF bytes or the rendered page images to a provider; it sends extracted text (and, for structured extraction, the schema you define). `collectDocumentText` returns `null` when no document is open, and accepts an optional `maxPages` cap. See [Privacy](#privacy).

### Reference implementation: the Claude provider

The default provider is the `ClaudeProvider` class in [`src/ai/providers/ClaudeProvider.ts`](../src/ai/providers/ClaudeProvider.ts). It does **not** use the `@anthropic-ai/sdk`. Instead it calls the Anthropic Messages API directly with `fetch` and parses the Server-Sent Events (SSE) stream by hand, which keeps the dependency surface small and works inside the app's webview. It defaults to the `claude-opus-4-8` model (configurable), sends the direct-browser-access header the Anthropic API requires for calls from a browser/webview, and holds the API key in memory only.

```ts
// src/ai/providers/ClaudeProvider.ts
import {
  AiNotConfiguredError,
  type AIProvider,
  type AiRequestOptions,
  type DocumentText,
} from '../types';

export class ClaudeProvider implements AIProvider {
  readonly id = 'claude';
  readonly name = 'Claude';

  private apiKey: string | null = null;
  private model = 'claude-opus-4-8';
  private readonly baseUrl = 'https://api.anthropic.com';
  private readonly maxContextChars = 120_000;

  // The key is held in memory only. Persisting it in the OS keychain via a
  // Tauri command is planned (see "Provider configuration").
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

  async *ask(question: string, context: DocumentText, opts?: AiRequestOptions): AsyncIterable<string> {
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
      'Extract data from the document above that matches this JSON schema and reply with ONLY the JSON:\n' +
      JSON.stringify(schema);
    for await (const chunk of this.stream(
      'You extract structured data and output only valid JSON.',
      prompt,
      opts?.signal,
    )) {
      raw += chunk;
    }
    return JSON.parse(stripJsonFence(raw)); // best-effort: parse the model's JSON reply
  }

  /** Stream text deltas from the Anthropic Messages API (SSE). */
  private async *stream(system: string, userText: string, signal?: AbortSignal): AsyncIterable<string> {
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

    // Read the SSE body and yield each content_block_delta / text_delta chunk.
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
```

A few notes on what this implementation actually does:

- **Streaming.** `summarize` and `ask` are async generators over the Messages API SSE stream. They yield each `text_delta` as it arrives (`content_block_delta` events), so the UI can paint tokens live and long documents avoid request timeouts.
- **Direct webview access.** The `anthropic-dangerous-direct-browser-access: 'true'` header lets the app call the Anthropic API directly from the webview. The API version is pinned via `anthropic-version: 2023-06-01`, and each request currently caps output at `max_tokens: 2048`.
- **Context truncation.** Very large documents are truncated at `maxContextChars` (120,000 characters) with a `[document truncated]` marker before being sent. There is no retrieval/page-range selection yet.
- **Structured extraction (current form).** `extract` does not use the Anthropic structured-output beta. It prompts the model to reply with JSON only, accumulates the stream, strips any Markdown code fence, and `JSON.parse`s the result, returning `unknown`. This is best-effort: the shape is not guaranteed by the API, so callers should validate the parsed value.
- **Cancellation.** Every streaming call threads an `AbortSignal` (`opts?.signal`) into `fetch`, so a UI Stop button can abort an in-flight request.
- **Not-configured guard.** If no key has been supplied, `stream()` throws `AiNotConfiguredError` before any network call is made.

> **Planned: a more robust provider.** A future iteration could adopt the official Anthropic TypeScript SDK (`@anthropic-ai/sdk`) and its higher-level features: constrained structured outputs (`output_config.format` with a JSON schema) so `extract` returns schema-valid JSON rather than free text that is parsed defensively; `cache_control: { type: 'ephemeral' }` on the document body so follow-up requests on the same document are cheaper; and adaptive thinking (`thinking: { type: 'adaptive' }`) for harder analysis. None of these are wired up today; the shipping provider is the plain `fetch` + SSE implementation above.

## Built-in AI features

These describe the three provider capabilities and the command ids intended to expose them. The `ai.*` commands are **planned** and not yet registered (see the next section); today the capabilities are reachable by calling the provider directly (for example `claudeProvider.summarize(doc)`).

### Summarize document

`provider.summarize(doc)` extracts the document text and streams a plain-language summary. The intended command id is `ai.summarizeDocument`, which would stream the result into a results panel. (Style and length options are **planned**; the current provider takes none.)

### Ask (grounded in the document)

`provider.ask(question, doc)` answers a question using only the document's extracted text, with a system prompt that instructs the model to say so when the answer is not present. The intended command id is `ai.askDocument`. Multi-turn chat history and page-range selection for very large documents are **planned**; today each call sends the (possibly truncated) full text and a single question.

### Extract structured data

`provider.extract(schema, doc)` takes a plain JSON-schema object you define (invoice fields, contract parties, table rows) and returns the model's parsed JSON reply as `unknown`. The intended command id is `ai.extractData`.

```ts
import { claudeProvider, collectDocumentText } from '@/ai';

const invoiceSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    invoiceNumber: { type: 'string' },
    date: { type: 'string', format: 'date' },
    total: { type: 'number' },
    lineItems: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          description: { type: 'string' },
          amount: { type: 'number' },
        },
        required: ['description', 'amount'],
      },
    },
  },
  required: ['invoiceNumber', 'date', 'total', 'lineItems'],
} as const;

const doc = await collectDocumentText();
if (doc) {
  const data = await claudeProvider.extract(invoiceSchema, doc); // returns unknown; validate before use
}
```

Because the current provider prompts for JSON rather than using constrained structured outputs, the returned value is not guaranteed to match the schema; validate it before handing it to the rest of the app. Schema-guaranteed output is a **planned** improvement (see the provider note above).

## How AI features dispatch through the command registry

> **Status: PLANNED.** The command registry itself is real: [`src/commands/defaultCommands.ts`](../src/commands/defaultCommands.ts) registers the File, View, Navigate, Search, and Appearance commands. No `ai.*` commands are registered there yet. The design below is the intended integration, not shipping code.

AI actions are not meant to be special. The plan is to register them as commands so they inherit everything commands get: keybindings, the command palette, toolbar buttons, and invocation by plugins. A `when` predicate would keep them disabled until AI is enabled, a provider is configured, and a document is open, so the UI never offers an AI action that cannot run.

The registration would build on the real exports of the AI layer (`getProvider`, `useAiStore`, `collectDocumentText`) and the command registry:

```ts
// PLANNED: not present in src/commands/defaultCommands.ts yet
import { commandRegistry } from '@/commands/registry';
import { collectDocumentText, getProvider, useAiStore } from '@/ai';
import { useDocumentStore } from '@/state/documentStore';

export function registerAiCommands(): void {
  const canRun = () => {
    const { enabled, providerId } = useAiStore.getState();
    const provider = getProvider(providerId);
    return enabled && provider?.isConfigured() === true
      && useDocumentStore.getState().status === 'ready';
  };

  commandRegistry.register({
    id: 'ai.summarizeDocument',
    title: 'AI: Summarize document',
    category: 'AI',
    when: canRun,
    run: async () => {
      const provider = getProvider(useAiStore.getState().providerId)!;
      const doc = await collectDocumentText();
      if (doc) openResultsPanel(provider.summarize(doc)); // consumes the stream
    },
  });

  commandRegistry.register({
    id: 'ai.askDocument',
    title: 'AI: Ask about this document',
    category: 'AI',
    when: canRun,
    run: () => openChatPanel(),
  });

  commandRegistry.register({
    id: 'ai.extractData',
    title: 'AI: Extract structured data',
    category: 'AI',
    when: canRun,
    run: async () => {
      const provider = getProvider(useAiStore.getState().providerId)!;
      const doc = await collectDocumentText();
      if (doc) return provider.extract(await pickSchema(), doc);
    },
  });
}
```

The payoff, once this lands: a plugin could offer its own "Summarize selection" button simply by calling `commandRegistry.execute('ai.summarizeDocument')`, and a user could rebind any AI action from the keybindings settings, with no AI-specific plumbing.

## Provider configuration

Providers are registered in a small in-module registry in [`src/ai/providers/index.ts`](../src/ai/providers/index.ts). The active provider id and the global on/off flag live in the `useAiStore` Zustand store; the provider's API key lives on the provider instance itself.

```ts
// src/ai/providers/index.ts
export const claudeProvider: ClaudeProvider;

export function getProvider(id: string): AIProvider | undefined;
export function listProviders(): AIProvider[];
export function registerProvider(provider: AIProvider): void; // register an extra provider (e.g. a local model)
```

```ts
// src/ai/aiStore.ts: enabled defaults to false (opt-in); providerId defaults to 'claude'
interface AiState {
  enabled: boolean;
  providerId: string;
  setEnabled(enabled: boolean): void;
  setProviderId(id: string): void;
}
```

### Claude (Anthropic), the default

`claudeProvider` (id `'claude'`, name `'Claude'`) is preregistered and is the default. It is inert until you call `configure({ apiKey })`, which stores the key in memory on the provider instance; an optional `model` overrides the `claude-opus-4-8` default. `isConfigured()` returns `true` once a key is present. With no key, invoking the provider throws `AiNotConfiguredError`.

### Where keys are stored today, and where they are headed

**Today:** the API key is held **in memory only**, on the `ClaudeProvider` instance, set via `configure(...)`. It is not persisted anywhere; it is lost when the app restarts, and you re-enter it to re-enable AI.

> **Planned: the Tauri secure store.** Keys should never be written to the settings file, logs, or the webview's local storage. The plan is to store them in the operating system's credential store through a Tauri command backed by the Rust `keyring` crate: Keychain on macOS, the Secret Service (libsecret) on Linux, and the Windows Credential Manager on Windows. None of the code below exists yet; it describes the intended design.
>
> ```ts
> // PLANNED (src/ai/secureStore.ts): thin wrapper over Tauri commands backed by the OS keychain.
> import { invoke } from '@tauri-apps/api/core';
>
> export const secureStore = {
>   getKey: (providerId: string) => invoke<string | null>('ai_get_key', { providerId }),
>   setKey: (providerId: string, key: string) => invoke<void>('ai_set_key', { providerId, key }),
>   deleteKey: (providerId: string) => invoke<void>('ai_delete_key', { providerId }),
> };
> ```
>
> ```rust
> // PLANNED: src-tauri/src/ai_keys.rs
> use keyring::Entry;
>
> const SERVICE: &str = "com.folio.app";
>
> #[tauri::command]
> fn ai_set_key(provider_id: String, key: String) -> Result<(), String> {
>     Entry::new(SERVICE, &provider_id)
>         .and_then(|e| e.set_password(&key))
>         .map_err(|e| e.to_string())
> }
>
> #[tauri::command]
> fn ai_get_key(provider_id: String) -> Result<Option<String>, String> {
>     match Entry::new(SERVICE, &provider_id).and_then(|e| e.get_password()) {
>         Ok(k) => Ok(Some(k)),
>         Err(keyring::Error::NoEntry) => Ok(None),
>         Err(e) => Err(e.to_string()),
>     }
> }
> ```

### Adding another provider

Implement `AIProvider` and register it with `registerProvider(...)`. Nothing else in the app needs to change; consumers resolve the provider by id. A local model served over HTTP (Ollama, LM Studio, llama.cpp) is a natural fit and keeps everything on-device.

```ts
// src/ai/providers/local.ts (illustrative)
import type { AIProvider, AiRequestOptions, DocumentText } from '../types';
import { registerProvider } from './index';

// Talks to a local model server; no key, no network egress off the machine.
export class LocalProvider implements AIProvider {
  readonly id = 'local';
  readonly name = 'Local model';

  constructor(private endpoint = 'http://127.0.0.1:11434') {}

  isConfigured(): boolean {
    return true; // no API key required for a local server
  }

  async *summarize(doc: DocumentText, opts?: AiRequestOptions): AsyncIterable<string> {
    const res = await fetch(`${this.endpoint}/api/generate`, {
      method: 'POST',
      body: JSON.stringify({ model: 'llama3', prompt: buildSummaryPrompt(doc), stream: true }),
      signal: opts?.signal,
    });
    yield* streamNdjsonTokens(res); // adapt the local server's stream to string chunks
  }

  async *ask(/* question, context, opts */): AsyncIterable<string> {
    /* same shape as summarize */
  }

  async extract(schema: object, context: DocumentText, opts?: AiRequestOptions): Promise<unknown> {
    /* prompt the local model with the schema, parse and validate the JSON */
    return {};
  }
}

// Register it at startup:
// registerProvider(new LocalProvider());
```

Because the interface is the only contract, a local provider gets Summarize, Ask, and Extract, plus (once the `ai.*` commands land) command dispatch, keybindings, and the results UI, for free.

## Privacy

Privacy is a design constraint, not a setting you have to find.

- **Opt-in.** `useAiStore.enabled` defaults to `false`. Nothing is sent to any provider until you turn AI on and configure a key. With AI off or no key configured, no requests are ever made.
- **Local-first posture.** Folio is a desktop app. Your documents stay on your machine. The AI layer is the only component that can send anything off-device, and only when you turn it on.
- **What is sent, and when.** When you run an AI action against a cloud provider, Folio sends the extracted text of the active document (truncated for very large documents), plus your question or the schema you defined. It does not send the PDF file itself, rendered page images, your filesystem paths, or any telemetry. A request happens only in direct response to you invoking an AI action.
- **Keys.** Today the provider key is held **in memory only** and never written to disk (it is lost on restart). Moving keys into the OS credential store is **planned** (see [Provider configuration](#where-keys-are-stored-today-and-where-they-are-headed)).
- **Prefer local when it matters.** For sensitive documents, register a local provider (above). Everything then stays on the machine, and the same three capabilities work unchanged.

If you use the Claude provider, the document text is sent to Anthropic's Messages API over HTTPS to produce the response. Review Anthropic's data-handling terms for what their API does with request data.

## MCP (Model Context Protocol)

> Status: **PLANNED / EXPERIMENTAL.** Both the client and the server in [`src/ai/mcp`](../src/ai/mcp) are stubs: their methods throw "not implemented yet". The interfaces and tool names below are a design target so features and docs can be built against them. They may change. Nothing here is enabled.

[MCP](https://modelcontextprotocol.io) is an open protocol for connecting AI assistants to tools and data. Folio's MCP work has two independent directions.

### Direction 1: Folio as an MCP client

Let Folio's in-app assistant call external MCP tools that you have configured (a search index, a knowledge base, a ticketing system). When you Ask a question, the assistant could reach beyond the document to an MCP tool you trust, then ground its answer in both.

The current stub in [`src/ai/mcp/McpClient.ts`](../src/ai/mcp/McpClient.ts) declares the shape; the transport is not implemented (`listTools` and `callTool` throw):

```ts
// src/ai/mcp/McpClient.ts (stub: methods throw "not implemented yet")
interface McpTool {
  name: string;
  description: string;
  inputSchema: object;
}

interface McpClientOptions {
  /** Server command/URL to connect to (stdio or HTTP transport). */
  endpoint: string;
}

class McpClient {
  constructor(options: McpClientOptions);
  listTools(): Promise<McpTool[]>;                                   // throws today
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>; // throws today
}
```

The eventual config would mirror the provider setup: you register MCP servers, and the active provider is allowed to call their tools during Ask.

```ts
// PLANNED: richer server config than the current McpClientOptions
interface McpServerConfig {
  id: string;
  name: string;
  transport: { type: 'stdio'; command: string; args: string[] }
           | { type: 'http'; url: string };
  enabled: boolean;
}
```

As with everything in the AI layer, this would be opt-in and off by default, and MCP tool calls would be surfaced to you rather than run silently.

### Direction 2: Folio as an MCP server

Expose Folio itself as an MCP server so an external assistant (Claude Desktop, Claude Code, or any MCP-capable client) can drive it: open a document, search it, read its outline, extract text, add an annotation, or grab a rendered page image. This turns Folio into a tool the assistant can operate on your behalf.

The tool surface is declared in [`src/ai/mcp/McpServer.ts`](../src/ai/mcp/McpServer.ts) as `FOLIO_MCP_TOOLS`; `startMcpServer()` throws "not implemented yet". The declared tools are:

| Tool | Purpose (from `FOLIO_MCP_TOOLS`) |
| --- | --- |
| `open_document` | Open a PDF by path or URL. |
| `search` | Search the active document for text. |
| `get_outline` | Return the document outline / bookmarks. |
| `extract_text` | Extract text from a page or page range. |
| `add_annotation` | Add a highlight or note to a page. |
| `get_page_image` | Render a page to a PNG image. |

A user might eventually wire this into Claude Desktop with a config like the following (illustrative, not final):

```json
{
  "mcpServers": {
    "folio": {
      "command": "folio",
      "args": ["--mcp-server"]
    }
  }
}
```

The external assistant would then call `open_document`, `search`, and `extract_text` to work with your PDFs, and `add_annotation` to write back, all through Folio's real rendering and annotation pipeline. Because this direction hands document control to an external process, it would ship gated behind an explicit opt-in with a clear permission surface, consistent with the privacy posture above.

## Related documentation

- [Plugin authoring](./plugins.md): the command registry that AI actions would dispatch through, and how plugins can invoke them.
- [Roadmap](../ROADMAP.md): the v0.5 milestone tracks AI GA and MCP client/server GA.
