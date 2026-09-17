import { styled } from "@linaria/react";

const Strip = styled.div`
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
`;

const Figure = styled.figure`
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  flex: 1 1 240px;
  max-width: 420px;

  img {
    width: 100%;
    max-height: 360px;
    object-fit: contain;
    border-radius: 8px;
    background: #000;
  }

  figcaption {
    font-size: 12px;
    color: #8f8fa3;
  }
`;

export interface Snapshot {
  url: string;
  caption: string;
}

/** One frame each from the input and the most recent output, for eyeballing tile/margin choices. */
export function Snapshots({ items }: { items: Snapshot[] }) {
  if (items.length === 0) return null;
  return (
    <Strip>
      {items.map((item) => (
        <Figure key={item.caption}>
          <img src={item.url} alt={item.caption} />
          <figcaption>{item.caption}</figcaption>
        </Figure>
      ))}
    </Strip>
  );
}
