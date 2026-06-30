// TagBar.tsx
type Props = {
  tags: string[];
  active: string | null;
  onToggle: (tag: string) => void;
};

export function TagBar({ tags, active, onToggle }: Props) {
  if (!tags.length) return null;
  return (
    <div className="tagrow">
      {tags.map((t) => (
        <button
          key={t}
          className={"chip" + (t === active ? " active" : "")}
          onClick={() => onToggle(t)}
        >
          #{t}
        </button>
      ))}
    </div>
  );
}
