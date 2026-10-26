# Building and releasing macOS installers

The initial release is **0.1.0**, tagged **v0.1.0**. Both downloads belong to the same GitHub Release:

| Mac | Download |
| --- | --- |
| Apple Silicon (M1 and later) | `wetmytt-0.1.0-mac-arm64.dmg` |
| Intel | `wetmytt-0.1.0-mac-x64.dmg` |

The app includes Electron and the built interface. Users do not need Node.js or npm. Drag the app from the DMG into Applications before launching it. Installed production builds check public GitHub Releases at startup and every four hours, then download updates in the background. Settings includes **Check for Updates**. A small badge appears while downloading; **Restart to Update** becomes available after macOS verifies and stages the update. Updates also apply after a normal quit and relaunch. Development builds never check for updates.

Both macOS builds use the Codex plugin artwork for the app's Finder and Dock icon. The source is `electron/assets/icon.svg`; electron-builder converts the committed 1024×1024 `build/icon.png` into the app bundle's macOS icon before signing. After changing the SVG, regenerate the PNG with ImageMagick before committing:

```sh
magick -background none -density 1536 electron/assets/icon.svg -resize 1024x1024 build/icon.png
```

GitHub builds use the committed PNG and do not require ImageMagick.

## 1. Create a Developer ID Application certificate

An Apple Developer membership enables signing, but you also need a certificate and its private key. For downloads outside the App Store, choose **Developer ID Application**. A Developer ID Installer certificate is for `.pkg` installers and is not needed for these DMGs.

