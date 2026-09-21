# VeilCast B 站油猴插件

在 `.bpx-player-primary-area` 内查找 `video`，用 WebGL2 叠加还原画面。
直接复用 `viewer/veilcast.js` 的 SplitMix64、Fisher–Yates、FNV-1a 和 margin 裁除逻辑。
不重新下载视频，不改视频 `src`、音轨、弹幕或播放进度。

## 安装与使用

1. 首次安装：在油猴管理器中新建脚本，把 `userscript/veilcast.user.js` 的**完整内容**粘贴进去并保存。
   从旧版升级：在原脚本编辑页全文替换、保存，再刷新视频页；当前版本 **0.1.2**，不要同时启用两份副本。
2. 打开或刷新 `https://www.bilibili.com/video/*` 视频页。
3. 点击**分享右侧**的 **VeilCast · 关**，在按钮下方弹出的设置窗口填写参数，再点击 **启用还原**。
4. **停用还原**会立即撤去还原画面；**应用参数**会保存参数，启用中则重建还原计划。
   也可从油猴菜单「VeilCast：还原参数」展开面板。Esc、关闭按钮或点击窗口外部都可关闭。
   窗口不占工具栏布局；空间不足时滚动页面腾出下方空间，短视口内限高滚动。

**片头二维码（默认开）**：桌面端加密的视频前 1 秒是一张二维码。脚本在播放头位于前 1.5 秒时每 100 ms 抓一帧解码
（内置 jsQR，不依赖 `BarcodeDetector`），读到 VeilCast 的数字协议后自动填入宽高、tile、margin、反色
（片头含 seed 时连 seed 一起），保存并**自动启用还原**。普通视频里的其他二维码不会通过版本号和校验位，因此不会误启用。
从中途续播的视频读不到片头，此时仍需手动填写或读取简介；设置窗口里可以关闭这一行为。

脚本初始关闭还原，避免扰乱普通视频；参数保存于油猴的脚本存储中。
同页清晰度切换或替换 video 时继续绑定；切到不同视频或分 P 时关闭还原，保留参数供手动启用。

## 参数

| 参数 | 默认值 | 含义 |
| --- | --- | --- |
| seed | `20040821` | 与桌面端逐字符一致，支持数字、中文和空字符串，不去除空白 |
| tile / tail | `40` | 原图中的方块边长，正偶数；`tail` 是兼容别名 |
| margin | `0` | 每边保护像素数量，非负偶数 |
| invert / 反色 | `false` | 仅在桌面端加密时开启了反色的情况下勾选，然后应用参数 |
| 原始宽度 | `720` | 加密前的视频宽度，直接显示在设置窗口中 |
| 原始高度 | `1280` | 加密前的视频高度，直接显示在设置窗口中 |

默认配置来自 `app/src/default-settings.json`，Tauri 直接引用同一文件。
修改默认值或浏览器核心后重新构建脚本，`--check` 可检测产物是否过期。

**原始宽高不是平台播放分辨率。** 平台可能缩放上传视频，并丢弃本地 MP4 的参数标签，
仅靠 seed、tile、margin 和当前 `videoWidth` 不足以唯一确定原始网格。
本插件使用明确的原始尺寸计算补齐网格，并在上传画面的归一化坐标中采样。
尺寸错误或 seed 错误会得到错误画面；此扰乱格式没有认证标签来识别错误 seed。

**读取简介参数**仅解析 `#v_desc` 中明确标注的宽、高、tile/tail、margin、seed 五项字段，
只填表单，不自动保存或启用。还可写 `invert=1` / `invert=0`（或 true/false）；省略时关闭反色，兼容旧视频。
简介中的 seed 使用无空白的单个词；复杂文字 seed 请手动输入。
例如用户测试视频的参数行：

```text
原始宽2560，高1370 tile 16 margin 4 seed 20260916
```

对应网格为 160×86，工作尺寸 2560×1376，上传尺寸 3840×2064。
测试此视频时请使用以上参数，而不是修改全局 Tauri 默认值。

还可通过 URL 参数预填（仍需手动启用）：

```text
?vc_seed=20260916&vc_tile=40&vc_margin=0&vc_width=720&vc_height=1280
```

`vc_tail` 等同于 `vc_tile`，两者同时出现时以 `vc_tile` 为准。
`vc_invert=1` / `vc_invert=true` 打开反色，`0` / `false` 关闭；未指定时沿用已保存值，首次默认为关闭。
URL 的值覆盖已保存值；URL 中的 `+` 要写成 `%2B`。
URL 参数会进入站点请求和浏览器历史；需要保密的 seed 应在面板中填写，不放进链接。

