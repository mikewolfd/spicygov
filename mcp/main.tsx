import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowUpRight, Check, Copy } from 'lucide-react';
import '../app/globals.css';
import './style.css';

const endpoint = 'https://mcp.spicygov.ai/mcp';
const command = `claude mcp add --transport http spicygov ${endpoint}`;

function CopyButton({ value, label }: { value: string; label: string }) {
  const [status, setStatus] = useState('');
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setStatus('Copied');
    } catch {
      setStatus('Select and copy the text above.');
    }
  }
  return <div className="copy-control">
    <button type="button" onClick={copy} aria-label={label}>
      {status === 'Copied' ? <Check size={16} /> : <Copy size={16} />}
      {status === 'Copied' ? 'Copied' : 'Copy'}
    </button>
    <span className="copy-status" role="status">{status}</span>
  </div>;
}

function McpGuide() {
  return <div className="mcp-page">
    <a href="#connect" className="skip-link">Skip to connection guide</a>
    <header className="topbar">
      <a className="wordmark" href="/">spicygov<span className="brand-star" aria-hidden="true">✳</span></a>
      <nav aria-label="Main">
        <a href="/">Explore</a>
        <span className="nav-active" aria-current="page">MCP</span>
        <a href="https://docs.spicygov.ai" target="_blank" rel="noreferrer">Data docs <ArrowUpRight size={13} /></a>
      </nav>
      <span className="header-note">PUBLIC DATA. OPEN POSSIBILITIES.</span>
    </header>
    <main id="connect" className="mcp-content">
      <p className="mcp-eyebrow">SPICYGOV / MCP</p>
      <h1>Public data.<br /><em>Meet your AI.</em></h1>
      <p className="mcp-intro">Connect your AI tools to government records. Model Context Protocol (MCP) lets your assistant discover tables, query data, and follow connections.</p>
      <section className="mcp-endpoint" aria-labelledby="server-heading">
        <div className="mcp-section-label"><h2 id="server-heading">Server URL</h2><span>Streamable HTTP</span></div>
        <div className="mcp-copy-row"><code>{endpoint}</code><CopyButton value={endpoint} label="Copy server URL" /></div>
        <p>Public access. No API key required.</p>
      </section>
      <section className="mcp-setup" aria-labelledby="setup-heading">
        <h2 id="setup-heading">Connect in your app</h2>
        <p>Add a remote MCP server, name it <strong>SpicyGov</strong>, and paste the URL above. Choose HTTP if your app asks for a transport.</p>
        <details>
          <summary>Using Claude Code?</summary>
          <p>Run this in your terminal, then use <code>/mcp</code> in Claude Code to check the connection.</p>
          <div className="mcp-command"><code>{command}</code><CopyButton value={command} label="Copy Claude Code command" /></div>
          <a className="mcp-text-link" href="https://code.claude.com/docs/en/mcp" target="_blank" rel="noreferrer">Claude Code setup guide <ArrowUpRight size={14} /></a>
        </details>
      </section>
      <section className="mcp-try" aria-labelledby="try-heading">
        <h2 id="try-heading">Start with a question</h2>
        <blockquote>“What datasets are available? Show me how bills connect to their sponsors.”</blockquote>
        <p>Ask for source records with your answer so you can check the results.</p>
      </section>
      <footer className="mcp-footer"><a href="/">Explore the data yourself <span aria-hidden="true">→</span></a><a href="https://docs.spicygov.ai">Read the data docs <ArrowUpRight size={14} /></a></footer>
    </main>
  </div>;
}

createRoot(document.getElementById('root')!).render(<McpGuide />);
