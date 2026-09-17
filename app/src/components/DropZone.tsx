import { useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { styled } from "@linaria/react";

import { Button } from "./ui";

const Zone = styled.div<{ active: boolean }>`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  min-height: 120px;
  padding: 20px;
  border: 2px dashed ${({ active }) => (active ? "#7c6cff" : "#3a3a48")};
  border-radius: 12px;
  background: ${({ active }) => (active ? "rgba(124, 108, 255, 0.08)" : "transparent")};
  color: #a0a0b0;
  text-align: center;
  transition: border-color 120ms ease, background 120ms ease;
`;

const Current = styled.div`
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
  color: #d0d0dc;
  word-break: break-all;
`;

interface Props {
  file: string | null;
  onFile: (path: string) => void;
}

/** Accepts a video via native drag-drop or the system file dialog. */
export function DropZone({ file, onFile }: Props) {
  const [active, setActive] = useState(false);

  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      switch (event.payload.type) {
        case "enter":
        case "over":
          setActive(true);
          break;
        case "leave":
          setActive(false);
          break;
        case "drop":
          setActive(false);
          if (event.payload.paths[0]) onFile(event.payload.paths[0]);
          break;
      }
    });
    return () => {
      unlisten.then((stop) => stop());
    };
  }, [onFile]);

  async function pick() {
    const chosen = await open({
      multiple: false,
      filters: [{ name: "视频", extensions: ["mp4", "mkv", "mov", "webm", "m4v"] }],
    });
    if (typeof chosen === "string") onFile(chosen);
  }

  return (
    <Zone active={active}>
      <span>把视频拖到这里，或者</span>
      <Button type="button" onClick={pick}>
        选择视频…
      </Button>
      {file && <Current>{file}</Current>}
    </Zone>
  );
}
