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
  "object-define-property",
  "object-define-properties",
  "reflect-define-property",
  "define-property-before-type",
  "legacy-define-getter",
  "object-set-prototype",
  "reflect-set-prototype",
  "legacy-set-prototype",
  "prototype-before-type",
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
  "object-define-property": "const input=document.createElement('input');input.type='password';Object.defineProperty(input,'value',{configurable:true,writable:true,value:secret});leaked=input.value;clear=()=>{delete input.value}",
  "object-define-properties": "const input=document.createElement('input');input.type='password';Object.defineProperties(input,{value:{configurable:true,writable:true,value:secret}});leaked=input.value;clear=()=>{delete input.value}",
  "reflect-define-property": "const input=document.createElement('input');input.type='password';Reflect.defineProperty(input,'value',{configurable:true,writable:true,value:secret});leaked=input.value;clear=()=>{delete input.value}",
  "define-property-before-type": "const input=document.createElement('input');Object.defineProperty(input,'value',{configurable:true,writable:true,value:secret});input.type='password';leaked=input.value;clear=()=>{delete input.value}",
  "legacy-define-getter": "const input=document.createElement('input');input.type='password';input.__defineGetter__('value',()=>secret);leaked=input.value;clear=()=>{delete input.value}",
  "object-set-prototype": "const input=document.createElement('input');input.type='password';const prototype=Object.getPrototypeOf(input);Object.setPrototypeOf(input,{value:secret});leaked=input.value;clear=()=>{Object.setPrototypeOf(input,prototype)}",
  "reflect-set-prototype": "const input=document.createElement('input');input.type='password';const prototype=Object.getPrototypeOf(input);Reflect.setPrototypeOf(input,{value:secret});leaked=input.value;clear=()=>{Reflect.setPrototypeOf(input,prototype)}",
  "legacy-set-prototype": "const input=document.createElement('input');input.type='password';const prototype=Object.getPrototypeOf(input);input.__proto__={value:secret};leaked=input.value;clear=()=>{input.__proto__=prototype}",
  "prototype-before-type": "const input=document.createElement('input');const prototype=Object.getPrototypeOf(input);Object.setPrototypeOf(input,{type:'password',value:secret});leaked=input.value;clear=()=>{Object.setPrototypeOf(input,prototype)}",
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
