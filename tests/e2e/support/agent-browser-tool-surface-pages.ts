import type { IncomingMessage, ServerResponse } from "node:http";

const POLICY = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'";
let posts = 0;

const belowFold = "<h1>Long form</h1>"
  + "<div style='height:2400px'></div><button id='save' type='button'>Save at the bottom</button>"
  + "<script>document.querySelector('#save').addEventListener('click',()=>{window.__bottomClicked=true;"
  + "document.querySelector('h1').textContent='Saved at the bottom'})</script>";

const pages: Record<string, string> = {
  "/agent-browser-below-fold": `<title>Below the fold</title>${belowFold}`,
  "/agent-browser-below-fold-smooth": `<title>Smooth below the fold</title><style>html{scroll-behavior:smooth}</style>${belowFold}`,
  "/agent-browser-history-first": "<title>First page</title><p>First page body</p>",
  "/agent-browser-history-second": "<title>Second page</title><p>Second page body</p>",
  "/agent-browser-focus-order": "<title>Focus order</title>"
    + "<label>First field <input id='first'></label><label>Second field <input id='second'></label>",
  "/agent-browser-confirm": "<title>Confirm delete</title><p id='status'>Ready</p>"
    + "<button id='delete' type='button'>Delete item</button>"
    + "<script>document.querySelector('#delete').addEventListener('click',()=>{"
    + "if(confirm('Delete?'))document.querySelector('#status').textContent='Deleted'})</script>",
  "/agent-browser-post-form": "<title>Post form</title>"
    + "<form method='post' action='/agent-browser-post-count'><button type='submit'>Send post</button></form>",
  "/agent-browser-closed-shadow-alert": "<title>Closed code entry</title><div id='host'></div>"
    + "<script>const root=document.querySelector('#host').attachShadow({mode:'closed'});"
    + "const input=document.createElement('input');root.append(input);"
    + "input.addEventListener('input',()=>setTimeout(()=>alert('Invalid code '+input.value),0));input.focus()</script>",
};

export function agentBrowserToolSurfacePostCount(): number {
  return posts;
}

export function serveAgentBrowserToolSurfaceFixture(
  request: IncomingMessage,
  response: ServerResponse,
): boolean {
  if (request.url === "/agent-browser-post-count") {
    if (request.method === "POST") posts += 1;
    request.resume();
    response.writeHead(200, { "Content-Type": "text/html", "Content-Security-Policy": POLICY });
    response.end(`<!doctype html><title>Post count</title><p>Posts: ${posts}</p>`);
    return true;
  }
  const html = request.url === undefined ? undefined : pages[request.url];
  if (html === undefined) return false;
  response.writeHead(200, { "Content-Type": "text/html", "Content-Security-Policy": POLICY });
  response.end(`<!doctype html>${html}`);
  return true;
}