1. On your Mac, open **Keychain Access**. From its application menu, choose **Certificate Assistant → Request a Certificate From a Certificate Authority**.
2. Enter your email and name, leave the CA email blank, and choose **Saved to disk**. Keep the private key on this Mac.
3. In [Apple Developer → Certificates](https://developer.apple.com/account/resources/certificates/list), create a **Developer ID Application** certificate using that request. If offered a certificate authority, use the current recommended option.
4. Download the `.cer` and import it into your login keychain. In **My Certificates**, it should expand to show its private key.
5. Verify locally:

   ```sh
   security find-identity -v -p codesigning
   ```

   A valid `Developer ID Application: Your Name (TEAMID)` identity should appear. If the keychain is locked or the private key is missing, resolve that before continuing.

6. Select the certificate together with its private key in Keychain Access and export them as a password-protected `.p12`. Keep it outside this repository and back it up securely.

Apple's instructions: [Create a certificate request](https://developer.apple.com/help/account/certificates/create-a-certificate-signing-request) and [Create Developer ID certificates](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/).

## 2. Add GitHub Actions secrets

Open [this repository's Actions secrets](https://github.com/RationalAsh/wetmytt/settings/secrets/actions) and add:

| Secret | Value |
| --- | --- |
| `MAC_CSC_LINK` | Base64-encoded contents of the exported `.p12` |
| `MAC_CSC_KEY_PASSWORD` | Password chosen when exporting that `.p12` |
| `APPLE_ID` | Apple Developer account email |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password created for notarization |
| `APPLE_TEAM_ID` | Team ID from your Apple Developer membership details |

To copy the certificate's base64 contents directly to the clipboard, replace the example path:

```sh
base64 -i /path/to/DeveloperID.p12 | pbcopy
```

Paste into `MAC_CSC_LINK` in GitHub Settings. Do not paste certificates or passwords into chat, release notes, or source files. Create an **app-specific password** at [Apple Account](https://account.apple.com/) under **Sign-In and Security**. Use that password for `APPLE_APP_SPECIFIC_PASSWORD`, rather than your account login password.

The workflow imports the signing certificate into a temporary keychain. Electron-builder signs the app with Hardened Runtime, submits it to Apple's notarization service, staples the ticket to the app, and signs the DMG. The workflow verifies the app signature, stapled ticket, Gatekeeper assessment, and DMG signature before uploading. Missing secrets or a signing/notarization failure stop the release.

## 3. Test before tagging

Commit and push the release setup. In the repository's **Actions → macOS release**, use **Run workflow** on that branch to build both signed DMGs without creating a release. GitHub requires a manually dispatched workflow to exist on the default branch before its Run workflow button is available.

Download the `mac-arm64` and `mac-x64` workflow artifacts. Install and test the corresponding DMG on each Mac: launch, create/open a deck, save text, present, export PDF, and configure AI if used. Both builds currently run on an Apple Silicon macOS runner, with the Intel Electron binary packaged for x64; an actual Intel launch check is still needed.

For local signed builds, with the certificate installed in Keychain Access, set `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` in your shell (without committing them), then run:

```sh
npm ci
npm run dist:mac
```

Or build one architecture with `npm run dist:mac:arm64` / `npm run dist:mac:x64`. Outputs are in `dist/`. Local builds require working Apple notarization credentials too.

## 4. Tag and create the draft release

A **tag** records the exact commit being released. You do not need a release branch. An optional `release/0.1` branch is useful only if you plan to maintain 0.1 separately from ongoing development.

Ensure `package.json` says `0.1.0`, commit all release changes, and push the release commit. Then:

```sh
git tag -a v0.1.0 -m "Welcome to My TED Talk 0.1.0"
git push origin v0.1.0
```

The tag must match the package version. `.github/workflows/release.yml` builds both architectures, signs and notarizes them, and creates a **draft** release with both DMGs, both signed app ZIPs, blockmaps, a merged `latest-mac.yml`, `SHA256SUMS.txt`, and the text in `docs/release-notes/v0.1.0.md`. Only the final release job has repository write permission; it uses GitHub's automatically provided token, so no personal access token is needed.

Review the draft in [Releases](https://github.com/RationalAsh/wetmytt/releases), then publish it when ready. A public repository's release downloads are public; private repository downloads require repository access. GitHub's automatically generated source archives contain source code, not an installed app.

If a build fails, fix it and validate using Run workflow before publishing a new version. If the final draft-creation step fails, check whether a draft already exists before rerunning it; the workflow intentionally does not overwrite existing releases.

If signing fails at `security set-key-partition-list` with `SecKeychainUnlock`, check the installed electron-builder version before changing secrets. Version 26.16.1 fixes a bug where the certificate export password was used to unlock a temporary keychain protected by a different password. Keep the lockfile on this version or a later patched release.

For the next release, update `package.json` and `package-lock.json` together, add a matching `docs/release-notes/vX.Y.Z.md`, and push the corresponding tag.

## Repeat-release checklist

Once the certificate and secrets are configured, future releases use the same workflow:

1. Finish and commit the changes you want to ship. Start from a clean working tree.
2. Update both package files without creating a tag yet. For example:

   ```sh
   npm version 0.1.1 --no-git-tag-version
   ```

3. Create `docs/release-notes/v0.1.1.md` with a brief list of changes and download filenames using the new version. There must be a notes file for every tag.
4. Run `npm test`, `npm run typecheck`, and `npm run build`. Review and commit the version files and release notes along with any remaining intended changes. Push that commit to GitHub.
5. Optionally run **Actions → macOS release → Run workflow** on the branch and test both downloads before tagging.
6. Tag the tested commit and push the tag:

   ```sh
   git tag -a v0.1.1 -m "Welcome to My TED Talk 0.1.1"
   git push origin v0.1.1
   ```

7. Wait for **macOS release** to finish. Check the draft contains both architecture DMGs and ZIPs, blockmaps, `latest-mac.yml`, release notes, and `SHA256SUMS.txt`. Install and check each architecture on its matching Mac if not already done on this commit.
8. Publish the draft in GitHub Releases. Share the release page so users can choose their Mac's download.

Use a new version for subsequent changes after publishing. Reuse the existing signing setup until credentials expire or are revoked; if notarization authentication fails, update the app-specific-password secret. Renew the Developer ID certificate before it expires, export the new certificate with its private key, and replace the two `MAC_CSC_*` secrets.

## Bundled Git

`dugite` installs a checksum-verified host Git distribution for development and
tests. If install scripts were skipped, run `npm rebuild dugite`. Packaged builds
use `scripts/before-pack.cjs` to download and verify the distribution for each
target architecture into ignored `build/git/<arch>/` folders. Electron Builder
copies that target's distribution outside ASAR to `Contents/Resources/git/`.
The host development binary is not replaced when building x64 on arm64. Build
on the target operating system. Release builds require network access on the
first download; subsequent builds use Dugite's verified archive cache.

Both Mac architectures must include `Resources/git/bin/git` and
`Resources/git-notices.md`. `Resources/git/distribution.json` records the exact
binary URL and checksum used. Verify the embedded Git's architecture and version,
and exercise a new deck and Git status/log in the packaged app in addition to
the existing deep signature, Gatekeeper, and notarization checks.
The bundled binary sources and licenses are described in [git-notices.md](git-notices.md).

Run `npm run test:package` after packaging on the matching architecture. It loads
the shared tools from the actual ASAR and creates an initial commit with system
Git removed from `PATH`. Set `WETMYTT_PACKAGED_APP` to the `.app` path when testing
an app outside `dist/mac-arm64/` or `dist/mac/`.


## Test automatic updates with two successive releases

The first release must already contain the updater. Versions released before
this integration require one manual DMG installation. Use two increasing stable
versions (for example `0.3.1` and `0.3.2`); do not reuse a published version or
mark either release as a prerelease. No GitHub token is shipped in the app.
The repository and release assets must be public.

1. Set the first version with `npm version 0.3.1 --no-git-tag-version`, add
   `docs/release-notes/v0.3.1.md`, validate, commit, and push tag `v0.3.1` using
   the release procedure above. Review and publish the draft. Install its DMG
   into `/Applications` and launch from there, outside the mounted DMG.
2. Open Settings and select **Check for Updates**. It should report that the
   app is current. Rapid repeated clicks must not start overlapping checks.
   Checks are throttled for 30 seconds, including after an error.
3. Make a visible change and release `0.3.2` the same way. Before publishing,
   verify that the draft contains both `wetmytt-0.3.2-mac-arm64.zip` and
   `wetmytt-0.3.2-mac-x64.zip`, the DMGs, blockmaps, and `latest-mac.yml`.
   The manifest's `files` must reference both architectures with SHA-512 hashes
   and sizes. The workflow merges the matrix manifests and verifies each
   referenced file's checksum and size before creating the draft. Keep every
   artifact's filename intact. Drafts are invisible to installed clients.
4. Publish the second draft as the latest stable release. In the first app,
   use **Check for Updates** (or relaunch to test the startup check, or leave
   it running for the four-hour check). Expect the small download badge,
   then **Restart to Update**. Continue using the app during the download;
   it must not restart itself. Choose Restart and confirm the version badge
   and visible change now match the second release.
5. Reinstall the first version with the app closed to test the other path.
   Let it download the second version, then quit normally with Cmd+Q without
   selecting Restart. Launch again and confirm the second version is installed.
   Closing the last window on macOS leaves the app running; use Quit to test
   installation. Also confirm reopening a closed window retains update status.
6. Repeat on Intel and Apple Silicon. Test offline startup/manual checking:
   Settings should show a quiet connection error and the rest of the app must
   work. Reconnect, wait at least 30 seconds, and check again. Disconnect during
   a download to test retry; a failed download must never enable Restart.
   With an already staged update, quitting and installation should work offline.
7. Run `npm run dev` or `npm start` from the source checkout and verify Settings
   explains updates require the installed macOS app and no release requests occur.

The feed is configured in `electron-builder.yml`; electron-builder embeds
`app-update.yml` in the app. Do not use `setFeedURL`, bundle a GitHub token, or
upload only the DMGs. The updater validates download hashes and macOS verifies
the signed app through Squirrel.Mac before Restart is shown. Keep the app ID
and signing identity consistent between releases. See the
[electron-builder auto-update guide](https://www.electron.build/docs/features/auto-update/).
