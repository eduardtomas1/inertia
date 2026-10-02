# Attachments

Attach files with the paperclip, drag and drop, or paste clipboard files. Each
message accepts up to **100 attachments**, **50 MiB per file**. Regular files have
no additional combined size limit. Attachment storage settings still control
retained disk usage.

Uploads are written to private staging in acknowledged chunks. Completed files
are validated and hashed before adoption. Cancelled uploads, closed composers,
and interrupted sends reclaim their temporary files. Sent and queued attachments
are copied into durable conversation storage without buffering the entire batch.

Agents receive the saved paths of documents and other files, with their names
and sizes. They can read or search what they need using file tools. File contents
are not automatically extracted into the prompt. This includes PDFs and
spreadsheets; their interpretation depends on the selected agent's tools.
Images continue to use the provider's image input.

Pasted text becomes a `.txt` attachment at **32 KiB of UTF-8**, or when inserting
it would exceed the message limit. **Shift-paste** keeps text inline. If importing
the paste fails, the text is restored to the draft. During an active turn,
follow-ups still accept images only; text pastes stay inline.

| Format | Preview | Provider input |
| --- | --- | --- |
| PNG, JPEG, WebP, GIF | Image with zoom | Image input when the model supports it |
| PDF | Page viewer, files up to 10 MiB | Saved file path |
| Text, logs, Markdown, JSON, source and configuration files | Inert text, first 1 MiB | Saved file path, complete original bytes |
| CSV, XLSX, XLS | Bounded table / worksheet view; CSV first 1 MiB, workbooks up to 10 MiB | Saved file path |
| Other files, including archives | File information; no active content | Saved file path |

`.env`, `.pem`, and `.key` files are refused by name. Credentials and private keys
stay out of attachment storage, which agents can read.

Text accepts UTF-8 or BOM-marked UTF-16 LE/BE. ANSI color sequences are stripped
from previews. A text-format file with binary data, terminal control commands, or
another encoding is kept as an opaque file: no preview, delivered by path.
Preview truncation never changes the stored file. JSON that does not parse,
including a truncated prefix, is shown as raw text. PDF and spreadsheet previews keep
their structural validation, including rejection of spreadsheet macros.

Images accept source files up to **50 MiB**. The import utility compresses or
resizes oversized images to **10 MiB each**, with an **80 MiB combined image
budget**. Images needing conversion become JPEGs (transparency uses a white
background and animations become a still frame). Decoding remains bounded to
40 megapixels across animation frames, with at most 256 frames. Processed images
have at most 8,192 pixels per side. Providers may enforce additional limits.

Provider requests have their own image limits. Claude, Cursor, and Kimi Code
receive image bytes inside one request, so a message to them carries at most
**20 MiB of images**. Every provider accepts at most **32 images** per message;
Codex and OpenCode receive image paths, and Antigravity has no image input in
Inertia. A message over its
provider's limit is refused before anything is sent, and the text and
attachments stay in the composer or the queue.

Sent files can be reopened from a message or **Open a surface → Attachments**,
including after restart while the retained copy remains available. Removing a
stored copy frees disk space; re-add the original if it is needed again.

This storage and context model follows [T3 Code's composer](https://github.com/pingdotgg/t3code/blob/5cc99e1c23980d7995a13c47f969b47cb68ed1be/docs/user/composer.md).
