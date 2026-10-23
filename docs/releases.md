# Building and releasing macOS installers

The initial release is **0.1.0**, tagged **v0.1.0**. Both downloads belong to the same GitHub Release:

| Mac | Download |
| --- | --- |
| Apple Silicon (M1 and later) | `wetmytt-0.1.0-mac-arm64.dmg` |
| Intel | `wetmytt-0.1.0-mac-x64.dmg` |

The app includes Electron and the built interface. Users do not need Node.js or npm. Drag the app from the DMG into Applications before launching it. Auto-update is not configured; install later releases manually.

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

The tag must match the package version. `.github/workflows/release.yml` builds both architectures, signs and notarizes them, and creates a **draft** release with both DMGs, `SHA256SUMS.txt`, and the text in `docs/release-notes/v0.1.0.md`. Only the final release job has repository write permission; it uses GitHub's automatically provided token, so no personal access token is needed.

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

7. Wait for **macOS release** to finish. Check the draft contains both architecture DMGs, release notes, and `SHA256SUMS.txt`. Install and check each architecture on its matching Mac if not already done on this commit.
8. Publish the draft in GitHub Releases. Share the release page so users can choose their Mac's download.

Use a new version for subsequent changes after publishing. Reuse the existing signing setup until credentials expire or are revoked; if notarization authentication fails, update the app-specific-password secret. Renew the Developer ID certificate before it expires, export the new certificate with its private key, and replace the two `MAC_CSC_*` secrets.
