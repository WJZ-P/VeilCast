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

## 结构

- `src/App.tsx` — 页面骨架
- `src/components/DropZone.tsx` — 监听 Tauri 原生拖放事件，拿到文件路径
- `src/components/PlanPanel.tsx` — tile / margin 参数与上传尺寸预览
- `src/ipc.ts` — Tauri 命令的类型化封装
- `src-tauri/src/lib.rs` — 命令实现；`plan_preview` 用核心库校验参数并算出打乱后的尺寸

## Linaria 注意事项

- 组件里 `styled.div<{ active: boolean }>` 的动态插值会编译成 CSS 变量，由一个很小的运行时在渲染时设置；静态部分全部进 CSS 文件。
- `vite.config.ts` 里 `wyw({ include: ["**/*.{ts,tsx}"], prefixer: false })`：WebView2 是 Chromium，不需要旧浏览器前缀。
- 全局样式（reset、字体）放在 `src/global.css`，不走 Linaria。
