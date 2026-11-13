#!/bin/bash
cd /home/omar/projects/nasa
.venv/bin/python pipeline/crop_gcov.py 31.05 22.78 6 _079_D_077_ data/farms 2>&1 | grep -v -i warn
.venv/bin/python -W ignore pipeline/make_layers.py | head -1 && .venv/bin/python pipeline/build_page.py && echo "PAGE READY"
pipeline/quick_check.sh fishponds 32.00 31.22 6
pipeline/quick_check.sh nasser_shore 32.30 22.85 6
pipeline/quick_check.sh rice 30.95 31.25 6
pipeline/quick_check.sh gold_sukari 34.78 24.95 6
