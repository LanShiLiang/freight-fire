# Environment photography and PBR maps

All downloaded JPG maps in this directory come from Poly Haven. Its official
[asset license](https://polyhaven.com/license) states that every texture asset is
licensed under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/),
including redistribution inside another product. These are locally bundled
images; the game does not fetch them from an external texture server.

| Asset | Authors | Source | Use |
| --- | --- | --- | --- |
| Metal Plate 02 | Rob Tuytel | https://polyhaven.com/a/metal_plate_02 | Coated deck plates |
| Green Metal Rust | Rob Tuytel | https://polyhaven.com/a/green_metal_rust | Worn cargo container paint; subtle normal and roughness of white ship paint |
| Wooden Planks | Charlotte Baglioni (photography), Dario Barresi (processing) | https://polyhaven.com/a/wooden_planks | Wood crate panels and frames |

Downloaded 2026-10-04 through the official Poly Haven API. `sources.json` records
the individual image URL, original asset metadata, author, download size and MD5
checksum. Bundled maps are 1K JPG diffuse, OpenGL normal, and packed
ambient occlusion / roughness / metallic (ARM). Runtime uses diffuse, OpenGL
normal, and ARM, three files per selected surface.

`camouflage.svg` is original paint-pattern artwork by AI Game Lab, licensed under
the project's MIT license. It is combined with the photographed Green Metal Rust
surface; no existing game's texture or logo is copied.

Photographic source files have not been modified. The classic map uses
`surface-art.js` to draw 1024px face textures with photographic grain, independent
container ribs, door rods, hinges, stencils, timber frames, cargo straps, deck
seams and bolts. Original painted artwork is covered by the project's MIT
license; the photographs remain CC0 and the derived map geometry/UVs retain the
map's separate notice. Normal maps are computed from painted panel heights.
Original face UVs keep the texture scale and orientation attached to each face.
The earlier procedural-map fallback retains metre-projected PBR finishes.

Standalone export: only the three selected surfaces and their diffuse, normal and ARM maps are bundled. Unused rough-plank candidates and separate roughness maps are omitted.
