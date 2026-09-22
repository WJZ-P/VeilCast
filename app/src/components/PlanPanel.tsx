import { useEffect, useState } from "react";

import { type EncoderInfo, type PlanPreview, hardwareEncoder, planPreview } from "../ipc";
import { Field, Note, Panel, Row } from "./ui";

export interface PlanSettings {
  width: number;
  height: number;
  tile: number;
  margin: number;
  seed: string;
  invert: boolean;
  intro: boolean;
  seedInIntro: boolean;
  gpu: boolean;
  /** Reverse time inside audio blocks; `audioMs` is the block length. */
  audio: boolean;
  audioMs: number;
}

interface Props {
  settings: PlanSettings;
  onChange: (settings: PlanSettings) => void;
  /** Whether width/height came from the file rather than the user. */
  sizeFromFile: boolean;
}

function describe(preview: PlanPreview): string {
  const { work } = preview;
  const padding =
    work.pad_right || work.pad_bottom
      ? `右补 ${work.pad_right}、下补 ${work.pad_bottom} 像素 → ${work.width} × ${work.height}，`
      : "";
  return `${padding}${preview.columns} × ${preview.rows} = ${preview.tile_count} 个 tile，上传尺寸 ${preview.upload_width} × ${preview.upload_height}`;
}

/** Tile/margin/seed with the resulting upload size, validated by the core crate. */
export function PlanPanel({ settings, onChange, sizeFromFile }: Props) {
  const [preview, setPreview] = useState<PlanPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  // undefined while detecting, null when no hardware encoder initialises.
  const [encoder, setEncoder] = useState<EncoderInfo | null | undefined>(undefined);
  const { width, height, tile, margin } = settings;

  useEffect(() => {
    let cancelled = false;
    hardwareEncoder()
      .then((result) => {
        if (!cancelled) setEncoder(result);
      })
      .catch(() => {
        if (!cancelled) setEncoder(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    planPreview({ width, height, tile, margin })
      .then((result) => {
        if (cancelled) return;
        setPreview(result);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setPreview(null);
        setError(String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [width, height, tile, margin]);

  const number = (name: "width" | "height" | "tile" | "margin", label: string, step = 1) => (
    <Field>
      {label}
      <input
        type="number"
        min={0}
        step={step}
        value={settings[name]}
        onChange={(e) => onChange({ ...settings, [name]: Number(e.currentTarget.value) })}
      />
    </Field>
  );

  return (
    <Panel>
      <Row>
        {number("width", sizeFromFile ? "原始宽度（来自文件）" : "原始宽度")}
        {number("height", sizeFromFile ? "原始高度（来自文件）" : "原始高度")}
        {number("tile", "tile（偶数）", 2)}
        {number("margin", "margin（偶数）", 2)}
        <Field>
          seed（数字或任意文字）
          <input
            type="text"
            value={settings.seed}
            onChange={(e) => onChange({ ...settings, seed: e.currentTarget.value })}
          />
        </Field>
      </Row>
      <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          type="checkbox"
          checked={settings.invert}
          onChange={(e) => onChange({ ...settings, invert: e.currentTarget.checked })}
        />
        反色（加密与还原两端需保持一致）
      </label>
      <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          type="checkbox"
          checked={settings.intro}
          onChange={(e) => onChange({ ...settings, intro: e.currentTarget.checked })}
        />
        片头二维码（1 秒，写入尺寸、tile、margin、反色；解密时跳过）
      </label>
      <label style={{ display: "flex", alignItems: "center", gap: 8, opacity: settings.intro ? 1 : 0.5 }}>
        <input
          type="checkbox"
          checked={settings.seedInIntro}
          disabled={!settings.intro}
          onChange={(e) => onChange({ ...settings, seedInIntro: e.currentTarget.checked })}
        />
        把 seed 也写进二维码（任何人装了脚本都能观看）
      </label>
      <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          type="checkbox"
          checked={settings.audio}
          onChange={(e) =>
            onChange({
              ...settings,
              audio: e.currentTarget.checked,
              // Settings saved by the earlier "0 = off" field hold 0 here.
              audioMs: settings.audioMs > 0 ? settings.audioMs : 250,
            })
          }
        />
        音频加扰（分块倒放，解密时自动还原）
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, opacity: settings.audio ? 1 : 0.5 }}>
          块长
          <input
            type="number"
            min={50}
            step={50}
            value={settings.audioMs}
            disabled={!settings.audio}
            onChange={(e) => onChange({ ...settings, audioMs: Number(e.currentTarget.value) })}
            style={{ width: 72 }}
          />
          ms
        </span>
      </label>
      <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          type="checkbox"
          checked={settings.gpu}
          onChange={(e) => onChange({ ...settings, gpu: e.currentTarget.checked })}
        />
        尝试用显卡编码（NVENC / AMF / Quick Sync，不可用时自动回退 CPU）
        <span style={{ color: "#8f8fa3", fontSize: 12 }}>
          {encoder === undefined
            ? "检测中…"
            : encoder
              ? `检测到 ${encoder.label}（${encoder.codec}）`
              : "未检测到可用的显卡编码器，将使用 CPU（libx264）"}
        </span>
      </label>
      <Note tone={error ? "error" : undefined}>
        {error ? error : preview ? describe(preview) : "…"}
      </Note>
    </Panel>
  );
}
