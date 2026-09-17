import { styled } from "@linaria/react";

export const Panel = styled.section`
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  border-radius: 12px;
  background: #1c1c24;
`;

export const Row = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 12px 16px;
  align-items: flex-end;
`;

export const Field = styled.label`
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  flex: 1 1 120px;
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
    min-width: 0;
  }

  input:read-only {
    color: #8f8fa3;
  }
`;

export const Button = styled.button<{ primary?: boolean }>`
  padding: 7px 16px;
  border: 1px solid ${({ primary }) => (primary ? "#7c6cff" : "#3a3a48")};
  border-radius: 6px;
  background: ${({ primary }) => (primary ? "#7c6cff" : "#24242e")};
  color: ${({ primary }) => (primary ? "#ffffff" : "#e8e8f0")};
  font: inherit;
  cursor: pointer;

  &:hover:not(:disabled) {
    filter: brightness(1.15);
  }

  &:disabled {
    opacity: 0.45;
    cursor: default;
  }
`;

export const Note = styled.p<{ tone?: "error" | "muted" }>`
  margin: 0;
  font-size: 13px;
  color: ${({ tone }) => (tone === "error" ? "#ff7b7b" : tone === "muted" ? "#8f8fa3" : "#c8c8d8")};
  word-break: break-all;
`;
