/** A Markdown link that runs a VS Code command, for hovers and inline cards. */
export function commandLink(label: string, command: string, args?: unknown[], title?: string): string {
  const query = args ? `?${encodeURIComponent(JSON.stringify(args))}` : '';
  const t = title ? ` "${title.replace(/"/g, "'")}"` : '';
  return `[${label}](command:${command}${query}${t})`;
}

export function searchUrl(site: string | undefined, query: string): string {
  const q = site ? `site:${site} ${query}` : `${query} documentation`;
  return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
}

export function videoSearchUrl(query: string): string {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
}
