#!/usr/bin/env bash

set -e

echo '<?xml version="1.0" encoding="utf-8"?>' > sitemap.xml
echo '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' >> sitemap.xml

echo '<url><loc>https://ctron.github.io/openshift-update-graph</loc></url>' >> sitemap.xml

jq < streams.json -r '.[] | "<url><loc>https://ctron.github.io/openshift-update-graph/#\(.)</loc></url>"' >> sitemap.xml

echo '</urlset>' >> sitemap.xml

cat sitemap.xml

echo "" > sitemap.txt
jq < streams.json -r '.[] | "https://ctron.github.io/openshift-update-graph/#\(.)' >> sitemap.txt

cat sitemap.txt
