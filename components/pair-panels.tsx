/**
 * Two lists side by side from lg, one after the other below it.
 *
 * From lg they share the frame and each fills its half. Below lg the page
 * scrolls as a whole, so each list takes its natural height (its feed caps
 * itself to the newest rows there) instead of a small scrolling window.
 */
export function PairPanels({
  panels,
}: {
  panels: { key: string; label: string; content: React.ReactNode }[];
}) {
  return (
    <div
      className={`flex flex-col gap-5 lg:grid lg:h-full lg:min-h-0 lg:gap-3 ${
        panels.length > 1 ? "lg:grid-cols-2" : ""
      }`}
    >
      {panels.map((p) => (
        <section key={p.key} className="flex flex-col gap-2 lg:min-h-0">
          <h2 className="font-display shrink-0 text-[15px] font-semibold tracking-[-0.01em]">
            {p.label}
          </h2>
          <div className="lg:min-h-0 lg:flex-1">{p.content}</div>
        </section>
      ))}
    </div>
  );
}
