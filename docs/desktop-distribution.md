# Linux desktop distribution

Relay's Linux x86_64 desktop release is distributed as a versioned tarball. The Arch recipe in [`packaging/arch/PKGBUILD`](../packaging/arch/PKGBUILD) repackages that archive as `relay-workspace-bin`, installing the app under `/opt/relay-workspace`, a launcher in `/usr/bin`, the desktop entry, scalable icon and bundled license texts.

## Build artifacts

With development dependencies installed, `pnpm package:linux` builds the UI, downloads the pinned official Node runtime after SHA-256 verification, deploys production dependencies in an isolated temporary workspace, and compiles Relay's server and contracts into JavaScript. It stages Electron and the runtime in `release/relay-workspace-<version>-linux-x64` and creates the corresponding `.tar.gz` plus `.sha256` file. The release does not contain databases, credentials or session worktrees.

`pnpm package:arch` additionally invokes `makepkg` on Arch Linux as an ordinary user. It creates `release/relay-workspace-bin-<version>-1-x86_64.pkg.tar.zst` and its checksum. The generated recipe in `release/arch-build/PKGBUILD` receives the exact archive checksum; the build does not install packages or request sudo. `makepkg --nodeps` is used for this repackaging step; install-time dependencies remain recorded in the package and are resolved by `pacman -U`.

The manual **Build desktop packages** GitHub workflow creates downloadable workflow artifacts for both formats. It does not create tags, public releases or AUR entries. Run it after these changes have been pushed, then download the `relay-arch-x86_64` artifact. Use a GitHub Release for public downloads; publication is a separate step.

## Arch Linux

For a locally staged release, copy the archive next to the recipe, build it with `makepkg`, then install the resulting package:

```sh
cp release/relay-workspace-0.1.0-linux-x64.tar.gz packaging/arch/
cd packaging/arch
makepkg -s
sudo pacman -U ./relay-workspace-bin-0.1.0-1-x86_64.pkg.tar.zst
```

`pacman -U` installs a local package file and resolves its declared runtime dependencies. The recipe also downloads the versioned GitHub release archive when no local copy is present. Verify that its pinned SHA-256 matches the release before building.

The package is **not currently registered on the AUR**, so `yay -S relay-workspace-bin` is not available yet. That command applies only after an AUR package entry is published.

## Runtime requirements

The package bundles Electron 44.9.0, the official Node 26.8.2 runtime, Relay's compiled server and the built web client. It therefore does not require system `electron` or `nodejs`. It does require the host's shared libraries used by Electron/Chromium and Node, including the split `libatomic`, `libgcc` and `libstdc++` packages ([Arch guidance](https://archlinux.org/todo/gcc-libs-deprecation/)); the direct Arch package dependencies are listed in the `PKGBUILD`. Git is a required dependency for session worktrees and version-control features.

The Chromium sandbox helper is installed root-owned with mode `4755`, as required by Electron's Linux sandbox arrangement. The package does not turn off the sandbox. Review the [Arch package dependency guidance](https://wiki.archlinux.org/title/Arch_package_guidelines#Package_dependencies) and [Electron notes](https://wiki.archlinux.org/title/Electron) when maintaining the dependency list.

## License metadata

The repository does not currently declare a project license. The recipe records this as `unknown` and installs the license notices bundled in each release; it does not claim that those third-party notices license Relay itself. Set the package license metadata only after the project owner selects and documents a project license. The build inventories both backend dependencies and bundled frontend dependencies and includes their license/notice files.


## Installed behavior and updates

The package installs a real desktop entry and the `relay-workspace` command. The desktop process selects a free loopback port, starts its packaged backend, opens the workspace and shuts thepens the workspace and shuts the backend down when the app exits. The renderer retains context isolation and Chromium sandboxing. A fresh install stores data in `appData/Mingle/workspace`; if initialized legacy state exists, it selects `appData/Relay/workspace` in place and keeps Electron's user-data root there. Existing absolute worktree and profile paths are preserved. See [Mingle rename and data continuity](mingle-rename.md).

Claude Code and Codex remain separately installed provider tools. The optional SDK-bundled native Claude executable is excluded from the release; Mingle keeps its JavaScript Agent SDK adapter and discovers the user's installed CLI/login normally. No provider calls run during a package build.

The previous installed app may have created its database and browser profile under `appData/Relay`; the rebranded desktop selects this root in place when it contains initialized workspace data. It does not copy or rewrite it. Package upgrades replace application files while retaining user data; removing the package likewise leaves that user data for the owner to manage.

There is no automatic updater. Until an AUR listing exists, install newer package files with `pacman -U`; after publication, an AUR helper can rebuild/install new versions. The package is currently unsigned; signing and a package repository are separate release work.

## Publishing checklist

1. Select and document Mingle's project license; replace `unknown` metadata. Third-party license notices do not grant rights to Mingle itself.
2. Build the intended version and perform installation/launch verification on Arch. Type checking and package creation do not substitute for that check.
3. Review the generated archive/package checksums. Copy the generated recipe into the AUR publication checkout, regenerate `.SRCINFO`, and ensure its source URL names the exact release asset.
4. With the owner's approval, publish the versioned archive/package and checksums as a GitHub release, then register/update `mingle-bin` on the AUR using the owner's AUR account.

A GitHub repository or local `PKGBUILD` alone does not make the package available through `yay`. `pacman -S` would require inclusion in a configured package repository; the supported local-file command is `pacman -U` ([ArchWiki](https://wiki.archlinux.org/title/Arch_User_Repository)).
