import xa11y from "@crowecawcaw/xa11y";
import { createCanvas } from "@napi-rs/canvas";
import ffi from "ffi-rs";
const { App, screenshot } = xa11y;
const { load } = ffi;

// Package verification loads the shipped native bindings without reading the desktop.
if (typeof App.foreground !== "function" || typeof screenshot !== "function"
  || typeof load !== "function" || createCanvas(1, 1).toBuffer("image/png").length < 8) process.exit(1);
const parent = process.parentPort;
if (!parent) process.exit(1);
const timer = setTimeout(() => process.exit(1), 3000);
parent.once("message", (event) => { clearTimeout(timer); process.exit(event.data === "received" ? 0 : 1); });
parent.postMessage("bindings-ready");
