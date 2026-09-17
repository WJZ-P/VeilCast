import { useEffect, useState } from "react";
import { styled } from "@linaria/react";

import { type PlanParams, type PlanPreview, planPreview } from "../ipc";

const Panel = styled.section`
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px 16px;
  padding: 16px;
  border-radius: 12px;
  background: #1c1c24;
`;

const Field = styled.label`
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: #8f8fa3;

  input {
    padding: 6px 8px;
    border: 1px solid #3a3a48;
    border-radius: 6px;
    background: #12121a;
    color: #e8e8f0;
    font: inherit;
    font-size: 14px;
  }
`;

const Summary = styled.p<{ error: boolean }>`
  grid-column: 1 / -1;
  margin: 0;
  font-size: 13px;
  color: ${({ error }) => (error ? "#ff7b7b" : "#c8c8d8")};
`;

const DEFAULTS: PlanParams = { width: 720, height: 1280, tile: 16, margin: 4 };

/** Tile/margin settings with the resulting upload size, validated by the core crate. */
export function PlanPanel() {
  const [params, setParams] = useState<PlanParams>(DEFAULTS);
  const [preview, setPreview] = useState<PlanPreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    planPreview(params)
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
  }, [params]);

  const field = (name: keyof PlanParams, label: string) => (
    <Field>
      {label}
      <input
        type="number"
        min={0}
        value={params[name]}
        onChange={(e) => setParams({ ...params, [name]: Number(e.currentTarget.value) })}
      />
    </Field>
  );

  return (
    <Panel>
      {field("width", "宽度")}
      {field("height", "高度")}
      {field("tile", "tile")}
      {field("margin", "margin")}
      <Summary error={error !== null}>
        {error
          ? error
          : preview
            ? `${preview.columns} × ${preview.rows} = ${preview.tile_count} 个 tile，上传尺寸 ${preview.upload_width} × ${preview.upload_height}`
            : "…"}
      </Summary>
    </Panel>
  );
}
