#!/usr/bin/env bash
# Tile-size / margin experiment: how much quality does tile scrambling lose once
# the scrambled video has been re-encoded the way a video platform would?
#
# For a baseline (identity permutation) and each tile:margin configuration:
#   source -> raw frames -> raw_pipe scramble -> x264 crf16 slow        = scrambled.mp4
#   scrambled.mp4 -> platform-like transcode per tier                    = plat_<tier>.mp4
#   plat_<tier>.mp4 -> scale back -> raw_pipe restore -> ffv1 lossless   = restored_<tier>.mkv
#   restored_<tier>.mkv vs source: PSNR / SSIM / VMAF
#
# Platform tiers are derived from the *uploaded* (scrambled) size: "native" keeps
# it, "low" scales it by 2/3 so tile edges land on fractional pixels. Platform
# bitrate is modelled as proportional to pixel count, 1800 kbps at the source size.
#
# Run from Git Bash. PowerShell 5.1 pipes are not binary-safe, which rules it
# out for the ffmpeg | raw_pipe | ffmpeg stages.
#
# Usage: scripts/experiment/tile_size.sh <input video> [tile:margin ...]
#   default: 16:0 16:4 16:8 40:0 40:4 40:8
#   PIXFMT=rgb24 selects the packed RGB path instead of planar yuv420p.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -W)"
FFMPEG="$ROOT/tools/ffmpeg/ffmpeg.exe"
FFPROBE="$ROOT/tools/ffmpeg/ffprobe.exe"
RAW_PIPE="$ROOT/target/release/examples/raw_pipe.exe"
SEED=20260916
PIXFMT="${PIXFMT:-yuv420p}"
BASE_KBPS=1800

