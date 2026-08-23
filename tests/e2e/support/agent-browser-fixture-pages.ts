import type { ServerResponse } from "node:http";

export function serveAgentBrowserPrivacyFixture(
  url: string | undefined,
  response: ServerResponse,
): boolean {
  if (url === "/agent-browser-window-capture-privacy") {
    response.writeHead(200, {
      "Content-Type": "text/html",
      "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'",
    });
    response.end(
      "<!doctype html><title>Window capture privacy probe</title>"
      + "<label>Window guarded password <input id='credential' type='password'></label>"
      + "<p id='mirror'></p><script>window.addEventListener('input',event=>{"
      + "const input=document.querySelector('#credential');if(event.composedPath().includes(input)){"
      + "document.querySelector('#mirror').textContent=input.value;input.value='';"
      + "event.stopImmediatePropagation()}},true)</script>",
    );
    return true;
  }
  if (url !== "/agent-browser-password-assignment-privacy") return false;
  response.writeHead(200, {
    "Content-Type": "text/html",
    "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'",
  });
  response.end(
    "<!doctype html><title>Password assignment privacy probe</title>"
    + "<input id='credential' type='password'><script>"
    + "const input=document.querySelector('#credential');"
    + "input.value='hunter2';console.error(input.value);input.value='';"
    + "</script>",
  );
  return true;
}
