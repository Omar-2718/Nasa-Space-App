#!/bin/bash
# usage: quick_check.sh name lon lat half_km   -> data/qc/<name>/compare.png (first vs last date, same track)
cd /home/omar/projects/nasa
n=$1; d=data/qc/$n
.venv/bin/python pipeline/crop_gcov.py $2 $3 $4 auto $d ends 2>&1 | grep -v -i warn
a=$(ls $d/*.npz | head -1 | xargs basename -s .npz); b=$(ls $d/*.npz | tail -1 | xargs basename -s .npz)
.venv/bin/python -W ignore pipeline/compare.py $d $a $b $d/compare.png && echo "DONE $n $a $b ($(du -sh $d | cut -f1))"