INPUT="${1:?usage: tile_size.sh <input video> [tile:margin ...]}"
shift
CONFIGS=("$@")
if [[ ${#CONFIGS[@]} -eq 0 ]]; then
    CONFIGS=(16:0 16:4 16:8 40:0 40:4 40:8)
fi

OUT="$ROOT/target/experiment/$(basename "${INPUT%.*}")-$PIXFMT"
mkdir -p "$OUT"
SRC="$OUT/source.mp4"
cp -f "$INPUT" "$SRC"

(cd "$ROOT" && cargo build --release --example raw_pipe --quiet)

probe() {
    "$FFPROBE" -v error -select_streams v:0 -show_entries "stream=$1" -of default=noprint_wrappers=1:nokey=1 "$SRC"
}
W=$(probe width)
H=$(probe height)
FPS=$(probe r_frame_rate)
DURATION=$("$FFPROBE" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$SRC")

# Colour handling differs per path: yuv420p frames pass through untouched and
# only need tagging; rgb24 frames need an explicit bt709 matrix on the way back.
if [[ $PIXFMT == yuv420p ]]; then
    ENCODE_COLOR=(-pix_fmt yuv420p -color_range tv -colorspace bt709 -color_primaries bt709 -color_trc bt709)
else
    ENCODE_COLOR=(-vf scale=out_color_matrix=bt709:out_range=tv -pix_fmt yuv420p
                  -color_range tv -colorspace bt709 -color_primaries bt709 -color_trc bt709)
fi

echo "source: ${W}x${H} @ ${FPS} fps, ${DURATION}s; path $PIXFMT; out: $OUT"

kbps() {
    local bytes
    bytes=$(stat -c %s "$1")
    awk -v b="$bytes" -v d="$DURATION" 'BEGIN { printf "%.0f", b * 8 / d / 1000 }'
}

even() { echo $(( ($1 + 1) / 2 * 2 )); }

# metric <restored> <filter> <regex>: last match of <regex> in ffmpeg's log.
#
# Both inputs are forced to the same colour tags: if they differ, libavfilter
# silently inserts a YUV->RGB->YUV conversion in front of the metric filter and
# the numbers become meaningless. Frames are paired by index rather than by
# timestamp because Matroska rounds 1/30 s to whole milliseconds.
TAGS=(-color_range tv -colorspace bt709 -color_primaries bt709 -color_trc bt709)
ALIGN="settb=${FPS#*/}/${FPS%/*},setpts=N"
metric() {
    "$FFMPEG" -v info -nostats "${TAGS[@]}" -i "$1" "${TAGS[@]}" -i "$SRC" \
        -lavfi "[0:v]$ALIGN[a];[1:v]$ALIGN[b];[a][b]$2" \
        -f null - 2>&1 | grep -oE "$3" | tail -1 || true
}

# run_config <name> <tile> <margin> <forward mode> <inverse mode>
run_config() {
    local name=$1 tile=$2 margin=$3 forward=$4 inverse=$5
    local dir="$OUT/$name"
    mkdir -p "$dir"
    local sw=$(( W / tile * (tile + 2 * margin) ))
    local sh=$(( H / tile * (tile + 2 * margin) ))
    echo "== $name (tile $tile, margin $margin, uploads ${sw}x${sh})"

    "$FFMPEG" -v error -nostats -i "$SRC" -f rawvideo -pix_fmt "$PIXFMT" - \
        | "$RAW_PIPE" "$forward" "$W" "$H" "$tile" "$margin" "$SEED" "$PIXFMT" \
        | "$FFMPEG" -v error -nostats \
            -f rawvideo -pix_fmt "$PIXFMT" -s "${sw}x${sh}" -framerate "$FPS" -i - -i "$SRC" \
            -map 0:v -map '1:a?' -c:a copy "${ENCODE_COLOR[@]}" \
            -c:v libx264 -preset slow -crf 16 -y "$dir/scrambled.mp4"

    local row="| $name | $tile | $margin | ${sw}x${sh} | $(kbps "$dir/scrambled.mp4") |"
    local tier tw th tkbps
    for tier in native low; do
        if [[ $tier == native ]]; then
            tw=$sw; th=$sh
        else
            tw=$(even $(( sw * 2 / 3 ))); th=$(even $(( sh * 2 / 3 )))
        fi
        tkbps=$(( BASE_KBPS * tw * th / (W * H) ))

        "$FFMPEG" -v error -nostats -i "$dir/scrambled.mp4" -an \
            -vf "scale=${tw}:${th}:flags=bicubic" \
            -pix_fmt yuv420p -color_range tv -colorspace bt709 -color_primaries bt709 -color_trc bt709 \
            -c:v libx264 -preset medium -b:v "${tkbps}k" \
            -maxrate "$((tkbps * 3 / 2))k" -bufsize "$((tkbps * 2))k" \
            -y "$dir/plat_$tier.mp4"

        "$FFMPEG" -v error -nostats -i "$dir/plat_$tier.mp4" \
            -vf "scale=${sw}:${sh}:flags=bicubic" -f rawvideo -pix_fmt "$PIXFMT" - \
            | "$RAW_PIPE" "$inverse" "$W" "$H" "$tile" "$margin" "$SEED" "$PIXFMT" \
            | "$FFMPEG" -v error -nostats \
                -f rawvideo -pix_fmt "$PIXFMT" -s "${W}x${H}" -framerate "$FPS" -i - \
                "${ENCODE_COLOR[@]}" -c:v ffv1 -y "$dir/restored_$tier.mkv"

        local psnr ssim vmaf
        psnr=$(metric "$dir/restored_$tier.mkv" psnr 'average:[0-9.]+' | cut -d: -f2)
        ssim=$(metric "$dir/restored_$tier.mkv" ssim 'All:[0-9.]+' | cut -d: -f2)
        vmaf=$(metric "$dir/restored_$tier.mkv" libvmaf 'VMAF score: [0-9.]+' | awk '{print $3}')
        row+=" ${tw}x${th}@${tkbps}k | ${psnr:-n/a} | ${ssim:-n/a} | ${vmaf:-n/a} |"
        echo "   $tier ${tw}x${th}@${tkbps}k: psnr ${psnr:-n/a} ssim ${ssim:-n/a} vmaf ${vmaf:-n/a}"
    done
    ROWS+=("$row")
}

ROWS=()
NAMES=(identity)
IFS=: read -r first_tile _ <<<"${CONFIGS[0]}"
run_config identity "$first_tile" 0 identity identity
for config in "${CONFIGS[@]}"; do
    IFS=: read -r tile margin <<<"$config"
    name="t${tile}m${margin}"
    NAMES+=("$name")
    run_config "$name" "$tile" "$margin" scramble restore
done

# Visual comparison: a 2x nearest-neighbour zoom of the same central region from
# the source and every restored output, side by side, plus the scrambled frames.
CROP_W=180; CROP_H=240
CROP_X=$(( (W - CROP_W) / 2 )); CROP_Y=$(( (H - CROP_H) / 2 ))
ZOOM="crop=${CROP_W}:${CROP_H}:${CROP_X}:${CROP_Y},scale=$((CROP_W * 2)):$((CROP_H * 2)):flags=neighbor"
SNAP=$(awk -v d="$DURATION" 'BEGIN { printf "%.2f", d / 2 }')

for tier in native low; do
    inputs=("${TAGS[@]}" -ss "$SNAP" -i "$SRC")
    for name in "${NAMES[@]}"; do
        inputs+=("${TAGS[@]}" -ss "$SNAP" -i "$OUT/$name/restored_$tier.mkv")
    done
    n=$(( ${#NAMES[@]} + 1 ))
    chain=""
    for ((i = 0; i < n; i++)); do chain+="[$i:v]$ZOOM[z$i];"; done
    for ((i = 0; i < n; i++)); do chain+="[z$i]"; done
    "$FFMPEG" -v error "${inputs[@]}" -lavfi "${chain}hstack=inputs=$n" \
        -frames:v 1 -y "$OUT/compare_$tier.png"
done

inputs=()
for name in "${NAMES[@]}"; do inputs+=(-ss "$SNAP" -i "$OUT/$name/scrambled.mp4"); done
n=${#NAMES[@]}
chain=""
for ((i = 0; i < n; i++)); do chain+="[$i:v]scale=-2:480[s$i];"; done
for ((i = 0; i < n; i++)); do chain+="[s$i]"; done
"$FFMPEG" -v error "${inputs[@]}" -lavfi "${chain}hstack=inputs=$n" \
    -frames:v 1 -y "$OUT/scrambled_frames.png"

{
    echo "# Tile/margin experiment: $(basename "$INPUT") via $PIXFMT"
    echo
    echo "Source ${W}x${H} @ ${FPS} fps, ${DURATION}s, $(kbps "$SRC") kbps. Seed $SEED."
    echo "Platform model: bitrate = $BASE_KBPS kbps × (tier pixels / source pixels); low tier = 2/3 scale of the upload."
    echo
    echo "| config | tile | margin | upload | upload kbps (crf16) | native tier | PSNR | SSIM | VMAF | low tier | PSNR | SSIM | VMAF |"
    echo "|---|---|---|---|---|---|---|---|---|---|---|---|---|"
    printf '%s\n' "${ROWS[@]}"
    echo
    echo "Images: compare_native.png, compare_low.png (source, ${NAMES[*]}; 2x zoom of the centre), scrambled_frames.png (${NAMES[*]})."
} | tee "$OUT/summary.md"
