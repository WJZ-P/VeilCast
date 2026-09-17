// Typed wrappers around the Tauri commands in src-tauri/src/lib.rs.
import { invoke } from "@tauri-apps/api/core";

export interface PlanParams {
  width: number;
  height: number;
  tile: number;
  margin: number;
}

export interface PlanPreview {
  columns: number;
  rows: number;
  tile_count: number;
  upload_width: number;
  upload_height: number;
}

/** Rejects with the core crate's error message when the parameters are invalid. */
export function planPreview(params: PlanParams): Promise<PlanPreview> {
  return invoke<PlanPreview>("plan_preview", { ...params });
}
