# VeilCast 桌面端

Tauri 2 + React 19 + TypeScript，样式用 Linaria（`@linaria/react` 的 `styled` 语法，构建期提取为静态 CSS，零运行时）。
Rust 壳在 `src-tauri/`，是根 workspace 的成员，通过 path 依赖 `veilcast-core`。

## 命令

```text
npm install          # 首次
npm run tauri dev    # 开发：起 Vite（5173）并打开窗口，前后端都热更新
npm run build        # 只构建前端到 dist/（tsc + vite）
npm run tauri build  # 打包安装程序
```

在仓库根目录 `cargo build -p veilcast-app` / `cargo clippy --workspace` 也能编译壳。

仅生成可独立运行的程序、不创建安装包：先在 `app/` 执行 `npm run build`，再在仓库根目录执行
`cargo build --release -p veilcast-app --features tauri/custom-protocol`。
`custom-protocol` 用于内嵌已构建的前端，避免依赖 Vite 开发服务器。

开发端口是 5173/5174 而不是 Tauri 模板默认的 1420：Windows 的 Hyper-V 会保留 1331–1430 这一段，
`netsh interface ipv4 show excludedportrange protocol=tcp` 可以查看。

## 功能

拖入或选择一个视频 → 调 tile / margin / seed / 反色 → 选输出目录（留空放在视频旁边）→ 加密或解密。
默认 tile 40、margin 0：上传尺寸等于原尺寸，平台按原档位处理，观众看到完整分辨率；代价是 tile 边缘有淡淡接缝。
每一步都有反馈：探测到的分辨率、帧率、时长；参数是否合法及打乱后的上传尺寸；逐帧进度；
完成后输入和输出各一张中间帧的快照，方便对比不同参数的效果。

- **任意尺寸都能处理**：宽高不是 tile 的整数倍时，打乱前把右边和下边补到整数倍（复制边缘像素，不是黑边），
  解密后裁回原尺寸。1920×1078 + tile 40 → 补 2 行按 1920×1080 处理。核心库本身仍要求整除，补边只在应用层。
- 加密输出命名 `<原名>.veilcast-t<tile>m<margin>.mp4`，音轨原样复制，并在 mp4 的 comment 元数据里写入
  `veilcast/1 width= height= tile= margin= source=WxH invert=0/1`（width/height 是补齐后的工作尺寸，source 是原尺寸，不含 seed）。
  开启反色时文件名增加 `-inv` 后缀，避免与相同参数的非反色输出混淆。
  再把这个文件拖回来，程序会自动认出并填好几何参数和反色状态；旧文件没有 invert 字段时默认关闭。
- **片头二维码**（默认开）：加密时在最前面加 1 秒白底二维码（H 级纠错，占短边 60%），内容是核心库的 `IntroHeader`
  纯数字串——原始宽高、tile、margin、反色、音频块长，勾选"把 seed 也写进二维码"后还包含数值化的 seed。
  音轨相应延后 1 秒（重编码为 AAC）。解密时自动跳过片头并把音轨裁回，输出时长与原片一致。
  探测文件时元数据缺失就从片头帧读码（`rqrr`），所以从平台下载回来的文件也能自动填参数；
  实测元数据抹掉并转码到 360p / 400 kbps 后仍可读。
- 解密输出命名 `<原名>.restored.mp4`。输入若被平台缩放过，会先按计划的上传尺寸缩回再还原。
- **音频分块反转**（默认关，填毫秒数开启，建议 250）：音轨统一重采样到 48 kHz，按固定时长切块、块内时间倒放。
  变换是自身的逆，加密解密是同一个操作；只移动整帧、不改任何样本值，单独这一步往返逐样本一致（FLAC 中转，有测试）。
  块栅格锚定在内容起点（片头之后），末尾不足一块的部分原样保留。块长写进元数据 `audio=<ms>`，拖回来会自动填；
  片头二维码也带块长，所以从平台下载回来、元数据已被抹掉的文件同样能自动填好。
  实测（元数据以外全链路，中间模拟平台 AAC 重编码）：250 ms 块相对不加扰只多损失约 1–1.5 dB SNR；
  100 ms 损失更多（块边界更多），500 ms 最少；上传的音轨与原音 SNR 约 −3 dB，即完全不相关。
- **显卡编码**（默认开）：启动时依次让 `h264_nvenc`、`h264_amf`、`h264_qsv` 试编一帧（ffmpeg 列出的编码器不等于驱动可用），
  第一个成功的用于加密和解密的输出，面板上会显示检测结果；都不可用时静默回退 libx264 `medium` crf 16，结果里也会写明实际用的编码器。
  硬件编码器的质量参数按 VMAF 对齐到 libx264 的档位：NVENC `p4` cq 19 与 x264 质量相当、体积小约 10%、整条管道快 3.5 倍
  （2560×1376 混淆内容实测约 270 fps，此时瓶颈变成管道本身）；AMF 用 cqp 17/19，Ryzen 核显上质量略低于 x264；QSV 未实测。
  整条管道不用 GPU 做别的事，解码和分块复制都在 CPU，占比不到 5%。
- seed 可以是数字或任意文字，规则见核心库 `seed_from_text`。
- 启动时可通过第一个命令行参数或 `VEILCAST_OPEN` 环境变量直接打开一个视频。
- 参数保存在 localStorage，下次打开沿用。
- **反色默认关闭**，还原方必须与加密方一致。启用时先统一为有限范围 YUV，再在 Rust 中原地反色；输出标记为有限范围。
  首版面向 SDR；检测到 PQ/HLG 标记的 HDR 输入时提示先转 SDR。超范围样本会裁剪，不承诺有损编码后的逐字节还原。

ffmpeg 的查找顺序：`VEILCAST_FFMPEG_DIR` → 可执行文件旁边 → 开发仓库的 `tools/ffmpeg` → PATH。
打包时的 sidecar 配置还没做。

## 结构

- `src/App.tsx` — 状态与流程
- `src/components/DropZone.tsx` — Tauri 原生拖放 + 文件对话框
- `src/components/PlanPanel.tsx` — 尺寸 / tile / margin / seed / 反色与上传尺寸预览
- `src/components/JobPanel.tsx` — 输出目录、加密 / 解密按钮、进度、结果
- `src/components/Snapshots.tsx` — 输入 / 输出快照
- `src/components/ui.tsx` — 共用的 Linaria 基础组件
- `src/ipc.ts` — Tauri 命令的类型化封装
- `src-tauri/src/lib.rs` — 命令：`plan_preview`、`initial_file`、`probe_video`、`snapshot`、`run_job`（进度走 `Channel`）
- `src-tauri/src/ffmpeg.rs` — ffmpeg 子进程：探测、截帧、解码 → 核心库 → 编码的管道
- `src-tauri/src/intro.rs` — 片头二维码的渲染（`qrcode`）与读取（`rqrr`）
- `src-tauri/tests/pipeline.rs` — 用真实 ffmpeg 跑一遍加密 → 解密；找不到 ffmpeg 或样例视频时跳过
- `src-tauri/tests/invert_pipeline.rs` — 自动合成有限/全范围源片，验证反色、元数据、往返还原及关闭反色的差异

## Linaria 注意事项

- 组件里 `styled.div<{ active: boolean }>` 的动态插值会编译成 CSS 变量，由一个很小的运行时在渲染时设置；静态部分全部进 CSS 文件。
- `vite.config.ts` 里 `wyw({ include: ["**/*.{ts,tsx}"], prefixer: false })`：WebView2 是 Chromium，不需要旧浏览器前缀。
- 全局样式（reset、字体）放在 `src/global.css`，不走 Linaria。
