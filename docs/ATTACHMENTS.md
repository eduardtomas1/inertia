# Attachment formats

Use the attachment button, drop files on the composer, or paste clipboard files.
Pasting ordinary text still inserts it into the message. OS clipboard support
for copying files varies; the file must be present in the clipboard file list.
In the picker, choose **All files** for extensionless names such as `Dockerfile`.
The import validates file content even when the OS supplies no MIME type or a
generic binary type.

| Format | Preview | Delivered to the provider |
| --- | --- | --- |
| PNG, JPEG, WebP, GIF | Image with zoom | Image input, when the selected model supports images |
| PDF | Page viewer | Bounded selectable text; pages with graphics or sparse text become images, requiring image support |
| TXT, TEXT, LOG, Markdown, RST, TeX | Inert text | Bounded text |
| CSV | Table | Bounded raw CSV text |
| XLSX, XLS | Worksheet tables | Bounded worksheet text; macros are rejected |
| JSON | Formatted text; valid JSON required | Bounded raw JSON text |
| JSONC, JSON5, JSONL, NDJSON, IPYNB, TSV | Inert text | Bounded raw text, including notebook JSON; no notebook execution or output rendering |
| YAML, TOML, INI, CFG, CONF, properties, XML, HTML, CSS, SCSS, LESS | Inert text | Bounded text; markup and scripts are not executed |
| JS/TS/JSX/TSX, Vue, Svelte, MDX, Python, Ruby, Go, Rust, Java/Kotlin/Scala, C/C++/C#, Swift, PHP, Lua, Dart, R, Perl, Elixir, Erlang, Haskell, Clojure | Inert text | Bounded source text |
| Shell, Bash, Zsh, PowerShell, BAT/CMD, SQL, GraphQL, Proto, diff/patch | Inert text | Bounded text |
| Dockerfile, Containerfile, Makefile, GNUmakefile, Justfile, README, LICENSE, .gitignore, .gitattributes, .dockerignore, .editorconfig | Inert text | Bounded text |

Text accepts UTF-8 (with or without a BOM) and UTF-16 LE/BE with a BOM. Original
bytes, filename and content digest are retained. ANSI color/style sequences are
removed from the preview and provider text; terminal control commands and binary
data are rejected. Convert legacy code pages or UTF-16 without a BOM to UTF-8.
Text files must be nonempty and at most 2 MiB in their original encoding.

Provider text is bounded to 64 KiB per document and 96 KiB total before prompt
metadata, including JSON escaping. Truncation is identified in provider context;
the preview can show more than the provider receives. Large logs should be
reduced to a relevant excerpt. Document attachments can be sent in a new turn;
follow-ups during a running turn currently support images only.

ZIP/TAR and other archives, executables, media, Word/PowerPoint documents, SVG,
`.env`, and key/certificate files are not supported attachments. Extract archives
and attach supported files, or export documents to PDF or text. Renaming a binary
file does not make it supported.

Sent files can be reopened from the message or **Open a surface → Attachments**,
including after restart, while their validated retained copy remains available.
If a copy is removed or changed, re-add the original file.
