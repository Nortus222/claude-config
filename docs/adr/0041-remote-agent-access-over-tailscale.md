---
status: accepted
---

# The agent serves the owner's other machines on its Tailscale address, admitting callers by `whois`

Amends ADRs 0019 and 0040: local IPC is unchanged, and remote access is a second, opt-in listener.
Managing skills across machines needs one machine's agent to reach another's, and the agent so far
listened only on a user-private socket or pipe. A person at the machine turns remote access on
(`setRemoteAccess`, app or CLI only); until then, and whenever Tailscale is not running, the agent
opens no network socket and asks Tailscale nothing. While on, it listens over HTTP on port 47821 of
each of this node's Tailscale addresses (100.64.0.0/10, fd7a:115c:a1e0::/48), never a wildcard,
loopback or LAN address, and re-reads the switch and Tailscale's status every 30 s and whenever
the switch changes. Every request is checked before its body is read. A request carrying `Origin`
(a browser) or a `Host` other than this node's address or MagicDNS name (DNS rebinding) is refused,
then the LocalAPI `whois` of the caller's address must name an untagged, unshared node of this
node's Tailscale user that is not this node; anything else gets 403 and a log line, never a History
entry. Admitted requests run as the `remote` actor naming the caller's machine, limited to the few
operations the grid needs, `skillNow` previews, and plans the same caller previewed here. The
LocalAPI is the only authority: the network path is Tailscale's WireGuard tunnel, and `whois`
names the node that holds the tunnel's key, so the identity needs no header, secret or token of
ours.

## Considered options

- `tailscale serve` in front of a loopback listener: it rewrites the user's node-wide serve
  config, which the user may already use, and the Mac App Store client does not support it.
- Loopback or LAN TCP with our own authentication: reachable from browsers and the local network
  (ADR 0011), and a token would have to be copied between machines.
- Relaying through the hosted service: it stores metadata only and is never on the apply path
  (ADR 0010).

## Consequences

- Tailscale stays a prerequisite for remote access only; the app and CLI work without it.
- Any process on the owner's other machines can drive these operations once remote access is on
  there; that is the owner's accepted risk, recorded with the remote actions themselves.
- Before admission a caller costs little: one `whois` per IP at a time, reused for a minute (5 s
  when Tailscale does not know the caller), at most 64 connections, and one refusal log line per
  IP per minute.
- Where the LocalAPI is a TCP port (the macOS App Store and Standalone clients), the agent finds it
  again at least every 30 s. If Tailscale restarts on a new port, a local process that takes the
  old port within that window could receive the LocalAPI token and answer `whois` falsely; sockets
  and pipes have no such window.
