# Tutorials

Hands-on, end-to-end walkthroughs. Each is a numbered sequence with
copy-pasteable commands and expected output. Work through them in order —
each builds on the last.

1. **[01 — Install on kind](01-install-on-kind.md)** — from zero to a running
   Hades control plane on a local kind cluster, verified with `hades get`.
2. **[02 — A Discord bot agent](02-discord-bot.md)** — spin up a Discord bot
   via the `discord-bot` template + a Connector for outbound calls.
3. **[03 — A custom Nix hands image](03-custom-hands-image.md)** — give an
   agent its own packages with `installPackages` + a HandsImage.
4. **[04 — Publish and consume a Skill](04-publish-consume-skill.md)** — one
   agent exposes an HTTP capability, another calls it via the skill catalog.

> Prerequisites throughout: a working `nix` setup (or Docker + kind + helm +
> kubectl installed directly) and a terminal in the Hades repo root.

See also: [Setup](../setup.md), [Install](../install.md), [Connectors](../connectors.md).
