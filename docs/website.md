# Project website

The landing page lives in `website/`. It is plain HTML and CSS, with no browser JavaScript, external fonts, analytics, or application dependencies. It describes the desktop app; it does not run the Electron workspace in a browser.

## Local preview

Requires Node.js 22.12+; no dependency installation is needed. From the repository root, run:

```sh
npm run preview:website
```

Open `http://127.0.0.1:4173/website/`. Edit `website/index.html` or `website/styles.css`, then refresh your browser to see changes. The server reads source files on each request with caching disabled; no rebuild or restart is needed. Stop it with Ctrl+C.

The server binds only to your computer and serves only the website's HTML, stylesheet, and images. It fetches the latest stable release metadata once on startup so the download links match production. Internet access is required at startup unless you supply saved release metadata:

```sh
npm run preview:website -- --release-json /path/to/release.json
```

To use a different port:

```sh
npm run preview:website -- --port 8081
```

You can also run `node scripts/preview-website.mjs` directly without npm. Restart the server to refresh release metadata.

## Production build

Requires Node.js 22.12+; no npm installation is needed:

```sh
node --test tests/website.test.js
node scripts/build-website.mjs
python3 -m http.server 8080 --bind 127.0.0.1 --directory dist
```

Open `http://127.0.0.1:8080/website/`. Stop the server with Ctrl+C. Output is ignored at `dist/website/`; the screenshot and icon are copied from the existing repository assets.

The build reads the public GitHub latest-release API and requires both published architecture DMGs. It stops on missing assets or API failures instead of publishing broken or guessed links. It supports an optional `GITHUB_TOKEN` for API requests; the token is never written into the output. To build offline with saved GitHub release metadata:

```sh
node scripts/build-website.mjs --release-json /path/to/release.json
```

`PAGES_BASE_URL` overrides the canonical and social-preview URLs. GitHub Actions supplies the actual Pages base URL; the default is `https://rationalash.github.io/wetmytt/`. Local CSS, image, and icon paths are relative, so project subpaths work.

## Publish when ready

The `Project website` workflow is **manual only**, restricted to `master`. Pushing source changes or publishing a desktop release does not deploy the site. No Pages settings or deployment are enabled by adding these files.

When publication is authorized:

1. In repository **Settings → Pages → Build and deployment**, select **GitHub Actions** as the source.
2. Use the `github-pages` environment's deployment protection rules to restrict deployment to `master`.
3. In **Actions → Project website → Run workflow**, choose `master`.
4. Check the successful deployment URL. The expected default is `https://rationalash.github.io/wetmytt/`.

The workflow uses official Actions pinned to commit SHAs, read-only build permissions, and Pages/OIDC write permissions only for the deployment job. It publishes only `dist/website/`, not the repository or the desktop app's static export. No personal access token is required.

After every new stable desktop release, rerun the workflow on `master` to refresh the site's download buttons. Wait for deployment to succeed and verify the live site's version, release-notes link, and both architecture download buttons match the published release. This deployment and the README badge update are required release follow-up, as described in `AGENTS.md` and the [release checklist](releases.md#repeat-release-checklist); report any blocked step explicitly. Do not advance the site for drafts or prereleases. Download URLs are resolved at build time; the deployed page does not call GitHub's API in visitors' browsers. If automatic publishing is wanted later, add narrowly scoped default-branch push and stable-release triggers after reviewing that change.
