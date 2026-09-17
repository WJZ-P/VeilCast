import { useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { styled } from "@linaria/react";

const Zone = styled.div<{ active: boolean }>`
  display: grid;
  place-items: center;
  min-height: 180px;
  padding: 24px;
  border: 2px dashed ${({ active }) => (active ? "#7c6cff" : "#3a3a48")};
  border-radius: 12px;
  background: ${({ active }) => (active ? "rgba(124, 108, 255, 0.08)" : "transparent")};
  color: #a0a0b0;
  text-align: center;
  transition: border-color 120ms ease, background 120ms ease;
`;

const Paths = styled.ul`
  margin: 12px 0 0;
  padding: 0;
  list-style: none;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
  color: #d0d0dc;
`;

interface Props {
  onFiles: (paths: string[]) => void;
}

/** Listens to Tauri's native drag-drop events for the whole window. */
export function DropZone({ onFiles }: Props) {
  const [active, setActive] = useState(false);
  const [paths, setPaths] = useState<string[]>([]);

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
          setPaths(event.payload.paths);
          onFiles(event.payload.paths);
          break;
      }
    });
    return () => {
      unlisten.then((stop) => stop());
    };
  }, [onFiles]);

  return (
    <Zone active={active}>
      <div>
        <p>把视频拖到这里</p>
        {paths.length > 0 && (
          <Paths>
            {paths.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </Paths>
        )}
      </div>
    </Zone>
  );
}
