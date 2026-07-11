# AI & MCP Integration

Folio's AI layer is provider-agnostic and off by default. Nothing about a document leaves your machine until you explicitly enable a provider and supply a key. The default provider targets Claude (Anthropic) with a bring-your-own-key model, and the interface is designed so a local or third-party model can be dropped in without touching the rest of the app.

- AI layer: [`src/ai`](../src/ai)
- Providers: [`src/ai/providers`](../src/ai/providers)
- MCP (planned/experimental): [`src/ai/mcp`](../src/ai/mcp)

Three features ship on top of this layer: **Summarize** a document, **Ask** questions grounded in the document's extracted text, and **Extract** structured data to a JSON schema. All three run through Folio's command registry, so they behave exactly like any other command (keybinding, command palette, toolbar, or a plugin invoking them).

## The `AIProvider` interface

A provider is any object satisfying `AIProvider`. Summarize and Ask stream (they return `AsyncIterable<string>` so the UI can render tokens as they arrive); Extract resolves once with a validated result.

```ts
// src/ai/types.ts
interface AIProvider {
  id: string;
  name: string;
  summarize(doc: DocumentText, opts?: SummarizeOptions): AsyncIterable<string>;
  ask(question: string, context: DocumentText, opts?: AskOptions): AsyncIterable<string>;
  extract(schema: JSONSchema, context: DocumentText): Promise<unknown>;
}

interface DocumentText {
  documentId: string;
  title: string;
  pageCount: number;
  pages: { pageNumber: number; text: string }[];
  text: string;            // full document text, concatenated from the extracted text layer
}

interface SummarizeOptions {
  style?: 'abstract' | 'bullets' | 'executive';
  maxWords?: number;
  model?: string;          // override the provider default
  signal?: AbortSignal;    // cancel a long stream
}

interface AskOptions {
  history?: { role: 'user' | 'assistant'; content: string }[];
  model?: string;
  signal?: AbortSignal;
}
```

`DocumentText` is produced by Folio's core from the same PDF.js text layer that powers search and selection. The AI layer never sends the raw PDF bytes or the rendered page images to a provider; it sends extracted text (and, for structured extraction, the schema you define). See [Privacy](#privacy).

### Reference implementation: the Claude provider

The default provider lives in `src/ai/providers/anthropic.ts` and uses the official Anthropic TypeScript SDK (`@anthropic-ai/sdk`). It defaults to `claude-opus-4-8` and streams via the Messages API. Model ids are configurable and are read from the provider's settings, so specific model choices stay light here (see the [Anthropic models docs](https://docs.anthropic.com/en/docs/about-claude/models) for the current list).

