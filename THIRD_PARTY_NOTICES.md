# Sources and licenses

Original game simulation, UI, audio mixing, Three.js integration and camera code use the root LICENSE. Third-party models, textures, animations, sound recordings and structural map data retain their separate rights and notices.

## Packages

| Package | Version | Use | License | Upstream |
|---|---|---|---|---|
| Three.js | 0.180.0 | Browser rendering and official local glTF/skeleton utilities | MIT | https://github.com/mrdoob/three.js/tree/r180 |
| cannon-es | 0.20.0 | Local visual ragdoll physics | MIT | https://github.com/pmndrs/cannon-es |
| ws | 8.22.0 | Local Node WebSocket servers | MIT | https://github.com/websockets/ws |
| Playwright | 1.63.0 | Development-only Windows Chromium verification | Apache-2.0 | https://github.com/microsoft/playwright |

Notices are retained at `games/freight-fire/vendor/LICENSE`, `games/freight-fire/vendor/cannon-es-LICENSE`, `licenses/ws-LICENSE` and `licenses/playwright-LICENSE`. Exact dependency versions and integrity hashes are in package-lock.json; the unchanged vendored physics module and its official npm package integrity are recorded in `games/freight-fire/vendor/cannon-es-source.json`. Reference repositories serve as asset documentation; their game code is not included in the runtime. Dependencies are installed with lifecycle scripts disabled.

## Transport Ship current assets

| Asset | Source / rights | Records and adaptations |
|---|---|---|
| Freight Fire lobby cover illustration | Original promotional artwork generated for this project using built-in ImageGen | `games/freight-fire/cover-source.json` retains final prompts, generation mode and hashes. Encoded as 1440×800 WebP; promotional art, not gameplay screenshots. |
| Harbor Watch gloves / sleeves; retained Dock Steel AK base-color artwork | Original cosmetic repaint commissioned for this project using ImageGen; underlying model, UV and surface maps retain the original Valve / creator rights | Harbor Watch arms remain active. Dock Steel is retained for source/derivative byte verification and is no longer the selected gun skin. `games/freight-fire/assets/viewmodel-cs2/original/` contains four native-resolution JPEG atlases and a reproducible recipe. `original-skins.json` verifies source/derived hashes and unchanged geometry, UV, joints, skinning and animation data. |
| AK-47 Vulcan and M4A1-S Printstream | CS community finishes by jim´s and JTPNZ, respectively. Original creators and Valve retain rights. Complete matching GLBs obtained through the user-selected public CS2 resource mirror. | `games/freight-fire/assets/viewmodel-cs2/skin-selection-community.json` records original Workshop pages, source URLs, SHA-256, full material preservation and byte-identical matched geometry / UV / skeleton data. No newly painted gun atlas. |
| M4A1-S, AK-47, AWP, USP-S, Karambit, CT SAS / T Phoenix arms, sport gloves, native weapon animations and skins | Public CS2 resource mirror selected by https://github.com/ETO-ze/dust2-web at commit `8b0f9f68772601237ad1a5385868368e9306edd1`, asset-lock version `5a82c6eead18b7e0`. Valve Corporation and the respective creators retain rights. | `games/freight-fire/assets/viewmodel-cs2/SOURCES.md`, `source-lock.json` and `animation-selection.json`. Five native matched weapon/arm sets; unused animation data removed while selected source values remain unchanged. Independent runtime adapter; static original scope-glass material. |
| Original SAS / Phoenix world characters and 40 movement, weapon and death animation clips | Same public reference manifest / resource mirror and retained Valve / creator rights | `games/freight-fire/assets/characters-cs2/README.md` and `sources.json`. Native bone weapon attachments, tracks filtered to existing bones, independently implemented contact correction and death camera. |
| CS2 weapon, handling, melee, hit, headshot and kill samples; UI SVG icons | Same public reference resource mirror. Original Valve / creator rights retained. | `games/freight-fire/assets/audio/cs2/NOTICE.md` and `freight-manifest.json`, including original URLs, byte sizes and SHA-256. Selected audio and icons bundled locally without altering sample content. Audio mixing and gameplay feedback code independently authored. |
| Classic Transport Ship structural geometry | SmileGate (original); Riding crab snails (conversion); ElysiumLeoSK (compile/screenshots). https://gamebanana.com/mods/111054 . Original rights retained; not MIT/CC0. | `games/freight-fire/assets/maps/classic-source.json` and `README.md`: numeric surfaces, convex collisions and spawn coordinates transformed uniformly and repainted with independent materials. Original engine units remain unverified. |
| metal_plate_02, green_metal_rust, wooden_planks | Poly Haven contributors, CC0. https://polyhaven.com/license | `games/freight-fire/assets/textures/environment/sources.json` and `LICENSES.md`. Local photographic maps and independently drawn container/deck surface details. |

The user-selected reference's public asset documentation and original notice are at https://github.com/ETO-ze/dust2-web/blob/main/docs/ASSETS.md and https://github.com/ETO-ze/dust2-web/blob/main/LICENSE.md . Public hosting does not relicense Valve assets as MIT or CC0. The reference repository assigns no general open-source license to its own code; this project implements its integration independently.

Additional classic map visual research: https://ol.3dmgame.com/gl/21161.html and https://news.7k7k.com/content/20160318/782971.html . No original CF textures, logos, screenshots, entities, scripts or compiled map code are shipped.

Only current Transport Ship resources and source models retained for byte verification are included. Game and trade names do not imply endorsement or affiliation.
