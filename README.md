# Welcome to My TED Talk

**Got a point? Make it.**

`wetmytt` for short. A playful nod to the familiar “welcome to my TED talk” sign-off, with its own violet-and-lime stage identity. An independent project, not affiliated with TED.

A minimal AI-first presentation app built with Electron, Next.js, and React. A presentation is an ordinary folder. There is no database, custom document format, or compilation step for slides.

## Run

Requires Node.js 22.12+ and npm.

```sh
npm install
npm run dev
```

This starts Next.js on `127.0.0.1:3210`, waits for it, then launches Electron. The Next.js shell has hot reload. To use the static production shell:

```sh
npm run build
npm start
```

`npm run dev:web` previews the UI in a browser; folder access and AI require Electron. `npm start` uses the existing `out/` build. Distribution installers and code signing are not configured yet.

## Make a deck

Click **New deck** and choose a new folder name, or **Open folder** for an existing deck with `index.html`. A new deck copies the editable starter:

```text
my-presentation/
  AGENTS.md      # guidance for agents editing the deck
  deck.json      # structured content
  index.html     # actual slide entry point
  slides.js      # JSON → slide HTML
  styles.css     # all deck styling
  assets/        # images and other local resources
```

`deck.json` contains a title and slides with `title`, `eyebrow`, `body`, optional `bullets`, optional `image` / `imageAlt`, and `layout` (`cover`, `split`, `closing`). HTML, CSS, rendering code, and content are all yours to change. Use relative asset URLs. No resources are fetched from the internet by the deck preview.

The app watches the complete deck folder for changes, including images and nested assets, and reloads while retaining the current slide where possible. Hidden files and `node_modules` are ignored. A temporarily invalid JSON file displays an error in the slide area; saving valid JSON recovers automatically.

With a project open, drag files anywhere onto the app (including the slide preview) to copy them into its `assets/` folder. Originals stay in place, and duplicate names get a numbered suffix instead of overwriting existing assets. Folders are not imported.

Use the visible arrows or **← / →** to navigate. **Present** enters full screen with the shell hidden; **Esc** exits. A hidden exit button also appears on hover at the top right. Hide or show the chat sidebar with the top-right panel button. Navigation keys do not interfere with typing in chat.

### Custom slide HTML

Mark each slide container with `data-slide`, keep a closing `</body>` tag, and respect `[hidden] { display: none !important; }`. Welcome to My TED Talk injects a small bridge that counts those containers, hides inactive slides, and communicates navigation with the shell. It does not prescribe the HTML structure inside a slide. The default renderer reads JSON, but custom HTML can use any local rendering approach.

## AI: bring your own key

Open **AI settings** and enter an OpenAI-compatible API base URL (including `/v1` if your provider requires it), a model ID, and an API key. The model must support Chat Completions function calling. HTTPS is required except for loopback endpoints, which support local models without a key.

The built-in agent can list, read, and write text files in the open deck. A request grants it permission to edit that folder. Changes are applied directly and auto-reloaded; there is no undo or review workflow yet. Use version control for work you want to preserve. Image generation and binary uploads by the agent are outside this first pass; agents can reference dropped assets or write SVG.

Keys stay in Electron's main process and are encrypted at rest using Electron `safeStorage`. If OS encryption is unavailable, the key is kept in memory only. Provider settings are stored in Electron's user-data directory, never in the deck. Chat is in memory and resets when you switch decks. The model receives your chat and any deck files it reads through tools. Stop cancels the running request; completed writes remain. Each request is limited to 16 model turns and three minutes.

## External agents and MCP

Hide chat and run your agent directly:

```sh
cd /path/to/my-presentation
codex
```

Welcome to My TED Talk does not need to launch or supervise the agent. Changes from any editor or agent appear automatically.

For an MCP-capable client, this repo also provides a stdio MCP server exposing `list_files`, `read_file`, and `write_file`, scoped to one deck. Configure your client to execute Node with absolute paths:

```json
{
  "mcpServers": {
    "wetmytt": {
      "command": "node",
      "args": ["/absolute/path/to/wetmytt/electron/mcp.js", "/absolute/path/to/my-presentation"]
    }
  }
}
```

Or run `npm run mcp -- /absolute/path/to/my-presentation`. This app exposes an MCP server for external agents; it does not run an embedded MCP client. No listener or API key is required for MCP.

## Architecture and checks

- `app/`: Next.js App Router interface, exported as static HTML for production.
- `electron/main.js` and `preload.cjs`: native dialogs, watcher, isolated IPC, settings, and agent orchestration.
- `electron/server.js`: loopback HTTP serving; decks have separate origins and random URL prefixes, with local-only CSP.
- `electron/bridge.js`: injected deck navigation protocol.
- `electron/files.js`: shared folder-scoped file tools, with traversal and symlink checks.
- `electron/agent.js` and `mcp.js`: BYOK tool loop and stdio MCP server.

```sh
npm test
npm run typecheck
npm run build
```

The preview is sandboxed without Node integration, and IPC validates that calls come from the main application frame. File tools reject hidden paths and paths or symlinks outside the deck. This is a local desktop prototype; avoid opening untrusted folders or allowing concurrent untrusted processes to replace symlinks during writes.

Presenter notes, a separate presenter view, and selecting slide elements for editing are intentionally deferred.
