# portfolio tracker — working copy

Single-page app with 74 historical snapshots (Jun 2023 – Aug 2026) baked into `BASE_RAW`. 

New: transaction registration system (Node.js backend) for buy/sell events. Transactions automatically create derived snapshots and persist to `data.json` on the server.

## Develop  (from Mac or iPhone, over Tailscale SSH)
    dev            # attach the tmux session; starts it (running claude + server) if down
    dev bash       # same session, plain shell instead of claude
    dev status     # running?
    dev stop       # kill it
    dev deploy     # -> runs ./deploy.sh
    dev help

**Session structure:** Tmux session "dev" has two windows:
- Window 0: Claude REPL
- Window 1: Node.js server (port 3000)

Detach and leave it running:  Ctrl-b  then  d
Switch windows in tmux:        Ctrl-b  then  n (next) or  0/1 (specific)
From the Mac in one shot:      ssh ptdev     (alias -> ssh -t hetzner dev)
Script lives at ~/.local/bin/dev ; tmux session name is "dev".

## Deploy (same server, no scp)
    ./deploy.sh          # cp -> /var/www/portfoliotracker/ , then curl check

Live: https://www.luisdanielsilva.com/portfoliotracker/  (nginx alias in
/etc/nginx/sites-available/singleuseapps-portal ; docroot /var/www/portfoliotracker)

## Transaction registration

In the **Add data** tab, register buy/sell transactions:
- Date, time, ticker, quantity, amount (EUR or USD)
- Specify exchange rate for USD conversions
- Each transaction automatically creates a derived snapshot (last snapshot + this trade)
- Transactions persist to `data.json` on the server

All transactions appear in the portfolio timeline and charts.

## History / data provenance
Built Sept 2026 from 74 iPhone screenshots (~/Desktop/Portfolio evolution/ on the
Mac). One-off compile scripts (compile.js, add-etf.js) also stayed on the Mac.
Transaction system added Sept 2026.
