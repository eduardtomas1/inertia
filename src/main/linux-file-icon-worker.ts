import { isAbsolute } from "node:path";
import ffi from "ffi-rs";

const parent = process.parentPort;
if (!parent || process.platform !== "linux") process.exit(1);
const deadline = setTimeout(() => process.exit(1), 4_000);
parent.once("message", (event) => {
  const value: unknown = event.data;
  if (!value || typeof value !== "object" || !("file" in value) || !("icon" in value)
    || typeof value.file !== "string" || typeof value.icon !== "string"
    || !isAbsolute(value.file) || value.file.length > 4096 || value.file.includes("\0")
    || !value.icon.startsWith("file:///") || value.icon.length > 16_384 || value.icon.includes("\0")) process.exit(1);
  const { DataType: T, load, open, isNullPointer } = ffi;
  open({ library: "inertia-gio", path: "libgio-2.0.so.0" });
  const nullPointer = ffi.unwrapPointer(ffi.createPointer({ paramsType: [T.U64], paramsValue: [0] }))[0];
  const file = load({ library: "inertia-gio", funcName: "g_file_new_for_path",
    retType: T.External, paramsType: [T.String], paramsValue: [value.file] });
  if (isNullPointer(file)) process.exit(1);
  let success = false;
  try {
    const info = load({ library: "inertia-gio", funcName: "g_file_query_info", retType: T.External,
      paramsType: [T.External, T.String, T.I32, T.External, T.External],
      paramsValue: [file, "metadata::custom-icon", 0, nullPointer, nullPointer] });
    if (!isNullPointer(info)) {
      try {
        const hasIcon = load({ library: "inertia-gio", funcName: "g_file_info_has_attribute",
          retType: T.I32, paramsType: [T.External, T.String], paramsValue: [info, "metadata::custom-icon"] });
        // Respect an icon selected in the file manager, including our existing icon.
        if (hasIcon) success = true;
      } finally {
        load({ library: "inertia-gio", funcName: "g_object_unref", retType: T.Void,
          paramsType: [T.External], paramsValue: [info] });
      }
    }
    if (!success) success = Boolean(load({ library: "inertia-gio", funcName: "g_file_set_attribute_string",
      retType: T.I32, paramsType: [T.External, T.String, T.String, T.I32, T.External, T.External],
      paramsValue: [file, "metadata::custom-icon", value.icon, 0, nullPointer, nullPointer] }));
  } finally {
    load({ library: "inertia-gio", funcName: "g_object_unref", retType: T.Void,
      paramsType: [T.External], paramsValue: [file] });
    clearTimeout(deadline);
  }
  process.exit(success ? 0 : 1);
});
