# Rico VIP Route

Live companion to `rico-recipient-guard`. ISTS/VIP direct iMessage turns start
on `anthropic/claude-opus-4-8`. Qwen / LM Studio is never the primary for those
directs.

VIP identity is the union of:

- recipient-guard identities with `access: approved` or `access: trusted`
- the exact Jeff principal in the private ISTS grant, when that file is readable

A VIP **sender handle from this inbound** is required. Live rico-shared keys
are `imessage:default:direct:<handle>`. That suffix names the thread; it is
not inbound and must not pin Claude. `rico-vip-route/vip-directs.json` is
not required and may be missing.

Do not create a `rico-vip` agent. This plugin is defense in depth if a VIP
session still lands on `rico-shared`.

Install:

```bash
openclaw plugins install --force "/Applications/OpenClaw Studio.app/Contents/Resources/RicoVipRoute"
openclaw plugins enable rico-vip-route
```
