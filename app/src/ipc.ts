// Typed wrappers around the Tauri commands in src-tauri/src/lib.rs.
import { Channel, invoke } from "@tauri-apps/api/core";

export interface PlanParams {
  width: number;
  height: number;
  tile: number;
  margin: number;
}

/** Source padded up to a tile multiple (replicated edge pixels), cropped back on restore. */
export interface WorkSize {
  width: number;
  height: number;
  pad_right: number;
  pad_bottom: number;
}

export interface PlanPreview {
  work: WorkSize;
  columns: number;
  rows: number;
  tile_count: number;
  upload_width: number;
  upload_height: number;
}

/** Geometry a scrambled file carries in its metadata (never the seed). */
export interface PlanHint {
  width: number;
  height: number;
  tile: number;
  margin: number;
}

export interface VideoInfo {
  path: string;
  width: number;
  height: number;
  fps: number;
  duration: number;
  frames: number;
  codec: string;
  has_audio: boolean;
  hint: PlanHint | null;
}

export type Mode = "scramble" | "restore";

export interface JobParams extends PlanParams {
  input: string;
  outputDir: string;
  mode: Mode;
  seed: string;
}

export interface Progress {
  done: number;
  total: number;
}

export interface JobResult {
  output: string;
  frames: number;
  work: WorkSize;
  upload_width: number;
  upload_height: number;
}

/** Rejects with the core crate's error message when the parameters are invalid. */
export function planPreview(params: PlanParams): Promise<PlanPreview> {
  return invoke<PlanPreview>("plan_preview", { ...params });
}

/** A file passed on the command line or via VEILCAST_OPEN, if any. */
export function initialFile(): Promise<string | null> {
  return invoke<string | null>("initial_file");
}

export function probeVideo(path: string): Promise<VideoInfo> {
  return invoke<VideoInfo>("probe_video", { path });
}

/** Runs one scramble/restore job; `onProgress` fires from the worker thread as frames go by. */
export function runJob(params: JobParams, onProgress: (progress: Progress) => void): Promise<JobResult> {
  const channel = new Channel<Progress>();
  channel.onmessage = onProgress;
  return invoke<JobResult>("run_job", { params, onProgress: channel });
}

/** A blob URL for one frame of `path`; revoke it when done. */
export async function snapshotUrl(path: string, seconds: number): Promise<string> {
  const bytes = await invoke<ArrayBuffer>("snapshot", { path, seconds });
  return URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
}
