# Classic Transport Ship structural reference

The structural data derives from the publicly shared classic-map conversion:
https://gamebanana.com/mods/111054 (2014).

Credits: SmileGate, original map; Riding crab snails, map/prop/texture conversion
and navigation; ElysiumLeoSK, compilation and screenshots. Original map rights
remain with their respective owners. This derived geometry is not represented
as MIT or CC0. The public source page records its permission to port.

`classic-geometry.json` contains numeric surface geometry and per-face UVs. The matching convex
collision planes and original sixteen spawn positions are in
`../../classic-map-data.js`. `classic-source.json` records the source hash,
coordinate transform, uniform scale and adaptations. The conversion applies
1.76 / 72 metres per Source-port unit. Original CF engine units have not been
independently verified; this is not a certified exact engine-scale copy.

No original textures, logos, screenshots, entities, scripts or compiled code
ship with the game. Surfaces use the independently bundled CC0 Poly Haven
photographic grain, identified in `../textures/environment/`. `surface-art.js`
paints independent 1024px container doors, ribbed panels, strapped cargo, timber
crate frames and steel deck joins, including matching normal maps. Original
face UV scale is retained; mirrored wall stencils are reoriented. Layout and
collisions are unchanged. Research downloads stay
in ignored `artifacts/transport-source-reference/` and are never executed.

Rebuild the numeric data with `scripts/build-transport-reference.py` after
placing the public reference BSP in that research directory.
