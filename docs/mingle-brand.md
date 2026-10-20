# Mingle identity

Use **Mingle** in product text and window titles, and `mingle` for the desktop command and icon identifier.

The mark uses the same restrained node-and-connection style as the previous app icon. Five nodes and a continuous path form an M. It is monochrome, with no gradient, glow or animation.

- Editable source and favicon: `apps/web/public/mingle.svg`.
- Desktop raster export: `apps/web/public/mingle-icon.png`, 512 × 512 with transparent outer corners.
- Background: `#101010`; connections: `#a3a3a3`; nodes: `#d4d4d4`.
- Geometry: 32 × 32 view box, 1.8-unit stroke and 1.8-unit node radii.
- Keep the mark square and preserve its internal spacing. Place the word Mingle beside it when the product name needs to be read; keep that text accessible.

The PNG is rendered directly from the SVG. No fonts or external image assets are required. To refresh it after editing the source, with librsvg installed:

```sh
rsvg-convert -w 512 -h 512 apps/web/public/mingle.svg -o apps/web/public/mingle-icon.png
```
