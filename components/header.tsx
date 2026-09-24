import Link from "next/link";

const navLink: React.CSSProperties = {
  color: "var(--bone-light)",
  height: 32,
  display: "inline-flex",
  alignItems: "center",
  letterSpacing: ".08em",
  textTransform: "uppercase",
  fontSize: 12,
};

export function Header() {
  return (
    <header
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        padding: "16px 0",
        borderBottom: "1px solid var(--border)",
        flexWrap: "wrap",
      }}
    >
      <Link href="/" style={{ display: "flex", alignItems: "center", gap: 14, color: "inherit", textShadow: "none" }}>
        <span
          style={{
            width: 40,
            height: 40,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "var(--bg-panel)",
            border: "1px solid var(--bone-dark)",
            boxShadow: "0 0 12px rgba(120,220,255,.25)",
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/assets/cage.png"
            alt=""
            style={{ width: 24, height: 29, display: "block", filter: "drop-shadow(0 0 6px rgba(120,220,255,.8))" }}
          />
        </span>
        <span
          className="font-tiny"
          style={{
            fontSize: 32,
            lineHeight: 1,
            color: "var(--bone-bright)",
            letterSpacing: ".06em",
            textShadow: "0 0 12px rgba(120,220,255,.6)",
          }}
        >
          XRAY
        </span>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            fontSize: 11,
            letterSpacing: ".14em",
            border: "1px solid var(--border)",
            padding: "5px 10px",
            color: "var(--text)",
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              background: "var(--profit)",
              display: "inline-block",
              boxShadow: "0 0 8px #60F080",
              animation: "pulse 1.6s ease-in-out infinite",
            }}
          />
          LIVE ENGINE
        </span>
      </Link>
      <nav style={{ display: "flex", gap: 28, alignItems: "center" }}>
        <Link href="/terminal" style={navLink}>
          terminal
        </Link>
        <Link href="/holders" style={navLink}>
          holders
        </Link>
        <a href="https://x.com" target="_blank" rel="noopener" style={navLink}>
          X
        </a>
        <a href="https://github.com/crptAtlas/xray-terminal" target="_blank" rel="noopener" style={navLink}>
          github
        </a>
      </nav>
    </header>
  );
}
