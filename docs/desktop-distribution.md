# Linux desktop distribution

Relay's Linux x86_64 desktop release is distributed as a versioned tarball. The Arch recipe in [`packaging/arch/PKGBUILD`](../packaging/arch/PKGBUILD) repackages that archive as `relay-workspace-bin`, installing the app under `/opt/relay-workspace`, a launcher in `/usr/bin`, the desktop entry, scalable icon and bundled license texts.

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

The package bundles the Electron executable, a same-ABI Node runtime, the Relay server and the built web client. It therefore does not require system `electron` or `nodejs`. It does require the host's shared libraries used by Electron/Chromium and Node; the direct Arch package dependencies are listed in the `PKGBUILD`. Git is an optional dependency for session worktrees and version-control features.

The Chromium sandbox helper is installed root-owned with mode `4755`, as required by Electron's Linux sandbox arrangement. The package does not turn off the sandbox. Review the [Arch package dependency guidance](https://wiki.archlinux.org/title/Arch_package_guidelines#Package_dependencies) and [Electron notes](https://wiki.archlinux.org/title/Electron) when maintaining the dependency list.

## License metadata

The repository does not currently declare a project license. The recipe records this as `unknown` and installs the license notices bundled in each release; it does not claim that those third-party notices license Relay itself. Set the package license metadata only after the project owner selects and documents a project license.
