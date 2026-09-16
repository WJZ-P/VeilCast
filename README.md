# VeilCast Core

视频画面分块重排的 Rust 核心库。第一轮仅实现已解码帧的空间置换，供接口和基础实现 CR。

## 本轮范围

- 单 crate、零第三方依赖，禁止 `unsafe`。
- 支持 `Gray8` / `Rgb24` / `Rgba32` 交错像素及带行尾 padding 的缓冲区。
- 校验帧布局和完整排列，预计算方块字节偏移。
- 同一计划复用于多帧，逐帧扰乱与还原阶段零堆分配。
- 调用方持有输入、输出缓冲区；两者布局相同，使用独立缓冲区。

暂不涉及：密钥派生、种子和排列生成、参数持久化、编解码、YUV 平面、音频、播放器、并行与 SIMD。
后续可由独立模块从密钥和文件随机参数生成排列，再交给本层；密钥计算留在逐帧热点路径之外。

**分块重排是可逆扰乱，不是密码学加密。** 测试中的逐字节还原仅针对本库直接处理的像素，
不代表经有损压缩、缩放或裁剪后仍能精确恢复。这里尚未评测吞吐量。

## 最小用法

```rust
use veilcast_core::{FrameLayout, PixelFormat, ShufflePlan};

fn main() -> Result<(), veilcast_core::Error> {
    // 4×2 灰度帧，每行 4 字节；切为 4 个 2×1 方块。
    let layout = FrameLayout::new(4, 2, PixelFormat::Gray8, 4)?;
    let plan = ShufflePlan::new(layout, 2, 1, &[2, 0, 3, 1])?;
    let original = [0, 1, 2, 3, 4, 5, 6, 7];
    let mut scrambled = [0; 8];
    let mut restored = [0; 8];

    plan.scramble(&original, &mut scrambled)?;
    assert_eq!(scrambled, [4, 5, 0, 1, 6, 7, 2, 3]);
    plan.restore(&scrambled, &mut restored)?;
    assert_eq!(restored, original);
    Ok(())
}
```

## CR 重点：接口契约

1. **排列方向**：方块按从左到右、从上到下编号；`permutation[目标块] = 源块`。
   例如 `[2, 0, 3, 1]` 将源块 2 放到目标块 0；还原时交换预计算的源/目标偏移。
   构造函数只借用排列，计划保有自己的偏移数据。
2. **尺寸与 stride**：宽高及块尺寸使用像素单位，stride 使用字节单位。
   块尺寸须整除帧宽高，否则返回错误；本轮没有隐式裁剪或补齐。
3. **缓冲区**：至少需要 `stride × height` 字节，包含最后一行的 padding。
   只写入有效像素；输出行尾 padding 及缓冲区多余尾部保持调用前的值。
   调用方若需要确定的 padding 内容，应提前初始化输出缓冲区。
4. **失败行为**：无效排列在构造阶段返回错误；缓冲区不足在复制前返回错误，输出保持原样。
   初始化阶段分配计划内存，逐帧处理阶段仅执行验证和按块逐行复制。
5. **复用边界**：同一计划对应固定布局、块尺寸和排列；布局变化时需要重新构造。
   本层不修改帧顺序，也不管理时间戳。

## 本地验证

在仓库根目录运行：

```text
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
cargo build --release
cargo run --release --example round_trip
```

测试包含已知排列方向、逆向还原、跨像素格式/块尺寸/stride 的像素级参考对照、
计划与缓冲区复用、padding 保持、整数溢出及错误输入。
示例使用两帧合成 RGB 数据，不读取或生成实际视频文件。
