#!/usr/bin/env bash

set -e

echo "[]" > streams.json
for i in $(ls cincinnati-graph-data/channels/*.yaml | sort); do
  cat streams.json | jq ". += [\"$(basename "$i" .yaml)\"]" > streams.json.new
  rm streams.json && mv streams.json.new streams.json
done
cat streams.json
