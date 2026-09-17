export function Footer() {
  return (
    <footer
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 16,
        paddingTop: 24,
        borderTop: "1px solid var(--border)",
        fontSize: 12,
        color: "var(--text-dim)",
        flexWrap: "wrap",
        marginTop: "auto",
      }}
    >
      <span style={{ display: "inline-flex", gap: 12, alignItems: "center" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/assets/lightbox.png" alt="" style={{ width: 24, height: 24, display: "block" }} />
        <a href="https://x.com" style={{ color: "var(--text-dim)" }}>
          x
        </a>
        <a href="https://github.com/Skynet-inisghts/holder-pnl" style={{ color: "var(--text-dim)" }}>
          github
        </a>
        <a href="https://t.me" style={{ color: "var(--text-dim)" }}>
          telegram
        </a>
        <span>· read-only, holds no keys</span>
      </span>
      <span>XRAY - who is in profit, who is underwater and can they trade at all · Robinhood Chain</span>
    </footer>
  );
}
