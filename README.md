# portfolio tracker — working copy

Single static `index.html` (no build, no backend). 74 snapshots baked into
`BASE_RAW`. Snapshots added in the Add-data tab live in that browser localStorage
only.

## Develop  (from Mac or iPhone, over Tailscale SSH)
    dev            # attach the tmux session; starts it (running claude) if down
    dev bash       # same session, plain shell instead of claude
    dev status     # running?
    dev stop       # kill it
    dev deploy     # -> runs ./deploy.sh
    dev help

Detach and leave it running:  Ctrl-b  then  d
From the Mac in one shot:      ssh ptdev     (alias -> ssh -t hetzner dev)
Script lives at ~/.local/bin/dev ; tmux session name is "dev".

## Deploy (same server, no scp)
    ./deploy.sh          # cp -> /var/www/portfoliotracker/ , then curl check

Live: https://www.luisdanielsilva.com/portfoliotracker/  (nginx alias in
/etc/nginx/sites-available/singleuseapps-portal ; docroot /var/www/portfoliotracker)

## History / data provenance
Built Sept 2026 from 74 iPhone screenshots (~/Desktop/Portfolio evolution/ on the
Mac). One-off compile scripts (compile.js, add-etf.js) also stayed on the Mac.
