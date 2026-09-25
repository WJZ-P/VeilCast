import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { styled } from "@linaria/react";

import type { JobResult, Mode, Progress } from "../ipc";
import { Button, Field, Note, Panel, Row } from "./ui";

const Bar = styled.div<{ ratio: number }>`
  height: 6px;
  border-radius: 3px;
  background: #2a2a36;
  overflow: hidden;

  &::after {
    content: "";
    display: block;
    height: 100%;
    width: ${({ ratio }) => `${Math.round(ratio * 100)}%`};
    background: #7c6cff;
    transition: width 120ms linear;
  }
`;

export interface JobState {
  running: boolean;
  mode: Mode | null;
  progress: Progress | null;
  result: JobResult | null;
  error: string | null;
}

interface Props {
  outputDir: string;
  onOutputDir: (dir: string) => void;
  canRun: boolean;
  job: JobState;
  onRun: (mode: Mode) => void;
}

/** Output directory, the two actions, and the live state of the current job. */
export function JobPanel({ outputDir, onOutputDir, canRun, job, onRun }: Props) {
  async function pickDir() {
    const chosen = await open({ directory: true, multiple: false, defaultPath: outputDir || undefined });
    if (typeof chosen === "string") onOutputDir(chosen);
  }

  const ratio = job.progress ? job.progress.done / Math.max(1, job.progress.total) : 0;
  const busy = job.running;

  return (
    <Panel>
      <Row>
        <Field style={{ flex: "1 1 320px" }}>
          输出目录（留空则放在视频旁边）
          <input type="text" value={outputDir} onChange={(e) => onOutputDir(e.currentTarget.value)} />
        </Field>
        <Button type="button" onClick={pickDir} disabled={busy}>
          选择目录…
        </Button>
        <Button type="button" primary disabled={!canRun || busy} onClick={() => onRun("scramble")}>
          加密（打乱）
        </Button>
        <Button type="button" primary disabled={!canRun || busy} onClick={() => onRun("restore")}>
          解密（还原）
        </Button>
      </Row>

      {(busy || job.progress) && (
        <>
          <Bar ratio={busy ? ratio : 1} />
          <Note tone="muted">
            {busy
              ? `${job.mode === "scramble" ? "加密" : "解密"}中… ${job.progress?.done ?? 0} / ${job.progress?.total ?? "?"} 帧`
              : `完成，共 ${job.progress?.done ?? 0} 帧`}
          </Note>
        </>
      )}

      {job.error && <Note tone="error">{job.error}</Note>}

      {job.result && !busy && (
        <Row>
          <Note>
            输出：{job.result.output}
            {job.mode === "scramble" && `（${job.result.upload_width} × ${job.result.upload_height}）`}
            {` · 编码器 ${job.result.encoder}`}
            {` · 音频${job.result.audio_ms ? `${job.result.audio_mirror ? "频谱翻转 + " : ""}分块倒放 ${job.result.audio_ms} ms` : "未处理"}`}
          </Note>
          <Button type="button" onClick={() => revealItemInDir(job.result!.output)}>
            在文件夹中显示
          </Button>
        </Row>
      )}
    </Panel>
  );
}
