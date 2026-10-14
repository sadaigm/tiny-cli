# Image Processing via `@` Mentions — Design

Send images referenced with the `@` file-mention picker alongside the user query,
when the active model supports vision. The model client speaks the
OpenAI-compatible `/chat/completions` protocol, which supports image input
natively via a content-parts array — no protocol change needed, only plumbing.

---

## 1. Current Behavior

- Typing `@` opens the file picker; accepting inserts a `[@path]` token
  (`packages/cli/src/tui/components/input/usePickers.ts`).
- On submit, `hydrateMessage()` (`packages/cli/src/file-mention.ts`) reads each
  mentioned file as **utf-8 text** and prepends
  `<file path="...">…</file>` blocks to the message.
- `Message.content` is a plain `string` end-to-end
  (`packages/core/src/types.ts`) — an image mention today hydrates to garbage
  bytes.

```mermaid
flowchart LR
    A["User types @"] --> B["File picker"]
    B --> C["Draft contains [@path] token"]
    C --> D["Submit"]
    D --> E["hydrateMessage()"]
    E --> F{"Matches<br/>[@path] tokens?"}
    F -- no --> G["Message sent as-is"]
    F -- yes --> H["fs.readFile utf-8<br/>(binary = garbage)"]
    H --> I["Prepend file content blocks"]
    I --> J["content: string<br/>→ /chat/completions"]
```

---

## 2. Proposed Design

### 2.1 Types (`packages/core/src/types.ts`)

Keep `content: string`; add an optional attachments field on the user message:

```ts
interface ImageAttachment {
  path: string;      // workspace-relative, as mentioned
  mimeType: string;  // image/png | image/jpeg | image/gif | image/webp
  data: string;      // base64, no data-url prefix
}

// on the user message:
images?: ImageAttachment[];
```

Everything downstream that assumes string content keeps working.

### 2.2 Hydration split (`packages/cli/src/file-mention.ts`)

`hydrateMessage()` returns `{ text, images }` instead of a string:

- Mentions with image extensions (`.png .jpg .jpeg .gif .webp`) are read as
  base64 into `images`; their spot in the text becomes `[image: path]` so the
  model knows what it is looking at.
- Text files behave exactly as today.

### 2.3 Client transform (`packages/core/src/model/client.ts`)

One shared point in payload building. When `images` is present, the user
message becomes a content-parts array:

```ts
content: [
  { type: 'text', text: message.content },
  ...images.map(i => ({
    type: 'image_url',
    image_url: { url: `data:${i.mimeType};base64,${i.data}` },
  })),
]
```

Both the streamed and buffered paths share payload construction, so a single
transform covers both.

**Wire-format notes:**

- Always emit the **object form** (`{"url": ...}`). It is the official OpenAI
  spec, accepted by every vision-capable OpenAI-compatible server (Ollama,
  vLLM, LM Studio, llama.cpp, OpenRouter, …). A bare-string shorthand
  (`"image_url": "data:..."`) is tolerated by some servers but rejected by
  strictly-compliant ones.
- Always use **data URLs** (inline base64). Local servers (Ollama, llama.cpp,
  LM Studio) generally only accept data URLs; hosted ones also accept `https://`
  URLs, but tiny-cli reads local files, so data URLs work for both.

**Verified (2026-10-14):** against a local `mlx-vlm` server on
`localhost:8080` — object-form data-URL payload returned HTTP 200 and the
model correctly described the image contents (a 1×1 red pixel → `"Red"`),
with the image counted in `prompt_tokens`.

### 2.4 Capability gating

Per-profile `vision: true` flag in config. When an image is mentioned but the
flag is off, hydration skips it and injects
`[image @path skipped — model has no vision]` — explicit behavior instead of a
cryptic API error. Default: off.

### 2.5 Display

The TUI must never render base64:

- Log view shows a `📎 path` placeholder. The display/sent split already keeps
  the raw `[@path]` for display (`useAgent.ts`), images ride the same split.
- Session persistence stores **path only**; replay re-reads from disk. Missing
  file degrades to `[image missing]`. Keeps session files small.

### 2.6 Estimator (`logView/estimator.ts`)

Exclude base64 from char-based token estimates; count each image as a flat
~800–1500 tokens.

---

## 3. Flow Diagrams

### 3.1 End-to-end flow

