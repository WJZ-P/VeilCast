# VeilCast Core

视频画面分块重排的 Rust 核心库，配套 ffmpeg 流水线实验和浏览器端 WebGL2 还原器。

目标场景：桌面端（Tauri）把视频打乱后上传视频网站，观众通过油猴脚本在浏览器里实时还原。
平台会重新编码并缩放视频，所以本库的设计围绕"打乱后的画面经有损转码仍能还原到可看"展开。

## 当前范围

- 单 crate、零第三方依赖，禁止 `unsafe`。
- 交错像素 `Gray8` / `Rgb24` / `Rgba32`（`ShufflePlan`）和平面 `yuv420p`（`Yuv420Plan`），支持行尾 padding。
- **保护边（margin）**：每个 tile 连同四周 `margin` 像素的邻居一起搬运，还原时丢弃。
  编码器和缩放在块边缘产生的伪影落在被丢弃的边上，这是画质的关键。
- **种子排列**：`seeded_permutation(tile_count, seed)`，splitmix64 + Fisher-Yates，
  两端各自生成，排列本身不传输；`seed_from_text` 把用户输入的数字或文字变成种子（FNV-1a 64）。
  `viewer/veilcast.js` 有逐位一致的 JS 实现。
- **片头协议**：`IntroHeader` 把宽高、tile、margin、反色和可选 seed 编成一串定长纯数字（18 或 38 位，
  末两位是 mod 97 校验），供桌面端渲染成 1 秒二维码片头、浏览器端扫码后自动配置。布局见 `src/header.rs`，
  `viewer/veilcast.js` 的 `encodeIntroHeader` / `parseIntroHeader` 逐位一致。
- 同一计划复用于多帧，逐帧阶段零堆分配；调用方持有独立的输入、输出缓冲区。

核心库不承担编解码和参数持久化；这些由 `app/` 桌面端和 `userscript/` 浏览器集成负责。
暂不涉及：密码学密钥派生、音频扰乱、并行与 SIMD。

**分块重排是可逆扰乱，不是密码学加密。** 持有种子和参数的任何人都能还原。

## 可选反色

桌面端与油猴均支持 `invert`，默认 `false`；加密和还原时需要使用同一开关值。
桌面端启用时先由 ffmpeg 把输入统一为有限范围 `yuv420p`，再由 Rust 的
`invert_yuv420_limited` 原地执行 `Y'=251-Y`、`U'=256-U`、`V'=256-V`。
浏览器在既有还原 shader 中执行 RGB 的 `1-color`，不增加一次独立绘制。

标称范围为 Y=16..235、UV=16..240，超范围样本先裁剪；两次反色仅对标称范围内的样本精确可逆。
范围转换及视频有损编码仍可能引入误差，初版面向 SDR；检测到 PQ/HLG 标记的 HDR 输入时提示先转 SDR。
文件 comment 元数据保存 `invert=0/1`，旧文件缺少此字段时按关闭处理。音轨不参与反色。

## 最小用法

```rust
use veilcast_core::{FrameLayout, PixelFormat, ShufflePlan, seeded_permutation};

fn main() -> Result<(), veilcast_core::Error> {
    // 4×2 灰度帧，切为 4 个 2×1 tile，每个 tile 带 1 像素保护边。
    let layout = FrameLayout::new(4, 2, PixelFormat::Gray8, 4)?;
    let permutation = seeded_permutation(4, 20260916);
    let plan = ShufflePlan::with_margin(layout, 2, 1, 1, &permutation)?;

    // 打乱后每个块是 4×3，整帧 8×6。
    let scrambled_layout = plan.scrambled_layout();
    assert_eq!((scrambled_layout.width(), scrambled_layout.height()), (8, 6));

    let original = [0, 1, 2, 3, 4, 5, 6, 7];
    let mut scrambled = vec![0; scrambled_layout.buffer_len()];
    let mut restored = [0; 8];
    plan.scramble(&original, &mut scrambled)?;
    plan.restore(&scrambled, &mut restored)?;
    assert_eq!(restored, original);
    Ok(())
}
```

`Yuv420Plan::new(Yuv420Layout::packed(w, h)?, tile_w, tile_h, margin, &permutation)` 对三个平面做同样的事，
色度平面用减半的 tile 和 margin，因此宽高、tile、margin 都必须是偶数。
`Yuv420Layout::split` / `split_mut` 把 ffmpeg `-f rawvideo -pix_fmt yuv420p` 的连续缓冲切成三个平面。

## 接口契约

1. **排列方向**：tile 按从左到右、从上到下编号；`permutation[打乱后的块] = 原始 tile`。
   还原时把块内部的 tile 拷回原位，margin 丢弃。
2. **尺寸与 stride**：宽高、tile、margin 用像素，stride 用字节。tile 须整除帧宽高，没有隐式裁剪或补齐
   （桌面端在库外面把源片补到 tile 的整数倍、还原后裁回，库本身保持严格）。
   打乱后的布局：`columns × (tile_w + 2·margin)` 宽，`rows × (tile_h + 2·margin)` 高，格式和行尾 padding 与原始布局相同。
   帧边缘之外的 margin 用最近的边缘像素填充。
