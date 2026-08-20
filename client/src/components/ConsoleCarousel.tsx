export function ConsoleCarousel({
  consoles,
  onSelect,
}: {
  consoles: string[];
  onSelect: (console: string) => void;
}) {
  if (consoles.length === 0) {
    return <p className="muted">No ROM folders configured yet — add one in Settings.</p>;
  }

  return (
    <div className="console-carousel">
      {consoles.map((console) => (
        <button key={console} className="console-tile" onClick={() => onSelect(console)}>
          {console}
        </button>
      ))}
    </div>
  );
}
