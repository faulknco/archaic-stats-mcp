export const LANDING_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Ireland Stats MCP — Archaic</title>
<meta name="description" content="A public, read-only MCP server over Ireland's Central Statistics Office data. Point Claude, ChatGPT or Cursor at it and ask about Irish statistics." />
<link rel="canonical" href="https://stats.archaic.ie/" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@400&family=Space+Grotesk:wght@300;400;500&display=swap" rel="stylesheet" />
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{background:#060606;color:#686868;font-family:'Space Grotesk',system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:72ch;margin:0 auto;padding:72px 24px 96px}
h1{font-family:'Cinzel',serif;text-transform:uppercase;font-size:clamp(22px,3vw,30px);letter-spacing:3px;color:#e8e4d8;margin-bottom:20px}
h2{font-family:'Cinzel',serif;text-transform:uppercase;font-size:14px;letter-spacing:2px;color:#e8e4d8;margin:48px 0 16px}
p{font-size:14px;line-height:1.8;margin-bottom:16px}
a{color:#8a8a8a;text-decoration:none;border-bottom:1px solid #333}a:hover{color:#e8e4d8}
dl{font-size:13px;line-height:1.7}dt{color:#e8e4d8;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;margin-top:12px}dd{margin-left:0}
pre{background:#0d0d0d;border:1px solid #1a1a1a;padding:14px 16px;font-size:12px;line-height:1.6;overflow-x:auto;color:#b0b0b0;margin:8px 0 16px}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.eyebrow{font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#4a4a4a;margin-bottom:24px}
footer{margin-top:72px;font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:#333}
a:focus-visible{outline:1px solid #8a8a8a;outline-offset:4px}
</style>
</head>
<body>
<div class="wrap">
<p class="eyebrow">Archaic — Irish data for agents</p>
<h1>Ireland Stats MCP</h1>
<p>A public, read-only <a href="https://modelcontextprotocol.io">Model Context Protocol</a> server over every table published by Ireland's Central Statistics Office. Connect an assistant to it and ask about population, prices, earnings, housing, the labour market, trade, or anything else the CSO measures. No account, no key.</p>
<p>Endpoint: <code>https://stats.archaic.ie/mcp</code></p>

<h2>Connect</h2>
<p>Claude Code</p>
<pre><code>claude mcp add --transport http ireland-stats https://stats.archaic.ie/mcp</code></pre>
<p>Claude (claude.ai and desktop): Settings → Connectors → Add custom connector → URL above, authentication "No sign-in".</p>
<p>ChatGPT (developer mode) and Cursor take the same URL. For Cursor, <code>.cursor/mcp.json</code>:</p>
<pre><code>{ "mcpServers": { "ireland-stats": { "url": "https://stats.archaic.ie/mcp" } } }</code></pre>

<h2>Tools</h2>
<dl>
<dt>search_tables</dt><dd>Full-text search across the catalogue.</dd>
<dt>browse_catalog</dt><dd>Themes, subjects and products, top down.</dd>
<dt>list_tables</dt><dd>The tables inside one product.</dd>
<dt>get_table_metadata</dt><dd>Dimensions, codes and labels for a table. Read this before querying.</dd>
<dt>query_table</dt><dd>Filtered cells from a table, with a size guard so nothing enormous comes back.</dd>
<dt>recent_updates</dt><dd>What the CSO has released or revised lately.</dd>
</dl>

<h2>Data</h2>
<p>All data comes live from the CSO's PxStat API and is licensed <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>. Every response carries the attribution: Source: Central Statistics Office, Ireland. This service is not affiliated with the CSO.</p>
<p>Source code: <a href="https://github.com/faulknco/archaic-stats-mcp">github.com/faulknco/archaic-stats-mcp</a>. Built by <a href="https://archaic.ie">Archaic</a>.</p>
<footer>Archaic Limited · Registered in Ireland · Co. No. 811858</footer>
</div>
</body>
</html>`;
