# Arch Linux package

`PKGBUILD` packages the x86_64 Linux release as `relay-workspace-bin`. It uses the bundled Electron and Node runtimes; it does not depend on the system `electron` or `nodejs` packages.

For a local release build, copy the release archive beside `PKGBUILD`, then build the package:

```sh
cp ../../release/relay-workspace-0.1.0-linux-x64.tar.gz .
makepkg -s
sudo pacman -U ./relay-workspace-bin-0.1.0-1-x86_64.pkg.tar.zst
```

The archive's SHA-256 must match the checksum in `PKGBUILD`. For an upstream release build, makepkg downloads that same archive from the GitHub release URL instead.

This recipe is not registered on the AUR. After maintainers publish and register it there, users may install it with `yay -S relay-workspace-bin`. Until then, use the local `makepkg` and `pacman -U` steps above.
