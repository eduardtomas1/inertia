# Conversation history and delivery

Opening a chat loads a bounded window of stored history. **Older history** and
**Newer history** replace that window, and **Latest history** returns to the live
conversation. Search can open the window containing a matching message, even
when that message is outside the current window.

History selection is remembered separately for up to 32 chats. A runtime restart
returns remembered selections to the latest history because old cursors are no
longer valid.

Long messages, reasoning and activity details show a preview. **Read full** opens
their stored text in bounded parts with previous/next controls. A changed record
or runtime restart invalidates its cursor; reopen the content from the latest
history. No stored transcript text is deleted by this navigation.

Search runs outside the runtime's main event loop. If a scan reaches its time,
byte or result limit, **Search older messages** continues from its last completed
record. Searches still exclude archived chats and assistant commentary without
final-answer provenance. Individual messages above the search size limit are
reported as an incomplete search; history navigation can still retrieve them.

## Queued messages

Each chat can hold three pending text messages, shared by its windows and saved
in the runtime database. Queue controls can pause, resume, reorder or remove
pending work. A queued message starts automatically only after the turn it
follows completes successfully. Failed, cancelled or replaced turns do not
silently advance the queue.

An interrupted delivery remains uncertain until an accepted receipt can be
reconciled. Uncertain work does not automatically retry. Review the conversation
before removing it or sending new work. Recovery imports pause queued work;
imported uncertain deliveries remain uncertain.

Direct text sends retain a request identity across renderer reloads while their
acknowledgement is unresolved. The runtime records accepted receipts before
publishing them, so retrying that identity returns its original acknowledgement.
The renderer stores only a payload digest and request UUID. Attachment sends
retain their existing attachment handoff protocol.

## Storage and protocol limits

History windows contain at most 24 primary records, plus the turn, message and
checkpoint dependencies needed to render those records correctly. Text previews
are bounded to 16 KiB and full-content reads to 64 KiB of UTF-8 per response.
Metadata is checked before materialization and serialized history has an 8 MiB
ceiling. Cursors are signed, scoped to the conversation and runtime, and detect
content replacement even when its length is unchanged.

Search scans have a two-second and 256 MiB budget, with a 16 MiB per-message
limit. Continuation records progress rather than restarting the entire search.
These limits bound a single operation; they are not transcript retention limits.