3. **缓冲区**：`scramble(original, scrambled)` 和 `restore(scrambled, original)` 各自按对应布局校验长度。
   只写入有效像素；padding 和缓冲区多余尾部保持调用前的值。
4. **失败行为**：无效排列、奇数尺寸、溢出在构造阶段返回错误；缓冲区不足在复制前返回错误，输出保持原样。
   `Yuv420Plan` 在写任何平面之前校验全部六个缓冲区。
5. **复用边界**：同一计划对应固定布局、tile、margin 和排列；变化时重新构造。本层不改帧顺序，不管时间戳。

## 实验：tile 尺寸与保护边

`scripts/experiment/tile_size.sh <视频> [tile:margin ...]` 模拟完整链路：
打乱 → x264 高质量编码 → 模拟平台转码（原尺寸 + 缩放到 2/3 两档，码率按像素数等比）→ 还原 → 对原片算 PSNR / SSIM / VMAF，
并输出对比图。需要 Git Bash（PowerShell 5.1 管道不是二进制安全的）和 `tools/ffmpeg/`。

720×1280 竖屏测试片的结果（VMAF，identity 为同一链路不打乱的基线）：

| 配置 | 上传尺寸 | 原尺寸档 | 缩放档 | 打乱画面 |
|---|---|---|---|---|
| identity | 720×1280 | 86.1 | 72.3 | — |
| tile 16, margin 0 | 720×1280 | 68.4 | 36.3 | 噪点，不可辨认 |
| **tile 16, margin 4** | 1080×1920 | **75.1** | **61.4** | 噪点，不可辨认 |
| tile 16, margin 8 | 1440×2560 | 78.9 | 60.1 | 噪点，不可辨认 |
| tile 40, margin 0 | 720×1280 | 77.7 | 49.9 | 碎片可辨认局部 |
| tile 40, margin 4 | 864×1536 | 80.5 | 66.2 | 碎片可辨认局部 |

结论：接缝来自编码器和缩放核在块边缘的处理，与色度子采样无关（无损 yuv420p 往返下打乱与否无差别）。
margin 4 消除肉眼可见的网格；再加只涨零点几分，上传体积却继续膨胀。
打乱内容本身更难压缩，同码率下仍比基线低约 10 分，只能靠码率弥补。

实验中踩过的度量坑（已在脚本里处理）：ffmpeg 7+ 在两个输入色彩标签不一致时会自动插入 YUV→RGB→YUV 转换，
psnr/ssim 的参考就此被改掉；Matroska 把 1/30 s 舍入到毫秒，按时间戳配对会隔帧错位。
两个输入必须强制相同标签并按帧序号对齐。

## 浏览器端还原

`viewer/veilcast.js`：`seededPermutation` 与 Rust 逐位一致（`node --test viewer/*.test.mjs` 对拍已知答案向量），
`createRestorer(gl, {width, height, tile, margin, seed})` 用一个 fragment shader 完成还原；
`width`/`height` 是原始尺寸，网格按补齐到 tile 整数倍的工作尺寸计算，和桌面端一致。
采样在上传尺寸的归一化坐标里进行，平台缩放视频不影响 tile 网格；bilinear 采样跨过 tile 内边时落在 margin 上，
那正是原图的邻居像素，所以不会出现接缝。

`viewer/index.html` 是开发用测试页，`node viewer/serve.mjs` 起本地服务后打开 `http://127.0.0.1:8765/`，
可加载 `target/experiment/` 里的转码结果；`?url=&tile=&margin=&t=` 参数可直接定位。

## B 站油猴插件

`userscript/veilcast.user.js` 是可直接安装的单文件脚本，仅匹配 `https://www.bilibili.com/video/*`。
通过 `.bpx-player-primary-area video` 定位播放器，在原视频层叠加 WebGL2 还原画面，保留原播放器控制。
默认 `seed="20260916"`、`tile=40`、`margin=0`；`tail` 作为 `tile` 的兼容别名。
默认值与 Tauri 共用 `app/src/default-settings.json`，构建脚本内联 `viewer/veilcast.js`，不加载远程依赖。

安装、参数、限制和测试步骤见 [userscript/README.md](userscript/README.md)。

## 本地验证

```text
powershell -ExecutionPolicy Bypass -File scripts/fetch-ffmpeg.ps1   # 首次：下载 ffmpeg 到 tools/ffmpeg/
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo build --release --example raw_pipe
node --test viewer/*.test.mjs
bash scripts/experiment/tile_size.sh <视频.mp4>
```

`examples/raw_pipe.rs` 是 stdin→stdout 的裸帧过滤器，实验脚本用它把库接进 ffmpeg 管道。
`tools/ffmpeg/` 不进 git；`scripts/fetch-ffmpeg.ps1` 下载 gyan.dev 的 essentials 构建并校验 SHA256。
该构建含 libx264，属 GPL：作为独立进程调用不影响本仓库许可，但打包发行前要确认。

## 桌面端

`app/` 是 Tauri 2 + React + Linaria 的桌面端骨架，`app/src-tauri` 是根 workspace 的成员并依赖本 crate。
拖入视频、调 tile / margin / seed、选输出目录，一键加密或解密；ffmpeg 以子进程方式接入，逐帧进度和前后快照都在界面里。
见 [app/README.md](app/README.md)。
