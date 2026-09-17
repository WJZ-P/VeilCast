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

开发端口是 5173/5174 而不是 Tauri 模板默认的 1420：Windows 的 Hyper-V 会保留 1331–1430 这一段，
`netsh interface ipv4 show excludedportrange protocol=tcp` 可以查看。

## 功能

拖入或选择一个视频 → 调 tile / margin / seed → 选输出目录（留空放在视频旁边）→ 加密或解密。
每一步都有反馈：探测到的分辨率、帧率、时长；参数是否合法及打乱后的上传尺寸；逐帧进度；
完成后输入和输出各一张中间帧的快照，方便对比不同参数的效果。

- 加密输出命名 `<原名>.veilcast-t<tile>m<margin>.mp4`，音轨原样复制，并在 mp4 的 comment 元数据里写入
  `veilcast/1 width= height= tile= margin=`（不含 seed）。再把这个文件拖回来，程序会自动认出并填好几何参数。
- 解密输出命名 `<原名>.restored.mp4`。输入若被平台缩放过，会先按计划的上传尺寸缩回再还原。
- seed 可以是数字或任意文字，规则见核心库 `seed_from_text`。
- 启动时可通过第一个命令行参数或 `VEILCAST_OPEN` 环境变量直接打开一个视频。
- 参数保存在 localStorage，下次打开沿用。

ffmpeg 的查找顺序：`VEILCAST_FFMPEG_DIR` → 可执行文件旁边 → 开发仓库的 `tools/ffmpeg` → PATH。
打包时的 sidecar 配置还没做。

## 结构

- `src/App.tsx` — 状态与流程
- `src/components/DropZone.tsx` — Tauri 原生拖放 + 文件对话框
- `src/components/PlanPanel.tsx` — 尺寸 / tile / margin / seed 与上传尺寸预览
- `src/components/JobPanel.tsx` — 输出目录、加密 / 解密按钮、进度、结果
- `src/components/Snapshots.tsx` — 输入 / 输出快照
- `src/components/ui.tsx` — 共用的 Linaria 基础组件
- `src/ipc.ts` — Tauri 命令的类型化封装
- `src-tauri/src/lib.rs` — 命令：`plan_preview`、`initial_file`、`probe_video`、`snapshot`、`run_job`（进度走 `Channel`）
- `src-tauri/src/ffmpeg.rs` — ffmpeg 子进程：探测、截帧、解码 → 核心库 → 编码的管道
- `src-tauri/tests/pipeline.rs` — 用真实 ffmpeg 跑一遍加密 → 解密；找不到 ffmpeg 或样例视频时跳过

## Linaria 注意事项

- 组件里 `styled.div<{ active: boolean }>` 的动态插值会编译成 CSS 变量，由一个很小的运行时在渲染时设置；静态部分全部进 CSS 文件。
- `vite.config.ts` 里 `wyw({ include: ["**/*.{ts,tsx}"], prefixer: false })`：WebView2 是 Chromium，不需要旧浏览器前缀。
- 全局样式（reset、字体）放在 `src/global.css`，不走 Linaria。
