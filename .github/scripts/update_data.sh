#!/usr/bin/env bash

for i in $(cat streams.json | jq -r .[]); do

  echo Updating: "${i}"

  ( set -x; curl -sH 'Accept:application/json' "https://api.openshift.com/api/upgrades_info/v1/graph?channel=${i}&arch=amd64" -o "streams/${i}.json" )
  mkdir -p streams/expanded
  cat "streams/${i}.json" | node .github/workflows/expand.js > "streams/expanded/${i}.json"

  git diff --no-pager -- "streams/expanded/${i}.json"

  if git diff --exit-code -- "streams/expanded/${i}.json"; then
    echo "${i}: Update model did not change, reverting JSON ..."
    git checkout -- "streams/expanded/${i}.json"
    git checkout -- "streams/${i}.json"
  fi

done