```ts
// src/ai/providers/anthropic.ts
import Anthropic from '@anthropic-ai/sdk';
import type { AIProvider, DocumentText, SummarizeOptions, AskOptions, JSONSchema } from '../types';
import { secureStore } from '../secureStore';

const DEFAULT_MODEL = 'claude-opus-4-8';

const SUMMARY_SYSTEM =
  'You are a precise document summarizer. Summarize only what the document states. ' +
  'Do not add outside facts. If the document is ambiguous, say so.';

const ASK_SYSTEM =
  'Answer strictly from the provided document. If the answer is not in the document, ' +
  'say you cannot find it. Cite page numbers when possible.';

const EXTRACT_SYSTEM =
  'Extract structured data from the document. Use only values present in the text. ' +
  'Leave a field null if the document does not contain it.';

export class AnthropicProvider implements AIProvider {
  id = 'anthropic';
  name = 'Claude (Anthropic)';

  constructor(private defaultModel = DEFAULT_MODEL) {}

  // The key is read from the OS keychain via the Tauri backend, never hardcoded.
  private async client(): Promise<Anthropic> {
    const apiKey = await secureStore.getKey('anthropic');
    if (!apiKey) throw new AIProviderNotConfiguredError('anthropic');
    return new Anthropic({ apiKey });
  }

  async *summarize(doc: DocumentText, opts?: SummarizeOptions): AsyncIterable<string> {
    const client = await this.client();
    const stream = client.messages.stream(
      {
        model: opts?.model ?? this.defaultModel,
        max_tokens: 4096,
        thinking: { type: 'adaptive' },        // let Claude decide how much to reason
        system: SUMMARY_SYSTEM,
        messages: [
          {
            role: 'user',
            content: [
              // Cache the document body so follow-up requests on the same doc are cheap.
              { type: 'text', text: doc.text, cache_control: { type: 'ephemeral' } },
              { type: 'text', text: buildSummaryInstruction(opts) },
            ],
          },
        ],
      },
      { signal: opts?.signal },
    );

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield event.delta.text;
      }
    }
  }

  async *ask(question: string, context: DocumentText, opts?: AskOptions): AsyncIterable<string> {
    const client = await this.client();
    const stream = client.messages.stream(
      {
        model: opts?.model ?? this.defaultModel,
        max_tokens: 2048,
        system: ASK_SYSTEM,
        messages: [
          {
            role: 'user',
            content: [
              // The document is a stable prefix; caching it makes multi-turn chat inexpensive.
              { type: 'text', text: context.text, cache_control: { type: 'ephemeral' } },
            ],
          },
          ...(opts?.history ?? []),
          { role: 'user', content: question },
        ],
      },
      { signal: opts?.signal },
    );

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield event.delta.text;
      }
    }
  }

  async extract(schema: JSONSchema, context: DocumentText): Promise<unknown> {
    const client = await this.client();
    const res = await client.messages.create({
      model: this.defaultModel,
      max_tokens: 4096,
      system: EXTRACT_SYSTEM,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: context.text, cache_control: { type: 'ephemeral' } },
            { type: 'text', text: 'Extract the fields defined by the response schema.' },
          ],
        },
      ],
      // Structured outputs constrain the response to valid JSON matching the schema.
      output_config: { format: { type: 'json_schema', schema } },
    });

    const block = res.content.find((b) => b.type === 'text');
    if (!block || block.type !== 'text') throw new Error('No structured output returned');
    return JSON.parse(block.text);
  }
}
```

A few deliberate choices in this implementation:

- **Streaming.** Summarize and Ask use `client.messages.stream(...)` and yield text deltas, so the UI paints tokens as they arrive. Streaming also avoids request timeouts on long documents.
- **Prompt caching.** The document body is sent as a stable prefix with `cache_control: { type: 'ephemeral' }`. In a chat session, or when you run several extractions on the same document, the document tokens are served from cache instead of reprocessed, which cuts cost and latency substantially. Caching is ephemeral and provider-side; it is a performance detail, not additional data retention.
- **Structured outputs.** Extract uses `output_config.format` with your JSON schema, so the model is constrained to return schema-valid JSON rather than free text you then have to parse defensively.
- **Cancellation.** Every streaming call threads an `AbortSignal`, so the UI's Stop button actually stops the request.

## Built-in AI features

### Summarize document

`ai.summarizeDocument` extracts the document text, calls `provider.summarize(...)`, and streams the result into a results panel. The user picks a style (abstract, bullets, executive) and an optional length cap.

### Ask (chat grounded in the document)

`ai.askDocument` opens a chat grounded in the active document's extracted text. Each question is answered from that text, with the system prompt instructing the model to answer only from the document and cite page numbers where possible. Because the document is sent as a cached prefix, follow-up questions are cheap. This is retrieval-free for typical documents (the whole text fits in context); very large documents fall back to page-range selection driven by search hits.

### Extract structured data

`ai.extractData` takes a JSON schema you define (invoice fields, contract parties, table rows) and returns schema-valid JSON via `provider.extract(...)`. Because it uses structured outputs, the result is guaranteed to match the shape you asked for, ready to hand to the rest of the app or export.

```ts
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

const data = await commandRegistry.execute('ai.extractData', { schema: invoiceSchema });
```

## How AI features dispatch through the command registry

AI actions are not special. They are commands, registered by the AI module at startup, and they inherit everything commands get: keybindings, the command palette, toolbar buttons, and invocation by plugins. Their `when` predicate keeps them disabled until a provider is configured and a document is open, so the UI never offers an AI action that cannot run.

