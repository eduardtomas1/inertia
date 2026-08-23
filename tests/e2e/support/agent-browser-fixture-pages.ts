import type { ServerResponse } from "node:http";

export const NATIVE_CREDENTIAL_AUDIT_ROUTES = [
  "set-attribute",
  "default-value-after-type",
  "default-value-before-type",
  "set-range-text",
  "attr-value-set-node",
  "attr-node-value-set-node",
  "named-node-map",
  "attached-attr-value",
  "attached-attr-node-value",
  "attached-attr-text-content",
  "inner-html",
  "outer-html",
  "insert-adjacent-html",
  "range-fragment",
  "dom-parser",
  "document-write",
  "document-writeln",
  "set-html-unsafe",
  "document-parse-html-unsafe",
] as const;

const nativeCredentialSource: Record<(typeof NATIVE_CREDENTIAL_AUDIT_ROUTES)[number], string> = {
  "set-attribute": "const input=document.createElement('input');input.type='password';input.setAttribute('value',secret);leaked=input.value;clear=()=>input.removeAttribute('value')",
  "default-value-after-type": "const input=document.createElement('input');input.type='password';input.defaultValue=secret;leaked=input.defaultValue;clear=()=>{input.defaultValue=''}",
  "default-value-before-type": "const input=document.createElement('input');input.defaultValue=secret;input.type='password';leaked=input.defaultValue;clear=()=>{input.defaultValue=''}",
  "set-range-text": "const input=document.createElement('input');input.type='password';input.setRangeText(secret);leaked=input.value;clear=()=>{input.value=''}",
  "attr-value-set-node": "const input=document.createElement('input');input.type='password';const attr=document.createAttribute('value');attr.value=secret;input.setAttributeNode(attr);leaked=input.value;clear=()=>input.removeAttributeNode(attr)",
  "attr-node-value-set-node": "const input=document.createElement('input');input.type='password';const attr=document.createAttribute('value');attr.nodeValue=secret;input.setAttributeNode(attr);leaked=input.value;clear=()=>input.removeAttributeNode(attr)",
  "named-node-map": "const input=document.createElement('input');input.type='password';const attr=document.createAttribute('value');attr.value=secret;input.attributes.setNamedItem(attr);leaked=input.value;clear=()=>input.attributes.removeNamedItem('value')",
  "attached-attr-value": "const input=document.createElement('input');input.type='password';const attr=document.createAttribute('value');input.setAttributeNode(attr);attr.value=secret;leaked=input.value;clear=()=>{attr.value=''}",
  "attached-attr-node-value": "const input=document.createElement('input');input.type='password';const attr=document.createAttribute('value');input.setAttributeNode(attr);attr.nodeValue=secret;leaked=input.value;clear=()=>{attr.nodeValue=''}",
  "attached-attr-text-content": "const input=document.createElement('input');input.type='password';const attr=document.createAttribute('value');input.setAttributeNode(attr);attr.textContent=secret;leaked=input.value;clear=()=>{attr.textContent=''}",
  "inner-html": "const host=document.createElement('div');host.innerHTML=markup;const input=host.firstElementChild;leaked=input.value;clear=()=>{host.innerHTML=''}",
  "outer-html": "const host=document.createElement('div');host.innerHTML='<span></span>';host.firstElementChild.outerHTML=markup;const input=host.firstElementChild;leaked=input.value;clear=()=>{host.innerHTML=''}",
  "insert-adjacent-html": "const host=document.createElement('div');host.insertAdjacentHTML('beforeend',markup);const input=host.firstElementChild;leaked=input.value;clear=()=>{host.innerHTML=''}",
  "range-fragment": "const host=document.createElement('div');const range=document.createRange();range.selectNodeContents(host);const fragment=range.createContextualFragment(markup);const input=fragment.firstElementChild;leaked=input.value;clear=()=>input.remove()",
  "dom-parser": "const parsed=new DOMParser().parseFromString(markup,'text/html');const input=parsed.querySelector('input');leaked=input.value;clear=()=>input.remove()",
  "document-write": "const parsed=document.implementation.createHTMLDocument('');parsed.write(markup);const input=parsed.querySelector('input');leaked=input.value;clear=()=>{parsed.body.textContent=''}",
  "document-writeln": "const parsed=document.implementation.createHTMLDocument('');parsed.writeln(markup);const input=parsed.querySelector('input');leaked=input.value;clear=()=>{parsed.body.textContent=''}",
  "set-html-unsafe": "const host=document.createElement('div');if(typeof host.setHTMLUnsafe!=='function')throw new Error('unsupported');host.setHTMLUnsafe(markup);const input=host.firstElementChild;leaked=input.value;clear=()=>{host.setHTMLUnsafe('')}",
  "document-parse-html-unsafe": "if(typeof Document.parseHTMLUnsafe!=='function')throw new Error('unsupported');const parsed=Document.parseHTMLUnsafe(markup);const input=parsed.querySelector('input');leaked=input.value;clear=()=>input.remove()",
};

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
  const parsed = new URL(url ?? "", "http://fixture.invalid");
  if (parsed.pathname !== "/agent-browser-password-assignment-privacy") return false;
  const route = parsed.searchParams.get("route") ?? "set-attribute";
  const source = Object.hasOwn(nativeCredentialSource, route)
    ? nativeCredentialSource[route as keyof typeof nativeCredentialSource]
    : null;
  if (!source) return false;
  response.writeHead(200, {
    "Content-Type": "text/html",
    "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'",
  });
  response.end(
    "<!doctype html><title>Password assignment privacy probe</title>"
    + "<script>const secret='hunter2';const markup=\"<input type='password' value='hunter2'>\";"
    + "let leaked='';let clear=()=>{};let supported=true;try{"
    + source
    + "}catch{supported=false}if(leaked)console.error(leaked);clear();"
    + `window.__credentialRouteStatus={route:${JSON.stringify(route)},supported,produced:leaked===secret};`
    + "</script>",
  );
  return true;
}
