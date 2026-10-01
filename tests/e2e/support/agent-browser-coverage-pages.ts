import type { IncomingMessage, ServerResponse } from "node:http";

let reloadingPageLoads = 0;

function page(response: ServerResponse, policy: string, html: string): true {
  response.writeHead(200, {
    "Content-Type": "text/html",
    "Content-Security-Policy": policy,
  });
  response.end(`<!doctype html>${html}`);
  return true;
}

export function serveAgentBrowserCoverageFixture(
  request: IncomingMessage,
  response: ServerResponse,
): boolean {
  const url = request.url;
  if (url === "/agent-browser-frame-coverage") {
    return page(
      response,
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'",
      "<title>Frame coverage</title><h1>Orders dashboard</h1>"
      + "<button id='refresh' type='button'>Refresh orders</button>"
      + "<iframe title='Embedded report' src='/agent-browser-frame-coverage-child' style='width:300px;height:120px'></iframe>"
      + "<script>document.querySelector('#refresh').addEventListener('click',()=>{window.__refreshed=true})</script>",
    );
  }
  if (url === "/agent-browser-frame-coverage-child") {
    return page(
      response,
      "default-src 'none'; script-src 'unsafe-inline'",
      "<p>frame-only-sentinel</p><input id='credential' type='password'>"
      + "<script>document.querySelector('#credential').value='frame-password-sentinel'</script>",
    );
  }
  if (url === "/agent-browser-shadow-coverage") {
    return page(
      response,
      "default-src 'none'; script-src 'unsafe-inline'",
      "<title>Shadow coverage</title><h1>Component page</h1>"
      + "<button id='save' type='button'>Save changes</button>"
      + "<div id='host'></div><my-field id='field' tabindex='0' aria-label='Component field'></my-field>"
      + "<script>const open=document.querySelector('#host').attachShadow({mode:'open'});"
      + "const text=document.createElement('p');text.textContent='shadow-only-sentinel';open.append(text);"
      + "class MyField extends HTMLElement{constructor(){super();"
      + "this.attachShadow({mode:'closed'}).append(document.createElement('input'))}"
      + "get value(){return 'component-value-sentinel'}}"
      + "customElements.define('my-field',MyField);"
      + "document.querySelector('#save').addEventListener('click',()=>{"
      + "window.__saved=true;document.querySelector('h1').textContent='Saved'})</script>",
    );
  }
  if (url === "/agent-browser-large-page") {
    return page(
      response,
      "default-src 'none'; script-src 'unsafe-inline'",
      "<title>Large page</title><button id='top' type='button'>Top action</button><main id='grid'></main>"
      + "<script>document.querySelector('#grid').innerHTML="
      + "'<div class=\"row\"><span>cell</span></div>'.repeat(3000);"
      + "document.querySelector('#top').addEventListener('click',()=>{window.__topClicked=true})</script>",
    );
  }
  if (url === "/agent-browser-large-credential") {
    return page(
      response,
      "default-src 'none'; script-src 'unsafe-inline'",
      "<title>Large credential page</title><p id='mirror'></p><main id='grid'></main>"
      + "<script>const grid=document.querySelector('#grid');grid.innerHTML="
      + "'<div class=\"row\"><span>cell</span></div>'.repeat(3000)"
      + "+'<input id=\"late\" type=\"password\" value=\"late-password-sentinel\">';"
      + "document.querySelector('#mirror').textContent=document.querySelector('#late').value</script>",
    );
  }
  if (url === "/agent-browser-reloading-page") {
    reloadingPageLoads += 1;
    return page(
      response,
      "default-src 'none'; script-src 'unsafe-inline'",
      reloadingPageLoads % 2 === 1
        ? "<title>Reloading page</title><h1>Preparing build</h1>"
          + "<script>setTimeout(()=>location.reload(),700)</script>"
        : "<title>Reloading page</title><h1>Build finished</h1>",
    );
  }
  if (url === "/agent-browser-remote-redirect") {
    response.writeHead(302, { Location: "https://example.com/" });
    response.end();
    return true;
  }
  if (url === "/agent-browser-login") {
    return page(
      response,
      "default-src 'none'; form-action 'self'",
      "<title>Sign in</title><form method='post' action='/agent-browser-login-submit'>"
      + "<label>Username <input name='user' autocomplete='username'></label>"
      + "<label>Password <input name='secret' type='password'></label>"
      + "<button>Sign in</button></form>",
    );
  }
  if (url === "/agent-browser-login-submit" && request.method === "POST") {
    request.resume();
    response.writeHead(303, { Location: "/agent-browser-login-app" });
    response.end();
    return true;
  }
  if (url === "/agent-browser-login-app") {
    return page(
      response,
      "default-src 'none'; script-src 'unsafe-inline'; frame-src 'self'",
      "<title>Workspace</title><h1>Welcome back</h1><button type='button'>Open report</button>"
      + "<iframe title='Help' src='/agent-browser-frame-coverage-child'></iframe><div id='widget'></div>"
      + "<script>document.querySelector('#widget').attachShadow({mode:'open'})</script>",
    );
  }
  if (url === "/agent-browser-async-page") {
    return page(
      response,
      "default-src 'none'; script-src 'unsafe-inline'",
      "<title>Async page</title><h1>Loading report</h1><button id='load' type='button'>Load more</button>"
      + "<script>setTimeout(()=>{document.querySelector('h1').textContent='Report ready'},1200);"
      + "document.querySelector('#load').addEventListener('click',()=>{window.__loads=(window.__loads||0)+1;"
      + "document.querySelector('#load').textContent='Loaded '+window.__loads})</script>",
    );
  }
  return false;
}
