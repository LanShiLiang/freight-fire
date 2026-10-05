# 配套第一人称资源来源

来源：[ETO-ze/dust2-web](https://github.com/ETO-ze/dust2-web)，资源锁清单镜像 `https://cs2.duskrain.cn/`。仅下载本游戏所需的五种武器、两套阵营手臂与动作集合。原镜像路径、字节数、SHA-256 在 `source-lock.json` 中；下载时逐文件核验。

| 游戏 id | 实际模型与饰面 | 配套动画 |
| --- | --- | --- |
| m4a1 | M4A1-S / Printstream 印花集 | m4a1/* |
| ak47 | AK-47 / Vulcan 火神 | ak47/* |
| awp | AWP / Dragon Lore 巨龙传说 | awp/* |
| usp | USP-S / Kill Confirmed 确认击杀 | usp/* |
| knife | Karambit / Sapphire 蓝宝石 | knife/*，拔刀、两种轻击、重刺 |

两队保留原 CT SAS / T Phoenix 手臂几何，第一人称使用「港湾警戒」原创手套与袖口颜色贴图：石板灰、深蓝和少量工业橙标记。所有武器、手指、手腕、枪栓、弹匣均使用同一原始骨骼体系的匹配动作；没有将一个独立枪体拼装到另一种枪械的手部动画上，也没有第一人称手部 IK。枪体通过原始 `wpn` 骨骼挂接；取消重复的 Source 到 glTF 坐标基变换。

## 当前社区武器饰面

AK 使用 [jim´s 的 Vulcan: AK-47](https://steamcommunity.com/sharedfiles/filedetails/?id=203495799)，黑白和青蓝的几何分区使护木、机匣、弹匣和枪托更容易辨认。M4 使用 [JTPNZ 的 M4A1-S | PRINTSTREAM](https://steamcommunity.com/sharedfiles/filedetails/?id=2111422399)，原作黑白配色、法线和珠光遮罩均来自配套完整饰面模型；[Steam 的印花集条目](https://steamcommunity.com/market/listings/730/M4A1-S%20%7C%20Printstream%20%28Factory%20New%29) 确认它属于 M4A1-S 和狂牙收藏品。两者均使用原作者已被 CS2 采纳的成熟作品，没有重新绘制枪械贴图。

`ak47-vulcan.glb`、`m4a1-printstream.glb` 与同名 WebP 预览直接来自参考项目 `assets/weapons/cs2-loadout/` 镜像，逐字节匹配公开资源锁版本 `5a82c6eead18b7e0`。`skin-selection-community.json` 记录完整下载地址、来源哈希、作者页面、纹理分辨率和实际几何比较。两份模型与此前加载的同型号模型具有相同骨骼名称、层级和局部变换；八个网格访问器（顶点、UV、法线、切线、关节索引、权重和三角索引）及逆绑定矩阵按实际访问器解析后逐字节一致。只忽略饰面编号和场景显示名称；印花集多一张原生珠光图导致逆绑定矩阵的缓冲视图序号变化，但矩阵值保持不变。配套动作、枪口骨骼与握持关系继续沿用。

## 原创手部贴图与历史武器试作

「港湾警戒」与「船坞黑钢」通过 ImageGen 在原 UV 布局上绘制，AK 已清除火蛇装饰，改为简洁石墨黑钢、深蓝木件和橙色标记。源 JPEG 与可重复打包配方随 `original/` 提供，运行 `node scripts/prepare-original-skins.mjs repack games/freight-fire/assets/viewmodel-cs2/original/recipe.json` 可重建 `ct-sas-harbor.glb`、`t-phoenix-harbor.glb`、`ak47-docksteel.glb`。

`original-skins.json` 记录原模型及派生文件 SHA-256、替换图像来源、分辨率和保护数据比较。只替换 baseColor 图像及材质名称，保留原图分辨率、法线和 ORM；节点、UV、网格、关节、蒙皮权重、逆绑定矩阵与动画结构及非图像缓冲区逐字节不变。当前运行时使用两份港湾手臂派生模型；原创船坞黑钢 AK 仅保留为历史试作与打包流程核验，游戏不加载。源 JPEG 不新增运行时请求。原模型保留供核验；原始版权与以下来源说明继续适用。

## 原始基底与历史饰面选择

此前金蛇缠绕与用于原创改色的火蛇基底来自参考资源清单中可选的 `cs2-skins/optional` 完整 PBR 模型；该步骤的历史几何比对记录在 `skin-selection.json`。这些基底的节点名称、局部变换、八个网格访问器（含顶点、UV、索引、蒙皮权重）和逆绑定矩阵与原型号逐字节一致。金蛇缠绕、火蛇和船坞黑钢 GLB 仅保留供来源及几何核验，运行时不加载。

历史饰面型号由 Steam 原始页面核验：[M4A1-S 金蛇缠绕](https://steamcommunity.com/market/listings/730/M4A1-S%20%7C%20Golden%20Coil%20%28Factory%20New%29) 属于暗影收藏品；作者 [Kitch.sb 的 Snakebite / Golden Coil 系列](https://steamcommunity.com/sharedfiles/filedetails/?id=460239102) 记录 M4A1-S 在 2015 年被采用。并未将 M4A4 的皮肤贴在 M4A1-S 上。[AK-47 火蛇](https://steamcommunity.com/market/listings/730/AK-47%20%7C%20Fire%20Serpent%20%28Factory%20New%29) 属于英勇收藏品。早期印花集/火神研究副本仍在不参与发布的 `artifacts/skin-upgrade/retired`，当前发布使用本轮重新从镜像核验下载的同名原装文件。

动画资源由参考项目从原 CS2 `.vnmclip` 导出。本仓库 `scripts/prepare-cs2-viewmodel.py` 仅删除不使用的动画家族与缓冲区，保留这些五种武器的逐字节动作值。原文件在忽略构建的研究目录保存；衍生文件哈希、保留动作名称与处理说明在 `animation-selection.json` 中。AWP `shared_scope` 原本就是两片独立镜片；运行时替换为原创静态玻璃渐变材质与平面 UV，枪体饰面 UV、原始网格和动作不改。

枪口由原生 idle 姿态的真实蒙皮端面中心校准，初始化时更新蒙皮矩阵，并跟随端面所属的 `silencer` / `weapon_offset` 骨骼。第三人称复用同一模型与该校准点；枪体采用原始配套 idle 的局部骨骼变换，而不是含导出根偏移的 bind pose。成熟 idle 的双手相对枪体矩阵和原始指骨四元数通过 `nativeGrip` 提供给人物适配器。原素材文件的顶点、骨架和动画数据保持不变。

Counter-Strike、Valve 模型、纹理、手套饰面和动画，以及 Workshop 作者的饰面作品，保留 Valve 及各创作者的原有权利。公开下载地址、GitHub 代码可读或个人非商用使用不将这些素材改为 CC0、MIT 或通用开源素材。此处作为用户指定参考作品的素材复用并保留来源；未宣称获得 Valve 官方授权。参考仓库自身亦没有给原创游戏代码赋予通用开源许可证。

本项目 `viewmodel-cs2.js` 是独立编写的 Three.js 适配器；资产来源说明与项目自编代码许可分别适用。Three.js / GLTFLoader / SkeletonUtils 保持各自现有 MIT 许可。