```mermaid
flowchart TD
    A["User types @"] --> B["File picker<br/>(usePickers.ts)"]
    B --> C["Accept → draft gains [@path] token"]
    C --> D["Submit (useInputSubmit.ts)"]
    D --> E["hydrateMessage() splits mentions"]
    E --> F{"Mention is<br/>an image file?"}
    F -- "no (text)" --> G["utf-8 read →<br/>file content block"]
    F -- "yes (image)" --> H{"Profile has<br/>vision: true?"}
    H -- no --> I["Skip + inject<br/>[image @path skipped]"]
    H -- yes --> J{"Size ≤ 5 MB?"}
    J -- no --> I2["Skip + warn<br/>file too large"]
    J -- yes --> K["base64 read →<br/>ImageAttachment"]
    G --> L["text: string"]
    I --> L
    I2 --> L
    K --> M["images: ImageAttachment[]"]
    L --> N["User message<br/>{ content, images? }"]
    M --> N
    N --> O["Agent loop (agent.ts)<br/>passes message through"]
    O --> P["Model client payload build"]
    P --> Q{"images<br/>present?"}
    Q -- no --> R["content: string"]
    Q -- yes --> S["content: [ text part,<br/>image_url parts (data URL) ]"]
    R --> T["POST /chat/completions"]
    S --> T
```

### 3.2 Capability + hydration decision flow

```mermaid
flowchart TD
    A["[@path] mention"] --> B{"Extension in<br/>IMAGE_EXT set?"}
    B -- no --> C["Text path:<br/>utf-8 read,<br/>file content block"]
    B -- yes --> D{"vision flag<br/>on profile?"}
    D -- off --> E["Mark skipped<br/>note in text"]
    D -- on --> F{"stat size<br/>≤ 5 MB?"}
    F -- no --> G["Mark skipped<br/>warn: too large"]
    F -- yes --> H{"read ok?"}
    H -- no --> I["Mark missing<br/>warn: unreadable"]
    H -- yes --> J["mime from extension<br/>base64 encode"]
    J --> K["Push ImageAttachment<br/>text keeps [image: path]"]
```

### 3.3 Request payload sequence

```mermaid
sequenceDiagram
    participant U as User (TUI)
    participant H as hydrateMessage
    participant A as Agent loop
    participant C as Model client
    participant API as /chat/completions

    U->>H: submit "query [@a.png] [@notes.md]"
    H->>H: split mentions by type
    H-->>A: { text, images: [a.png] }
    Note over H: display string keeps [@a.png]<br/>for the log view
    A->>C: Message { content: text, images }
    C->>C: images present → build parts array
    C->>API: content: [ text, image_url(data URL a.png) ]
    API-->>C: SSE / buffered response
    C-->>A: { content, toolCalls }
    A-->>U: render response (no base64)
```

### 3.4 Session persistence and replay

```mermaid
flowchart TD
    A["Turn completes"] --> B["Serialize session"]
    B --> C{"Message has<br/>images?"}
    C -- no --> D["Store as today"]
    C -- yes --> E["Store content text +<br/>image PATHS only"]
    E --> F["Session file stays small"]
    F --> G["Later: reload / replay"]
    G --> H{"For each stored<br/>image path"}
    H --> I{"File exists<br/>on disk?"}
    I -- yes --> J["Re-read → base64 →<br/>rebuild ImageAttachment"]
    I -- no --> K["Degrade:<br/>[image missing] in text"]
    J --> L["History replays with<br/>real image parts"]
    K --> L
```

---

## 4. Files Touched

| File | Change |
| --- | --- |
| `packages/core/src/types.ts` | `ImageAttachment`, optional `images` on user message |
| `packages/cli/src/file-mention.ts` | `hydrateMessage` → `{ text, images }`, image ext set, size cap, vision gating |
| `packages/cli/src/config.ts` | per-profile `vision` flag (default off) |
| `packages/core/src/model/client.ts` | payload transform to content-parts array |
| `packages/cli/src/tui/hooks/useAgent.ts` | thread `{ text, images }` into agent call |
| TUI log view | `📎 path` placeholder, never base64 |
| `logView/estimator.ts` | flat per-image token count |
| Session persistence | store paths only, re-hydrate on replay |

## 5. Testing Plan

- `file-mention`: unit tests — image vs text vs unknown extension; vision off →
  skip note; oversize → skip; unreadable → degrade.
- `model/client`: payload shape with/without images (text-only stays a plain
  string — no behavior change for existing sessions).
- Replay: session with image paths reloads; missing file degrades gracefully.
- Manual: `@screenshot.png` round-trip against a vision-capable endpoint.

## 6. Decisions (settled 2026-10-14)

1. **Capability flag** — explicit `vision: true` per profile (approved);
   default off. No auto-detection from model names, no send-and-see.
2. **Large images** — cap at ~5 MB with skip+warn.
3. **Estimate per image** — flat 800 tokens per attached image.
