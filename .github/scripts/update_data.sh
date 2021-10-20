#!/usr/bin/env bash

set -e

for i in $(cat streams.json | jq -r .[]); do

  echo Updating: "${i}"

  ( set -x; curl -vsH 'Accept:application/json' "https://api.openshift.com/api/upgrades_info/v1/graph?channel=${i}&arch=amd64" -o "streams/${i}.json" )
  mkdir -p streams/expanded
  cat "streams/${i}.json" | node .github/workflows/expand.js > "streams/expanded/${i}.json"

  echo "---"
  git --no-pager diff -- "streams/expanded/${i}.json" || true
  echo "---"

  # new file -> leave it
  git ls-files -o --error-unmatch -- "streams/${i}.json" &>/dev/null && continue

  # normalized file did change -> leave it
  git diff --exit-code -- "streams/expanded/${i}.json" || continue

  # not a new file, and no change in normalized file -> revert to existing version
  echo "${i}: Update model did not change, reverting JSON ..."
  git checkout -- "streams/expanded/${i}.json"
  git checkout -- "streams/${i}.json"

done
