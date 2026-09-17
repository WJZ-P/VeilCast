import { useCallback, useState } from "react";
import { styled } from "@linaria/react";

import { DropZone } from "./components/DropZone";
import { PlanPanel } from "./components/PlanPanel";

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

function App() {
  const [files, setFiles] = useState<string[]>([]);
  const onFiles = useCallback((paths: string[]) => setFiles(paths), []);

  return (
    <Shell>
      <Title>
        VeilCast<span>{files.length > 0 ? `${files.length} 个文件待处理` : "尚未选择视频"}</span>
      </Title>
      <DropZone onFiles={onFiles} />
      <PlanPanel />
    </Shell>
  );
}

export default App;
