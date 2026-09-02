#!/usr/bin/env bash
# Publish the working copy to the live docroot (same box, no scp).
set -e
cp ~/portfoliotracker/index.html /var/www/portfoliotracker/index.html
echo "deployed -> https://www.luisdanielsilva.com/portfoliotracker/"
curl -sI https://www.luisdanielsilva.com/portfoliotracker/ | head -1
