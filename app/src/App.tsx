import { useCallback, useEffect, useRef, useState } from "react";
import { styled } from "@linaria/react";

import { DropZone } from "./components/DropZone";
import { JobPanel, type JobState } from "./components/JobPanel";
import { PlanPanel, type PlanSettings } from "./components/PlanPanel";
import { type Snapshot, Snapshots } from "./components/Snapshots";
import { Note } from "./components/ui";
import { type Mode, type VideoInfo, initialFile, probeVideo, runJob, snapshotUrl } from "./ipc";
import defaultSettings from "./default-settings.json";

const Shell = styled.main`
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 100vh;
  padding: 24px;
  box-sizing: border-box;
`;

const Title = styled.h1`
  margin: 0;
  font-size: 20px;
  font-weight: 500;
  color: #e8e8f0;

  span {
    margin-left: 8px;
    font-size: 13px;
    font-weight: 400;
    color: #8f8fa3;
  }
`;

const SETTINGS_KEY = "veilcast.settings";
const DEFAULT_SETTINGS: PlanSettings & { outputDir: string } = defaultSettings;

function loadSettings(): typeof DEFAULT_SETTINGS {
  try {
    const stored = localStorage.getItem(SETTINGS_KEY);
    return stored ? { ...DEFAULT_SETTINGS, ...JSON.parse(stored) } : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

const IDLE_JOB: JobState = { running: false, mode: null, progress: null, result: null, error: null };

function App() {
  const [file, setFile] = useState<string | null>(null);
  const [info, setInfo] = useState<VideoInfo | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [settings, setSettings] = useState(loadSettings);
  const [sizeFromFile, setSizeFromFile] = useState(false);
  const [job, setJob] = useState<JobState>(IDLE_JOB);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const snapshotUrls = useRef<string[]>([]);

  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }, [settings]);

  // Blob URLs are per-window resources; revoke the ones that leave the strip.
  const showSnapshots = useCallback((items: Snapshot[]) => {
    const keep = new Set(items.map((item) => item.url));
    snapshotUrls.current.filter((url) => !keep.has(url)).forEach((url) => URL.revokeObjectURL(url));
    snapshotUrls.current = [...keep];
    setSnapshots(items);
  }, []);

  const onFile = useCallback(
    async (path: string) => {
      setFile(path);
      setInfo(null);
      setProbeError(null);
      setJob(IDLE_JOB);
      showSnapshots([]);
      try {
        const probed = await probeVideo(path);
        setInfo(probed);
        // A scrambled file knows its own geometry; anything else is treated as an original.
        const hint = probed.hint;
        setSettings((current) => ({
          ...current,
          width: hint ? hint.width : probed.width,
          height: hint ? hint.height : probed.height,
          ...(hint
            ? {
                tile: hint.tile,
                margin: hint.margin,
                invert: hint.invert ?? false,
                intro: hint.intro_ms > 0,
                ...(hint.seed ? { seed: hint.seed } : {}),
              }
            : {}),
        }));
        setSizeFromFile(true);
        const url = await snapshotUrl(path, probed.duration / 2);
        showSnapshots([{ url, caption: `输入 ${probed.width}×${probed.height}` }]);
      } catch (reason) {
        setProbeError(String(reason));
      }
    },
    [showSnapshots],
  );

  useEffect(() => {
    initialFile().then((path) => {
      if (path) onFile(path);
    });
  }, [onFile]);

  async function run(mode: Mode) {
    if (!file) return;
    setJob({ running: true, mode, progress: null, result: null, error: null });
    try {
      const result = await runJob(
        {
          input: file,
          outputDir: settings.outputDir,
          mode,
          width: settings.width,
          height: settings.height,
          tile: settings.tile,
          margin: settings.margin,
          seed: settings.seed,
          invert: settings.invert,
          intro: settings.intro,
          seedInIntro: settings.intro && settings.seedInIntro,
          gpu: settings.gpu,
        },
        (progress) => setJob((current) => ({ ...current, progress })),
      );
      setJob((current) => ({ ...current, running: false, result }));
      const seconds = info ? info.duration / 2 : 0;
      const url = await snapshotUrl(result.output, seconds);
      showSnapshots([
        ...snapshots.slice(0, 1),
        { url, caption: `${mode === "scramble" ? "加密输出" : "解密输出"} tile ${settings.tile} margin ${settings.margin} · 反色${settings.invert ? "开" : "关"}` },
      ]);
    } catch (reason) {
      setJob((current) => ({ ...current, running: false, error: String(reason) }));
    }
  }

  const status = !file
    ? "尚未选择视频"
    : probeError
      ? "读取失败"
      : info
        ? `${info.width}×${info.height} · ${info.fps.toFixed(2)} fps · ${info.duration.toFixed(1)} s · ${info.codec}${info.has_audio ? " · 有音轨" : ""}${info.hint ? (info.hint.intro_ms > 0 ? " · 已识别为加密文件（片头二维码）" : " · 已识别为加密文件") : ""}`
        : "读取中…";

  return (
    <Shell>
      <Title>
        VeilCast<span>{status}</span>
      </Title>
      <DropZone file={file} onFile={onFile} />
      {probeError && <Note tone="error">{probeError}</Note>}
      <PlanPanel
        settings={settings}
        sizeFromFile={sizeFromFile}
        onChange={(next) => {
          if (next.width !== settings.width || next.height !== settings.height) setSizeFromFile(false);
          setSettings((current) => ({ ...current, ...next }));
        }}
      />
      <JobPanel
        outputDir={settings.outputDir}
        onOutputDir={(outputDir) => setSettings((current) => ({ ...current, outputDir }))}
        canRun={Boolean(file && info)}
        job={job}
        onRun={run}
      />
      <Snapshots items={snapshots} />
    </Shell>
  );
}

export default App;
