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

Open **AI settings**, choose **OpenRouter**, **OpenAI**, **Claude**, or **Ollama**, and enter a model ID that supports tools. Cloud connections require an API key; local Ollama does not. OpenAI, OpenRouter, and Ollama use Chat Completions; Claude uses the Anthropic Messages API. OpenRouter routing requires support for the requested parameters. The advanced base URL supports proxies using the selected API format, with HTTPS required except for loopback servers. Changing providers or endpoints does not reuse the saved key. Saving validates the configuration locally; model access and tool support are checked when you send a message.

The built-in agent can list, read, and write text files in the open deck. A request grants it permission to edit that folder. Changes are applied directly and auto-reloaded; there is no undo or review workflow yet. Use version control for work you want to preserve. Image generation and binary uploads by the agent are outside this first pass; agents can reference dropped assets or write SVG.

Keys stay in Electron's main process and are encrypted at rest using Electron `safeStorage`. If OS encryption is unavailable, the key is kept in memory only. Provider settings are stored in Electron's user-data directory, never in the deck. Chat is in memory and resets when you switch decks. The model receives your chat and any deck files it reads through tools. Stop cancels the running request; completed writes remain. Each request is limited to 16 model turns and three minutes.

## External agents and MCP

Hide chat and run your agent directly:

```sh
cd /path/to/my-presentation
codex
```

Welcome to My TED Talk does not need to launch or supervise the agent. Changes from any editor or agent appear automatically.

### Connect Codex to the running app

The Electron app hosts a Streamable HTTP MCP endpoint at `http://127.0.0.1:43187/mcp` while it is running. No presentation contains server code, and clients do not need a path to this app's installation.

1. Start the app and open a presentation.
2. Click **Connect to Codex** in the toolbar. The app prepares a private local plugin and opens its details in Codex Desktop.
3. Select **Install** in Codex, then start a new Codex chat and use the **Welcome to My TED Talk** plugin.

No manual MCP configuration is needed. If the plugin doesn't appear immediately, restart Codex and click **Open in Codex** in the connection dialog. Codex remains responsible for the final installation and enablement; the app does not silently install the plugin or change tool approval settings.

The app creates its plugin under `~/.agents/plugins/wetmytt/` and adds an entry to `~/.agents/plugins/marketplace.json`, preserving other entries and marketplace metadata. The plugin includes its name, icon, and the authenticated local MCP endpoint. The connection button opens a `codex://plugins/wetmytt?marketplacePath=...` link to that personal marketplace. Repeated use refreshes the same plugin source without adding duplicate entries. Existing installed copies may need to be refreshed or reinstalled through Codex after changing credentials.

The access token is generated once and stored with owner-only permissions in `mcp-token` in Electron's user data directory. It remains valid across app restarts. The generated plugin folder is private to your user, and its `.mcp.json` is owner-readable/writable because it contains the token. Keep this generated package local; do not share or commit it. To revoke the token, quit the app, remove that token file, restart, click **Connect to Codex**, and reinstall the plugin in Codex to refresh its cached credentials.

If you previously added `[mcp_servers.wetmytt]` to Codex's config manually, remove that old entry after installing the plugin to avoid duplicate connections. The app preserves your existing Codex configuration.

The endpoint binds only to `127.0.0.1`, checks Host and Origin headers, and requires the token on every request. Only one app instance runs at a time. If the fixed port is occupied, the app still opens and the connection dialog reports the error; free the port and restart the app.

Tools available through MCP:

- `get_presentation`: identifies the presentation bound to this session and whether it is still current.
- `list_files`, `read_file`, `write_file`: operate within that presentation folder, with the existing path and symlink restrictions.
- `screenshot_slide`: accepts `{ "slide": 2 }` and returns a 1280×720 PNG of the second slide directly to the model.

Each session binds to the presentation open at initialization. Switching, closing, or reopening a presentation invalidates file and screenshot calls for existing sessions, including when the same folder is reopened. Reconnect MCP or start a new Codex session to select the newly open presentation. A connection made before opening a deck also needs to reconnect. An operation already in progress keeps its original folder; it never redirects into the new presentation.

Screenshots use isolated hidden windows inside the running Electron app. They wait for slide containers, images, and fonts, report invalid slide numbers or rendering timeouts, and leave the visible preview and presentation folder untouched. Sessions expire after 30 minutes without requests; reconnect if needed. Quitting the app stops MCP. The built-in BYOK chat still uses the three text file tools.

The former standalone stdio command (`npm run mcp` / `node electron/mcp.js`) has been replaced by this app-hosted endpoint. Remove its `command` and `args` configuration when migrating.

## Architecture and checks

- `app/`: Next.js App Router interface, exported as static HTML for production.
- `electron/main.js` and `preload.cjs`: native dialogs, watcher, isolated IPC, settings, and agent orchestration.
- `electron/server.js`: loopback HTTP serving; decks have separate origins and random URL prefixes, with local-only CSP.
- `electron/bridge.js`: injected deck navigation protocol.
- `electron/files.js`: shared folder-scoped file tools, with traversal and symlink checks.
- `electron/agent.js` and `mcp.js`: BYOK tool loop and app-hosted HTTP MCP server.
- `electron/codex-plugin.js`: private local plugin generation, personal marketplace registration, and Codex deep link.

```sh
npm test
npm run typecheck
npm run build
npm run test:screenshot
```

The preview is sandboxed without Node integration, and IPC validates that calls come from the main application frame. File tools reject hidden paths and paths or symlinks outside the deck. This is a local desktop prototype; avoid opening untrusted folders or allowing concurrent untrusted processes to replace symlinks during writes.

Presenter notes, a separate presenter view, and selecting slide elements for editing are intentionally deferred.