## 实现与边界

- `src/settings.js`：参数校验、tail 别名、带 `vc_` 前缀的 URL 参数及明确简介字段解析。
- `src/main.js`：分享右侧入口、Shadow DOM 原生 dialog、动态播放器绑定、帧调度和生命周期清理。
- `build.mjs`：将核心、参数和页面集成内联为 `veilcast.user.js`；无 npm 依赖、无 CDN。
  `viewer/vendor/jsQR.js`（Apache-2.0）以本地 CommonJS 壳内联，不挂到页面 window 上。
- 帧循环优先使用 `requestVideoFrameCallback`，旧浏览器回退到 rAF；暂停/后台时停止主动帧循环，拖动进度后重绘。
- 反色合并在原有 shader 中：采样、逆重排、丢弃 margin 后按开关执行 `1-RGB`，不改 alpha；参数持久化保存明确的布尔值。
  与桌面端的有限范围 SDR YUV 反色对应。开关不一致时会显示负片，旧视频应保持关闭。
- 入口紧接 `#arc_toolbar_report .video-toolbar-left-main`，不再覆盖在视频右上角。
  使用 `dialog.showModal()` 的浏览器顶层显示设置窗口，避开播放器/工具栏的 overflow 和层叠裁剪；工具栏重建时自动迁移入口并保留表单草稿。
- Canvas 在视频容器内且 `pointer-events:none`，保留外层控制栏和弹幕的层次；还原画面适配容器缩放与播放器容器全屏。
  全屏切换会关闭设置窗口，常规工具栏入口留在视频外；可退出全屏调整参数。
- WebGL 错误、跨域纹理读取失败或上下文丢失时关闭还原、保留原播放器，不更改站点视频请求。
- 原生视频画中画、只把 video 元素全屏的模式不包含旁边的 Canvas。音频仍为原音轨。
- 仅支持保持整幅网格的转码/缩放；平台裁剪、额外黑边和覆盖式水印可能影响还原。
- 为限制误输入开销：每个尺寸不超过 16384、画面像素数不超过 7680×4320、方块数不超过 262144、seed 最长 4096 字符；还会检查 GPU 限制。
- 分块扰乱不属于密码学加密。这里没有上传或修改平台内容，也没有平台兼容性/性能保证。

## 构建与验证

脚本头部的 `@version` 取自 `userscript/package.json` 的 `version`：每次改动源码后先把它加一位，再重新构建，
油猴才会把新脚本视为更新。在仓库根目录运行：

```text
node userscript/build.mjs
node userscript/build.mjs --check
node --test userscript/tests/*.test.mjs viewer/*.test.mjs
```

浏览器集成验证使用合成画面，经**真实 Rust 核心**打乱；文件仅写入忽略目录 `target/userscript-smoke/`：

```text
node userscript/tests/prepare-browser.mjs
node viewer/serve.mjs 8767
```

打开 `http://127.0.0.1:8767/userscript/tests/browser.html`。
片头二维码路径另有 `userscript/tests/intro.html`：它加载 `cargo test -p veilcast-app --test pipeline` 生成的
`target/tmp/pipeline-intro/low.mp4`（元数据已抹、360p 转码），检查脚本在第一秒内自动纠正错误参数并启用还原。
测试会自动检查默认值、延迟挂载、分享右侧位置、模态窗口/关闭操作、简介导入、工具栏重建、像素还原、margin/裁剪、半尺寸视频、暂停、节点替换、rAF、上下文恢复及 SPA 切换。
页面提供全屏/播放按钮供人工检查。该页面用测试存储代替 GM API，**不等同于真实油猴扩展与 B 站线上验证**。
本次已在 Chromium 浏览器通过 12 项集成检查；原尺寸/半尺寸测试的 RGB 最大采样误差分别为 1 / 5。
新增的反色用例使用真实 Rust YUV 反色与 ffmpeg H.264 编码，浏览器还原后的 RGB 最大采样误差为 3。
节点测试 19 项、Rust workspace 测试 31 项及 Tauri 前端构建通过。合成有限/全范围输入的桌面端往返 RGB 平均绝对误差分别约为 0.720 / 0.916；这些是小型测试图的结果，不代表任意视频画质。

## 审阅记录与 API 参考

本轮代码审阅见 [REVIEW.md](REVIEW.md)。

- [Tampermonkey 官方文档：脚本匹配、存储及菜单](https://www.tampermonkey.net/documentation.php)
- [MDN：视频帧回调](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback)
- [MDN：WebGL 视频纹理上传](https://developer.mozilla.org/en-US/docs/Web/API/WebGLRenderingContext/texImage2D)