```ts
// src/ai/commands.ts
import { commandRegistry } from '@folio/commands';
import { providerRegistry } from './registry';
import { toDocumentText } from './extract';

export function registerAICommands(): void {
  const canRun = (ctx) => providerRegistry.getActive() !== null && ctx.getActiveDocument() !== null;

  commandRegistry.register({
    id: 'ai.summarizeDocument',
    title: 'AI: Summarize Document',
    category: 'AI',
    keybinding: 'Ctrl+Alt+S',
    when: canRun,
    run: async (ctx) => {
      const provider = providerRegistry.getActive()!;
      const doc = await toDocumentText(ctx.getActiveDocument()!);
      openResultsPanel(provider.summarize(doc, { style: 'bullets' })); // consumes the stream
    },
  });

  commandRegistry.register({
    id: 'ai.askDocument',
    title: 'AI: Ask About This Document',
    category: 'AI',
    keybinding: 'Ctrl+Alt+A',
    when: canRun,
    run: (ctx) => openChatPanel(ctx.getActiveDocument()!),
  });

  commandRegistry.register({
    id: 'ai.extractData',
    title: 'AI: Extract Structured Data',
    category: 'AI',
    when: canRun,
    run: async (ctx) => {
      const provider = providerRegistry.getActive()!;
      const doc = await toDocumentText(ctx.getActiveDocument()!);
      const schema = ctx.args?.schema ?? (await pickSchema());
      return provider.extract(schema, doc);
    },
  });
}
```

The payoff: a plugin can offer its own "Summarize selection" button simply by calling `commandRegistry.execute('ai.summarizeDocument', ...)`, and a user can rebind any AI action from the keybindings settings, with no AI-specific plumbing.

## Provider configuration

Providers register themselves with the `providerRegistry`. The active provider and model are stored in Folio's settings; the API key is stored separately in the OS keychain and never in plain settings.

```ts
// src/ai/registry.ts
interface AIProviderRegistry {
  register(provider: AIProvider): Disposable;
  get(id: string): AIProvider | undefined;
  list(): AIProvider[];
  getActive(): AIProvider | null;
  setActive(id: string): void;
}
```

### Claude (Anthropic), the default

Anthropic is the default and only preconfigured provider. It is inert until you provide a key. To enable it, paste an Anthropic API key into Settings > AI; Folio writes it to the OS keychain and marks the provider active.

### Where keys are stored: the Tauri secure store

Keys are never written to the settings file, logs, or the webview's local storage. They go into the operating system's credential store through a Tauri command backed by the Rust `keyring` crate: Keychain on macOS, the Secret Service (libsecret) on Linux, and the Windows Credential Manager on Windows.

```ts
// src/ai/secureStore.ts: thin wrapper over Tauri commands backed by the OS keychain.
import { invoke } from '@tauri-apps/api/core';

export const secureStore = {
  getKey: (providerId: string) => invoke<string | null>('ai_get_key', { providerId }),
  setKey: (providerId: string, key: string) => invoke<void>('ai_set_key', { providerId, key }),
  deleteKey: (providerId: string) => invoke<void>('ai_delete_key', { providerId }),
};
```

```rust
// src-tauri/src/ai_keys.rs
use keyring::Entry;

const SERVICE: &str = "com.folio.app";

#[tauri::command]
fn ai_set_key(provider_id: String, key: String) -> Result<(), String> {
    Entry::new(SERVICE, &provider_id)
        .and_then(|e| e.set_password(&key))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn ai_get_key(provider_id: String) -> Result<Option<String>, String> {
    match Entry::new(SERVICE, &provider_id).and_then(|e| e.get_password()) {
        Ok(k) => Ok(Some(k)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}
```

### Adding another provider

Implement `AIProvider` and register it. Nothing else in the app needs to change; the AI commands resolve the active provider at dispatch time. A local model served over HTTP (Ollama, LM Studio, llama.cpp) is a natural fit and keeps everything on-device.

