// Static catalog of well-known MCP servers for the map editor / .mcp.json export.
// Placeholders stay literal "<TOKEN>" — the user fills them in after export.
export const MCP_CATALOG = [
  {
    id: 'github',
    label: 'GitHub',
    desc: 'Repos, issues, PRs, code search',
    config: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: '<GITHUB_TOKEN>' },
    },
    docsUrl: 'https://github.com/modelcontextprotocol/servers',
  },
  {
    id: 'obsidian',
    label: 'Obsidian',
    desc: 'Read and search an Obsidian vault',
    config: { command: 'npx', args: ['-y', 'mcp-obsidian', '<VAULT_PATH>'] },
    docsUrl: 'https://github.com/MarkusPfundstein/mcp-obsidian',
  },
  {
    id: 'filesystem',
    label: 'Filesystem',
    desc: 'Read/write files under allowed directories',
    config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '<ALLOWED_DIR>'] },
    docsUrl: 'https://github.com/modelcontextprotocol/servers',
  },
  {
    id: 'memory',
    label: 'Memory',
    desc: 'Knowledge-graph persistent memory',
    config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
    docsUrl: 'https://github.com/modelcontextprotocol/servers',
  },
  {
    id: 'fetch',
    label: 'Fetch',
    desc: 'Fetch web pages as markdown',
    config: { command: 'uvx', args: ['mcp-server-fetch'] },
    docsUrl: 'https://github.com/modelcontextprotocol/servers',
  },
  {
    id: 'playwright',
    label: 'Playwright',
    desc: 'Browser automation and scraping',
    config: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
    docsUrl: 'https://github.com/microsoft/playwright-mcp',
  },
];
