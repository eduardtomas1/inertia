import type { ServerResponse } from "node:http";

const POLICY = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'";

const pages: Record<string, string> = {
  "/agent-browser-below-fold": "<title>Below the fold</title><h1>Long form</h1>"
    + "<div style='height:2400px'></div><button id='save' type='button'>Save at the bottom</button>"
    + "<script>document.querySelector('#save').addEventListener('click',()=>{window.__bottomClicked=true;"
    + "document.querySelector('h1').textContent='Saved at the bottom'})</script>",
  "/agent-browser-history-first": "<title>First page</title><p>First page body</p>",
  "/agent-browser-history-second": "<title>Second page</title><p>Second page body</p>",
  "/agent-browser-focus-order": "<title>Focus order</title>"
    + "<label>First field <input id='first'></label><label>Second field <input id='second'></label>",
  "/agent-browser-confirm": "<title>Confirm delete</title><p id='status'>Ready</p>"
    + "<button id='delete' type='button'>Delete item</button>"
    + "<script>document.querySelector('#delete').addEventListener('click',()=>{"
    + "if(confirm('Delete?'))document.querySelector('#status').textContent='Deleted'})</script>",
};

export function serveAgentBrowserToolSurfaceFixture(
  url: string | undefined,
  response: ServerResponse,
): boolean {
  const html = url === undefined ? undefined : pages[url];
  if (html === undefined) return false;
  response.writeHead(200, { "Content-Type": "text/html", "Content-Security-Policy": POLICY });
  response.end(`<!doctype html>${html}`);
  return true;
}