```ts
// src/ai/providers/local.ts
import type { AIProvider, DocumentText, SummarizeOptions, JSONSchema } from '../types';

// Talks to a local model server; no key, no network egress off the machine.
export class LocalProvider implements AIProvider {
  id = 'local';
  name = 'Local model';

  constructor(private endpoint = 'http://127.0.0.1:11434') {}

  async *summarize(doc: DocumentText, opts?: SummarizeOptions): AsyncIterable<string> {
    const res = await fetch(`${this.endpoint}/api/generate`, {
      method: 'POST',
      body: JSON.stringify({ model: opts?.model ?? 'llama3', prompt: buildSummaryPrompt(doc, opts), stream: true }),
      signal: opts?.signal,
    });
    yield* streamNdjsonTokens(res); // adapt the local server's stream to string chunks
  }

  async *ask(/* ... */): AsyncIterable<string> {
    /* same shape as summarize */
  }

  async extract(schema: JSONSchema, context: DocumentText): Promise<unknown> {
    /* prompt the local model with the schema, parse and validate the JSON */
    return {};
  }
}

// Register it at startup:
// providerRegistry.register(new LocalProvider());
```

Because the interface is the only contract, a local provider gets Summarize, Ask, and Extract, plus command dispatch, keybindings, and the results UI, for free.

## Privacy

Privacy is a design constraint, not a setting you have to find.

- **Opt-in.** No AI provider is active until you enable one and supply a key. With no active provider, the AI commands are disabled and no requests are ever made.
- **Local-first posture.** Folio is a desktop app. Your documents stay on your machine. The AI layer is the only component that can send anything off-device, and only when you turn it on.
- **What is sent, and when.** When you run an AI action against a cloud provider, Folio sends the extracted text of the active document (or the selected page range, for very large documents), plus your question or the schema you defined. It does not send the PDF file itself, rendered page images, your filesystem paths, or any telemetry. A request happens only in direct response to you invoking an AI action.
- **Keys stay in the OS keychain.** Provider keys live in the operating system credential store, never in settings files, logs, or the webview.
- **Prefer local when it matters.** For sensitive documents, register a local provider (above). Everything then stays on the machine, and the same three features work unchanged.

If you use the Anthropic provider, the document text is sent to Anthropic's Messages API over HTTPS to produce the response. Folio uses ephemeral prompt caching to reduce repeated cost within a session; that is a provider-side performance mechanism, not additional retention. Review Anthropic's data handling terms for what their API does with request data.

## MCP (Model Context Protocol)

> Status: **PLANNED / EXPERIMENTAL.** The interfaces and tool names below are a design target for `src/ai/mcp`, not shipping features. They may change. Nothing in this section is enabled by default.

[MCP](https://modelcontextprotocol.io) is an open protocol for connecting AI assistants to tools and data. Folio's MCP work has two independent directions.

### Direction 1: Folio as an MCP client

Let Folio's in-app assistant call external MCP tools that you have configured (a search index, a knowledge base, a ticketing system). When you Ask a question, the assistant could reach beyond the document to an MCP tool you trust, then ground its answer in both.

The planned shape mirrors the provider config: you register MCP servers, and the active provider is allowed to call their tools during Ask.

```ts
// PLANNED (src/ai/mcp/client.ts)
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

Proposed tool surface:

| Tool | Purpose | Sketch of inputs |
| --- | --- | --- |
| `open_document` | Open a PDF in Folio | `{ path: string }` |
| `search` | Full-text search the open document | `{ query: string, documentId?: string }` |
| `get_outline` | Return the document outline (bookmarks) | `{ documentId?: string }` |
| `extract_text` | Extract text for a page or range | `{ documentId?: string, pages?: string }` |
| `add_annotation` | Add a highlight, note, or shape | `{ page: number, type: string, rect: number[], text?: string }` |
| `get_page_image` | Render a page to an image | `{ page: number, scale?: number }` |

A user might wire this into Claude Desktop with a config like the following (illustrative, not final):

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

The external assistant then calls `open_document`, `search`, and `extract_text` to work with your PDFs, and `add_annotation` to write back, all through Folio's real rendering and annotation pipeline. Because this direction hands document control to an external process, it will ship gated behind an explicit opt-in with a clear permission surface, consistent with the privacy posture above.

## Related documentation

- [Plugin authoring](./plugins.md): the command registry that AI actions dispatch through, and how plugins can invoke them.
- [Roadmap](../ROADMAP.md): the v0.5 milestone tracks AI GA and MCP client/server GA.
