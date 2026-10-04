# 配套第一人称资源来源

来源：[ETO-ze/dust2-web](https://github.com/ETO-ze/dust2-web)，资源锁清单镜像 `https://cs2.duskrain.cn/`。仅下载本游戏所需的五种武器、两套阵营手臂与动作集合。原镜像路径、字节数、SHA-256 在 `source-lock.json` 中；下载时逐文件核验。

| 游戏 id | 实际模型与饰面 | 配套动画 |
| --- | --- | --- |
| m4a1 | M4A1-S / Golden Coil 金蛇缠绕 | m4a1/* |
| ak47 | AK-47 / Fire Serpent 火蛇 | ak47/* |
| awp | AWP / Dragon Lore 巨龙传说 | awp/* |
| usp | USP-S / Kill Confirmed 确认击杀 | usp/* |
| knife | Karambit / Sapphire 蓝宝石 | knife/*，拔刀、两种轻击、重刺 |

两队统一使用原 CT SAS / T Phoenix 手臂及 Sport Gloves / Hedge Maze 运动手套。所有武器、手指、手腕、枪栓、弹匣均使用同一原始骨骼体系的匹配动作；没有将一个独立枪体拼装到另一种枪械的手部动画上，也没有第一人称手部 IK。枪体通过原始 `wpn` 骨骼挂接；取消重复的 Source 到 glTF 坐标基变换。

金蛇缠绕与火蛇使用参考资源清单中可选的 `cs2-skins/optional` 完整 PBR 模型；不采用参考游戏默认的印花集与火神。两把替换模型的节点名称、局部变换、八个网格访问器（含顶点、UV、索引、蒙皮权重）和逆绑定矩阵与原型号逐字节一致；仅 PBR 贴图与材质饰面不同，不修改配套手臂、枪械骨骼、动画或镜头体量。GLB 和 WebP 预览均按上游字节数与 SHA-256 核验；更换及几何比对记录在 `skin-selection.json`。

饰面型号由 Steam 原始页面核验：[M4A1-S 金蛇缠绕](https://steamcommunity.com/market/listings/730/M4A1-S%20%7C%20Golden%20Coil%20%28Factory%20New%29) 属于暗影收藏品；作者 [Kitch.sb 的 Snakebite / Golden Coil 系列](https://steamcommunity.com/sharedfiles/filedetails/?id=460239102) 记录 M4A1-S 在 2015 年被采用。并未将 M4A4 的皮肤贴在 M4A1-S 上。[AK-47 火蛇](https://steamcommunity.com/market/listings/730/AK-47%20%7C%20Fire%20Serpent%20%28Factory%20New%29) 属于英勇收藏品。旧印花集/火神研究副本移至不参与发布的 `artifacts/skin-upgrade/retired`，来源哈希仍保留在锁清单。

动画资源由参考项目从原 CS2 `.vnmclip` 导出。本仓库 `scripts/prepare-cs2-viewmodel.py` 仅删除不使用的动画家族与缓冲区，保留这些五种武器的逐字节动作值。原文件在忽略构建的研究目录保存；衍生文件哈希、保留动作名称与处理说明在 `animation-selection.json` 中。AWP `shared_scope` 原本就是两片独立镜片；运行时替换为原创静态玻璃渐变材质与平面 UV，枪体饰面 UV、原始网格和动作不改。

枪口由原生 idle 姿态的真实蒙皮端面中心校准，初始化时更新蒙皮矩阵，并跟随端面所属的 `silencer` / `weapon_offset` 骨骼。第三人称复用同一模型与该校准点；枪体采用原始配套 idle 的局部骨骼变换，而不是含导出根偏移的 bind pose。成熟 idle 的双手相对枪体矩阵和原始指骨四元数通过 `nativeGrip` 提供给人物适配器。原素材文件的顶点、骨架和动画数据保持不变。

Counter-Strike、Valve 模型、纹理、手套饰面和动画，以及 Workshop 作者的饰面作品，保留 Valve 及各创作者的原有权利。公开下载地址、GitHub 代码可读或个人非商用使用不将这些素材改为 CC0、MIT 或通用开源素材。此处作为用户指定参考作品的素材复用并保留来源；未宣称获得 Valve 官方授权。参考仓库自身亦没有给原创游戏代码赋予通用开源许可证。

本项目 `viewmodel-cs2.js` 是独立编写的 Three.js 适配器；资产来源说明与项目自编代码许可分别适用。Three.js / GLTFLoader / SkeletonUtils 保持各自现有 MIT 许可。
