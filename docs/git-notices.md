# Bundled Git

This application distributes a portable Git executable built by the
[dugite-native project](https://github.com/desktop/dugite-native), together with
the JavaScript bindings from [Dugite](https://github.com/desktop/dugite).

Git and dugite-native are licensed under GPL-2.0. Dugite's JavaScript bindings
are licensed under MIT. The portable distribution also includes components
with their own licenses; license files shipped in that distribution are retained.
The Git license is included at `git/COPYING` beside this notice.

The exact binary URLs and SHA-256 checksums are recorded in
`git/distribution.json` beside this notice in the packaged app, and in
`node_modules/dugite/script/embedded-git.json` for the version pinned in
`package-lock.json`. Each URL identifies a tagged dugite-native release. Source
code and build scripts for those releases are available at
https://github.com/desktop/dugite-native/releases and
https://github.com/desktop/dugite-native. The corresponding Git source is the
`git` submodule of that release. The application does not modify these binaries.
