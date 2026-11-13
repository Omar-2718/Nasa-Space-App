#!/bin/bash
# Zip everything the app needs that is NOT in git, to share with teammates (USB / Drive).
# Teammate: unzip in the project root, then ./dev.sh
cd "$(dirname "$0")/.."
zip -rq beneath-data.zip data/patches web_assets web/public/tour notebooks/sample_data
echo "beneath-data.zip: $(du -h beneath-data.zip | cut -f1)"
