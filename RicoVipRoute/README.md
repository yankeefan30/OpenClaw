# Rico VIP Route

Live companion to `rico-recipient-guard`. ISTS/VIP direct iMessage turns start
on `anthropic/claude-opus-4-8`. Qwen / LM Studio is never the primary for those
directs.

VIP identity is the union of:

- recipient-guard identities with `vip: true` or `access: trusted`
- the exact Jeff principal in the private ISTS grant, when that file is readable

Studio binds those directs to the `rico-vip` agent. This plugin is defense in
depth if a VIP session still lands on `rico-shared`.

Install:

```bash
openclaw plugins install --force "/Applications/OpenClaw Studio.app/Contents/Resources/RicoVipRoute"
openclaw plugins enable rico-vip-route
```
