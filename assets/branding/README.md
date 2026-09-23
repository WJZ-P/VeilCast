# VeilCast 图标：分片 V

## 当前正式图标

- 用户选定 v2（下方的清理版）：左侧切块、右侧连续渐变、较亮的蓝色背景。
- 母版：`veilcast-icon.png`，与 `veilcast-icon-concept-v2.png` 逐字节一致；保留两版候选和原始提示词，不重绘选定图稿。
- Tauri：`app/src-tauri/icons/` 下的 PNG、ICO、ICNS 和 Windows Logo 资源。
- 应用标题与 favicon：`app/public/icon.png`（64×64）。
- 油猴管理器：脚本头的 `@icon` / `@icon64` 内嵌 32×32 / 64×64 PNG；分享右侧按钮复用 64×64 图像。
- 图标没有远程 URL，安装油猴脚本后无需额外加载图标资源。

从仓库根目录重新生成：

```text
node scripts/generate-icons.mjs
node userscript/build.mjs
```

生成器使用项目已安装的 Tauri CLI，只进行图片尺寸和格式转换；移动平台的中间产物留在忽略目录 `target/branding-icons/`，不生成应用安装包。

## 历史候选 v1

- 文件：`veilcast-icon-concept-v1.png`
- 实际输出：1254×1254 PNG，RGBA，圆角外部透明。
- 状态：保留供对比，正式图标采用下方 v2。
- 风格：深蓝圆角底、青蓝主色、少量紫色，清晰的几何 V。
- 意象：分离的画面方块与完整的折叠条带，呼应切块重排、还原与 VeilCast 名称。
- 来源：内置 ImageGen，新生成的位图；原始生成文件保留，项目副本经过 SHA-256 一致性验证。
- v1 未用于正式图标集。

## v2：左侧打乱，右侧还原

- 文件：`veilcast-icon-concept-v2.png`，保留 v1 供对比。
- 左侧细分为错序的青蓝、紫色色块；右侧保留连续渐变的完整条带。
- 背景改为更亮的蓝色，保持圆角与透明外部。
- 使用内置 ImageGen 编辑，完整提示词见 [icon-v2-prompts.md](icon-v2-prompts.md)。
- 已选定为正式图稿，平台尺寸由上面的生成脚本统一导出。

## v1 完整生成提示词

```text
Use case: logo-brand.
Create one original premium desktop app icon for VeilCast, a video tile-scrambling and restoration project. Deliver a single square 1024x1024 icon, front-facing, not a mockup or contact sheet.
A bold, unmistakable geometric V monogram built from a few large video-tile facets. One arm has two or three clearly separated, slightly offset rectangular facets, while the other forms a clean continuous folded band: fragmented image becoming ordered again. Keep the whole silhouette coherent and immediately readable at 32px. Broad shapes and generous negative space; only a few intentional gaps, no tiny particles.
Style: exceptionally clean, vector-like raster brand design, restrained depth from subtle overlapping facets, precise edges. Luminous cyan and azure as the main colors, a small soft violet accent on one facet. Deep midnight navy rounded-square background tile, with genuinely transparent pixels outside the rounded corners. Tile nearly fills the canvas; the V occupies about 65% of its width. Crisp high contrast, balanced optical centering.
No text or wordmark, no lock, no shield, no eye, no play-button triangle, no QR code, no film perforations, no circuit traces, no sparkles, no glow bloom, no heavy 3D extrusion, no environment, no extra frame, no existing brand logos. This is an app-ready icon concept, not a poster.
```
