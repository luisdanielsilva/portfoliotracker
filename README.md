# portfolio tracker — working copy

Single static `index.html` (no build, no backend). 74 snapshots baked into
`BASE_RAW`. Snapshots added in the Add-data tab live in that browser localStorage
only.

## Develop
    cd ~/portfoliotracker
    tmux new-session -A -s dev      # attach or create
    claude                          # or edit index.html directly

## Deploy (same server)
    ./deploy.sh                     # cp -> /var/www/portfoliotracker/, then curl check

Live: https://www.luisdanielsilva.com/portfoliotracker/  (nginx alias in
/etc/nginx/sites-available/singleuseapps-portal; docroot /var/www/portfoliotracker)

## History / data provenance
Built Sept 2026 from 74 iPhone screenshots (`~/Desktop/Portfolio evolution/` on
the Mac). One-off compile scripts (compile.js, add-etf.js) also stayed on the Mac.
